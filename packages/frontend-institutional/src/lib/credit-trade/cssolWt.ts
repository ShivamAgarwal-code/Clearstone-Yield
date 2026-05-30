/**
 * cssolWt.ts — csSOL withdraw-ticket plumbing. Verbatim port from
 * `frontend-playground/src/lib/cssolWt.ts`.
 */
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

async function sha256_8(input: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(h).slice(0, 8);
}

const enc = new TextEncoder();

export function withdrawQueuePda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("withdraw_queue"), POOL_PDA.toBuffer()],
    GOVERNOR_PROGRAM,
  )[0];
}

export function withdrawBasePda(nonce: bigint): PublicKey {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [enc.encode("wt_base"), POOL_PDA.toBuffer(), nonceBytes],
    GOVERNOR_PROGRAM,
  )[0];
}

export function cssolWtMintConfig(cssolWtMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("mint_config"), cssolWtMint.toBuffer()],
    DELTA_MINT_PROGRAM,
  )[0];
}

export function cssolWtMintAuthority(cssolWtMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("mint_authority"), cssolWtMint.toBuffer()],
    DELTA_MINT_PROGRAM,
  )[0];
}

export function cssolWtWhitelistEntry(cssolWtMintCfg: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [enc.encode("whitelist"), cssolWtMintCfg.toBuffer(), owner.toBuffer()],
    DELTA_MINT_PROGRAM,
  )[0];
}

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
      { pubkey: args.base, isSigner: false, isWritable: false },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: CSSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: userCssolAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.jitoVaultConfig, isSigner: false, isWritable: false },
      { pubkey: CSSOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: args.vaultStakerWithdrawalTicket, isSigner: false, isWritable: true },
      { pubkey: args.vaultStakerWithdrawalTicketTokenAccount, isSigner: false, isWritable: true },
      { pubkey: POOL_VRT_ATA, isSigner: false, isWritable: true },
      { pubkey: args.vrtMint, isSigner: false, isWritable: false },
      { pubkey: userVrtAta, isSigner: false, isWritable: true },
      { pubkey: JITO_VAULT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mintCfg, isSigner: false, isWritable: true },
      { pubkey: args.cssolWtMint, isSigner: false, isWritable: true },
      { pubkey: mintAuth, isSigner: false, isWritable: false },
      { pubkey: whitelist, isSigner: false, isWritable: false },
      { pubkey: userCssolWtAta, isSigner: false, isWritable: true },
      { pubkey: DELTA_MINT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

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
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: args.jitoVaultConfig, isSigner: false, isWritable: false },
      { pubkey: CSSOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: CSSOL_VAULT_ST_TOKEN_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: CSSOL_VRT_MINT, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
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
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: args.poolPendingWsolAccount, isSigner: false, isWritable: true },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

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

export function decodeTicketSlotUnstaked(data: Buffer): bigint {
  return data.readBigUInt64LE(8 + 32 + 32 + 32 + 8);
}

export function decodeJitoConfigEpochLength(data: Buffer): bigint {
  return data.readBigUInt64LE(8 + 32 + 32);
}

/** JitoConfig layout (devnet, 2026-05):
 *    8  disc
 *   32  admin
 *   32  restaking_program
 *    8  epoch_length
 *    8  num_vaults
 *    2  deposit_withdrawal_fee_cap_bps
 *    2  fee_rate_of_change_bps
 *    2  fee_bump_bps
 *    2  program_fee_bps        ← fee taken on every withdrawal payout
 *   32  program_fee_wallet     ← what we want, at offset 96
 *  ...
 *  Distinct from `Vault.fee_wallet`. `mature_withdrawal_tickets`'s
 *  Jito CPI requires the program_fee ATA to be derived from THIS
 *  pubkey (not the vault's) — passing the vault-fee ATA in the
 *  program-fee slot trips Jito's "Account is not the associated
 *  token account" assertion in BurnWithdrawalTicket.
 */
export function decodeJitoConfigProgramFeeWallet(data: Buffer): PublicKey {
  return new PublicKey(data.subarray(96, 96 + 32));
}

/** Jito-program-level withdrawal fee in basis points. Taken off the
 *  wSOL payout when burning a withdrawal ticket — the staker receives
 *  `cssol_wt_amount × (1 - program_fee_bps/10000)` wSOL, while
 *  governor's `mature_withdrawal_tickets` then sweeps the FULL
 *  `cssol_wt_amount` from the user's wSOL ATA into the pool's
 *  pending pool. The frontend has to pre-fund the user's wSOL ATA
 *  with the fee delta (or risk the sweep failing with Token program
 *  custom 0x1 = "insufficient funds"). */
export function decodeJitoConfigProgramFeeBps(data: Buffer): number {
  return data.readUInt16LE(94);
}

export function decodeWithdrawQueue(data: Buffer): DecodedQueue {
  let off = 8;
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
