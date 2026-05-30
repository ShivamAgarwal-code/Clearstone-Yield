import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
// Keep Keypair import path resolved by send() helper signature even though
// we no longer instantiate one — extraSigners parameter still types as Keypair[].
import type { Keypair } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
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
  DEPOSIT_LUT,
  ELEVATION_GROUP_LST_SOL,
  JITO_VAULT_PROGRAM,
  KLEND_MARKET,
  POOL_PENDING_WSOL_ACCOUNT,
  POOL_PDA,
  WSOL_RESERVE,
  WSOL_RESERVE_ORACLE,
  DELTA_MINT_PROGRAM,
  CSSOL_WHITELIST_BUNDLE,
} from "../lib/addresses";
import {
  buildBorrowObligationLiquidityIx,
  buildDepositLiquidityAndCollateralIx,
  buildFlashBorrowIx,
  buildFlashRepayIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRepayObligationLiquidityIx,
  buildRequestElevationGroupIx,
  buildWithdrawCollateralAndRedeemIx,
  obligationPda,
  reserveLiqSupply,
} from "../lib/klend";
import { readObligation } from "../lib/obligationView";
import {
  buildEnqueueWithdrawViaPoolIx,
  buildMatureWithdrawalTicketsIx,
  buildRedeemCsSolWtIx,
  decodeJitoConfigEpochLength,
  decodeTicketSlotUnstaked,
  decodeWithdrawQueue,
  withdrawBasePda,
  withdrawQueuePda,
  type DecodedQueue,
} from "../lib/cssolWt";
import { readVaultState } from "../lib/jitoVault";

function short(p: string | PublicKey, n = 6): string {
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

export default function OneStepUnwindTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [queue, setQueue] = useState<DecodedQueue | null>(null);
  const [cssolBal, setCssolBal] = useState<bigint>(0n);
  const [cssolWtBal, setCssolWtBal] = useState<bigint>(0n);
  const [feeWallet, setFeeWallet] = useState<PublicKey | null>(null);
  const [amount, setAmount] = useState<string>("0.005");
  const [redeemAmount, setRedeemAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Per-MintConfig whitelist status — null = unchecked, true = whitelisted,
  // false = whitelist PDA missing on-chain. Tracks every MintConfig in
  // CSSOL_WHITELIST_BUNDLE (csSOL + csSOL-WT today, extensible). The
  // unwind needs a Holder entry on **all** of them, since
  // enqueue_withdraw_via_pool mints csSOL-WT (gated by the WT entry) and
  // any post-unwind redemption may also touch the csSOL entry.
  const [whitelistStatus, setWhitelistStatus] = useState<Record<string, boolean> | null>(null);
  const missingWhitelist = whitelistStatus
    ? CSSOL_WHITELIST_BUNDLE.filter((e) => whitelistStatus[e.label] === false).map((e) => e.label)
    : null;

  // Per-ticket unlock targets — keyed by ticket PDA base58. Populated
  // when the queue is loaded and used to render countdowns.
  const [ticketUnlockSlot, setTicketUnlockSlot] = useState<Record<string, bigint>>({});
  const [epochLength, setEpochLength] = useState<bigint | null>(null);
  // Cluster reference points so we can extrapolate "now in slot-space"
  // each second without hitting RPC. `clusterNowMs` is the wall-clock
  // when we last sampled `clusterSlot`; we project forward at ~400ms/slot.
  const [clusterSlot, setClusterSlot] = useState<bigint | null>(null);
  const [clusterNowMs, setClusterNowMs] = useState<number>(Date.now());
  const [tick, setTick] = useState(0); // forces 1Hz re-render for countdowns
  const SLOT_DURATION_MS = 400; // devnet/mainnet target slot time

  const refresh = async () => {
    try {
      const queueAddr = withdrawQueuePda();
      const queueInfo = await connection.getAccountInfo(queueAddr, "confirmed");
      const decodedQueue = queueInfo ? decodeWithdrawQueue(queueInfo.data) : null;
      setQueue(decodedQueue);

      // Cache vault state once for fee_wallet (used in mature_withdrawal_tickets)
      try {
        const v = await readVaultState(connection, CSSOL_VAULT);
        setFeeWallet(v.feeWallet);
      } catch { /* ignore */ }

      // Sample current cluster slot for countdown extrapolation.
      try {
        const slot = await connection.getSlot("confirmed");
        setClusterSlot(BigInt(slot));
        setClusterNowMs(Date.now());
      } catch { /* keep stale slot if RPC stutters */ }

      // Load Jito Config's epoch_length once + each live ticket's
      // slot_unstaked. Unlock condition: ticket withdrawable when
      // current_epoch >= ticket_unstake_epoch + 2 — that's
      // (floor(slot_unstaked / epoch_length) + 2) * epoch_length.
      try {
        const [jitoCfg] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode("config")],
          JITO_VAULT_PROGRAM,
        );
        const cfgInfo = await connection.getAccountInfo(jitoCfg, "confirmed");
        const epochLen = cfgInfo ? decodeJitoConfigEpochLength(cfgInfo.data) : null;
        setEpochLength(epochLen);

        if (epochLen && epochLen > 0n && decodedQueue) {
          const live = decodedQueue.tickets.filter((t) => !t.redeemed);
          if (live.length > 0) {
            const infos = await connection.getMultipleAccountsInfo(
              live.map((t) => t.ticketPda), "confirmed",
            );
            const unlocks: Record<string, bigint> = {};
            for (let i = 0; i < live.length; i++) {
              const info = infos[i];
              if (!info) continue;
              const slotUnstaked = decodeTicketSlotUnstaked(info.data);
              const unstakeEpoch = slotUnstaked / epochLen;
              const unlockEpoch = unstakeEpoch + 2n;
              unlocks[live[i].ticketPda.toBase58()] = unlockEpoch * epochLen;
            }
            setTicketUnlockSlot(unlocks);
          } else {
            setTicketUnlockSlot({});
          }
        }
      } catch { /* ignore — countdowns just won't render */ }

      if (wallet.publicKey) {
        const csAta = getAssociatedTokenAddressSync(CSSOL_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        try {
          const bal = await connection.getTokenAccountBalance(csAta, "confirmed");
          setCssolBal(BigInt(bal.value.amount));
        } catch { setCssolBal(0n); }

        if (CSSOL_WT_MINT) {
          const wtAta = getAssociatedTokenAddressSync(CSSOL_WT_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          try {
            const bal = await connection.getTokenAccountBalance(wtAta, "confirmed");
            setCssolWtBal(BigInt(bal.value.amount));
          } catch { setCssolWtBal(0n); }

          // Bundle-aware whitelist pre-flight. enqueue_withdraw_via_pool's
          // mint_to CPI checks ["whitelist", mint_config, owner] for the
          // csSOL-WT MintConfig (missing → 3012 AccountNotInitialized).
          // We also surface the csSOL entry status here so retail / institutional /
          // playground all show the same coverage gap and can point users at
          // the same `scripts/whitelist-wallet.ts` invocation.
          const pdas = CSSOL_WHITELIST_BUNDLE.map((e) =>
            PublicKey.findProgramAddressSync(
              [new TextEncoder().encode("whitelist"), e.mintConfig.toBuffer(), wallet.publicKey!.toBuffer()],
              DELTA_MINT_PROGRAM,
            )[0],
          );
          const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
          const status: Record<string, boolean> = {};
          CSSOL_WHITELIST_BUNDLE.forEach((entry, i) => {
            status[entry.label] = !!infos[i];
          });
          setWhitelistStatus(status);
        }
      }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  // 1Hz tick to re-render countdowns. The slot-space cursor is
  // extrapolated from (clusterSlot, clusterNowMs) using SLOT_DURATION_MS,
  // so we don't hammer RPC each second. A full `refresh()` happens on
  // mount + after each tx + on the user clicking Refresh — that
  // re-syncs the cluster slot reference.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Live "what slot is it right now" extrapolated from the last RPC sample.
  function projectedSlot(): bigint | null {
    if (clusterSlot === null) return null;
    void tick; // keeps this function reactive to the 1Hz tick
    const elapsedMs = Date.now() - clusterNowMs;
    const elapsedSlots = BigInt(Math.floor(elapsedMs / SLOT_DURATION_MS));
    return clusterSlot + elapsedSlots;
  }

  // Format "Nd Nh Nm Ns" style countdown from a number of seconds.
  function fmtCountdown(seconds: number): string {
    if (seconds <= 0) return "ready";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  async function send(tx: Transaction, label: string, extraSigners: Keypair[] = []) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    // Partial-sign with each ephemeral keypair (e.g. enqueue's `base`).
    // Wallet's signTransaction adds the user's signature on top.
    if (extraSigners.length > 0) tx.partialSign(...extraSigners);
    setLog((l) => [...l, `signing ${label} …`]);
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    setLog((l) => [...l, `submitted ${label}: ${sig}`]);
    await connection.confirmTransaction(sig, "confirmed");
    const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (receipt?.meta?.err) {
      const logs = receipt.meta.logMessages?.slice(-10).join("\n") ?? "";
      throw new Error(`${label} on-chain err: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
    return sig;
  }

  // Cache LUT once for the leveraged unwind path.
  const [lutAccount, setLutAccount] = useState<AddressLookupTableAccount | null>(null);
  useEffect(() => {
    if (!DEPOSIT_LUT) return;
    let cancelled = false;
    void connection.getAddressLookupTable(DEPOSIT_LUT, { commitment: "confirmed" })
      .then((r) => { if (!cancelled) setLutAccount(r.value ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [connection]);

  /**
   * Single-signature leveraged-position unwind via klend flash-loan.
   *
   * Flow (one atomic tx, fits with the deposit LUT):
   *   1. flashBorrow(wSOL, Y)              ← Y = user's full wSOL debt
   *   2. repay(wSOL, Y)                    ← obligation: [csSOL], 0 debt
   *   3. withdraw_collateral(csSOL, X)     ← obligation: [csSOL-X] (or empty if full)
   *   4. governor.enqueue(X)               ← burns csSOL → mints WT, queues VRT
   *   5. deposit_collateral(WT, X)         ← obligation: [csSOL-X, WT] (or [WT])
   *   6. request_elevation_group(2)        ← only if EG was dropped (rare)
   *   7. borrow(wSOL, Y)                   ← obligation: [..., WT], debt=Y
   *   8. flashRepay(wSOL, Y)
   *
   * Routes the bridge through wSOL (the *output* asset) rather than csSOL-WT.
   * The wSOL reserve has orders of magnitude more flash-borrowable
   * liquidity, and any klend depositor can permissionlessly grow it —
   * the WT reserve just needs init-reserve seed liquidity, not flash
   * inventory.
   *
   * Net effect: csSOL collateral atomically swapped for csSOL-WT
   * collateral; user's wSOL borrow position untouched throughout (LTV
   * preserved within eMode 2). Zero AMM impact, zero flash-loan fee
   * (verified flashLoanFeeSf=0 on the wSOL reserve).
   */
  async function leveragedUnwind() {
    if (!wallet.publicKey || !CSSOL_WT_MINT || !CSSOL_WT_RESERVE || !DEPOSIT_LUT) return;
    if (!lutAccount) { setError("LUT not loaded"); return; }
    setBusy(true); setError(null);
    setLog([`assembling wSOL-flash unwind for ${amount} csSOL …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");
      // Local non-null aliases — TS doesn't narrow null-checked optional
      // module exports across the async/closure boundary.
      const wtReserve = CSSOL_WT_RESERVE;
      const wtMint = CSSOL_WT_MINT;

      // Read the obligation to determine wSOL debt size and current
      // deposit/borrow reserve sets. The flash size = full wSOL debt; we
      // always close it and re-open in the same tx so the user's leverage
      // is exactly preserved.
      const ob = await readObligation(connection, owner, KLEND_MARKET);
      if (!ob.exists) throw new Error("no obligation found at v3 market");
      const wsolBorrow = ob.borrows.find((b) => b.reserve.equals(WSOL_RESERVE));
      if (!wsolBorrow || wsolBorrow.borrowedAmountSf === 0n) {
        throw new Error("no wSOL debt to bridge — use the plain enqueue flow");
      }
      // Q64.60 → integer: ceil-div by 2^60 so we cover the full debt
      // (klend rejects partial repays that don't bring debt to zero when
      //  followed by withdraw + re-borrow under EG constraints).
      const SF = 60n;
      const debtUnits = (wsolBorrow.borrowedAmountSf + ((1n << SF) - 1n)) >> SF;
      // Add 1 lamport buffer for interest accrual between RPC fetch + tx.
      const flashY = debtUnits + 1n;

      const preDepositReserves = ob.deposits.map((d) => d.reserve);
      const preBorrowReserves = ob.borrows.map((b) => b.reserve);

      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
      );
      if (!queue) throw new Error("queue not loaded yet — refresh and retry");
      const basePubkey = withdrawBasePda(queue.totalCssolWtMinted);
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
      const userCssolAta = getAssociatedTokenAddressSync(
        CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userCssolWtAta = getAssociatedTokenAddressSync(
        wtMint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userVrtAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userWsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const wsolLiqSupply = reserveLiqSupply(WSOL_RESERVE);

      const ixes: TransactionInstruction[] = [];
      // Bumped to 1.4M — this path runs ~12 ixes vs the v1 path's 8, plus
      // a borrow that re-walks the obligation graph for LTV.
      ixes.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      ixes.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));

      // ATAs (idempotent)
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userCssolAta, owner, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userCssolWtAta, owner, wtMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userVrtAta, owner, CSSOL_VRT_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, ticketVrtAta, vaultStakerWithdrawalTicket, CSSOL_VRT_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));

      // 1. flash_borrow(wSOL, Y)
      const borrowIxIdx = ixes.length;
      ixes.push(await buildFlashBorrowIx({
        user: owner, reserve: WSOL_RESERVE, liquidityMint: NATIVE_MINT,
        reserveSourceLiquidity: wsolLiqSupply, userDestinationLiquidity: userWsolAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID, amount: flashY,
      }));

      // Refresh every reserve currently on the obligation. klend's
      // check_refresh requires N-2 = refresh_reserve(<repayReserve>) and
      // N-1 = refresh_obligation. We satisfy this with up-front refreshes
      // for all referenced reserves, then the targeted N-2 placeholder
      // before each state-changing ix.
      const allRefreshed = new Set<string>();
      const refreshOnce = async (r: PublicKey, oracle: PublicKey) => {
        if (allRefreshed.has(r.toBase58())) return;
        ixes.push(await buildRefreshReserveIx(r, oracle));
        allRefreshed.add(r.toBase58());
      };
      // wSOL is freshly written by flash_borrow, so it MUST be refreshed
      // again here for klend to see correct available_amount. We refresh
      // every reserve the *pre-tx* obligation iterates (csSOL deposit +
      // wSOL borrow) — WT isn't on the obligation yet, so its refresh
      // gets deferred to step 5 where klend actually needs it. Skipping
      // the early WT refresh keeps the v0 message under 1232 bytes for
      // partial-unwind paths.
      await refreshOnce(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE);
      // Refresh other deposit reserves (e.g. ceUSX) using their oracles.
      // The current path only handles the LST/SOL EG so any other deposit
      // is unexpected; throw rather than silently mis-refresh.
      for (const r of preDepositReserves) {
        if (!r.equals(CSSOL_RESERVE) && !r.equals(wtReserve)) {
          throw new Error(`unsupported deposit reserve in obligation: ${r.toBase58()}`);
        }
      }

      // 2. repay(wSOL, Y) — N-2: refresh_reserve(wSOL), N-1: refresh_obligation.
      //    Pre-repay state still has the wSOL borrow slot, so klend's
      //    refresh_obligation expects it in remaining_accounts.
      ixes.push(await buildRefreshReserveIx(WSOL_RESERVE, WSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, preDepositReserves, preBorrowReserves));
      ixes.push(await buildRepayObligationLiquidityIx({
        user: owner, repayReserve: WSOL_RESERVE,
        liquidityMint: NATIVE_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userSourceLiquidity: userWsolAta, amount: flashY,
        // EG-2 obligation: klend's repay handler requires every deposit
        // reserve as remaining_accounts. Same rule as borrow.
        obligationDepositReserves: preDepositReserves,
      }));

      // 3. withdraw csSOL collateral — N-2: refresh_reserve(csSOL), N-1: refresh_obligation.
      //    klend's repay handler does NOT clear the borrow slot inline;
      //    the slot still references wSOL until a subsequent
      //    refresh_obligation rolls it forward, so we still need to pass
      //    the wSOL borrow as a remaining_account here. The repay also
      //    marked the wSOL reserve stale, so it must be refreshed BEFORE
      //    refresh_obligation iterates the borrow slot.
      ixes.push(await buildRefreshReserveIx(WSOL_RESERVE, WSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, preDepositReserves, preBorrowReserves));
      // After this withdraw, csSOL stays in the obligation iff the user
      // still has collateral left (partial unwind). For full unwind it
      // drops out entirely.
      const cssolCollDeposit = ob.deposits.find((d) => d.reserve.equals(CSSOL_RESERVE));
      const cssolFullyWithdrawn = cssolCollDeposit
        ? lamports >= cssolCollDeposit.depositedCtokens
        : true;
      const remainingAfterWithdraw = cssolFullyWithdrawn
        ? preDepositReserves.filter((r) => !r.equals(CSSOL_RESERVE))
        : preDepositReserves;
      ixes.push(await buildWithdrawCollateralAndRedeemIx({
        user: owner, reserve: CSSOL_RESERVE,
        liquidityMint: CSSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userDestinationLiquidity: userCssolAta, collateralAmount: lamports,
        refreshObligationDeposits: remainingAfterWithdraw,
      }));

      // 4. governor.enqueue — burn csSOL, mint WT, queue VRT in Jito ticket
      ixes.push(await buildEnqueueWithdrawViaPoolIx({
        user: owner, base: basePubkey, amount: lamports,
        cssolWtMint: wtMint, vrtMint: CSSOL_VRT_MINT,
        vaultStakerWithdrawalTicket, vaultStakerWithdrawalTicketTokenAccount: ticketVrtAta,
        jitoVaultConfig: jitoConfig,
      }));

      // 5. deposit WT — N-2: refresh_reserve(WT), N-1: refresh_obligation.
      //    The wSOL borrow slot persists (zero-amount but populated) until
      //    overwritten by the borrow ix in step 7, so we keep it in the
      //    refresh remaining_accounts list. The withdraw above marked
      //    csSOL stale; only refresh it when it's still in
      //    remainingAfterWithdraw (partial unwind) — for full unwind the
      //    obligation iteration skips csSOL and the extra refresh would
      //    push the v0 message past the 1232-byte limit.
      if (!cssolFullyWithdrawn) {
        ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
      }
      ixes.push(await buildRefreshReserveIx(wtReserve, CSSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, remainingAfterWithdraw, preBorrowReserves));
      ixes.push(await buildDepositLiquidityAndCollateralIx({
        user: owner, reserve: wtReserve,
        liquidityMint: wtMint, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userSourceLiquidity: userCssolWtAta, amount: lamports,
      }));

      // 6. Re-set elevation group to 2. Required when the obligation
      //    transiently emptied in step 3 (full unwind path) — klend
      //    resets EG to 0 on empty deposits. For partial unwind this is
      //    a no-op but cheap.
      const postDepositReserves = remainingAfterWithdraw.some((r) => r.equals(wtReserve))
        ? remainingAfterWithdraw
        : [...remainingAfterWithdraw, wtReserve];
      // Refresh every reserve we'll cite to request_elevation_group.
      // Fresh refreshes from earlier in the tx remain valid.
      ixes.push(await buildRefreshReserveIx(wtReserve, CSSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, postDepositReserves, preBorrowReserves));
      // Only request EG-2 if the obligation isn't already in it. klend's
      // repay/withdraw flow does NOT drop the elevation group when the
      // borrow slot survives at zero balance (which is what happens in
      // our partial-unwind path) — so issuing request_elevation_group(2)
      // when EG==2 already trips ElevationGroupAlreadyActivated (6083).
      // Re-issue is only useful if EG was actually dropped (e.g. some
      // future klend version that clears EG on transient empty deposits).
      if (ob.elevationGroup !== ELEVATION_GROUP_LST_SOL) {
        ixes.push(await buildRequestElevationGroupIx(
          owner, ELEVATION_GROUP_LST_SOL, postDepositReserves, [WSOL_RESERVE],
        ));
      }

      // 7. borrow wSOL (Y) — N-2: refresh_reserve(wSOL), N-1: refresh_obligation
      ixes.push(await buildRefreshReserveIx(WSOL_RESERVE, WSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, postDepositReserves, preBorrowReserves));
      ixes.push(await buildBorrowObligationLiquidityIx({
        user: owner, borrowReserve: WSOL_RESERVE,
        liquidityMint: NATIVE_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userDestinationLiquidity: userWsolAta, amount: flashY,
        obligationDepositReserves: postDepositReserves,
      }));

      // 8. flash_repay(wSOL, Y)
      ixes.push(await buildFlashRepayIx({
        user: owner, reserve: WSOL_RESERVE, liquidityMint: NATIVE_MINT,
        reserveDestinationLiquidity: wsolLiqSupply, userSourceLiquidity: userWsolAta,
        liquidityTokenProgram: TOKEN_PROGRAM_ID,
        amount: flashY, borrowInstructionIndex: borrowIxIdx,
      }));

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: owner, recentBlockhash: blockhash, instructions: ixes,
      }).compileToV0Message([lutAccount]);
      const vtx = new VersionedTransaction(msg);
      const serialized = vtx.serialize();
      setLog((l) => [...l, `tx assembled: ${ixes.length} ixes, ${serialized.length} bytes (limit 1232)`]);
      if (serialized.length > 1232) throw new Error(`tx too large: ${serialized.length} > 1232`);

      if (!wallet.signTransaction) throw new Error("wallet has no signTransaction");
      const signed = await wallet.signTransaction(vtx);
      setLog((l) => [...l, "submitting …"]);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setLog((l) => [...l, `submitted: ${sig}`]);
      await connection.confirmTransaction(sig, "confirmed");
      const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (receipt?.meta?.err) {
        const logs = receipt.meta.logMessages?.slice(-12).join("\n") ?? "";
        throw new Error(`wSOL-flash unwind on-chain err: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
      }
      // Avoid suppressing unused-var lint on preBorrowReserves (kept for future
      // partial-debt handling).
      void preBorrowReserves;
      setLog((l) => [...l, "✓ confirmed"]);
      await refresh();
    } catch (e: any) {
      setError(`${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function enqueueUnwind() {
    if (!wallet.publicKey || !CSSOL_WT_MINT) return;
    setBusy(true); setError(null);
    setLog([`assembling enqueue-unwind for ${amount} csSOL …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");

      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        JITO_VAULT_PROGRAM,
      );

      // Ticket PDA seeds: [b"vault_staker_withdrawal_ticket", vault, base].
      // `base` is a governor-derived PDA per (pool, queue.total_minted),
      // signed via invoke_signed inside the program — no client-side
      // ephemeral keypair, no extra wallet-signer slot.
      if (!queue) throw new Error("queue not loaded yet — refresh and retry");
      const basePubkey = withdrawBasePda(queue.totalCssolWtMinted);
      const [vaultStakerWithdrawalTicket] = PublicKey.findProgramAddressSync(
        [
          new TextEncoder().encode("vault_staker_withdrawal_ticket"),
          CSSOL_VAULT.toBuffer(),
          basePubkey.toBuffer(),
        ],
        JITO_VAULT_PROGRAM,
      );
      // Ticket's VRT ATA, owned by the ticket PDA off-curve.
      const vaultStakerWithdrawalTicketTokenAccount = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, vaultStakerWithdrawalTicket, true,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      // User must have a csSOL-WT ATA to receive the freshly-minted WT.
      const userCssolWtAta = getAssociatedTokenAddressSync(
        CSSOL_WT_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      // User's VRT ATA — VRT moves pool→here transiently inside the
      // governor ix before Jito EnqueueWithdrawal consumes it.
      const userVrtAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
        // Idempotent ATA creates — cheap and safe to always include.
        createAssociatedTokenAccountIdempotentInstruction(
          owner, userCssolWtAta, owner, CSSOL_WT_MINT,
          TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        // User's VRT ATA — receives VRT transiently from the pool inside
        // the governor ix, then Jito drains it into the ticket.
        createAssociatedTokenAccountIdempotentInstruction(
          owner, userVrtAta, owner, CSSOL_VRT_MINT,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        // Pre-create the ticket's VRT ATA. Jito's EnqueueWithdrawal
        // expects this canonical ATA to already exist as an SPL Token
        // account — it does spl_token::transfer_checked into it but
        // doesn't allocate it itself (verified by inspecting an
        // existing on-chain ticket at c7JUyWj8…/3h653SPD…). Owner =
        // ticket_pda (off-curve), funder = user.
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          vaultStakerWithdrawalTicketTokenAccount,
          vaultStakerWithdrawalTicket,
          CSSOL_VRT_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        await buildEnqueueWithdrawViaPoolIx({
          user: owner,
          base: basePubkey,
          amount: lamports,
          cssolWtMint: CSSOL_WT_MINT,
          vrtMint: CSSOL_VRT_MINT,
          vaultStakerWithdrawalTicket,
          vaultStakerWithdrawalTicketTokenAccount,
          jitoVaultConfig: jitoConfig,
        }),
      ];

      const tx = new Transaction();
      ixes.forEach((ix) => tx.add(ix));
      // Single-signer flow now: user signs via the wallet, base is a
      // governor PDA signed via invoke_signed inside the program.
      await send(tx, "enqueue unwind");
      await refresh();
    } catch (e: any) {
      const onchainLogs = e?.transactionLogs ?? e?.logs ?? null;
      setError(`${e.message ?? e}${onchainLogs ? "\n\n" + onchainLogs.slice(-8).join("\n") : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function matureTicket(ticketPda: PublicKey) {
    if (!wallet.publicKey || !POOL_PENDING_WSOL_ACCOUNT || !feeWallet) return;
    setBusy(true); setError(null);
    setLog([`maturing ticket ${short(ticketPda)} …`]);
    try {
      const owner = wallet.publicKey;
      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        JITO_VAULT_PROGRAM,
      );
      const ticketTokenAccount = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, ticketPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const vaultFeeAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      // Program fee ATA — same as vault fee until Jito Config's
      // program_fee_wallet is plumbed through.
      const programFeeAta = vaultFeeAta;
      const userWsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        // Pre-create user's wSOL ATA — Jito's BurnWithdrawalTicket
        // CPI sends wSOL here as the staker_token_account. Same
        // "WritableAccount no init" pattern as the enqueue ticket ATA.
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userWsolAta, owner, NATIVE_MINT,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(await buildMatureWithdrawalTicketsIx({
          user: owner,
          vaultStakerWithdrawalTicket: ticketPda,
          vaultStakerWithdrawalTicketTokenAccount: ticketTokenAccount,
          vaultFeeTokenAccount: vaultFeeAta,
          programFeeTokenAccount: programFeeAta,
          jitoVaultConfig: jitoConfig,
          poolPendingWsolAccount: POOL_PENDING_WSOL_ACCOUNT,
        }));

      await send(tx, "mature ticket");
      await refresh();
    } catch (e: any) {
      setError(`${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!wallet.publicKey || !CSSOL_WT_MINT || !POOL_PENDING_WSOL_ACCOUNT) return;
    setBusy(true); setError(null);
    setLog([`redeeming ${redeemAmount} csSOL-WT …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(redeemAmount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userWsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(await buildRedeemCsSolWtIx({
          user: owner,
          amount: lamports,
          cssolWtMint: CSSOL_WT_MINT,
          poolPendingWsolAccount: POOL_PENDING_WSOL_ACCOUNT,
        }));

      await send(tx, "redeem csSOL-WT");
      await refresh();
    } catch (e: any) {
      setError(`${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-bold mb-2">Unwind — csSOL → wSOL → SOL</h2>
        <p className="opacity-70 mb-6">
          Three-stage unwind through the Jito vault: enqueue (burn csSOL, mint csSOL-WT, queue VRT
          for unstaking), wait for epoch unlock, then claim wSOL.
        </p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  const setupMissing = !CSSOL_WT_MINT || !POOL_PENDING_WSOL_ACCOUNT || !queue;
  const liveTickets = queue ? queue.tickets.filter((t) => !t.redeemed) : [];

  return (
    <section className="max-w-3xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">Unwind — csSOL → csSOL-WT → wSOL</h2>
        <p className="opacity-70 mt-1 text-sm">
          Burns csSOL, mints csSOL-WT (Token-2022, KYC-gated), queues the underlying VRT in a
          Jito withdrawal ticket. After Jito's epoch unlock window the ticket can be matured
          permissionlessly; csSOL-WT then redeems 1:1 for wSOL from the pool's pending pool.
        </p>
      </header>

      {setupMissing ? (
        <div className="alert alert-warning text-xs">
          <div>
            <p className="font-bold">csSOL-WT pipeline not fully deployed yet.</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>VITE_CSSOL_WT_MINT: {CSSOL_WT_MINT ? "✓" : "missing — run scripts/setup-cssol-wt-mint.ts"}</li>
              <li>VITE_POOL_PENDING_WSOL_ACCOUNT: {POOL_PENDING_WSOL_ACCOUNT ? "✓" : "missing — run scripts/init-pool-pending-wsol.ts"}</li>
              <li>WithdrawQueue PDA: {queue ? "✓" : "not initialized — run scripts/init-withdraw-queue.ts"}</li>
            </ul>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Withdraw queue</div>
            {queue ? (
              <>
                <div>address: <code>{short(withdrawQueuePda())}</code></div>
                <div>pending wSOL pool: <code>{(Number(queue.pendingWsol) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
                <div>lifetime minted: <code>{(Number(queue.totalCssolWtMinted) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
                <div>lifetime redeemed: <code>{(Number(queue.totalCssolWtRedeemed) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
                <div>live tickets: <code>{liveTickets.length}</code> / 32</div>
              </>
            ) : <div className="opacity-60">queue not initialized</div>}
          </div>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Wallet balances</div>
            <div>csSOL: <code>{(Number(cssolBal) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
            <div>csSOL-WT: <code>{(Number(cssolWtBal) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
          </div>
        </div>
      </div>

      {missingWhitelist && missingWhitelist.length > 0 ? (
        <div className="alert alert-warning text-xs">
          <div>
            <p className="font-bold">
              Wallet missing whitelist entries: <code>{missingWhitelist.join(", ")}</code>
            </p>
            <p>
              The unwind path needs a Holder entry on every MintConfig in the bundle —
              delta-mint will trip <code>AccountNotInitialized: whitelist_entry</code> (3012)
              when minting csSOL-WT, and other ixes will fail similarly. Retail (KYC),
              institutional (KYB), and playground users all converge to the same on-chain
              Holder role; only the off-chain approval pipeline differs.
            </p>
            <p className="mt-1 opacity-80">
              One-shot whitelist across the full bundle:
              {" "}<code>
                npx tsx scripts/whitelist-wallet.ts{" "}
                {wallet.publicKey?.toBase58() ?? "<your-wallet>"}
              </code>
            </p>
          </div>
        </div>
      ) : null}

      {CSSOL_WT_RESERVE && DEPOSIT_LUT ? (
        <div className="card bg-base-300 border border-primary/30">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">Leveraged unwind via flash-loan collateral swap</div>
            <p className="text-xs opacity-80">
              For positions with active wSOL borrow against csSOL collateral. Single
              signature swaps your csSOL collateral for csSOL-WT collateral inside klend's
              eMode 2 (LTV preserved), then queues the underlying unstake — without ever
              needing external SOL liquidity to repay your borrow. Zero AMM impact, zero
              flash-loan fee (verified <code>flashLoanFeeSf = 0</code>).
            </p>
            <p className="text-xs opacity-60">
              ix sequence: <code>flashBorrow(wSOL) → repay → withdraw(csSOL) → enqueue → deposit(WT) → borrow(wSOL) → flashRepay</code>
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm opacity-70">amount: same as Step 1</span>
              <button
                className="btn btn-primary"
                onClick={leveragedUnwind}
                disabled={busy || setupMissing || (missingWhitelist?.length ?? 0) > 0}
              >
                {busy ? <span className="loading loading-spinner loading-sm" /> : null}
                Unwind {amount} csSOL via flash-loan
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-3">
          <div className="font-bold">Step 1: enqueue unwind</div>
          <p className="text-xs opacity-70">
            Burns X csSOL, queues X VRT in a fresh Jito withdrawal ticket (pool PDA = staker), mints X csSOL-WT to your wallet.
          </p>
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="input input-bordered w-48"
              value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            <span className="text-sm opacity-70">csSOL</span>
            <button className="btn btn-primary" onClick={enqueueUnwind} disabled={busy || setupMissing}>
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              Enqueue unwind
            </button>
          </div>
        </div>
      </div>

      {liveTickets.length > 0 ? (
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">Step 2: mature tickets (permissionless)</div>
            <p className="text-xs opacity-70">
              Each ticket is locked until the next Jito vault epoch flip. Once unlocked, anyone can
              click <em>Mature</em> to burn the ticket and sweep wSOL into the pool's pending pool.
              Devnet epoch ≈ 75 s; mainnet ≈ 2 days.
            </p>
            <table className="table table-xs">
              <thead><tr><th>ticket</th><th>amount</th><th>unlocks in</th><th></th></tr></thead>
              <tbody>
                {liveTickets.map((t, i) => {
                  const unlockSlot = ticketUnlockSlot[t.ticketPda.toBase58()];
                  const nowSlot = projectedSlot();
                  let countdownLabel = "—";
                  let ready = false;
                  if (unlockSlot !== undefined && nowSlot !== null) {
                    if (nowSlot >= unlockSlot) {
                      ready = true;
                      countdownLabel = "✓ ready";
                    } else {
                      const slotsLeft = Number(unlockSlot - nowSlot);
                      const secondsLeft = (slotsLeft * SLOT_DURATION_MS) / 1000;
                      countdownLabel = fmtCountdown(secondsLeft);
                    }
                  }
                  const isMine = !!wallet.publicKey && t.staker.equals(wallet.publicKey);
                  return (
                    <tr key={i} className={isMine ? "" : "opacity-60"}>
                      <td><code>{short(t.ticketPda)}</code> {isMine ? <span className="badge badge-xs badge-primary ml-1">yours</span> : null}</td>
                      <td>{(Number(t.cssolWtAmount) / LAMPORTS_PER_SOL).toFixed(6)}</td>
                      <td className={ready ? "text-success" : "text-warning"}><code>{countdownLabel}</code></td>
                      <td>
                        <button className="btn btn-xs btn-primary" disabled={busy || !ready || !isMine}
                          title={
                            !isMine ? "Only the original ticket creator can mature it (Jito enforces ticket.staker == provided_staker)"
                              : !ready ? "Ticket still in Jito's epoch lock — wait for the countdown"
                              : undefined
                          }
                          onClick={() => void matureTicket(t.ticketPda)}>
                          Mature
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {epochLength ? (
              <p className="text-xs opacity-60 mt-2">
                Unlock = ticket's <code>slot_unstaked</code> + 2 × Jito epoch_length
                ({epochLength.toString()} slots ≈ {(Number(epochLength) * SLOT_DURATION_MS / 1000 / 86400).toFixed(2)}d).
                Devnet test vault uses a mainnet-style ~2-day epoch, so first ticket needs roughly 2-4 days before maturation.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {queue && queue.pendingWsol > 0n ? (
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">Step 3: redeem csSOL-WT for wSOL</div>
            <p className="text-xs opacity-70">
              Burns your csSOL-WT and pays out wSOL from the pool's pending pool 1:1.
              Available: {(Number(queue.pendingWsol) / LAMPORTS_PER_SOL).toFixed(6)} wSOL.
            </p>
            <div className="flex items-center gap-2">
              <input type="number" step="0.001" min="0" className="input input-bordered w-48"
                value={redeemAmount} onChange={(e) => setRedeemAmount(e.target.value)} disabled={busy} />
              <span className="text-sm opacity-70">csSOL-WT</span>
              <button className="btn btn-primary" onClick={redeem} disabled={busy || !redeemAmount}>
                {busy ? <span className="loading loading-spinner loading-sm" /> : null}
                Redeem
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <pre className="alert alert-error text-xs whitespace-pre-wrap">{error}</pre> : null}
      {log.length > 0 ? <pre className="bg-base-300 p-2 text-xs whitespace-pre-wrap rounded">{log.join("\n")}</pre> : null}

      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">v0 scope notes</summary>
        <p className="mt-2">
          This tab is the v0 unwind UX: simple "free csSOL → unstake" path. The full
          institutional unwind also supports collateral-swapping the user's klend csSOL collateral
          into csSOL-WT collateral via a klend flash-loan in one tx (so users with leveraged
          positions can unwind without sourcing external SOL liquidity to repay borrows). That
          path needs the csSOL-WT klend reserve to be deployed — see
          <code className="mx-1">scripts/setup-cssol-wt-reserve.ts</code> (stub). When that lands,
          this tab gains a "Unwind leveraged position" card that bundles flashBorrow → deposit
          collateral → withdraw csSOL collateral → enqueue → flashRepay in one signature.
        </p>
      </details>
    </section>
  );
}
