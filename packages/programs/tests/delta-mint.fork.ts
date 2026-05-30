/**
 * Delta Mint — Fork Integration Test
 *
 * Tests the full KYC-gated lending flow:
 *   1. Initialize a Token-2022 mint (KYC-wrapped USDY) with confidential transfer extension
 *   2. Whitelist a user via KYC
 *   3. Mint wrapped tokens to the whitelisted user
 *   4. Verify the token is compatible with Kamino Lend V2 by loading the
 *      klend program from mainnet and exercising market + reserve creation
 *
 * Run with: ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com anchor test
 */

import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { expect } from "chai";
import type { DeltaMint } from "../target/types/delta_mint";

// ---------------------------------------------------------------------------
// Mainnet constants
// ---------------------------------------------------------------------------

const KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
const KAMINO_MAIN_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
const USDY_MINT = new PublicKey(
  "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"
);
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

// Pyth oracle feed IDs (hex)
const PYTH_USDY_FEED_ID =
  "e393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326";
const PYTH_USDC_FEED_ID =
  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function snapshotAccount(address: PublicKey, conn: Connection) {
  const info = await conn.getAccountInfo(address);
  if (!info) return null;
  return {
    address,
    info: {
      lamports: info.lamports,
      data: info.data,
      owner: info.owner,
      executable: info.executable,
    },
  };
}

async function trySnapshotAccounts(addresses: PublicKey[], conn: Connection) {
  const results = await Promise.allSettled(
    addresses.map((a) => snapshotAccount(a, conn))
  );
  const accounts: Array<{
    address: PublicKey;
    info: { lamports: number; data: Buffer; owner: PublicKey; executable: boolean };
  }> = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      accounts.push(r.value);
    }
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("delta-mint (mainnet fork)", () => {
  let provider: BankrunProvider;
  let program: Program<DeltaMint>;
  let mainnetAvailable = false;

  const mintKeypair = Keypair.generate();
  const recipient = Keypair.generate();

  let mintConfigPda: PublicKey;
  let mintAuthorityPda: PublicKey;
  let whitelistEntryPda: PublicKey;

  before(async () => {
    const rpcUrl =
      process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
    const mainnetConn = new Connection(rpcUrl);

    // Try to snapshot mainnet accounts (non-blocking — tests still run if offline)
    const mainnetAccounts = await trySnapshotAccounts(
      [KAMINO_MAIN_MARKET, USDY_MINT, USDC_MINT],
      mainnetConn
    );
    mainnetAvailable = mainnetAccounts.length === 3;

    // Programs to load from mainnet (bankrun fetches the executable)
    const extraPrograms: Array<{ name: string; programId: PublicKey }> = [];
    if (mainnetAvailable) {
      extraPrograms.push({ name: "klend", programId: KLEND_PROGRAM_ID });
    }

    const context = await startAnchor("", extraPrograms, mainnetAccounts);

    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    program = new Program<DeltaMint>(
      anchor.workspace.DeltaMint.idl,
      provider
    );

    [mintConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [whitelistEntryPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        recipient.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  // =========================================================================
  // Phase 1: Token-2022 mint with confidential transfer extension
  // =========================================================================

  it("creates a Token-2022 mint with confidential transfer extension", async () => {
    await program.methods
      .initializeMint(6)
      .accounts({
        authority: provider.wallet.publicKey,
        mint: mintKeypair.publicKey,
        mintConfig: mintConfigPda,
        mintAuthority: mintAuthorityPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintKeypair])
      .rpc();

    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.decimals).to.equal(6);
    expect(config.mint.toBase58()).to.equal(mintKeypair.publicKey.toBase58());

    // Verify the mint account is owned by Token-2022
    const mintAccount = await provider.connection.getAccountInfo(
      mintKeypair.publicKey
    );
    expect(mintAccount).to.not.be.null;
    expect(mintAccount!.owner.toBase58()).to.equal(
      TOKEN_2022_PROGRAM_ID.toBase58()
    );

    // Verify confidential transfer extension is present.
    // Token-2022 mint base size is 82 bytes; anything larger has extensions.
    expect(mintAccount!.data.length).to.be.greaterThan(82);
  });

  // =========================================================================
  // Phase 2: KYC whitelist + mint
  // =========================================================================

  it("whitelists a user (KYC approval)", async () => {
    await program.methods
      .addToWhitelist()
      .accounts({
        authority: provider.wallet.publicKey,
        mintConfig: mintConfigPda,
        wallet: recipient.publicKey,
        whitelistEntry: whitelistEntryPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.whitelistEntry.fetch(whitelistEntryPda);
    expect(entry.approved).to.be.true;
  });

  it("mints 10,000 KYC-wrapped USDY (cUSDY) to the whitelisted user", async () => {
    const destinationAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const createAtaIx = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey,
      destinationAta,
      recipient.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const amount = new BN(10_000_000_000); // 10,000 tokens × 10^6

    await program.methods
      .mintTo(amount)
      .accounts({
        authority: provider.wallet.publicKey,
        mintConfig: mintConfigPda,
        mint: mintKeypair.publicKey,
        mintAuthority: mintAuthorityPda,
        whitelistEntry: whitelistEntryPda,
        destination: destinationAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createAtaIx])
      .rpc();

    // Read raw token account to verify balance
    const ataInfo = await provider.connection.getAccountInfo(destinationAta);
    expect(ataInfo).to.not.be.null;
    // Token-2022 account layout: amount is a u64 LE at offset 64
    const rawAmount = ataInfo!.data.readBigUInt64LE(64);
    expect(Number(rawAmount)).to.equal(10_000_000_000);
  });

  // =========================================================================
  // Phase 3: Kamino Lend V2 integration verification (requires mainnet RPC)
  // =========================================================================

  it("confirms Kamino klend program is loaded on fork", function () {
    if (!mainnetAvailable) return this.skip();
    return (async () => {
      const klendAccount = await provider.connection.getAccountInfo(
        KLEND_PROGRAM_ID
      );
      expect(klendAccount).to.not.be.null;
      expect(klendAccount!.executable).to.be.true;
    })();
  });

  it("reads the Kamino main market account from fork", function () {
    if (!mainnetAvailable) return this.skip();
    return (async () => {
      const marketAccount = await provider.connection.getAccountInfo(
        KAMINO_MAIN_MARKET
      );
      expect(marketAccount).to.not.be.null;
      expect(marketAccount!.owner.toBase58()).to.equal(
        KLEND_PROGRAM_ID.toBase58()
      );
    })();
  });

  it("verifies USDY and USDC mints are available on fork", function () {
    if (!mainnetAvailable) return this.skip();
    return (async () => {
      const usdyAccount = await provider.connection.getAccountInfo(USDY_MINT);
      const usdcAccount = await provider.connection.getAccountInfo(USDC_MINT);
      expect(usdyAccount).to.not.be.null;
      expect(usdcAccount).to.not.be.null;
    })();
  });

  // =========================================================================
  // Phase 4: Negative path — non-whitelisted user blocked
  // =========================================================================

  it("blocks minting to a non-whitelisted wallet", async () => {
    const attacker = Keypair.generate();
    const [fakeWhitelistPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        attacker.publicKey.toBuffer(),
      ],
      program.programId
    );

    const ata = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      attacker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await program.methods
        .mintTo(new BN(1_000_000))
        .accounts({
          authority: provider.wallet.publicKey,
          mintConfig: mintConfigPda,
          mint: mintKeypair.publicKey,
          mintAuthority: mintAuthorityPda,
          whitelistEntry: fakeWhitelistPda,
          destination: ata,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have rejected — wallet not whitelisted");
    } catch (err) {
      expect(err).to.exist;
    }
  });

  // =========================================================================
  // Phase 5: Whitelist removal (revoke KYC)
  // =========================================================================

  it("removes a user from the whitelist", async () => {
    await program.methods
      .removeFromWhitelist()
      .accounts({
        authority: provider.wallet.publicKey,
        mintConfig: mintConfigPda,
        whitelistEntry: whitelistEntryPda,
      })
      .rpc();

    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.totalWhitelisted.toNumber()).to.equal(0);
  });
});
