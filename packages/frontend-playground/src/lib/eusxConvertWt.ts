/**
 * eusxConvertWt.ts — Builders for the leveraged ceUSX → ceUSX-WT
 * (convert) and ceUSX-WT → USDC (unwind) flows.
 *
 * Mirrors the csSOL convert/unwind pattern but with Solstice's async
 * Unlock+Withdraw split in place of Jito's epoch-locked ticket. See
 * packages/programs/CEUSX_WITHDRAWAL.md for the full architecture.
 *
 * Per-user PDA discovery: Solstice's Unlock and Withdraw ixes
 * reference per-user PDAs whose seeds we don't have an IDL for. We
 * recover them by calling Solstice's REST API with the user pubkey —
 * the API returns a fully-templated ix whose accounts include the
 * derived per-user PDAs at known indices. We extract those and pass
 * them through to the governor's CPI accounts list.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CEUSX_MINT,
  CEUSX_RESERVE,
  CEUSX_RESERVE_ORACLE,
  CEUSX_WT_DM_MINT_AUTHORITY,
  CEUSX_WT_DM_MINT_CONFIG,
  CEUSX_WT_HOST_POOL,
  CEUSX_WT_MINT,
  CEUSX_WT_RESERVE,
  EUSX_MINT,
  EUSX_POOL_PDA,
  GOVERNOR_PROGRAM,
  KLEND_MARKET,
  KLEND_PROGRAM,
  LEGACY_DELTA_MINT_PROGRAM,
  LEGACY_GOVERNOR_PROGRAM,
  SUSDC_MINT,
  SUSDC_RESERVE,
  SUSDC_RESERVE_ORACLE,
  USX_MINT,
  YIELD_VAULT_PROGRAM,
} from "./addresses";
import {
  buildBorrowObligationLiquidityIx,
  buildDepositLiquidityAndCollateralIx,
  buildFlashBorrowIx,
  buildFlashRepayIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRepayObligationLiquidityIx,
  buildWithdrawCollateralAndRedeemIx,
  obligationPda,
} from "./klend";
import { callSolstice } from "./eusxConversions";

async function sha256_8(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash, 0, 8);
}

/** Reserve PDA derivation (seed-based, namespaced by klend program). */
function reservePda(seed: string, reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(seed), reserve.toBuffer()],
    KLEND_PROGRAM,
  )[0];
}
function lmaPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("lma"), KLEND_MARKET.toBuffer()],
    KLEND_PROGRAM,
  )[0];
}
function legacyWhitelistPda(mintConfig: PublicKey, user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("whitelist"), mintConfig.toBuffer(), user.toBuffer()],
    LEGACY_DELTA_MINT_PROGRAM,
  )[0];
}
function newGovernorWhitelistPda(mintConfig: PublicKey, user: PublicKey, deltaMintProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("whitelist"), mintConfig.toBuffer(), user.toBuffer()],
    deltaMintProgram,
  )[0];
}

/** Build the legacy governor `unwrap` ix (ceUSX → eUSX). Same disc /
 *  account layout as `buildCeUsxToEusxUnwrapIx` in eusxConversions.ts —
 *  duplicated here to keep the builder self-contained. */
async function buildLegacyUnwrapCeusxIx(args: {
  user: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(EUSX_MINT, EUSX_POOL_PDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCeusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:unwrap"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: LEGACY_GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: EUSX_POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: EUSX_MINT, isSigner: false, isWritable: false },
      { pubkey: userEusxAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: CEUSX_MINT, isSigner: false, isWritable: true },
      { pubkey: userCeusxAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

/** Build the new governor `enqueue_eusx_unlock_via_pool` ix.
 *  Account ordering matches the EnqueueEusxUnlockViaPool struct in
 *  governor/src/lib.rs. The two per-user Solstice PDAs are extracted
 *  from a Solstice API call (the API derives them from the user
 *  pubkey; we don't have the seeds). */
async function buildEnqueueEusxUnlockViaPoolIx(args: {
  user: PublicKey;
  amount: bigint;
  apiKey: string;
  newDeltaMintProgram: PublicKey;
}): Promise<TransactionInstruction> {
  // Probe the API for an `Unlock` ix with this user — extract the two
  // per-user PDAs from acc[9] and acc[10].
  const probeIxes = await callSolstice(args.apiKey, {
    type: "Unlock",
    data: { amount: Number(args.amount), user: args.user.toBase58() },
  });
  if (probeIxes.length !== 1) {
    throw new Error("Solstice Unlock probe returned unexpected ix count");
  }
  const probeAccs = probeIxes[0].keys;
  if (probeAccs.length < 13) {
    throw new Error(`Solstice Unlock probe returned ${probeAccs.length} accs, expected 13`);
  }
  const solsticeVaultState        = probeAccs[2].pubkey;
  const solsticeVaultEusxAccount  = probeAccs[3].pubkey;
  const solsticeConfigA           = probeAccs[7].pubkey;
  const solsticeConfigB           = probeAccs[8].pubkey;
  const userPendingUnlockPda      = probeAccs[9].pubkey;
  const userPendingUnlockPdaB     = probeAccs[10].pubkey;
  const solsticeTokenProgram      = probeAccs[11].pubkey;

  const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtAta = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtWhitelistEntry = newGovernorWhitelistPda(CEUSX_WT_DM_MINT_CONFIG, args.user, args.newDeltaMintProgram);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:enqueue_eusx_unlock_via_pool"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: CEUSX_WT_HOST_POOL, isSigner: false, isWritable: true },

      // ceUSX-WT mint side
      { pubkey: CEUSX_WT_DM_MINT_CONFIG, isSigner: false, isWritable: true },
      { pubkey: CEUSX_WT_MINT, isSigner: false, isWritable: true },
      { pubkey: CEUSX_WT_DM_MINT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: userWtWhitelistEntry, isSigner: false, isWritable: false },
      { pubkey: userWtAta, isSigner: false, isWritable: true },
      { pubkey: args.newDeltaMintProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },

      // Solstice Unlock side
      { pubkey: YIELD_VAULT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: solsticeVaultState, isSigner: false, isWritable: true },
      { pubkey: solsticeVaultEusxAccount, isSigner: false, isWritable: true },
      { pubkey: EUSX_MINT, isSigner: false, isWritable: true },
      { pubkey: userEusxAta, isSigner: false, isWritable: true },
      { pubkey: USX_MINT, isSigner: false, isWritable: true },
      { pubkey: solsticeConfigA, isSigner: false, isWritable: true },
      { pubkey: solsticeConfigB, isSigner: false, isWritable: true },
      { pubkey: userPendingUnlockPda, isSigner: false, isWritable: true },
      { pubkey: userPendingUnlockPdaB, isSigner: false, isWritable: true },
      { pubkey: solsticeTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

/** Build the new governor `redeem_ceusx_wt` ix. */
async function buildRedeemCeusxWtIx(args: {
  user: PublicKey;
  amount: bigint;
  apiKey: string;
}): Promise<TransactionInstruction> {
  // Probe the API for a `Withdraw` ix with this user — extract per-user
  // PDA + vault USX account.
  const probeIxes = await callSolstice(args.apiKey, {
    type: "Withdraw",
    data: { amount: 1, user: args.user.toBase58() },
  });
  if (probeIxes.length !== 1) throw new Error("Solstice Withdraw probe returned unexpected ix count");
  const probeAccs = probeIxes[0].keys;
  if (probeAccs.length < 8) throw new Error(`Solstice Withdraw probe returned ${probeAccs.length} accs, expected 8`);

  const solsticeVaultState     = probeAccs[2].pubkey;
  const userPendingUnlockPda   = probeAccs[4].pubkey;
  const solsticeVaultUsxAccount = probeAccs[6].pubkey;
  const solsticeTokenProgram   = probeAccs[7].pubkey;

  const userWtAta = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userUsxAta = getAssociatedTokenAddressSync(USX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:redeem_ceusx_wt"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: CEUSX_WT_HOST_POOL, isSigner: false, isWritable: false },

      { pubkey: CEUSX_WT_MINT, isSigner: false, isWritable: true },
      { pubkey: userWtAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },

      { pubkey: YIELD_VAULT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: solsticeVaultState, isSigner: false, isWritable: true },
      { pubkey: USX_MINT, isSigner: false, isWritable: true },
      { pubkey: userPendingUnlockPda, isSigner: false, isWritable: true },
      { pubkey: userUsxAta, isSigner: false, isWritable: true },
      { pubkey: solsticeVaultUsxAccount, isSigner: false, isWritable: true },
      { pubkey: solsticeTokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

export interface ConvertCeusxArgs {
  user: PublicKey;
  /** Amount of ceUSX (and ceUSX-WT) to swap. Same value flows through:
   *  flash-borrow X WT → deposit X WT → withdraw X ceUSX → unwrap →
   *  Solstice.Unlock(X) → mint X WT → flash-repay X WT. */
  amount: bigint;
  apiKey: string;
  /** New delta-mint program ID. Caller passes from addresses.ts. */
  newDeltaMintProgram: PublicKey;
  /** Klend obligation deposit reserves at tx start (used for refresh
   *  chain remaining_accounts). After deposit_collateral(WT) and
   *  withdraw(ceUSX) the obligation deposits change, but the
   *  refresh_obligation reads the start-of-tx state. */
  obligationDeposits: PublicKey[];
}

/** Build the convert tx ix list. Caller compiles + signs. */
export async function buildConvertCeusxIxes(args: ConvertCeusxArgs): Promise<TransactionInstruction[]> {
  const userCeusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userEusxAta  = getAssociatedTokenAddressSync(EUSX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userUsxAta   = getAssociatedTokenAddressSync(USX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtAta    = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // Refresh chain: include every active deposit reserve + the WT
  // reserve (touched by flash_borrow + deposit_collateral) + ceUSX
  // reserve (touched by withdraw).
  const refreshReserves = new Set<string>();
  for (const r of args.obligationDeposits) refreshReserves.add(r.toBase58());
  refreshReserves.add(CEUSX_WT_RESERVE.toBase58());
  refreshReserves.add(CEUSX_RESERVE.toBase58());
  refreshReserves.add(SUSDC_RESERVE.toBase58());

  const oracleByReserve: Record<string, PublicKey> = {
    [CEUSX_WT_RESERVE.toBase58()]: CEUSX_RESERVE_ORACLE, // shares ceUSX oracle on devnet (1:1)
    [CEUSX_RESERVE.toBase58()]: CEUSX_RESERVE_ORACLE,
    [SUSDC_RESERVE.toBase58()]: SUSDC_RESERVE_ORACLE,
  };

  const refreshIxes: TransactionInstruction[] = [];
  for (const r of refreshReserves) {
    const reservePk = new PublicKey(r);
    const oracle = oracleByReserve[r] ?? CEUSX_RESERVE_ORACLE;
    refreshIxes.push(await buildRefreshReserveIx(reservePk, oracle));
  }
  // Re-push the action targets so they land at N-2 of the next ix
  // (klend's check_refresh constraint).
  refreshIxes.push(await buildRefreshReserveIx(CEUSX_WT_RESERVE, CEUSX_RESERVE_ORACLE));
  refreshIxes.push(await buildRefreshObligationIx(args.user, [...args.obligationDeposits]));

  const enqueueIx = await buildEnqueueEusxUnlockViaPoolIx({
    user: args.user, amount: args.amount, apiKey: args.apiKey,
    newDeltaMintProgram: args.newDeltaMintProgram,
  });
  const unwrapCeusxIx = await buildLegacyUnwrapCeusxIx({ user: args.user, amount: args.amount });

  const flashBorrowIx = await buildFlashBorrowIx({
    user: args.user,
    reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    reserveSourceLiquidity: reservePda("reserve_liq_supply", CEUSX_WT_RESERVE),
    userDestinationLiquidity: userWtAta,
    amount: args.amount,
  });
  const depositWtIx = await buildDepositLiquidityAndCollateralIx({
    user: args.user, reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userSourceLiquidity: userWtAta, amount: args.amount,
  });
  const withdrawCeusxIx = await buildWithdrawCollateralAndRedeemIx({
    user: args.user, reserve: CEUSX_RESERVE,
    liquidityMint: CEUSX_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCeusxAta, collateralAmount: args.amount,
    refreshObligationDeposits: args.obligationDeposits,
  });
  const flashRepayIx = await buildFlashRepayIx({
    user: args.user,
    reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    reserveDestinationLiquidity: reservePda("reserve_liq_supply", CEUSX_WT_RESERVE),
    userSourceLiquidity: userWtAta,
    amount: args.amount,
    borrowInstructionIndex: 0, // patched below to match real index
  });

  // Final ix list. The flash-borrow/repay borrowInstructionIndex needs
  // to point at the actual position of flash_borrow in the tx — we
  // compute it after assembly and patch.
  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userCeusxAta, args.user, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userEusxAta, args.user, EUSX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userUsxAta, args.user, USX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userWtAta, args.user, CEUSX_WT_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    flashBorrowIx,
    depositWtIx,
    ...refreshIxes,
    withdrawCeusxIx,
    unwrapCeusxIx,
    enqueueIx,
    flashRepayIx,
  ];

  // Patch flash-repay's borrowInstructionIndex to the real flash_borrow
  // position. klend cross-references via SysvarInstructions.
  const flashBorrowPosition = ixes.indexOf(flashBorrowIx);
  // Re-encode flashRepayIx data with the correct position. The
  // buildFlashRepayIx expects a u8 instruction-index field after the
  // amount; rebuild it now that we know.
  ixes[ixes.length - 1] = await buildFlashRepayIx({
    user: args.user,
    reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    reserveDestinationLiquidity: reservePda("reserve_liq_supply", CEUSX_WT_RESERVE),
    userSourceLiquidity: userWtAta,
    amount: args.amount,
    borrowInstructionIndex: flashBorrowPosition,
  });

  return ixes;
}

export interface UnwindCeusxWtArgs {
  user: PublicKey;
  /** Amount of ceUSX-WT to redeem (also amount of sUSDC to flash-borrow,
   *  repay, and final-redeem; assumes 1:1 USX:USDC). */
  amount: bigint;
  apiKey: string;
  obligationDeposits: PublicKey[];
}

/** Build the unwind tx ix list. Convert/Wait must have happened first
 *  AND the user's pending-unlock PDA must have matured. */
export async function buildUnwindCeusxWtIxes(args: UnwindCeusxWtArgs): Promise<TransactionInstruction[]> {
  const userUsdcAta = getAssociatedTokenAddressSync(SUSDC_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userUsxAta  = getAssociatedTokenAddressSync(USX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtAta   = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const refreshReserves = new Set<string>();
  for (const r of args.obligationDeposits) refreshReserves.add(r.toBase58());
  refreshReserves.add(CEUSX_WT_RESERVE.toBase58());
  refreshReserves.add(SUSDC_RESERVE.toBase58());

  const oracleByReserve: Record<string, PublicKey> = {
    [CEUSX_WT_RESERVE.toBase58()]: CEUSX_RESERVE_ORACLE,
    [SUSDC_RESERVE.toBase58()]: SUSDC_RESERVE_ORACLE,
  };
  const refreshIxes: TransactionInstruction[] = [];
  for (const r of refreshReserves) {
    refreshIxes.push(await buildRefreshReserveIx(new PublicKey(r), oracleByReserve[r] ?? CEUSX_RESERVE_ORACLE));
  }
  refreshIxes.push(await buildRefreshReserveIx(SUSDC_RESERVE, SUSDC_RESERVE_ORACLE));
  refreshIxes.push(await buildRefreshObligationIx(args.user, [...args.obligationDeposits]));

  // RequestRedeem + ConfirmRedeem ixes from Solstice REST API
  const [reqRedeemIxes, confRedeemIxes] = await Promise.all([
    callSolstice(args.apiKey, { type: "RequestRedeem", data: { amount: Number(args.amount), collateral: "usdc", user: args.user.toBase58() } }),
    callSolstice(args.apiKey, { type: "ConfirmRedeem", data: { user: args.user.toBase58(), collateral: "usdc" } }),
  ]);

  const flashBorrowIx = await buildFlashBorrowIx({
    user: args.user,
    reserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    reserveSourceLiquidity: reservePda("reserve_liq_supply", SUSDC_RESERVE),
    userDestinationLiquidity: userUsdcAta,
    amount: args.amount,
  });
  const repayIx = await buildRepayObligationLiquidityIx({
    user: args.user, repayReserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
    userSourceLiquidity: userUsdcAta, amount: args.amount,
  });
  const withdrawWtIx = await buildWithdrawCollateralAndRedeemIx({
    user: args.user, reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userWtAta, collateralAmount: args.amount,
    refreshObligationDeposits: args.obligationDeposits,
  });
  const redeemWtIx = await buildRedeemCeusxWtIx({ user: args.user, amount: args.amount, apiKey: args.apiKey });
  const flashRepayIx = await buildFlashRepayIx({
    user: args.user,
    reserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    reserveDestinationLiquidity: reservePda("reserve_liq_supply", SUSDC_RESERVE),
    userSourceLiquidity: userUsdcAta,
    amount: args.amount,
    borrowInstructionIndex: 0,
  });

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userUsdcAta, args.user, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userUsxAta, args.user, USX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userWtAta, args.user, CEUSX_WT_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    flashBorrowIx,
    ...refreshIxes,
    repayIx,
    withdrawWtIx,
    redeemWtIx,
    ...reqRedeemIxes,
    ...confRedeemIxes,
    flashRepayIx,
  ];

  const flashBorrowPosition = ixes.indexOf(flashBorrowIx);
  ixes[ixes.length - 1] = await buildFlashRepayIx({
    user: args.user,
    reserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    reserveDestinationLiquidity: reservePda("reserve_liq_supply", SUSDC_RESERVE),
    userSourceLiquidity: userUsdcAta,
    amount: args.amount,
    borrowInstructionIndex: flashBorrowPosition,
  });

  return ixes;
}

// SysvarInstructions reference is needed for klend's check_refresh
// validator on flash_borrow / flash_repay, but klend builds it
// internally — exporting the symbol so callers can probe if they need.
export const SYSVAR_INSTRUCTIONS = SYSVAR_INSTRUCTIONS_PUBKEY;

// Re-export for convenience so the panel UI can reuse the obligation
// PDA lookup without a separate import.
export const obligation = obligationPda;
