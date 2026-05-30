import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  CSSOL_VRT_MINT,
  DELTA_MINT_PROGRAM,
  GOVERNOR_PROGRAM,
  JITO_VAULT_PROGRAM,
  POOL_PDA,
  POOL_VRT_ATA,
} from "./addresses";

// Anchor-style discriminators for the 3 new governor ixes. Matches the
// snake_case Rust function names per Anchor v0.30+ convention.
//   sha256("global:enqueue_withdraw_via_pool")[0..8]
//   sha256("global:mature_withdrawal_tickets")[0..8]
//   sha256("global:redeem_cssol_wt")[0..8]
async function sha256_8(input: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(h).slice(0, 8);
}

const enc = new TextEncoder();

/** Pool's WithdrawQueue PDA — one per pool. */
export function withdrawQueuePda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("withdraw_queue"), POOL_PDA.toBuffer()],
    GOVERNOR_PROGRAM,
  )[0];
}

/**
 * Per-enqueue `base` PDA used to derive a fresh Jito ticket address.
 * Replaces v1's client-side ephemeral keypair (no extra signer needed
 * → fewer wallet "suspicious" warnings). Nonce = the queue's running
 * `total_cssol_wt_minted` counter at the moment the enqueue ix runs;
 * caller must read it from chain right before submitting.
 */
export function withdrawBasePda(nonce: bigint): PublicKey {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [enc.encode("wt_base"), POOL_PDA.toBuffer(), nonceBytes],
    GOVERNOR_PROGRAM,
  )[0];
}

/** csSOL-WT mint's MintConfig PDA — created by setup-cssol-wt-mint.ts. */
export function cssolWtMintConfig(cssolWtMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("mint_config"), cssolWtMint.toBuffer()],
    DELTA_MINT_PROGRAM,
  )[0];
}

/** csSOL-WT mint's MintAuthority PDA. */
export function cssolWtMintAuthority(cssolWtMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("mint_authority"), cssolWtMint.toBuffer()],
    DELTA_MINT_PROGRAM,
  )[0];
}

/** Whitelist entry PDA on the csSOL-WT MintConfig for a given holder. */
export function cssolWtWhitelistEntry(cssolWtMintCfg: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("whitelist"), cssolWtMintCfg.toBuffer(), owner.toBuffer()],
    DELTA_MINT_PROGRAM,
  )[0];
}

/** Build governor::enqueue_withdraw_via_pool. Caller passes an
 *  ephemeral `base` pubkey (also used to derive the ticket PDA); the
 *  base keypair must sign the outer transaction. */
export async function buildEnqueueWithdrawViaPoolIx(args: {
  user: PublicKey;
  base: PublicKey;
  amount: bigint;
  cssolWtMint: PublicKey;
  vrtMint: PublicKey;
  vaultStakerWithdrawalTicket: PublicKey;
  vaultStakerWithdrawalTicketTokenAccount: PublicKey;
  jitoVaultConfig: PublicKey;
}): Promise<TransactionInstruction> {
  const queue = withdrawQueuePda();
  const mintCfg = cssolWtMintConfig(args.cssolWtMint);
  const mintAuth = cssolWtMintAuthority(args.cssolWtMint);
  const whitelist = cssolWtWhitelistEntry(mintCfg, args.user);

  const userCssolAta = getAssociatedTokenAddressSync(
    CSSOL_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userCssolWtAta = getAssociatedTokenAddressSync(
    args.cssolWtMint, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userVrtAta = getAssociatedTokenAddressSync(
    args.vrtMint, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:enqueue_withdraw_via_pool"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: args.base, isSigner: false, isWritable: false },             // governor-derived PDA, signed via invoke_signed inside the program
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: CSSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: userCssolAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // cssol_token_program
      { pubkey: args.jitoVaultConfig, isSigner: false, isWritable: false },
      { pubkey: CSSOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: args.vaultStakerWithdrawalTicket, isSigner: false, isWritable: true },
      { pubkey: args.vaultStakerWithdrawalTicketTokenAccount, isSigner: false, isWritable: true },
      { pubkey: POOL_VRT_ATA, isSigner: false, isWritable: true },
      { pubkey: args.vrtMint, isSigner: false, isWritable: false },        // vrt_mint
      { pubkey: userVrtAta, isSigner: false, isWritable: true },           // user_vrt_token_account
      { pubkey: JITO_VAULT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // spl_token_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintCfg, isSigner: false, isWritable: true },
      { pubkey: args.cssolWtMint, isSigner: false, isWritable: true },
      { pubkey: mintAuth, isSigner: false, isWritable: false },
      { pubkey: whitelist, isSigner: false, isWritable: false },
      { pubkey: userCssolWtAta, isSigner: false, isWritable: true },
      { pubkey: DELTA_MINT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // cssol_wt_token_program
    ],
    data: Buffer.from(data),
  });
}

/** Build governor::mature_withdrawal_tickets. NOT permissionless —
 *  must be called by the original ticket creator (their signature
 *  satisfies Jito's `ticket.staker == provided_staker` check and
 *  authorizes the wSOL sweep into the pool's pending pool). */
export async function buildMatureWithdrawalTicketsIx(args: {
  user: PublicKey;
  vaultStakerWithdrawalTicket: PublicKey;
  vaultStakerWithdrawalTicketTokenAccount: PublicKey;
  vaultFeeTokenAccount: PublicKey;
  programFeeTokenAccount: PublicKey;
  jitoVaultConfig: PublicKey;
  poolPendingWsolAccount: PublicKey;
}): Promise<TransactionInstruction> {
  const queue = withdrawQueuePda();
  const userWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const data = new Uint8Array(8);
  data.set(await sha256_8("global:mature_withdrawal_tickets"), 0);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },                  // user (signer = ticket.staker)
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: args.jitoVaultConfig, isSigner: false, isWritable: false },
      { pubkey: CSSOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: CSSOL_VAULT_ST_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: CSSOL_VRT_MINT, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },              // wsol_mint
      { pubkey: userWsolAta, isSigner: false, isWritable: true },               // user_wsol_ata (Jito sends wSOL here, governor sweeps)
      { pubkey: args.poolPendingWsolAccount, isSigner: false, isWritable: true },
      { pubkey: args.vaultStakerWithdrawalTicket, isSigner: false, isWritable: true },
      { pubkey: args.vaultStakerWithdrawalTicketTokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.vaultFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.programFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: JITO_VAULT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/** Build governor::redeem_cssol_wt. User burns X csSOL-WT, gets X wSOL. */
export async function buildRedeemCsSolWtIx(args: {
  user: PublicKey;
  amount: bigint;
  cssolWtMint: PublicKey;
  poolPendingWsolAccount: PublicKey;
}): Promise<TransactionInstruction> {
  const queue = withdrawQueuePda();
  const userCssolWtAta = getAssociatedTokenAddressSync(
    args.cssolWtMint, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:redeem_cssol_wt"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: args.cssolWtMint, isSigner: false, isWritable: true },
      { pubkey: userCssolWtAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // cssol_wt_token_program
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: args.poolPendingWsolAccount, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/** Decode the WithdrawQueue PDA into a JS object. Layout matches
 *  the Rust struct in governor::lib.rs (Anchor borsh).
 *
 *  WithdrawTicket layout (81 bytes):
 *    ticket_pda(32) + staker(32) + cssol_wt_amount(u64=8)
 *      + created_at_slot(u64=8) + redeemed(u8=1)
 */
export interface DecodedQueue {
  poolConfig: PublicKey;
  pendingWsol: bigint;
  totalCssolWtMinted: bigint;
  totalCssolWtRedeemed: bigint;
  tickets: {
    ticketPda: PublicKey;
    staker: PublicKey;
    cssolWtAmount: bigint;
    createdAtSlot: bigint;
    redeemed: boolean;
  }[];
  bump: number;
}

/**
 * Decode the `slot_unstaked` field from a Jito VaultStakerWithdrawalTicket
 * account. Layout: discriminator(8) + vault(32) + staker(32) + base(32)
 *   + vrt_amount(u64=8) + slot_unstaked(u64=8) + ...
 * slot_unstaked starts at byte 112.
 */
export function decodeTicketSlotUnstaked(data: Buffer): bigint {
  return data.readBigUInt64LE(8 + 32 + 32 + 32 + 8);
}

/**
 * Decode `epoch_length` (slots per NCN epoch) from the Jito Vault Config
 * PDA. Layout: disc(8) + admin(32) + restakingProgram(32) + epochLength(u64).
 */
export function decodeJitoConfigEpochLength(data: Buffer): bigint {
  return data.readBigUInt64LE(8 + 32 + 32);
}

export function decodeWithdrawQueue(data: Buffer): DecodedQueue {
  let off = 8; // skip Anchor disc
  const poolConfig = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const pendingWsol = data.readBigUInt64LE(off); off += 8;
  const totalCssolWtMinted = data.readBigUInt64LE(off); off += 8;
  const totalCssolWtRedeemed = data.readBigUInt64LE(off); off += 8;
  const ticketCount = data.readUInt32LE(off); off += 4;
  const tickets: DecodedQueue["tickets"] = [];
  for (let i = 0; i < ticketCount; i++) {
    const ticketPda = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const staker = new PublicKey(data.subarray(off, off + 32)); off += 32;
    const cssolWtAmount = data.readBigUInt64LE(off); off += 8;
    const createdAtSlot = data.readBigUInt64LE(off); off += 8;
    const redeemed = data[off] !== 0; off += 1;
    tickets.push({ ticketPda, staker, cssolWtAmount, createdAtSlot, redeemed });
  }
  const bump = data[off];
  return { poolConfig, pendingWsol, totalCssolWtMinted, totalCssolWtRedeemed, tickets, bump };
}
