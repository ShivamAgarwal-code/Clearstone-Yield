/**
 * creditTrade.ts — Pure ix builders + quote helpers for the
 * single-tx leveraged credit-trade flow on the v3 csSOL market.
 *
 * Open flow (csSOL collateral / wSOL debt, eMode 2):
 *
 *   [0]  ComputeBudget setComputeUnitLimit
 *   [1]  init_user_metadata    (idempotent — only if missing)
 *   [2]  init_obligation       (idempotent)
 *   [3]  ATA(csSOL)            (idempotent)
 *   [4]  ATA(wSOL)             (idempotent)
 *   [5]  ATA(VRT)              (idempotent — needed by Jito vault wrap)
 *   [6]  flash_borrow_reserve_liquidity(wSOL_reserve, loan)
 *
 *   [7+] margin pre-wrap (only when margin asset = SOL or wSOL):
 *          SystemProgram.transfer(user → wsolAta, marginLamports)
 *          createSyncNativeInstruction(wsolAta)
 *
 *   [N]  wrap_with_jito_vault(amount = loan + (margin if SOL/wSOL else 0))
 *          → mints csSOL into user's csSOL ATA
 *
 *   [N+1..N+3]  refresh chain for csSOL deposit
 *   [N+4]  deposit_reserve_liquidity_and_obligation_collateral(
 *            csSOL_reserve,
 *            amount = csSOL_minted_from_wrap + (margin if csSOL else 0))
 *
 *   [N+5..N+6] re-refresh after deposit
 *   [N+7]  borrow_obligation_liquidity(wSOL_reserve, amount = loan,
 *            remaining_accounts = [csSOL_reserve, csSOL_WT_reserve?])
 *
 *   [last] flash_repay_reserve_liquidity(wSOL_reserve, loan)
 *          (fee = 0 in our reserve config — no headroom needed)
 *
 *   [last+1] (optional) closeAccount(wsolAta) so leftover wSOL
 *            (zero in the happy path) + ATA rent return as native SOL.
 *
 * Net effect: user wallet `−margin` of M, obligation
 * `+(loan + margin)` csSOL collateral, `+loan` wSOL debt.
 *
 * Increase path: same builder, the existing obligation deposit/borrow
 * reserves are auto-included in the refresh + borrow remaining accounts.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  CSSOL_VRT_MINT,
  CSSOL_WT_MINT,
  CSSOL_WT_RESERVE,
  ELEVATION_GROUP_LST_SOL,
  JITO_VAULT_PROGRAM,
  POOL_PENDING_WSOL_ACCOUNT,
  WSOL_RESERVE,
  WSOL_RESERVE_ORACLE,
} from "./addresses";
import { buildWrapWithJitoVaultIx, type VaultState } from "./jitoVault";
import {
  buildEnqueueWithdrawViaPoolIx,
  buildRedeemCsSolWtIx,
  withdrawBasePda,
} from "./cssolWt";
import {
  buildBorrowObligationLiquidityIx,
  buildDepositCsSolIx,
  buildDepositLiquidityAndCollateralIx,
  buildFlashBorrowIx,
  buildFlashRepayIx,
  buildInitObligationIx,
  buildInitUserMetadataIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRepayObligationLiquidityIx,
  buildRequestElevationGroupIx,
  buildWithdrawCollateralAndRedeemIx,
  reserveLiqSupply,
} from "./klend";

export type MarginAsset = "SOL" | "wSOL" | "csSOL";

export interface OpenCreditTradeArgs {
  user: PublicKey;
  /** Amount of `marginAsset` the user contributes (lamport-units). */
  marginAmount: bigint;
  /** Asset the user is contributing as margin. SOL is auto-wrapped. */
  marginAsset: MarginAsset;
  /** Flash-loaned wSOL amount = the resulting wSOL debt = the leverage. */
  loanAmount: bigint;
  /** Live Jito vault state — needed for the wrap CPI. */
  vaultState: VaultState;
  /** Existing obligation deposit reserves (for refresh + borrow remaining_accounts).
   *  Empty array on first-time open. */
  obligationDepositReserves: PublicKey[];
  /** Independent init flags — split because user_metadata and the
   *  obligation are separate accounts and one can exist without the
   *  other (e.g. user did a wrap-only earlier, which created the
   *  user_metadata, but never opened a klend position). */
  needsInitUserMetadata: boolean;
  needsInitObligation: boolean;
  /** True when the user wants the wSOL ATA closed at the end (so any
   *  leftover wSOL + ATA rent return as native SOL). */
  closeWsolAtaAtEnd?: boolean;
}

/** Build the ix list for opening a leveraged credit trade in a single tx. */
export async function buildOpenCreditTradeIxes(args: OpenCreditTradeArgs): Promise<{
  ixes: TransactionInstruction[];
  notes: { borrowInstructionIndex: number; expectedCsSolDeposit: bigint };
}> {
  const { user, marginAmount, marginAsset, loanAmount, vaultState } = args;
  const userCsSol = getAssociatedTokenAddressSync(CSSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsol  = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt   = getAssociatedTokenAddressSync(vaultState.vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const feeVrt    = getAssociatedTokenAddressSync(vaultState.vrtMint, vaultState.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const wsolReserveLiqSupply = reserveLiqSupply(WSOL_RESERVE);

  // The Jito wrap consumes wSOL from the user's wSOL ATA. After the
  // flash-borrow lands `loan` wSOL there, we add the margin-in-wSOL
  // (if the user picked SOL or wSOL) so the wrap consumes
  // `loan + margin`. csSOL margin path: user already holds csSOL —
  // wrap only consumes `loan`, and the deposit ix takes
  // `loan + margin_csSOL` from the ATA after the wrap mints `loan`
  // more csSOL into it.
  const wrapAmount = marginAsset === "csSOL" ? loanAmount : (loanAmount + marginAmount);
  const expectedCsSolDeposit = marginAsset === "csSOL" ? (loanAmount + marginAmount) : (loanAmount + marginAmount);

  const ixes: TransactionInstruction[] = [
    // High CU budget — the open path runs ~14 ixes including a Jito CPI.
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    // Explicit priority-fee ix so wallet adapters (notably Phantom)
    // don't auto-prepend their own compute-unit-price ix at slot 0.
    // Without this we'd see a runtime ix-shift (+1) that breaks
    // flash_repay's borrowInstructionIndex check (klend's
    // load_current_index_checked returns the post-prepend slot).
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
  ];

  if (args.needsInitUserMetadata) ixes.push(await buildInitUserMetadataIx(user, user));
  if (args.needsInitObligation)   ixes.push(await buildInitObligationIx(user, user));

  // ATAs (idempotent — cheap to include unconditionally).
  ixes.push(
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSol, user, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userVrt, user, vaultState.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, feeVrt, vaultState.feeWallet, vaultState.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  );

  // Flash-borrow `loan` wSOL into user's wSOL ATA. Position in the
  // tx (post-CB + init + ATAs) is what flash_repay needs to reference.
  const borrowInstructionIndex = ixes.length;
  ixes.push(await buildFlashBorrowIx({
    user, reserve: WSOL_RESERVE, liquidityMint: NATIVE_MINT,
    reserveSourceLiquidity: wsolReserveLiqSupply,
    userDestinationLiquidity: userWsol,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    amount: loanAmount,
  }));

  // Pre-wrap the margin into the wSOL ATA when the user contributes
  // SOL / wSOL. csSOL margin: user already holds csSOL; the deposit
  // step pulls the combined balance.
  if (marginAsset === "SOL") {
    ixes.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: Number(marginAmount) }));
    ixes.push(createSyncNativeInstruction(userWsol));
  } else if (marginAsset === "wSOL") {
    // Already in user's wSOL ATA — no transfer needed. (Make sure the
    // ATA actually has `marginAmount` before this — pre-flight check
    // is the caller's job.)
  }

  // Wrap into csSOL via Jito vault — consumes wSOL from user's wSOL
  // ATA, mints csSOL into user's csSOL ATA, sweeps VRT → pool vault.
  const [jitoConfig] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
  );
  ixes.push(await buildWrapWithJitoVaultIx({
    user,
    amount: wrapAmount,
    vrtMint: vaultState.vrtMint,
    feeWallet: vaultState.feeWallet,
    jitoVaultConfig: jitoConfig,
    vaultStTokenAccount: CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  }));

  // Refresh chain for the deposit. klend's `check_refresh`
  // (utils/refresh_ix_utils.rs:115) asserts the refresh_reserve at
  // position N-2 BEFORE the deposit ix targets the deposit's
  // collateral reserve — putting any other refresh_reserve last
  // trips RequireKeysEqViolated (2502). So queue all the OTHER
  // refreshes first, with csSOL last.
  const allRefs = new Set<string>();
  const otherRefs: { reserve: PublicKey; oracle: PublicKey }[] = [
    { reserve: WSOL_RESERVE, oracle: WSOL_RESERVE_ORACLE },
    ...args.obligationDepositReserves
      .filter((r) => !r.equals(CSSOL_RESERVE) && !r.equals(WSOL_RESERVE))
      .map((r) => ({ reserve: r, oracle: CSSOL_RESERVE_ORACLE })),
  ];
  for (const r of otherRefs) {
    if (allRefs.has(r.reserve.toBase58())) continue;
    allRefs.add(r.reserve.toBase58());
    ixes.push(await buildRefreshReserveIx(r.reserve, r.oracle));
  }
  // csSOL refresh LAST → lands at N-2 of the deposit ix (with
  // refresh_obligation at N-1). check_refresh accepts.
  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  // refresh_obligation's remaining_accounts must EXACTLY match the
  // obligation's current deposit/borrow reserve set (klend asserts
  // `expected_remaining_accounts == actual` at line 33). Pre-deposit:
  // pass only the obligation's existing deposits (empty for a fresh
  // obligation). Post-deposit: include csSOL (which is now in deposits).
  const preDepositReserves = args.obligationDepositReserves;
  const postDepositReserves = preDepositReserves.some((r) => r.equals(CSSOL_RESERVE))
    ? preDepositReserves
    : [CSSOL_RESERVE, ...preDepositReserves];
  ixes.push(await buildRefreshObligationIx(user, preDepositReserves));

  // Deposit csSOL as collateral.
  ixes.push(await buildDepositCsSolIx(user, expectedCsSolDeposit));

  // Re-refresh chain for the borrow:
  //   1. csSOL (deposit invalidated its last_update; refresh_obligation
  //      iterates all deposit reserves and rejects stale ones).
  //   2. wSOL last → lands at N-2 of the borrow ix; check_refresh
  //      asserts it matches the borrow target.
  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(WSOL_RESERVE,  WSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, postDepositReserves));

  // Move the obligation into eMode 2 (LST/SOL) BEFORE borrowing.
  // csSOL has `disable_usage_as_coll_outside_emode = 1`, so without
  // an active elevation group the borrow fails with
  // `BorrowingDisabledOutsideElevationGroup (6091)`.
  // remaining_accounts must match the obligation's CURRENT state —
  // post-deposit there's 1 deposit (csSOL) and 0 borrows. Passing
  // wSOL here trips InvalidAccountInput (6006).
  ixes.push(await buildRequestElevationGroupIx(
    user,
    ELEVATION_GROUP_LST_SOL,
    postDepositReserves,
    [],
  ));

  // Re-refresh after the eMode switch — request_elevation_group
  // mutates obligation state and klend's borrow check_refresh wants
  // a fresh obligation+wSOL pair at N-1/N-2.
  ixes.push(await buildRefreshReserveIx(WSOL_RESERVE, WSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, postDepositReserves));

  // Borrow `loan` wSOL — into the user's wSOL ATA, where it sits ready
  // for the flash-repay leg.
  ixes.push(await buildBorrowObligationLiquidityIx({
    user, borrowReserve: WSOL_RESERVE,
    liquidityMint: NATIVE_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
    userDestinationLiquidity: userWsol,
    amount: loanAmount,
    obligationDepositReserves: postDepositReserves,
  }));

  // Flash-repay — must reference the borrow ix's position. Fee = 0
  // (configured in the reserve), so we repay exactly `loan`.
  ixes.push(await buildFlashRepayIx({
    user, reserve: WSOL_RESERVE, liquidityMint: NATIVE_MINT,
    reserveDestinationLiquidity: wsolReserveLiqSupply,
    userSourceLiquidity: userWsol,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    amount: loanAmount,
    borrowInstructionIndex,
  }));

  if (args.closeWsolAtaAtEnd) {
    ixes.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID));
  }

  return { ixes, notes: { borrowInstructionIndex, expectedCsSolDeposit } };
}

// ─── Close — Step 1 (Convert) ────────────────────────────────────────

export interface ConvertStep1Args {
  user: PublicKey;
  /** Amount of csSOL to convert into csSOL-WT (raw lamport-units).
   *  Typically the user's full csSOL collateral. */
  amount: bigint;
  /** Live Jito vault state (for VRT mint + fee wallet). */
  vaultState: VaultState;
  /** WithdrawQueue's `total_cssol_wt_minted` counter — used as a nonce
   *  to derive the per-enqueue `base` PDA. Read once just before
   *  building this tx. */
  queueTotalMinted: bigint;
  /** Obligation's current deposit reserves (so refresh_obligation
   *  remaining_accounts matches klend's expected count). */
  preDepositReserves: PublicKey[];
}

/** Build the Convert (Step 1) ix list — flash-loan-assisted swap of
 *  csSOL collateral → csSOL-WT collateral via the Jito-vault unstake
 *  enqueue. Mirrors the Unwind tab's `leveragedUnwind` but parameterized
 *  for any market via the addresses.ts constants. */
export async function buildCloseStep1ConvertIxes(args: ConvertStep1Args): Promise<{
  ixes: TransactionInstruction[];
  notes: { borrowInstructionIndex: number };
}> {
  if (!CSSOL_WT_MINT || !CSSOL_WT_RESERVE) {
    throw new Error("csSOL-WT mint/reserve not configured — set VITE_CSSOL_WT_MINT + VITE_CSSOL_WT_RESERVE");
  }
  const wtMint = CSSOL_WT_MINT;       // narrow once for TS
  const wtReserve = CSSOL_WT_RESERVE;
  const { user, amount, vaultState, queueTotalMinted, preDepositReserves } = args;

  // Per-enqueue base PDA — used to derive the Jito withdrawal ticket.
  const basePubkey = withdrawBasePda(queueTotalMinted);
  const [vaultStakerWithdrawalTicket] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("vault_staker_withdrawal_ticket"),
      CSSOL_VAULT.toBuffer(), basePubkey.toBuffer(),
    ],
    JITO_VAULT_PROGRAM,
  );
  const ticketVrtAta = getAssociatedTokenAddressSync(
    CSSOL_VRT_MINT, vaultStakerWithdrawalTicket, true,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userCsSol   = getAssociatedTokenAddressSync(CSSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCsSolWt = getAssociatedTokenAddressSync(wtMint, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt     = getAssociatedTokenAddressSync(CSSOL_VRT_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const wtLiqSupply = reserveLiqSupply(wtReserve);
  const [jitoConfig] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
  );

  // postDepositReserves — what the obligation will hold after the
  // deposit ix below. csSOL-WT added if not already present.
  const postDepositReserves = preDepositReserves.some((r) => r.equals(wtReserve))
    ? preDepositReserves
    : [...preDepositReserves, wtReserve];
  // After the withdraw, csSOL stays in the obligation (partial) or is
  // gone (full). For full-withdraw semantics we mirror leveragedUnwind
  // which keeps csSOL in the list (cToken→liq exchange-rate slack).
  const remainingAfterWithdraw = postDepositReserves;

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSol,   user, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSolWt, user, wtMint,     TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userVrt,     user, CSSOL_VRT_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, ticketVrtAta, vaultStakerWithdrawalTicket, CSSOL_VRT_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  ];

  // Flash-borrow csSOL-WT — parked in user's WT ATA, used as the
  // collateral that briefly replaces csSOL while we extract csSOL
  // and enqueue it for unstake.
  const borrowInstructionIndex = ixes.length;
  ixes.push(await buildFlashBorrowIx({
    user, reserve: wtReserve, liquidityMint: wtMint,
    reserveSourceLiquidity: wtLiqSupply, userDestinationLiquidity: userCsSolWt,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID, amount,
  }));

  // Refresh chain for WT deposit. csSOL refresh first (so refresh_obligation
  // doesn't see it stale), then WT (lands at N-2 of deposit).
  for (const r of preDepositReserves) {
    if (!r.equals(CSSOL_RESERVE) && !r.equals(wtReserve)) {
      ixes.push(await buildRefreshReserveIx(r, CSSOL_RESERVE_ORACLE));
    }
  }
  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(wtReserve,     CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, preDepositReserves));

  // Deposit csSOL-WT into obligation.
  ixes.push(await buildDepositLiquidityAndCollateralIx({
    user, reserve: wtReserve,
    liquidityMint: wtMint, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userSourceLiquidity: userCsSolWt, amount,
  }));

  // Re-refresh WT (deposit invalidated it), then csSOL at N-2 of withdraw.
  ixes.push(await buildRefreshReserveIx(wtReserve,     CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, postDepositReserves));

  // Withdraw csSOL collateral into user's csSOL ATA.
  ixes.push(await buildWithdrawCollateralAndRedeemIx({
    user, reserve: CSSOL_RESERVE,
    liquidityMint: CSSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCsSol,
    collateralAmount: amount,
    refreshObligationDeposits: remainingAfterWithdraw,
  }));

  // Burn the just-withdrawn csSOL via governor's enqueue ix; mints
  // fresh csSOL-WT into user's WT ATA (which they now use to repay
  // the flash). Jito vault enqueues the underlying VRT unstake.
  ixes.push(await buildEnqueueWithdrawViaPoolIx({
    user, base: basePubkey, amount,
    cssolWtMint: wtMint, vrtMint: CSSOL_VRT_MINT,
    vaultStakerWithdrawalTicket, vaultStakerWithdrawalTicketTokenAccount: ticketVrtAta,
    jitoVaultConfig: jitoConfig,
  }));

  // Flash-repay csSOL-WT (fee = 0 in our reserve config).
  ixes.push(await buildFlashRepayIx({
    user, reserve: wtReserve, liquidityMint: wtMint,
    reserveDestinationLiquidity: wtLiqSupply, userSourceLiquidity: userCsSolWt,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    amount, borrowInstructionIndex,
  }));

  return { ixes, notes: { borrowInstructionIndex } };
}

// ─── Close — Step 2 (Unwind) ─────────────────────────────────────────

export interface UnwindStep2Args {
  user: PublicKey;
  /** Amount of wSOL debt to repay (raw lamport-units). For 100% close,
   *  pass the full debt; for partial, pass `pct × debt`. */
  repayAmount: bigint;
  /** Amount of csSOL-WT collateral to withdraw + redeem (raw units).
   *  Match `repayAmount` 1:1 for clean close (csSOL-WT ≈ wSOL). */
  redeemAmount: bigint;
  /** Obligation's current deposit reserves. */
  obligationDepositReserves: PublicKey[];
  /** Set true when this call closes 100% of the position — adds a
   *  closeAccount on the user's wSOL ATA so the surplus + ATA rent
   *  return as native SOL. */
  closeWsolAtaAtEnd?: boolean;
}

/** Build the Unwind (Step 2) ix list — flash-loan-assisted close of
 *  the matured WT position. Repays wSOL debt with flash, withdraws
 *  csSOL-WT collateral, redeems WT → wSOL via governor, repays the
 *  flash. Surplus (collateral_amount − debt_amount) lands in the
 *  user's wSOL ATA as their margin returning. */
export async function buildCloseStep2UnwindIxes(args: UnwindStep2Args): Promise<{
  ixes: TransactionInstruction[];
  notes: { borrowInstructionIndex: number };
}> {
  if (!CSSOL_WT_MINT || !CSSOL_WT_RESERVE || !POOL_PENDING_WSOL_ACCOUNT) {
    throw new Error("csSOL-WT mint/reserve or POOL_PENDING_WSOL_ACCOUNT not configured");
  }
  const wtMint = CSSOL_WT_MINT;
  const wtReserve = CSSOL_WT_RESERVE;
  const poolPendingWsol = POOL_PENDING_WSOL_ACCOUNT;
  const { user, repayAmount, redeemAmount, obligationDepositReserves } = args;

  const userWsol    = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCsSolWt = getAssociatedTokenAddressSync(wtMint, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const wsolReserveLiqSupply = reserveLiqSupply(WSOL_RESERVE);

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSolWt, user, wtMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  ];

  // Flash-borrow wSOL — parked in user's wSOL ATA so the immediate
  // repay_obligation_liquidity has the funds.
  const borrowInstructionIndex = ixes.length;
  ixes.push(await buildFlashBorrowIx({
    user, reserve: WSOL_RESERVE, liquidityMint: NATIVE_MINT,
    reserveSourceLiquidity: wsolReserveLiqSupply,
    userDestinationLiquidity: userWsol,
    liquidityTokenProgram: TOKEN_PROGRAM_ID, amount: repayAmount,
  }));

  // Refresh chain for the repay. wSOL last → N-2 of repay's check_refresh.
  for (const r of obligationDepositReserves) {
    if (!r.equals(CSSOL_RESERVE) && !r.equals(wtReserve)) {
      ixes.push(await buildRefreshReserveIx(r, CSSOL_RESERVE_ORACLE));
    }
  }
  ixes.push(await buildRefreshReserveIx(wtReserve,     CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(WSOL_RESERVE,  WSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, obligationDepositReserves));

  // Repay (partial or full) wSOL debt.
  ixes.push(await buildRepayObligationLiquidityIx({
    user, repayReserve: WSOL_RESERVE,
    liquidityMint: NATIVE_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
    userSourceLiquidity: userWsol, amount: repayAmount,
  }));

  // Refresh chain for the WT withdraw. wSOL invalidated by the repay,
  // WT lands at N-2.
  ixes.push(await buildRefreshReserveIx(WSOL_RESERVE, WSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(wtReserve,    CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, obligationDepositReserves));

  // Withdraw the matched amount of csSOL-WT collateral into user's
  // WT ATA. obligationDepositReserves stays unchanged for partial
  // withdraw (WT remains in deposits).
  ixes.push(await buildWithdrawCollateralAndRedeemIx({
    user, reserve: wtReserve,
    liquidityMint: wtMint, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCsSolWt,
    collateralAmount: redeemAmount,
    refreshObligationDeposits: obligationDepositReserves,
  }));

  // Burn the WT via governor; transfers wSOL pool → user's wSOL ATA
  // (which now holds enough wSOL to flash-repay).
  ixes.push(await buildRedeemCsSolWtIx({
    user, amount: redeemAmount, cssolWtMint: wtMint,
    poolPendingWsolAccount: poolPendingWsol,
  }));

  // Flash-repay wSOL.
  ixes.push(await buildFlashRepayIx({
    user, reserve: WSOL_RESERVE, liquidityMint: NATIVE_MINT,
    reserveDestinationLiquidity: wsolReserveLiqSupply,
    userSourceLiquidity: userWsol,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    amount: repayAmount, borrowInstructionIndex,
  }));

  // 100% close: any wSOL surplus + ATA rent flow back as native SOL.
  if (args.closeWsolAtaAtEnd) {
    ixes.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID));
  }

  return { ixes, notes: { borrowInstructionIndex } };
}

// ─── Quote helpers ───────────────────────────────────────────────────

export interface QuoteCreditTradeArgs {
  marginAsset: MarginAsset;
  marginAmount: number;     // human units (SOL / wSOL / csSOL — all 9-decimals)
  loanAmount: number;       // human units (wSOL = SOL terms)
  csSolPriceUsd: number;    // from the accrual oracle
  wsolPriceUsd: number;     // from Pyth
  /** Existing obligation collateral/debt in human units (csSOL / wSOL). */
  existing?: { csSolCollateral: number; wsolDebt: number };
  /** Effective LTV cap when the obligation is in eMode 2 (default 90%). */
  emodeLtvPct?: number;
  /** Effective liquidation threshold in eMode 2 (default 92%). */
  emodeLiqThresholdPct?: number;
}

export interface QuoteCreditTrade {
  collateralCsSol: number;
  collateralUsd: number;
  debtWsol: number;
  debtUsd: number;
  /** debt / equity (where equity = collateral − debt). */
  leverage: number;
  /** liq_threshold × collateral_value / debt_value, ∞ when no debt. */
  health: number;
  /** liquidation csSOL price in USD (assuming wSOL = 1 SOL stable). */
  liquidationCsSolPriceUsd: number;
  /** Max additional `loanAmount` for the chosen margin at the eMode LTV cap. */
  maxLoanAmount: number;
  ltvAfterPct: number;
  warnings: string[];
}

/** Pure-math quote — no RPC. Drives the calculator card. */
export function quoteCreditTrade(args: QuoteCreditTradeArgs): QuoteCreditTrade {
  const ltv = (args.emodeLtvPct ?? 90) / 100;
  const liq = (args.emodeLiqThresholdPct ?? 92) / 100;

  // csSOL/wSOL exchange ratio. csSOL price = SOL price × accrual_index;
  // for a fresh deployment accrual_index ≈ 1 so csSOL ≈ SOL. The flash
  // path wraps `wrapAmount` of wSOL into the same number of csSOL
  // units (Jito vault accrual handled at vault layer; minimal slippage
  // for the calculator).
  const newCsSolFromLoan = args.loanAmount;
  const marginInCsSol = args.marginAsset === "csSOL" ? args.marginAmount : args.marginAmount;
  const collateralCsSol = (args.existing?.csSolCollateral ?? 0) + newCsSolFromLoan + marginInCsSol;
  const debtWsol = (args.existing?.wsolDebt ?? 0) + args.loanAmount;

  const collateralUsd = collateralCsSol * args.csSolPriceUsd;
  const debtUsd = debtWsol * args.wsolPriceUsd;

  const equityUsd = Math.max(collateralUsd - debtUsd, 0);
  const leverage = equityUsd > 0 ? debtUsd / equityUsd : 0;
  const ltvAfterPct = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;
  const health = debtUsd > 0 ? (collateralUsd * liq) / debtUsd : Infinity;
  // Liquidation when collateral_value × liq = debt_value →
  // csSOL_price = debt_usd / (collateralCsSol × liq).
  const liquidationCsSolPriceUsd = collateralCsSol > 0 ? debtUsd / (collateralCsSol * liq) : 0;

  // Max-loan: `marginUsd` × ltv / (1 − ltv) at the cap, in wSOL units.
  // Subtract any existing-position headroom too.
  const marginUsd = args.marginAmount * (args.marginAsset === "csSOL" ? args.csSolPriceUsd : args.wsolPriceUsd);
  const existingEquityUsd = ((args.existing?.csSolCollateral ?? 0) * args.csSolPriceUsd) - ((args.existing?.wsolDebt ?? 0) * args.wsolPriceUsd);
  const totalCapacityUsd = (marginUsd + Math.max(existingEquityUsd, 0)) * ltv / (1 - ltv);
  const remainingCapacityUsd = Math.max(totalCapacityUsd - ((args.existing?.wsolDebt ?? 0) * args.wsolPriceUsd), 0);
  const maxLoanAmount = remainingCapacityUsd / args.wsolPriceUsd;

  const warnings: string[] = [];
  if (ltvAfterPct >= ltv * 100) warnings.push(`LTV after open (${ltvAfterPct.toFixed(2)}%) exceeds the eMode cap (${(ltv * 100).toFixed(0)}%) — borrow will fail.`);
  else if (ltvAfterPct >= ltv * 95) warnings.push(`LTV after open (${ltvAfterPct.toFixed(2)}%) is within 5% of the cap — small price drops will trigger liquidation.`);
  if (health < 1.1 && Number.isFinite(health)) warnings.push(`Health factor ${health.toFixed(2)} is dangerously close to 1.0.`);

  return {
    collateralCsSol,
    collateralUsd,
    debtWsol,
    debtUsd,
    leverage,
    health,
    liquidationCsSolPriceUsd,
    maxLoanAmount,
    ltvAfterPct,
    warnings,
  };
}
