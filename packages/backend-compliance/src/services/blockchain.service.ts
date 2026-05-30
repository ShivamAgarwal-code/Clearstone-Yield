/**
 * Blockchain Service — all Solana interaction is isolated here.
 *
 * Calls delta-mint program instructions directly via @solana/web3.js.
 * No Anchor IDL JSON is required — discriminators are computed from
 * the canonical Anchor formula: sha256("global:<ix_name>")[0..8].
 *
 * PDAs derived:
 *   mint_config      = ["mint_config",  mint.key]                        (delta-mint)
 *   whitelist_entry  = ["whitelist", mint_config.key, wallet.key]        (delta-mint)
 *
 * Multi-pool: addToWhitelist / removeFromWhitelist operate across ALL
 * configured mints in WRAPPED_MINT_ADDRESSES so one KYC approval grants
 * access to every pool simultaneously.
 *
 * Transaction signing is delegated to SigningService — swap LocalKeypairSigner
 * for FireblocksSigner by setting FIREBLOCKS_API_KEY in the environment.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import crypto from "crypto";
import { config } from "../config.js";
import { getSigningService, type SigningService } from "./signing.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function discriminator(name: string): Buffer {
  return Buffer.from(
    crypto.createHash("sha256").update(`global:${name}`).digest()
  ).subarray(0, 8);
}

function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhitelistResult {
  /** The pool's wrapped mint this entry belongs to. */
  mintAddress: string;
  signature: string;
  whitelistEntryAddress: string;
}

export interface BlockchainService {
  /** Whitelist wallet across all configured pools. */
  addToWhitelist(walletAddress: string): Promise<WhitelistResult[]>;
  /** Remove wallet from all configured pools. */
  removeFromWhitelist(walletAddress: string): Promise<string[]>;
  /** True if wallet is whitelisted in ALL configured pools. */
  isWhitelisted(walletAddress: string): Promise<boolean>;
  validateAddress(address: string): boolean;
}

// ---------------------------------------------------------------------------
// Solana implementation
// ---------------------------------------------------------------------------

class SolanaBlockchainService implements BlockchainService {
  private readonly connection: Connection;
  private readonly signer: SigningService;
  private readonly programId: PublicKey;
  private readonly governorProgramId: PublicKey;
  private readonly mintPubkeys: PublicKey[];

  constructor(signer?: SigningService) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.signer = signer ?? getSigningService();
    this.programId = new PublicKey(config.deltaMintProgramId);
    this.governorProgramId = new PublicKey(config.governorProgramId);
    this.mintPubkeys = config.wrappedMintAddresses.map((a) => new PublicKey(a));
  }

  validateAddress(address: string): boolean {
    return isValidPublicKey(address);
  }

  private getMintConfigPDA(mintPubkey: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), mintPubkey.toBuffer()],
      this.programId
    );
    return pda;
  }

  private getWhitelistEntryPDA(
    mintConfigPubkey: PublicKey,
    walletPubkey: PublicKey
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPubkey.toBuffer(),
        walletPubkey.toBuffer(),
      ],
      this.programId
    );
    return pda;
  }

  private async sendTx(tx: Transaction): Promise<string> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = this.signer.publicKey();

    const signed = await this.signer.sign(tx);
    const raw = signed.serialize();
    const signature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
    });
    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    return signature;
  }

  async isWhitelisted(walletAddress: string): Promise<boolean> {
    const walletPubkey = new PublicKey(walletAddress);
    const checks = await Promise.all(
      this.mintPubkeys.map(async (mint) => {
        const mintConfig = this.getMintConfigPDA(mint);
        const entry = this.getWhitelistEntryPDA(mintConfig, walletPubkey);
        return this.connection.getAccountInfo(entry);
      })
    );
    return checks.every((info) => info !== null);
  }

  async addToWhitelist(walletAddress: string): Promise<WhitelistResult[]> {
    const walletPubkey = new PublicKey(walletAddress);
    return Promise.all(
      this.mintPubkeys.map((mint) =>
        this._addToWhitelistForMint(mint, walletPubkey)
      )
    );
  }

  private async _addToWhitelistForMint(
    mintPubkey: PublicKey,
    walletPubkey: PublicKey
  ): Promise<WhitelistResult> {
    const mintConfigPDA = this.getMintConfigPDA(mintPubkey);
    const whitelistEntryPDA = this.getWhitelistEntryPDA(
      mintConfigPDA,
      walletPubkey
    );

    const existing = await this.connection.getAccountInfo(whitelistEntryPDA);
    if (existing) {
      // Already whitelisted — return success without error
      return {
        mintAddress: mintPubkey.toBase58(),
        signature: "already_whitelisted",
        whitelistEntryAddress: whitelistEntryPDA.toBase58(),
      };
    }

    // Try governor's add_participant_via_pool first (for activated pools),
    // then fall back to direct delta-mint add_to_whitelist (for non-activated pools)
    let signature: string;
    try {
      signature = await this._whitelistViaGovernor(mintPubkey, mintConfigPDA, walletPubkey, whitelistEntryPDA);
    } catch {
      // Fallback: direct delta-mint call (works if authority hasn't been transferred)
      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: this.signer.publicKey(), isSigner: true, isWritable: true },
          { pubkey: mintConfigPDA, isSigner: false, isWritable: true },
          { pubkey: walletPubkey, isSigner: false, isWritable: false },
          { pubkey: whitelistEntryPDA, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: discriminator("add_to_whitelist"),
      });
      signature = await this.sendTx(new Transaction().add(ix));
    }

    console.log(
      `[blockchain] Whitelisted ${walletPubkey.toBase58()} for mint ${mintPubkey.toBase58()} | tx: ${signature}`
    );

    return {
      mintAddress: mintPubkey.toBase58(),
      signature,
      whitelistEntryAddress: whitelistEntryPDA.toBase58(),
    };
  }

  /**
   * Whitelist via governor's add_participant_via_pool (for activated pools
   * where the delta-mint authority has been transferred to the pool PDA).
   */
  private async _whitelistViaGovernor(
    _mintPubkey: PublicKey,
    mintConfigPDA: PublicKey,
    walletPubkey: PublicKey,
    whitelistEntryPDA: PublicKey,
  ): Promise<string> {
    // Find the pool PDA for this mint's underlying
    // Read mintConfig to find the pool
    const mintConfigInfo = await this.connection.getAccountInfo(mintConfigPDA);
    if (!mintConfigInfo) throw new Error("MintConfig not found");

    // The pool PDA is the authority of the mintConfig (at offset 8)
    const poolPda = new PublicKey(mintConfigInfo.data.subarray(8, 40));

    // add_participant_via_pool discriminator: sha256("global:add_participant_via_pool")[0..8]
    const disc = Buffer.from([200, 11, 127, 111, 117, 242, 194, 36]);

    const ix = new TransactionInstruction({
      programId: this.governorProgramId,
      keys: [
        { pubkey: this.signer.publicKey(), isSigner: true, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: this.governorProgramId, isSigner: false, isWritable: false }, // adminEntry = None (use program ID as placeholder)
        { pubkey: mintConfigPDA, isSigner: false, isWritable: true },
        { pubkey: walletPubkey, isSigner: false, isWritable: false },
        { pubkey: whitelistEntryPDA, isSigner: false, isWritable: true },
        { pubkey: this.programId, isSigner: false, isWritable: false }, // deltaMintProgram
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc, Buffer.from([0])]), // ParticipantRole::Holder = 0
    });

    return this.sendTx(new Transaction().add(ix));
  }

  async removeFromWhitelist(walletAddress: string): Promise<string[]> {
    const walletPubkey = new PublicKey(walletAddress);
    return Promise.all(
      this.mintPubkeys.map((mint) =>
        this._removeFromWhitelistForMint(mint, walletPubkey)
      )
    );
  }

  private async _removeFromWhitelistForMint(
    mintPubkey: PublicKey,
    walletPubkey: PublicKey
  ): Promise<string> {
    const mintConfigPDA = this.getMintConfigPDA(mintPubkey);
    const whitelistEntryPDA = this.getWhitelistEntryPDA(
      mintConfigPDA,
      walletPubkey
    );

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.signer.publicKey(), isSigner: true, isWritable: true },
        { pubkey: mintConfigPDA, isSigner: false, isWritable: true },
        { pubkey: whitelistEntryPDA, isSigner: false, isWritable: true },
      ],
      data: discriminator("remove_from_whitelist"),
    });

    const signature = await this.sendTx(new Transaction().add(ix));

    console.log(
      `[blockchain] Removed ${walletPubkey.toBase58()} from mint ${mintPubkey.toBase58()} | tx: ${signature}`
    );

    return signature;
  }
}

// ---------------------------------------------------------------------------
// Singleton factory — swap implementation for a mock in tests
// ---------------------------------------------------------------------------

let _instance: BlockchainService | undefined;

export function getBlockchainService(): BlockchainService {
  if (!_instance) _instance = new SolanaBlockchainService();
  return _instance;
}

export function setBlockchainService(svc: BlockchainService): void {
  _instance = svc;
}
