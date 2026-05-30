/**
 * creditTrade.ts — Pure ix builders + quote helpers for the
 * single-tx leveraged credit-trade flow on the v3 csSOL market.
 * Verbatim port from `frontend-playground/src/lib/creditTrade.ts`.
 *
 * Three load-bearing invariants — DO NOT refactor without re-validating:
 *   1. klend `check_refresh` ordering: refresh_reserve at N-2 of action ix.
 *   2. `borrowInstructionIndex` captured at `ixes.length` BEFORE pushing the
 *      flash-borrow ix, with `setComputeUnitPrice` at slot 1 to absorb
 *      Phantom's auto-prepended compute-budget ix without shift.
 *   3. `request_elevation_group.remaining_accounts` must reflect the
 *      obligation's CURRENT state (post-deposit, pre-borrow). Passing the
 *      post-borrow set trips `InvalidAccountInput (6006)`.
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
  CSOL_MINT,
  CSOL_RESERVE,
  CSOL_RESERVE_ORACLE,
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
import { buildUnwrapNativeIx, buildWrapNativeIx } from "./csolWrap";
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
} from "./klendIx";

// ────────────────────────────────────────────────────────────────────
// csSOL accrual-oracle inline crank — REQUIRED for any tx that runs
// klend `refresh_obligation` over an obligation containing csSOL-WT
// collateral. The cleanest invariant is:
//
//   *Every klend tx that touches a WT-bearing obligation MUST include
//   `buildAccrualOracleRefreshIx()` BEFORE its first `refresh_reserve`
//   ix, and MUST also include `refresh_reserve(wtReserve, …)` before
//   the first `refresh_obligation` (or rely on the
//   refresh-all-unconditionally pattern in buildCloseStep2UnwindIxes).*
//
// Rationale: klend's `refresh_reserve(WT)` no-ops (returns Ok without
// bumping `reserve.last_update.slot`) if the underlying accrual oracle
// output's `posted_slot < current_slot`. In steady-state the
// keeper-cloud Worker (5-min cron in packages/keeper-cloud) keeps the
// oracle fresh, but inside a long convert/unwind tx the slot has
// usually advanced past the keeper's last fire — so without an inline
// crank, the WT refresh is a silent no-op and the next
// `refresh_obligation` reverts with `ReserveStale (6009)`.
//
// Why "no shared util in klendIx.ts": the constants here are
// csSOL-specific. When/if a separate WT-priced oracle is deployed
// (see packages/programs/configs/devnet/cssol-wt-oracle.json — TODO),
// this builder will need a dedicated WT crank too. Keeping the
// addresses local to creditTrade.ts makes that follow-up grep-able.
//
// The crank is permissionless. Accounts (3) + program ID are pinned
// to match packages/programs/configs/devnet/cssol-oracle.json + the
// keeper-cloud Worker's wiring.
// ────────────────────────────────────────────────────────────────────
const ACCRUAL_ORACLE_PROGRAM = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");
const ACCRUAL_ORACLE_CONFIG  = new PublicKey("6ZhhrkGkN91zz6qPu4n3YmyMCFA7hoPYpj5jtzvkF1JM");
const ACCRUAL_ORACLE_SOURCE  = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"); // Pyth-sponsored SOL/USD
const ACCRUAL_ORACLE_OUTPUT  = CSSOL_RESERVE_ORACLE; // 3Sx8WJC7…Pw3P

// Anchor sentence-case discriminator for `accrual_oracle::refresh`,
// pre-computed (sha256("global:refresh")[0..8] = aa9b16fe93b531a1).
const DISC_ACCRUAL_REFRESH = Buffer.from([0xaa, 0x9b, 0x16, 0xfe, 0x93, 0xb5, 0x31, 0xa1]);

/** Inline crank of the csSOL accrual oracle. See block comment above
 *  for the full invariant — required at the top of any tx that runs
 *  `refresh_obligation` over a WT-bearing obligation. */
export function buildAccrualOracleRefreshIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: ACCRUAL_ORACLE_PROGRAM,
    keys: [
      { pubkey: ACCRUAL_ORACLE_CONFIG, isSigner: false, isWritable: false },
      { pubkey: ACCRUAL_ORACLE_SOURCE, isSigner: false, isWritable: false },
      { pubkey: ACCRUAL_ORACLE_OUTPUT, isSigner: false, isWritable: true  },
    ],
    data: DISC_ACCRUAL_REFRESH,
  });
}

// ────────────────────────────────────────────────────────────────────
// WT-specific accrual oracle (vault-backed). Optional, env-var-gated.
//
// Once `setup-cssol-wt-oracle.ts` has been run on devnet AND the
// migration script has flipped the WT reserve to point at the new
// output, set these three env vars in
// `packages/frontend-institutional/.env.local`:
//
//   VITE_WT_ACCRUAL_CONFIG=<accrualConfig from cssol-wt-oracle.json>
//   VITE_WT_ACCRUAL_OUTPUT=<accrualOutput from cssol-wt-oracle.json>
//   VITE_WT_BOUND_VAULT=EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W
//
// The convert/unwind builders will then automatically inline a second
// `refresh_with_vault` ix that cranks the WT-specific oracle, so the
// downstream `refresh_reserve(WT)` works against an oracle that
// matches the WT reserve's pyth_configuration.price.
//
// If any of the three env vars are missing this is a no-op — the
// builder uses only the csSOL crank, which is correct for the
// current state where WT shares the csSOL oracle.
// ────────────────────────────────────────────────────────────────────

const WT_ACCRUAL_CONFIG = (import.meta as any).env?.VITE_WT_ACCRUAL_CONFIG as string | undefined;
const WT_ACCRUAL_OUTPUT = (import.meta as any).env?.VITE_WT_ACCRUAL_OUTPUT as string | undefined;
const WT_BOUND_VAULT    = (import.meta as any).env?.VITE_WT_BOUND_VAULT as string | undefined;

// Anchor sentence-case discriminator for `accrual_oracle::refresh_with_vault`,
// pre-computed (sha256("global:refresh_with_vault")[0..8]).
// Verified against the deployed program at 8GjxQk… by recomputing
// from the on-chain IDL — the previous literal was a placeholder and
// caused InstructionFallbackNotFound (0x65 / 101) on every convert/
// unwind that ran with VITE_WT_ACCRUAL_* env vars set.
const DISC_REFRESH_WITH_VAULT = Buffer.from([0xa5, 0xd0, 0x85, 0xfa, 0x8b, 0x52, 0xf8, 0x48]);

/** Returns the WT-specific crank ix when the env vars are set, else
 *  null. Builders should append `?? buildAccrualOracleRefreshIx()` and
 *  spread into the ix list — but the simpler pattern is to push only
 *  if non-null and rely on the csSOL crank to keep the shared-oracle
 *  state working through the migration. */
export function buildWtAccrualOracleRefreshIx(): TransactionInstruction | null {
  if (!WT_ACCRUAL_CONFIG || !WT_ACCRUAL_OUTPUT || !WT_BOUND_VAULT) return null;
  return new TransactionInstruction({
    programId: ACCRUAL_ORACLE_PROGRAM,
    keys: [
      { pubkey: new PublicKey(WT_ACCRUAL_CONFIG), isSigner: false, isWritable: false },
      { pubkey: ACCRUAL_ORACLE_SOURCE,            isSigner: false, isWritable: false },
      { pubkey: new PublicKey(WT_BOUND_VAULT),    isSigner: false, isWritable: false },
      { pubkey: new PublicKey(WT_ACCRUAL_OUTPUT), isSigner: false, isWritable: true  },
    ],
    data: DISC_REFRESH_WITH_VAULT,
  });
}

export type MarginAsset = "SOL" | "wSOL" | "csSOL";

export interface OpenCreditTradeArgs {
  user: PublicKey;
  marginAmount: bigint;
  marginAsset: MarginAsset;
  loanAmount: bigint;
  vaultState: VaultState;
  obligationDepositReserves: PublicKey[];
  /** Existing borrow reserves on the obligation. klend's
   *  `refresh_obligation` validates `expected_remaining_accounts ==
   *  deposits + borrows`; passing only deposits trips
   *  `InvalidAccountInput (6006)` for any obligation that already has
   *  open debt (the increase-position path). Empty array on first open. */
  obligationBorrowReserves?: PublicKey[];
  /** Obligation's current elevation group on-chain. When this already
   *  equals the target (EG-2), we skip `request_elevation_group` —
   *  re-issuing it trips `ElevationGroupAlreadyActivated (6083)`.
   *  Default 0 = no group (first open). */
  currentElevationGroup?: number;
  needsInitUserMetadata: boolean;
  needsInitObligation: boolean;
  closeWsolAtaAtEnd?: boolean;
  /** Klend obligation seed-id (0..255). Defaults to 0. Pass a non-zero
   *  value to target a sibling obligation so the user can run multiple
   *  parallel credit-trade positions on the same wallet (e.g. two
   *  separate EG-2 trades, or an EG-2 + EG-1 split). */
  obligationId?: number;
}

export async function buildOpenCreditTradeIxes(args: OpenCreditTradeArgs): Promise<{
  ixes: TransactionInstruction[];
  notes: { borrowInstructionIndex: number; expectedCsSolDeposit: bigint };
}> {
  const { user, marginAmount, marginAsset, loanAmount, vaultState } = args;
  const obId = args.obligationId ?? 0;
  const userCsSol = getAssociatedTokenAddressSync(CSSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsol  = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  // cSOL is the EG-2 debt asset post-2026-05-06 migration. We
  // flash-borrow cSOL, unwrap to wSOL inline so the Jito vault can
  // consume it, then borrow + flash-repay cSOL to close the loop.
  const userCsol  = getAssociatedTokenAddressSync(CSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt   = getAssociatedTokenAddressSync(vaultState.vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const feeVrt    = getAssociatedTokenAddressSync(vaultState.vrtMint, vaultState.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const csolReserveLiqSupply = reserveLiqSupply(CSOL_RESERVE);

  const wrapAmount = marginAsset === "csSOL" ? loanAmount : (loanAmount + marginAmount);
  const expectedCsSolDeposit = loanAmount + marginAmount;

  const ixes: TransactionInstruction[] = [
    // Bundle gained 1 governor.unwrap_native CPI vs the wSOL-era flow,
    // pushing CU usage from ~1.05M to ~1.15M. 1.4M still has headroom.
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
  ];

  if (args.needsInitUserMetadata) ixes.push(await buildInitUserMetadataIx(user, user));
  if (args.needsInitObligation)   ixes.push(await buildInitObligationIx(user, user, 0, obId));

  ixes.push(
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSol, user, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    // cSOL ATA — destination for flash-borrow, source for flash-repay.
    // Token-2022 because cSOL is a delta-mint Token-2022 wrapper.
    createAssociatedTokenAccountIdempotentInstruction(user, userCsol, user, CSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userVrt, user, vaultState.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, feeVrt, vaultState.feeWallet, vaultState.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  );

  const borrowInstructionIndex = ixes.length;
  // 1. flash_borrow(cSOL, loan) — cSOL lands in user's cSOL ATA.
  ixes.push(await buildFlashBorrowIx({
    user, reserve: CSOL_RESERVE, liquidityMint: CSOL_MINT,
    reserveSourceLiquidity: csolReserveLiqSupply,
    userDestinationLiquidity: userCsol,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    amount: loanAmount,
  }));

  // 2. unwrap_native(loan) — burns user's cSOL, sends pool's wSOL to
  //    user's wSOL ATA. Unconditional (no whitelist check on burn) so
  //    works even for first-tx wallets that haven't run KycGate yet —
  //    though the bundle's later wrap_with_jito_vault step itself
  //    requires whitelist on the csSOL pool, so KycGate is still de
  //    facto required for the open path.
  ixes.push(buildUnwrapNativeIx({
    user, amount: loanAmount,
    userUnderlyingAta: userWsol,
    userWrappedAta: userCsol,
    underlyingTokenProgram: TOKEN_PROGRAM_ID,
    wrappedTokenProgram: TOKEN_2022_PROGRAM_ID,
    underlyingMint: NATIVE_MINT,
  }));

  if (marginAsset === "SOL") {
    ixes.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: Number(marginAmount) }));
    ixes.push(createSyncNativeInstruction(userWsol));
  }

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

  const allRefs = new Set<string>();
  const otherRefs: { reserve: PublicKey; oracle: PublicKey }[] = [
    { reserve: CSOL_RESERVE, oracle: CSOL_RESERVE_ORACLE },
    ...args.obligationDepositReserves
      .filter((r) => !r.equals(CSSOL_RESERVE) && !r.equals(CSOL_RESERVE))
      .map((r) => ({ reserve: r, oracle: CSSOL_RESERVE_ORACLE })),
  ];
  for (const r of otherRefs) {
    if (allRefs.has(r.reserve.toBase58())) continue;
    allRefs.add(r.reserve.toBase58());
    ixes.push(await buildRefreshReserveIx(r.reserve, r.oracle));
  }
  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  const preDepositReserves = args.obligationDepositReserves;
  const preBorrowReserves = args.obligationBorrowReserves ?? [];
  const postDepositReserves = preDepositReserves.some((r) => r.equals(CSSOL_RESERVE))
    ? preDepositReserves
    : [CSSOL_RESERVE, ...preDepositReserves];
  // Post-borrow, the obligation's borrow set always contains cSOL (we
  // either had it already on increase, or are adding it on first open).
  const postBorrowReserves = preBorrowReserves.some((r) => r.equals(CSOL_RESERVE))
    ? preBorrowReserves
    : [...preBorrowReserves, CSOL_RESERVE];
  // Refresh any existing borrow reserves that aren't already covered by
  // the deposit refreshes above — klend's refresh_obligation rejects
  // any stale reserve referenced by the obligation.
  for (const r of preBorrowReserves) {
    if (!r.equals(CSOL_RESERVE) && !r.equals(CSSOL_RESERVE)
        && !preDepositReserves.some((d) => d.equals(r))) {
      ixes.push(await buildRefreshReserveIx(r, CSOL_RESERVE_ORACLE));
    }
  }
  ixes.push(await buildRefreshObligationIx(user, preDepositReserves, preBorrowReserves, obId));

  ixes.push(await buildDepositCsSolIx(user, expectedCsSolDeposit, obId));

  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(CSOL_RESERVE,  CSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, postDepositReserves, preBorrowReserves, obId));

  // Move the obligation into eMode 2 (LST/SOL) BEFORE borrowing — but
  // only when not already there. Re-issuing request_elevation_group
  // for the same group trips ElevationGroupAlreadyActivated (6083).
  // remaining_accounts = obligation's CURRENT state (post-deposit, pre-borrow) — see invariant 3 in the file header.
  if ((args.currentElevationGroup ?? 0) !== ELEVATION_GROUP_LST_SOL) {
    ixes.push(await buildRequestElevationGroupIx(
      user,
      ELEVATION_GROUP_LST_SOL,
      postDepositReserves,
      preBorrowReserves,
      obId,
    ));

    ixes.push(await buildRefreshReserveIx(CSOL_RESERVE, CSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshObligationIx(user, postDepositReserves, preBorrowReserves, obId));
  }

  // Borrow cSOL — proceeds repay the flash. No further conversion
  // needed: cSOL stays cSOL through the close of the bundle.
  ixes.push(await buildBorrowObligationLiquidityIx({
    user, borrowReserve: CSOL_RESERVE,
    liquidityMint: CSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCsol,
    amount: loanAmount,
    obligationDepositReserves: postDepositReserves,
    obligationId: obId,
  }));
  void postBorrowReserves;

  ixes.push(await buildFlashRepayIx({
    user, reserve: CSOL_RESERVE, liquidityMint: CSOL_MINT,
    reserveDestinationLiquidity: csolReserveLiqSupply,
    userSourceLiquidity: userCsol,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    amount: loanAmount,
    borrowInstructionIndex,
  }));

  if (args.closeWsolAtaAtEnd) {
    ixes.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID));
  }

  return { ixes, notes: { borrowInstructionIndex, expectedCsSolDeposit } };
}

// ─── Close — Step 1 (Convert / partial Unwind) ──────────────────────
//
// Routes the flash bridge through the wSOL pool (deeper output-side
// liquidity) rather than csSOL-WT (which only has init-reserve seed
// inventory). Mirrors `OneStepUnwindTab.leveragedUnwind` from the
// playground — see its file header for the bridge-asset reasoning.
//
// Flow (with wSOL debt Y > 0):
//   1. flashBorrow(wSOL, Y+1)
//   2. repay(wSOL, Y+1)              ← obligation now has 0 debt slot value
//   3. withdraw_collateral(csSOL, X)
//   4. governor.enqueue(X)            ← burns wallet csSOL, mints X WT,
//                                      queues VRT in Jito ticket
//   5. deposit_collateral(WT, X)      ← wallet WT goes back as collateral
//   6. borrow(wSOL, Y+1)              ← reopens debt
//   7. flashRepay(wSOL, Y+1)
//
// Flow (no debt — Y == 0):
//   1. withdraw_collateral(csSOL, X)
//   2. governor.enqueue(X)
//   3. deposit_collateral(WT, X)
//
// Net effect either way: csSOL collateral −X, csSOL-WT collateral +X,
// wallet untouched, debt unchanged. LTV preserved (csSOL ≈ csSOL-WT
// 1:1 by oracle). Each invocation queues its own Jito unstake ticket.

export interface ConvertStep1Args {
  user: PublicKey;
  amount: bigint;
  vaultState: VaultState;
  queueTotalMinted: bigint;
  preDepositReserves: PublicKey[];
  preBorrowReserves?: PublicKey[];
  /** Current wSOL debt in lamports (raw, post-ceil-of-Q64.60). When > 0
   *  the flow flash-borrows this amount + 1 lamport buffer through the
   *  wSOL pool to clear/reopen the debt around the partial withdraw. */
  wsolDebtLamports?: bigint;
  /** Klend obligation seed-id (0..255). Defaults to 0. */
  obligationId?: number;
}

export async function buildCloseStep1ConvertIxes(args: ConvertStep1Args): Promise<{
  ixes: TransactionInstruction[];
  notes: { borrowInstructionIndex: number };
}> {
  if (!CSSOL_WT_MINT || !CSSOL_WT_RESERVE) {
    throw new Error("csSOL-WT mint/reserve not configured");
  }
  const wtMint = CSSOL_WT_MINT;
  const wtReserve = CSSOL_WT_RESERVE;
  const { user, amount, vaultState, queueTotalMinted, preDepositReserves } = args;
  const preBorrowReserves = args.preBorrowReserves ?? [];
  const obId = args.obligationId ?? 0;
  const wsolDebtLamports = args.wsolDebtLamports ?? 0n;
  // 1-lamport buffer for interest accrual between RPC fetch + tx
  // execution. Klend rejects partial repays under EG with a non-zero
  // debt slot, so we always over-repay by 1 lamport then re-borrow Y+1.
  const flashY = wsolDebtLamports > 0n ? wsolDebtLamports + 1n : 0n;
  const hasDebt = flashY > 0n;
  void vaultState;

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
  const userWsol    = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCsol    = getAssociatedTokenAddressSync(CSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const csolLiqSupply = reserveLiqSupply(CSOL_RESERVE);
  void userWsol; // wSOL ATA no longer needed in convert path — kept for ATA-close at tx-end if a caller expects it
  const [jitoConfig] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
  );

  // Partial unwind keeps csSOL on the obligation (caller may pass full
  // collateral; klend handles the empty-slot case but we conservatively
  // pass the full preDeposit set as remaining_accounts).
  const remainingAfterWithdraw = preDepositReserves;
  const postDepositReserves = remainingAfterWithdraw.some((r) => r.equals(wtReserve))
    ? remainingAfterWithdraw
    : [...remainingAfterWithdraw, wtReserve];

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    // setComputeUnitPrice intentionally omitted — adding the inline
    // accrual_oracle::refresh below pushed the tx ~4 bytes over the
    // 1232-byte raw cap (encoded 1648 vs max 1644). Dropping the
    // priority-fee ix recovers ~13 bytes (1 ix overhead + 9B data + 1B
    // program idx). devnet leaders are uncongested enough that the tx
    // still lands without a tip; if mainnet ever needs the priority
    // budget, re-add and trim a refresh trio instead.
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSol,   user, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSolWt, user, wtMint,     TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userVrt,     user, CSSOL_VRT_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, ticketVrtAta, vaultStakerWithdrawalTicket, CSSOL_VRT_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    // Inline crank of the csSOL accrual oracle so klend's downstream
    // refresh_reserve(WT) actually bumps WT's last_update.slot. Without
    // this, the keeper-cloud Worker's 5-min cadence is too slow for a
    // long convert tx — the oracle goes stale between the keeper fire
    // and our submission, and refresh_obligation reverts with
    // ReserveStale 6009 mid-flow. See buildCloseStep2UnwindIxes for the
    // matching change on the close-position path.
    buildAccrualOracleRefreshIx(),
    // Optional second crank for the WT-specific (vault-backed) oracle —
    // null until VITE_WT_ACCRUAL_* env vars are set + the WT reserve
    // has been flipped to point at the new oracle. See block comment.
    ...(buildWtAccrualOracleRefreshIx() ? [buildWtAccrualOracleRefreshIx()!] : []),
    // Front-loaded refresh_reserve(WT). The pre-repay refresh loop
    // below excludes WT (it expects WT to be refreshed by the chain at
    // line 449/462 only), but the obligation has WT in slot 1, so the
    // FIRST refresh_obligation at line 401 needs WT fresh too. Doing it
    // once here covers all 3 refresh_obligations in this tx — repay
    // only marks wSOL stale, withdraw only marks csSOL stale, so WT
    // stays fresh from this single refresh through the deposit at
    // line 454 (which then marks WT stale and forces the re-refresh
    // chain at lines 462-464 to fire).
    await buildRefreshReserveIx(wtReserve, CSSOL_RESERVE_ORACLE),
  ];
  if (hasDebt) {
    // cSOL ATA holds the flash-borrowed cSOL through repay → re-borrow.
    ixes.push(createAssociatedTokenAccountIdempotentInstruction(
      user, userCsol, user, CSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ));
  }

  let borrowInstructionIndex = -1;

  if (hasDebt) {
    // 1. flash_borrow(cSOL, Y+1) — bridge through cSOL reserve. No
    //    unwrap needed in this path: the obligation's debt is cSOL,
    //    we repay cSOL, re-borrow cSOL, and flash-repay cSOL. The
    //    whole cycle stays in cSOL space — simpler than the open
    //    flow which had to detour through wSOL for the Jito wrap.
    borrowInstructionIndex = ixes.length;
    ixes.push(await buildFlashBorrowIx({
      user, reserve: CSOL_RESERVE, liquidityMint: CSOL_MINT,
      reserveSourceLiquidity: csolLiqSupply,
      userDestinationLiquidity: userCsol,
      liquidityTokenProgram: TOKEN_2022_PROGRAM_ID, amount: flashY,
    }));

    // Refresh chain for repay — cSOL at N-2.
    for (const r of preDepositReserves) {
      if (!r.equals(CSSOL_RESERVE) && !r.equals(wtReserve) && !r.equals(CSOL_RESERVE)) {
        ixes.push(await buildRefreshReserveIx(r, CSSOL_RESERVE_ORACLE));
      }
    }
    ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshReserveIx(CSOL_RESERVE,  CSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshObligationIx(user, preDepositReserves, preBorrowReserves, obId));

    // 2. repay(cSOL, Y+1) — clears debt slot value (slot remains, zero balance)
    ixes.push(await buildRepayObligationLiquidityIx({
      user, repayReserve: CSOL_RESERVE,
      liquidityMint: CSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
      userSourceLiquidity: userCsol, amount: flashY,
      obligationDepositReserves: preDepositReserves,
      obligationId: obId,
    }));

    // Refresh chain for withdraw — csSOL at N-2; cSOL marked stale by
    // repay so refresh again before refresh_obligation iterates the
    // (still-populated) borrow slot.
    ixes.push(await buildRefreshReserveIx(CSOL_RESERVE, CSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshObligationIx(user, preDepositReserves, preBorrowReserves, obId));
  } else {
    // No-debt path: just refresh chain for withdraw.
    for (const r of preDepositReserves) {
      if (!r.equals(CSSOL_RESERVE) && !r.equals(wtReserve)) {
        ixes.push(await buildRefreshReserveIx(r, CSSOL_RESERVE_ORACLE));
      }
    }
    ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshObligationIx(user, preDepositReserves, preBorrowReserves, obId));
  }

  // 3. withdraw_csSOL(X) → user wallet receives X csSOL
  ixes.push(await buildWithdrawCollateralAndRedeemIx({
    user, reserve: CSSOL_RESERVE,
    liquidityMint: CSSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCsSol,
    collateralAmount: amount,
    refreshObligationDeposits: remainingAfterWithdraw,
    obligationId: obId,
  }));

  // 4. governor.enqueue(X) — burns wallet csSOL, mints X csSOL-WT to
  //    wallet, queues a fresh VaultStakerWithdrawalTicket in the Jito vault.
  ixes.push(await buildEnqueueWithdrawViaPoolIx({
    user, base: basePubkey, amount,
    cssolWtMint: wtMint, vrtMint: CSSOL_VRT_MINT,
    vaultStakerWithdrawalTicket, vaultStakerWithdrawalTicketTokenAccount: ticketVrtAta,
    jitoVaultConfig: jitoConfig,
  }));

  // Refresh chain for deposit_WT — WT at N-2. csSOL was marked stale
  // by the withdraw above; re-refresh so refresh_obligation iterates
  // the remaining (partial) csSOL collateral cleanly.
  ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshReserveIx(wtReserve,     CSSOL_RESERVE_ORACLE));
  ixes.push(await buildRefreshObligationIx(user, remainingAfterWithdraw, preBorrowReserves, obId));

  // 5. deposit(WT, X) → wallet csSOL-WT goes back as obligation collateral
  ixes.push(await buildDepositLiquidityAndCollateralIx({
    user, reserve: wtReserve,
    liquidityMint: wtMint, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userSourceLiquidity: userCsSolWt, amount,
    obligationId: obId,
  }));

  if (hasDebt) {
    // 6. Re-borrow cSOL = Y+1 — restores the original debt size.
    ixes.push(await buildRefreshReserveIx(wtReserve,     CSSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshReserveIx(CSOL_RESERVE,  CSOL_RESERVE_ORACLE));
    ixes.push(await buildRefreshObligationIx(user, postDepositReserves, preBorrowReserves, obId));
    ixes.push(await buildBorrowObligationLiquidityIx({
      user, borrowReserve: CSOL_RESERVE,
      liquidityMint: CSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
      userDestinationLiquidity: userCsol, amount: flashY,
      obligationDepositReserves: postDepositReserves,
      obligationId: obId,
    }));

    // 7. flash_repay(cSOL, Y+1)
    ixes.push(await buildFlashRepayIx({
      user, reserve: CSOL_RESERVE, liquidityMint: CSOL_MINT,
      reserveDestinationLiquidity: csolLiqSupply,
      userSourceLiquidity: userCsol,
      liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
      amount: flashY, borrowInstructionIndex,
    }));
  }

  return { ixes, notes: { borrowInstructionIndex } };
}

// ─── Close — Step 2 (Unwind) ─────────────────────────────────────────

export interface UnwindStep2Args {
  user: PublicKey;
  repayAmount: bigint;
  redeemAmount: bigint;
  obligationDepositReserves: PublicKey[];
  /** Existing borrow reserves on the obligation. Required so
   *  `refresh_obligation`'s `expected_remaining_accounts` matches the
   *  obligation's deposits ∪ borrows count. */
  obligationBorrowReserves?: PublicKey[];
  closeWsolAtaAtEnd?: boolean;
  /** Klend obligation seed-id (0..255). Defaults to 0. */
  obligationId?: number;
  /** Lamports of native SOL to wrap into the user's wSOL ATA before
   *  the redeem step, giving `wrap_native(repayAmount)` headroom over
   *  `redeemAmount`. Used to absorb fuzziness — both floor() rounding
   *  in the panel's amount math AND debt accrual between the on-chain
   *  read and the tx landing — when the caller wants `repayAmount` to
   *  slightly exceed `redeemAmount`. Surplus stays in the user's wSOL
   *  ATA after the bundle (claimable via syncNative + closeAccount). */
  wsolPrefundLamports?: bigint;
}

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
  const obligationBorrowReserves = args.obligationBorrowReserves ?? [];
  const obId = args.obligationId ?? 0;
  const wsolPrefundLamports = args.wsolPrefundLamports ?? 0n;

  const userWsol    = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCsSolWt = getAssociatedTokenAddressSync(wtMint, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCsol    = getAssociatedTokenAddressSync(CSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const csolReserveLiqSupply = reserveLiqSupply(CSOL_RESERVE);

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    // setComputeUnitPrice MUST be included even at 0 microLamports.
    // Wallet adapters (Phantom in particular) auto-inject a priority
    // fee ix when none is present, prepending it after our limit ix
    // and shifting every subsequent ix index by 1. That breaks the
    // flash_repay's `borrow_instruction_index` back-pointer (encoded
    // at build time pointing at the bundle-local index of flash_borrow)
    // → klend rejects with InvalidFlashRepay 6033, "Borrow instruction
    // index N for flash repay doesn't match current index N+1".
    // Including our own price ix gives the adapter a no-op to
    // recognize, leaving the bundle's structure intact. 0 microLamports
    // costs nothing on devnet; mainnet should bump this to a real fee.
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(user, userCsSolWt, user, wtMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    // cSOL ATA for the flash-borrow / flash-repay ends of the bundle.
    createAssociatedTokenAccountIdempotentInstruction(user, userCsol, user, CSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    // Optional wSOL prefund — gives `wrap_native(repayAmount)` headroom
    // over `redeemAmount` so the panel can over-repay slightly to
    // absorb fuzziness (rounding + interest accrual). Skipped at 0
    // to keep the byte/CU budget tight on partial unwinds.
    ...(wsolPrefundLamports > 0n
      ? [
          SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: Number(wsolPrefundLamports) }),
          createSyncNativeInstruction(userWsol, TOKEN_PROGRAM_ID),
        ]
      : []),
    // Inline crank of the csSOL accrual oracle. Without this the WT
    // reserve's `last_update.slot` never advances inside the tx (klend
    // happy-paths the refresh when its source oracle is stale), and the
    // first `refresh_obligation` below reverts with ReserveStale 6009.
    // One ix bumps the oracle once for the entire tx — slot doesn't
    // change mid-tx, so the post-repay refresh chain still sees a
    // current oracle.
    buildAccrualOracleRefreshIx(),
    // Optional WT-specific crank — see buildWtAccrualOracleRefreshIx
    // header for the env-var gate. Spread instead of conditional push
    // to keep this list a single literal.
    ...(buildWtAccrualOracleRefreshIx() ? [buildWtAccrualOracleRefreshIx()!] : []),
  ];

  const borrowInstructionIndex = ixes.length;
  // 1. flash_borrow(cSOL, repayAmount) — bridge through cSOL reserve.
  //    Lands in user's cSOL ATA; fed straight into the repay ix.
  ixes.push(await buildFlashBorrowIx({
    user, reserve: CSOL_RESERVE, liquidityMint: CSOL_MINT,
    reserveSourceLiquidity: csolReserveLiqSupply,
    userDestinationLiquidity: userCsol,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID, amount: repayAmount,
  }));

  // Refresh EVERY obligation reserve before refresh_obligation. The
  // earlier version of this builder excluded csSOL / csSOL-WT / cSOL
  // from the loop on the assumption that the explicit refreshes below
  // covered them — but on devnet that left the WT reserve's
  // last_update.slot unchanged in some cases (suspected LUT-writability
  // / oracle-config edge), surfacing as ReserveStale (6009) inside
  // refresh_obligation. Refreshing unconditionally is idempotent and
  // ~9K CU per ix; cheap insurance vs the silent staleness path.
  //
  // `pickOracle` maps each reserve to its Pyth oracle. csSOL family
  // share CSSOL_RESERVE_ORACLE on devnet; cSOL has its own (= wSOL Pyth
  // feed since cSOL is a 1:1 wrapper). Anything else falls back to
  // CSSOL_RESERVE_ORACLE — wrong oracle would surface immediately as a
  // klend "oracle mismatch" rather than the silent staleness we're
  // guarding against.
  const pickOracle = (r: PublicKey): PublicKey =>
    r.equals(CSOL_RESERVE) ? CSOL_RESERVE_ORACLE : CSSOL_RESERVE_ORACLE;

  // Build a deduped, deterministically-ordered set of every reserve
  // klend will need to inspect: obligation deposits + borrows, plus the
  // WT and cSOL reserves the unwind itself touches.
  const refreshSet = new Map<string, PublicKey>();
  for (const r of obligationDepositReserves) refreshSet.set(r.toBase58(), r);
  for (const r of obligationBorrowReserves)  refreshSet.set(r.toBase58(), r);
  refreshSet.set(wtReserve.toBase58(),    wtReserve);
  refreshSet.set(CSOL_RESERVE.toBase58(), CSOL_RESERVE);
  for (const r of refreshSet.values()) {
    ixes.push(await buildRefreshReserveIx(r, pickOracle(r)));
  }
  ixes.push(await buildRefreshObligationIx(user, obligationDepositReserves, obligationBorrowReserves, obId));

  // 2. repay(cSOL, repayAmount) — clears the obligation's cSOL debt.
  // klend's EG-aware repay (`update_elevation_group_debt_trackers_on_repay`)
  // walks `obligation.active_deposits_mut()` and pulls one Reserve per
  // deposit slot from the ix's `remaining_accounts`. EG-2 obligations
  // routinely carry both csSOL and csSOL-WT, so the iter needs every
  // deposit reserve appended as writable. Without them klend reverts
  // with InvalidAccountInput 6006 at lending_operations.rs:2835. Same
  // rule the manage-positions repay path already follows; missing here
  // because this builder predates the fix. Memory:
  //   `klend repay/borrow ix accounts`.
  ixes.push(await buildRepayObligationLiquidityIx({
    user, repayReserve: CSOL_RESERVE,
    liquidityMint: CSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userSourceLiquidity: userCsol, amount: repayAmount,
    obligationDepositReserves,
    obligationId: obId,
  }));

  // Same full re-refresh after repay, BUT the order matters this time:
  // the next klend ix is `withdraw_obligation_collateral`, whose
  // `check_refresh_ixs!` walks back from itself expecting
  //   current_idx-1 : refresh_obligation
  //   current_idx-2 : refresh_reserve(withdraw_reserve = wtReserve)
  // The `refreshSet` Map's iteration order is insertion order
  // (csSOL → csSOL-WT → cSOL), so iterating naïvely puts cSOL last
  // and trips RequireKeysEqViolated 2502 ("Left: cSOL, Right:
  // csSOL-WT") at refresh_ix_utils.rs:115. Push every other reserve
  // first, then wtReserve last so the withdraw's pre-ix slot lines up.
  // Pre-repay refresh chain doesn't have this problem because there
  // cSOL IS the repay reserve and being last is what repay expects.
  for (const r of refreshSet.values()) {
    if (r.equals(wtReserve)) continue;
    ixes.push(await buildRefreshReserveIx(r, pickOracle(r)));
  }
  ixes.push(await buildRefreshReserveIx(wtReserve, pickOracle(wtReserve)));
  ixes.push(await buildRefreshObligationIx(user, obligationDepositReserves, obligationBorrowReserves, obId));

  // 3. Withdraw csSOL-WT collateral.
  ixes.push(await buildWithdrawCollateralAndRedeemIx({
    user, reserve: wtReserve,
    liquidityMint: wtMint, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCsSolWt,
    collateralAmount: redeemAmount,
    refreshObligationDeposits: obligationDepositReserves,
    obligationId: obId,
  }));

  // 4. Redeem csSOL-WT → wSOL via Jito vault. wSOL lands in user's
  //    wSOL ATA — but the flash-repay below needs cSOL, so the next
  //    ix wraps it.
  ixes.push(await buildRedeemCsSolWtIx({
    user, amount: redeemAmount, cssolWtMint: wtMint,
    poolPendingWsolAccount: poolPendingWsol,
  }));

  // 5. wrap_native(wSOL → cSOL) — KYC-gated. Bundle assumes the user
  //    holds a whitelist entry on the cSOL pool (KycGate covers this
  //    on every dashboard load post-2026-05-06 bundle fix). Without
  //    it, delta-mint reverts with AccountNotInitialized 3012 inside
  //    `mint_to`. The amount equals repayAmount because that's what
  //    we owe back to the flash — any leftover wSOL stays in the
  //    user's wSOL ATA.
  ixes.push(buildWrapNativeIx({
    user, amount: repayAmount,
    userUnderlyingAta: userWsol,
    userWrappedAta: userCsol,
    underlyingTokenProgram: TOKEN_PROGRAM_ID,
    wrappedTokenProgram: TOKEN_2022_PROGRAM_ID,
    underlyingMint: NATIVE_MINT,
  }));

  // 6. flash_repay(cSOL, repayAmount) — completes the bundle.
  ixes.push(await buildFlashRepayIx({
    user, reserve: CSOL_RESERVE, liquidityMint: CSOL_MINT,
    reserveDestinationLiquidity: csolReserveLiqSupply,
    userSourceLiquidity: userCsol,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    amount: repayAmount, borrowInstructionIndex,
  }));

  if (args.closeWsolAtaAtEnd) {
    ixes.push(createCloseAccountInstruction(userWsol, user, user, [], TOKEN_PROGRAM_ID));
  }

  return { ixes, notes: { borrowInstructionIndex } };
}

// ─── Quote helpers ───────────────────────────────────────────────────

export interface QuoteCreditTradeArgs {
  marginAsset: MarginAsset;
  marginAmount: number;
  loanAmount: number;
  csSolPriceUsd: number;
  wsolPriceUsd: number;
  existing?: { csSolCollateral: number; wsolDebt: number };
  emodeLtvPct?: number;
  emodeLiqThresholdPct?: number;
}

export interface QuoteCreditTrade {
  collateralCsSol: number;
  collateralUsd: number;
  debtWsol: number;
  debtUsd: number;
  leverage: number;
  health: number;
  liquidationCsSolPriceUsd: number;
  maxLoanAmount: number;
  ltvAfterPct: number;
  warnings: string[];
}

export function quoteCreditTrade(args: QuoteCreditTradeArgs): QuoteCreditTrade {
  const ltv = (args.emodeLtvPct ?? 90) / 100;
  const liq = (args.emodeLiqThresholdPct ?? 92) / 100;

  const newCsSolFromLoan = args.loanAmount;
  const marginInCsSol = args.marginAmount;
  const collateralCsSol = (args.existing?.csSolCollateral ?? 0) + newCsSolFromLoan + marginInCsSol;
  const debtWsol = (args.existing?.wsolDebt ?? 0) + args.loanAmount;

  const collateralUsd = collateralCsSol * args.csSolPriceUsd;
  const debtUsd = debtWsol * args.wsolPriceUsd;

  const equityUsd = Math.max(collateralUsd - debtUsd, 0);
  const leverage = equityUsd > 0 ? debtUsd / equityUsd : 0;
  const ltvAfterPct = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;
  const health = debtUsd > 0 ? (collateralUsd * liq) / debtUsd : Infinity;
  const liquidationCsSolPriceUsd = collateralCsSol > 0 ? debtUsd / (collateralCsSol * liq) : 0;

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
