/**
 * CreditTradeTab — Open + manage a leveraged csSOL/wSOL credit trade
 * in a single signature.
 *
 * The flow flash-borrows wSOL, wraps `loan + margin` into csSOL via
 * Jito vault, deposits as collateral, borrows `loan` wSOL, then
 * flash-repays. See [`lib/creditTrade.ts`](../lib/creditTrade.ts) for
 * the full ix list.
 */

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  CREDIT_TRADE_LUT,
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_WT_MINT,
  CSSOL_WT_RESERVE,
  DELTA_MINT_PROGRAM,
  DM_MINT_CONFIG,
  JITO_VAULT_PROGRAM,
  WSOL_RESERVE,
  WSOL_RESERVE_ORACLE,
} from "../lib/addresses";
import { obligationPda, userMetadataPda } from "../lib/klend";
import { readVaultState } from "../lib/jitoVault";
import CreditTradeEusxPanel from "./CreditTradeEusxPanel";
import {
  buildCloseStep1ConvertIxes,
  buildCloseStep2UnwindIxes,
  buildOpenCreditTradeIxes,
  quoteCreditTrade,
  type MarginAsset,
} from "../lib/creditTrade";
import {
  cTokensToUnderlying,
  readObligation,
  readReserve,
  sfToNumber,
} from "../lib/obligationView";
import {
  decodeJitoConfigEpochLength,
  decodeTicketSlotUnstaked,
  decodeWithdrawQueue,
  withdrawQueuePda,
  type DecodedQueue,
} from "../lib/cssolWt";

function fmt(n: number, dp = 4): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type Pair = "csSOL/wSOL" | "ceUSX/sUSDC";
const PAIRS: { id: Pair; label: string; active: boolean }[] = [
  { id: "csSOL/wSOL", label: "csSOL / wSOL — atomic 1-tx leveraged loop", active: true },
  { id: "ceUSX/sUSDC", label: "ceUSX / sUSDC — manual deposit + borrow", active: true },
];

export default function CreditTradeTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [pair, setPair] = useState<Pair>("csSOL/wSOL");

  // Live state
  const [csSolPrice, setCsSolPrice] = useState(0);
  const [wsolPrice, setWsolPrice]   = useState(0);
  const [solBal, setSolBal]         = useState(0);
  const [wsolBal, setWsolBal]       = useState(0);
  const [csSolBal, setCsSolBal]     = useState(0);
  // wSOL reserve's available_amount (raw lamport-units). The open
  // path consumes 2× the loan from the reserve in-flight (flash_borrow
  // drains it, then borrow_obligation_liquidity drains it again
  // before flash_repay returns the flash half), so the practical
  // trade-size cap is `wsolReserveAvailable / 2`.
  const [wsolReserveAvailable, setWsolReserveAvailable] = useState(0);
  const [existing, setExisting]     = useState<{ csSolCollateral: number; wsolDebt: number } | null>(null);
  const [obligationExists, setObligationExists] = useState<boolean | null>(null);
  const [obligationDeposits, setObligationDeposits] = useState<PublicKey[]>([]);
  // KYC gate — credit-trade open path mints csSOL via delta-mint,
  // which requires the user's whitelist_entry PDA. Without it the wrap
  // CPI fails with `AccountNotInitialized: whitelist_entry (3012)`.
  const [whitelisted, setWhitelisted] = useState<boolean | null>(null);
  const [whitelistPda, setWhitelistPda] = useState<PublicKey | null>(null);

  // Form
  const [marginAsset, setMarginAsset] = useState<MarginAsset>("SOL");
  const [marginAmountStr, setMarginAmountStr] = useState("0.05");
  const [loanAmountStr, setLoanAmountStr] = useState("0.45");

  // Close mechanic — two-step:
  //   Step 1 (Convert): csSOL → csSOL-WT via the existing
  //     leveragedUnwind path on the Unwind tab. After this the
  //     obligation holds csSOL-WT (a withdraw ticket) instead of
  //     csSOL, and the Jito vault enqueues the underlying VRT
  //     unstake (epoch-locked).
  //   Step 2 (Unwind): once the ticket matures (Jito vault epoch
  //     boundary + 2), redeem csSOL-WT → wSOL, repay the wSOL debt,
  //     and (if 100%) withdraw any remaining csSOL margin as native
  //     SOL.
  const [csSolWtCollateral, setCsSolWtCollateral]   = useState(0);
  const [queue, setQueue]                           = useState<DecodedQueue | null>(null);
  const [epochLength, setEpochLength]               = useState<bigint | null>(null);
  const [clusterSlot, setClusterSlot]               = useState<bigint | null>(null);
  const [clusterNowMs, setClusterNowMs]             = useState<number>(Date.now());
  const [, forceTick]                               = useState(0); // 1Hz countdown re-render
  const SLOT_DURATION_MS = 400;

  // Close form
  const [closePctStr, setClosePctStr] = useState<string>("100");
  // Explicit csSOL amount typed into the Convert panel — drives the
  // step-1 flash-loan size directly. No percentage indirection.
  const [convertAmountStr, setConvertAmountStr] = useState<string>("");

  // Tx state
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!wallet.publicKey) return;
    setError(null);
    try {
      // Prices via the same readReserve path the Lending tab uses
      // (live oracle if known, fallback to klend cached field).
      const [csSolReserve, wsolReserve] = await Promise.all([
        readReserve(connection, CSSOL_RESERVE, CSSOL_RESERVE_ORACLE),
        readReserve(connection, WSOL_RESERVE, WSOL_RESERVE_ORACLE),
      ]);
      if (csSolReserve) setCsSolPrice(sfToNumber(csSolReserve.marketPriceSf));
      if (wsolReserve) {
        setWsolPrice(sfToNumber(wsolReserve.marketPriceSf));
        setWsolReserveAvailable(Number(wsolReserve.availableAmount) / LAMPORTS_PER_SOL);
      }

      // Wallet balances
      const userCsSolAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(
        CSSOL_MINT, wallet.publicKey, false,
        (await import("@solana/spl-token")).TOKEN_2022_PROGRAM_ID,
        (await import("@solana/spl-token")).ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userWsolAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(
        (await import("@solana/spl-token")).NATIVE_MINT, wallet.publicKey,
      );
      const [solLamports, csSolInfo, wsolInfo] = await Promise.all([
        connection.getBalance(wallet.publicKey, "confirmed"),
        connection.getAccountInfo(userCsSolAta, "confirmed"),
        connection.getAccountInfo(userWsolAta, "confirmed"),
      ]);
      setSolBal(solLamports / LAMPORTS_PER_SOL);
      setCsSolBal(csSolInfo && csSolInfo.data.length >= 72 ? Number(csSolInfo.data.readBigUInt64LE(64)) / LAMPORTS_PER_SOL : 0);
      setWsolBal(wsolInfo && wsolInfo.data.length >= 72 ? Number(wsolInfo.data.readBigUInt64LE(64)) / LAMPORTS_PER_SOL : 0);

      // KYC gate — same `["whitelist", DM_MINT_CONFIG, owner]` PDA the
      // Lending tab checks. Without this the wrap CPI fails inside
      // delta-mint's `mint_to` with AccountNotInitialized (3012).
      const [wlPda] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("whitelist"), DM_MINT_CONFIG.toBuffer(), wallet.publicKey.toBuffer()],
        DELTA_MINT_PROGRAM,
      );
      setWhitelistPda(wlPda);
      const wlInfo = await connection.getAccountInfo(wlPda, "confirmed");
      setWhitelisted(!!wlInfo);

      // Obligation
      const ob = await readObligation(connection, wallet.publicKey);
      setObligationExists(ob.exists);
      if (ob.exists) {
        const csSolDeposit = ob.deposits.find((d) => d.reserve.equals(CSSOL_RESERVE));
        const wsolBorrow   = ob.borrows.find((b) => b.reserve.equals(WSOL_RESERVE));
        const wtReserve = CSSOL_WT_RESERVE; // narrow once for TS
        const csSolWtDeposit = wtReserve
          ? ob.deposits.find((d) => d.reserve.equals(wtReserve))
          : undefined;
        setExisting({
          csSolCollateral: csSolDeposit ? Number(cTokensToUnderlying(csSolDeposit.depositedCtokens)) / LAMPORTS_PER_SOL : 0,
          wsolDebt:        wsolBorrow ? sfToNumber(wsolBorrow.borrowedAmountSf) / LAMPORTS_PER_SOL : 0,
        });
        setCsSolWtCollateral(csSolWtDeposit ? Number(cTokensToUnderlying(csSolWtDeposit.depositedCtokens)) / LAMPORTS_PER_SOL : 0);
        setObligationDeposits(ob.deposits.map((d) => d.reserve));
      } else {
        setExisting({ csSolCollateral: 0, wsolDebt: 0 });
        setCsSolWtCollateral(0);
        setObligationDeposits([]);
      }

      // Withdraw queue + Jito vault config + cluster slot — drives
      // the close-mechanic timer.
      try {
        const [queueInfo, jitoCfgInfo] = await connection.getMultipleAccountsInfo(
          [withdrawQueuePda(), PublicKey.findProgramAddressSync(
            [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
          )[0]],
          "confirmed",
        );
        setQueue(queueInfo ? decodeWithdrawQueue(queueInfo.data) : null);
        setEpochLength(jitoCfgInfo ? decodeJitoConfigEpochLength(jitoCfgInfo.data) : null);
        const slot = await connection.getSlot("confirmed");
        setClusterSlot(BigInt(slot));
        setClusterNowMs(Date.now());
      } catch { /* timer just won't render */ }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  // 1Hz countdown tick — extrapolates "current slot" from the last
  // RPC sample so we don't hammer the indexer once a second.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  function projectedSlot(): bigint | null {
    if (clusterSlot === null) return null;
    const elapsedMs = Date.now() - clusterNowMs;
    return clusterSlot + BigInt(Math.floor(elapsedMs / SLOT_DURATION_MS));
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  const marginAmount = parseFloat(marginAmountStr) || 0;
  const loanAmount   = parseFloat(loanAmountStr)   || 0;

  // ── Close-mechanic state machine ────────────────────────────────────
  // - "idle":     position open, no WT — Step 1 (Convert) available
  // - "pending":  obligation has csSOL-WT but the underlying ticket
  //               hasn't matured yet — countdown
  // - "matured":  ticket(s) matured — Step 2 (Unwind) available
  type CloseStage = "idle" | "pending" | "matured" | "no-position";
  const [closeStage, ticketUnlockSlot] = useMemo<[CloseStage, bigint | null]>(() => {
    const hasPosition = (existing && (existing.csSolCollateral > 0 || existing.wsolDebt > 0)) || csSolWtCollateral > 0;
    if (!hasPosition) return ["no-position", null];
    if (csSolWtCollateral <= 0) return ["idle", null];
    // Has csSOL-WT collateral → Step 1 done. Find the earliest
    // unlock slot among the user's live (non-redeemed) tickets.
    if (!queue || !epochLength || epochLength === 0n || !wallet.publicKey) return ["pending", null];
    const userTickets = queue.tickets.filter((t) => !t.redeemed && t.staker.equals(wallet.publicKey!));
    if (userTickets.length === 0) return ["pending", null];
    // We don't have ticket slot_unstaked here without an extra RPC
    // round-trip; use the queue's createdAtSlot per ticket as a
    // conservative approximation (the actual unstake slot is later
    // by ~1 slot, so countdown undershoots by <1s).
    const unlocks = userTickets.map((t) => {
      const unstakeEpoch = t.createdAtSlot / epochLength;
      return (unstakeEpoch + 2n) * epochLength;
    });
    const earliest = unlocks.reduce((a, b) => (a < b ? a : b));
    const now = projectedSlot();
    return [now !== null && now >= earliest ? "matured" : "pending", earliest];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing, csSolWtCollateral, queue, epochLength, clusterSlot, clusterNowMs, wallet.publicKey?.toBase58()]);

  function fmtCountdown(targetSlot: bigint | null): string {
    if (targetSlot === null) return "—";
    const now = projectedSlot();
    if (now === null) return "—";
    if (now >= targetSlot) return "matured";
    const remainingSlots = Number(targetSlot - now);
    const ms = remainingSlots * SLOT_DURATION_MS;
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  }

  const quote = useMemo(() => {
    if (csSolPrice <= 0 || wsolPrice <= 0) return null;
    return quoteCreditTrade({
      marginAsset, marginAmount, loanAmount,
      csSolPriceUsd: csSolPrice, wsolPriceUsd: wsolPrice,
      existing: existing ?? undefined,
    });
  }, [marginAsset, marginAmount, loanAmount, csSolPrice, wsolPrice, existing]);

  // The flash-borrow + borrow_obligation_liquidity pair both pull
  // from wSOL_reserve.available_amount within the same tx, so the
  // pool needs ≥ 2× the loan amount in-flight. Headroom of 2% so we
  // don't tip exactly at the boundary (interest-rate accrual etc.).
  const reserveCapWsol = Math.max(wsolReserveAvailable / 2 - 0.001, 0);
  const overReserveCap = loanAmount > reserveCapWsol;
  // Effective trade-size cap shown to the user — the LOWER of the
  // LTV cap and the wSOL pool capacity.
  const effectiveMaxLoan = quote && Number.isFinite(quote.maxLoanAmount)
    ? Math.min(quote.maxLoanAmount, reserveCapWsol)
    : reserveCapWsol;

  function balanceFor(asset: MarginAsset): number {
    return asset === "SOL" ? solBal : asset === "wSOL" ? wsolBal : csSolBal;
  }

  async function onOpen() {
    if (!wallet.publicKey || !wallet.signTransaction) { setError("connect a wallet"); return; }
    if (marginAmount <= 0) { setError("Margin must be > 0"); return; }
    if (loanAmount <= 0) { setError("Trade size must be > 0"); return; }
    if (marginAmount > balanceFor(marginAsset)) {
      setError(`Insufficient ${marginAsset}: have ${balanceFor(marginAsset).toFixed(4)}, need ${marginAmount}`);
      return;
    }
    if (whitelisted === false) {
      setError("Wallet is not whitelisted on the csSOL pool — the wrap CPI in this tx will fail with AccountNotInitialized: whitelist_entry. Get whitelisted first (see banner above).");
      return;
    }
    if (overReserveCap) {
      setError(
        `Trade size ${loanAmount.toFixed(4)} wSOL exceeds the wSOL reserve's in-flight cap (${reserveCapWsol.toFixed(4)} wSOL).\n\n` +
        `The open path consumes 2× the loan from the reserve in the same tx — flash_borrow drains it once, then borrow_obligation_liquidity drains it again before flash_repay returns the flash half. ` +
        `wSOL reserve available: ${wsolReserveAvailable.toFixed(4)} → max trade size: ${reserveCapWsol.toFixed(4)} wSOL. ` +
        `Reduce trade size or wait for more wSOL liquidity in the reserve.`
      );
      return;
    }
    setBusy(true); setError(null); setLog([`opening credit trade: ${marginAmount} ${marginAsset} margin + ${loanAmount} wSOL leverage …`]);
    try {
      const owner = wallet.publicKey;
      const vaultState = await readVaultState(connection, CSSOL_VAULT);

      // Independent init checks — these are separate accounts that
      // can exist independently (e.g. user did a wrap-only earlier
      // which created user_metadata, but never deposited into klend).
      const obAddr = obligationPda(owner);
      const umAddr = userMetadataPda(owner);
      const [obInfo, umInfo] = await connection.getMultipleAccountsInfo([obAddr, umAddr], "confirmed");

      const { ixes, notes } = await buildOpenCreditTradeIxes({
        user: owner,
        marginAsset,
        marginAmount: BigInt(Math.round(marginAmount * LAMPORTS_PER_SOL)),
        loanAmount:   BigInt(Math.round(loanAmount   * LAMPORTS_PER_SOL)),
        vaultState,
        obligationDepositReserves: obligationDeposits,
        needsInitUserMetadata: !umInfo,
        needsInitObligation:   !obInfo,
        // Don't auto-close wSOL ATA — the user might want to keep it
        // around for repay/withdraw flows on the Lending tab.
        closeWsolAtaAtEnd: false,
      });

      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex}, expected csSOL deposit = ${(Number(notes.expectedCsSolDeposit) / LAMPORTS_PER_SOL).toFixed(6)})`]);

      // VersionedTransaction with the credit-trade LUT — collapses
      // the ~34 static pubkeys to 1-byte indices so the tx fits the
      // 1232-byte limit. Without this the 19-ix open path is ~1800 bytes.
      const lutAccountInfo = await connection.getAccountInfo(CREDIT_TRADE_LUT, "confirmed");
      if (!lutAccountInfo) throw new Error(`credit-trade LUT ${CREDIT_TRADE_LUT.toBase58()} not found on-chain`);
      const lutAccount = new AddressLookupTableAccount({
        key: CREDIT_TRADE_LUT,
        state: AddressLookupTableAccount.deserialize(lutAccountInfo.data),
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({
        payerKey: owner,
        recentBlockhash: blockhash,
        instructions: ixes,
      }).compileToV0Message([lutAccount]);
      const vtx = new VersionedTransaction(message);

      setLog((l) => [...l, `signing v0 tx (${vtx.serialize().byteLength} bytes via LUT) …`]);
      const signed = await wallet.signTransaction(vtx);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setLog((l) => [...l, `submitted: ${sig}`]);

      let txErr: unknown = null;
      try {
        const c = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (c.value.err) txErr = c.value.err;
      } catch (e) { txErr = e; }

      if (txErr) {
        let logs: string[] = [];
        for (let i = 0; i < 4; i++) {
          const r = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (r?.meta?.logMessages?.length) { logs = r.meta.logMessages; break; }
          await new Promise((rs) => setTimeout(rs, 750));
        }
        const errStr = typeof txErr === "string" ? txErr : (txErr as any)?.message ?? JSON.stringify(txErr);
        setError(`open failed: ${errStr}\nsig=${sig}\nexplorer: https://explorer.solana.com/tx/${sig}?cluster=devnet\n\n${logs.slice(-14).join("\n")}`);
      } else {
        setLog((l) => [...l, `✓ confirmed`]);
        await refresh();
      }
    } catch (e: any) {
      setError(e?.message ?? JSON.stringify(e, null, 2));
    } finally {
      setBusy(false);
    }
  }

  /** Send a v0 transaction with the credit-trade LUT applied. Shared
   *  by the open / convert / unwind paths so error/refresh handling
   *  is consistent. */
  async function sendVtx(label: string, ixes: import("@solana/web3.js").TransactionInstruction[]) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    const owner = wallet.publicKey;
    const lutAccountInfo = await connection.getAccountInfo(CREDIT_TRADE_LUT, "confirmed");
    if (!lutAccountInfo) throw new Error(`credit-trade LUT ${CREDIT_TRADE_LUT.toBase58()} not found`);
    const lutAccount = new AddressLookupTableAccount({
      key: CREDIT_TRADE_LUT,
      state: AddressLookupTableAccount.deserialize(lutAccountInfo.data),
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: owner, recentBlockhash: blockhash, instructions: ixes,
    }).compileToV0Message([lutAccount]);
    const vtx = new VersionedTransaction(message);
    setLog((l) => [...l, `signing ${label} v0 tx (${vtx.serialize().byteLength} bytes via LUT) …`]);
    const signed = await wallet.signTransaction(vtx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    setLog((l) => [...l, `submitted ${label}: ${sig}`]);

    let txErr: unknown = null;
    try {
      const c = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (c.value.err) txErr = c.value.err;
    } catch (e) { txErr = e; }
    if (txErr) {
      let logs: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (r?.meta?.logMessages?.length) { logs = r.meta.logMessages; break; }
        await new Promise((rs) => setTimeout(rs, 750));
      }
      const errStr = typeof txErr === "string" ? txErr : (txErr as any)?.message ?? JSON.stringify(txErr);
      throw new Error(`${label} failed: ${errStr}\nsig=${sig}\nexplorer: https://explorer.solana.com/tx/${sig}?cluster=devnet\n\n${logs.slice(-14).join("\n")}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
  }

  /** Step 1 — convert csSOL collateral to csSOL-WT via flash loan. The
   *  amount comes from the user-typed input on the Convert panel; we
   *  clamp to the available csSOL collateral so a too-large input
   *  doesn't trip the withdraw ix. */
  async function onConvert() {
    if (!wallet.publicKey || !existing) return;
    if (existing.csSolCollateral <= 0) {
      setError("No csSOL collateral to convert.");
      return;
    }
    if (!queue) { setError("Withdraw queue not loaded — refresh and retry."); return; }
    const typed = parseFloat(convertAmountStr);
    if (!(typed > 0)) { setError("Enter a csSOL amount > 0 to convert."); return; }
    const requested = Math.min(typed, existing.csSolCollateral);
    setBusy(true); setError(null); setLog([`converting ${requested.toFixed(6)} csSOL → csSOL-WT …`]);
    try {
      const owner = wallet.publicKey;
      const vaultState = await readVaultState(connection, CSSOL_VAULT);
      const amount = BigInt(Math.floor(requested * LAMPORTS_PER_SOL));
      const { ixes, notes } = await buildCloseStep1ConvertIxes({
        user: owner, amount, vaultState,
        queueTotalMinted: queue.totalCssolWtMinted,
        preDepositReserves: obligationDeposits,
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex})`]);
      await sendVtx("convert", ixes);
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? JSON.stringify(e, null, 2));
    } finally {
      setBusy(false);
    }
  }

  /** Step 2 — flash-loan-assisted unwind of pct% of the position. */
  async function onUnwind() {
    if (!wallet.publicKey || !existing) return;
    const pct = parseFloat(closePctStr) / 100;
    if (!(pct > 0 && pct <= 1)) { setError("Pick a percentage between 1 and 100."); return; }
    if (csSolWtCollateral <= 0) { setError("No csSOL-WT collateral to unwind."); return; }
    if (existing.wsolDebt <= 0)   { setError("No wSOL debt to repay."); return; }
    setBusy(true); setError(null);
    setLog([`unwinding ${(pct * 100).toFixed(0)}%: repay ${(existing.wsolDebt * pct).toFixed(6)} wSOL, redeem ${(csSolWtCollateral * pct).toFixed(6)} csSOL-WT …`]);
    try {
      const owner = wallet.publicKey;
      const repayAmount  = BigInt(Math.floor(existing.wsolDebt * pct * LAMPORTS_PER_SOL));
      const redeemAmount = BigInt(Math.floor(csSolWtCollateral * pct * LAMPORTS_PER_SOL));
      const { ixes, notes } = await buildCloseStep2UnwindIxes({
        user: owner,
        repayAmount, redeemAmount,
        obligationDepositReserves: obligationDeposits,
        closeWsolAtaAtEnd: pct >= 1, // 100% close → margin returns as native SOL
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex})`]);
      await sendVtx("unwind", ixes);
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? JSON.stringify(e, null, 2));
    } finally {
      setBusy(false);
    }
  }

  // ── UI ──────────────────────────────────────────────────────────────

  if (!wallet.publicKey) {
    return (
      <section className="max-w-5xl">
        <h2 className="text-2xl font-bold mb-2">Credit trade</h2>
        <p className="opacity-70 mb-6">One-tx leveraged csSOL/wSOL position via flash-loan + Jito-vault wrap + klend.</p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  const equityUsd = quote ? Math.max(quote.collateralUsd - quote.debtUsd, 0) : 0;
  const overCap = quote ? quote.ltvAfterPct >= 90 : false;

  return (
    <section className="max-w-6xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">Credit trade</h2>
        <p className="opacity-70 mt-1 text-sm">
          {pair === "csSOL/wSOL" ? (
            <>One-tx leveraged position: flash-borrow wSOL → wrap (margin + loan)
            via Jito vault → deposit csSOL collateral → borrow wSOL → flash-repay.
            Target eMode 2 (90% LTV / 92% liq). Margin can be SOL, wSOL, or csSOL.</>
          ) : (
            <>Manual deposit + borrow against ceUSX collateral / sUSDC debt in
            klend's Stables eMode (group 1, 90% LTV / 92% liq). Atomic 1-tx
            looping is impossible because Solstice gates USX <code>RequestMint</code> /
            <code>RequestRedeem</code> behind an operator multisig, so the
            sUSDC↔USX hop cannot be CPI'd from a user-signed tx.</>
          )}
        </p>
      </header>

      {/* KYC banner — only relevant for the csSOL pair (the
          credit-trade open path mints csSOL via delta-mint). The ceUSX
          pair has its own KYC story (Solstice institutional onboarding)
          surfaced inside CreditTradeEusxPanel. */}
      {pair === "csSOL/wSOL" && whitelisted === false ? (
        <div className="alert alert-warning text-sm">
          <span>
            <strong>Wallet not whitelisted.</strong> The credit-trade open
            tx mints csSOL via delta-mint, which requires this wallet's
            whitelist_entry PDA. Run{" "}
            <code className="text-xs">DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json npx tsx scripts/whitelist-wallet.ts {wallet.publicKey?.toBase58()} holder</code>{" "}
            from <code className="text-xs">packages/programs</code>, then
            refresh.
            {whitelistPda ? <> PDA: <code className="text-xs">{whitelistPda.toBase58().slice(0, 6)}…{whitelistPda.toBase58().slice(-4)}</code></> : null}
          </span>
        </div>
      ) : pair === "csSOL/wSOL" && whitelisted === true ? (
        <div className="text-xs opacity-60 flex items-center gap-2">
          <span className="badge badge-success badge-sm">whitelisted</span>
          <span>csSOL pool Holder role active.</span>
        </div>
      ) : null}

      {/* Pair selector */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-center gap-3">
            <span className="font-bold text-sm">Pair:</span>
            <select
              className="select select-bordered select-sm"
              value={pair}
              onChange={(e) => setPair(e.target.value as Pair)}
              disabled={busy}
            >
              {PAIRS.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.active}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ceUSX / sUSDC — manual deposit + borrow flow. Atomic loop is
          impossible because Solstice's USX program gates RequestMint /
          RequestRedeem behind their operator multisig; see
          CreditTradeEusxPanel.tsx for the full UI + handlers. */}
      {pair === "ceUSX/sUSDC" ? <CreditTradeEusxPanel /> : null}

      {/* csSOL / wSOL — atomic 1-tx leveraged loop via flash_borrow +
          wrap_with_jito_vault + deposit + request_elevation_group +
          borrow + flash_repay. Everything below this line is csSOL-specific. */}
      {pair === "csSOL/wSOL" ? (<>

      {/* Pool liquidity — the open path's hard ceiling. The wSOL
          reserve's available_amount is consumed twice within one tx
          (flash_borrow + borrow_obligation_liquidity), so the trade
          size is bounded by available/2. Surface both halves so the
          user can see the ceiling before designing a position. */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between">
            <span className="font-bold text-sm">Pool liquidity (wSOL)</span>
            <span className="text-[11px] opacity-60">
              flash + borrow consume 2× loan in-flight
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-2 text-sm">
            <div>
              <div className="opacity-60 text-[11px]">Available</div>
              <div className="font-mono">{fmt(wsolReserveAvailable)}</div>
              <div className="text-[10px] opacity-50">{fmtUsd(wsolReserveAvailable * wsolPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">Flash capacity</div>
              <div className="font-mono">{fmt(wsolReserveAvailable)}</div>
              <div className="text-[10px] opacity-50">single ix can flash up to this</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">Open-path cap</div>
              <div className={`font-mono ${overReserveCap ? "text-warning" : ""}`}>{fmt(reserveCapWsol)}</div>
              <div className="text-[10px] opacity-50">≈ available / 2</div>
            </div>
          </div>
          {overReserveCap ? (
            <div className="alert alert-warning text-xs mt-2">
              <span>
                Trade size {loanAmount.toFixed(4)} wSOL exceeds the open-path
                cap of {reserveCapWsol.toFixed(4)} wSOL. Reduce trade size or wait
                for more wSOL liquidity (Lending tab → wSOL → Deposit).
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* Existing position */}
      {existing && (existing.csSolCollateral > 0 || existing.wsolDebt > 0) ? (
        <div className="card bg-base-200">
          <div className="card-body p-4">
            <div className="font-bold text-sm mb-2">Existing position</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="opacity-60 text-xs">Collateral (csSOL)</div>
                <div className="font-mono">{fmt(existing.csSolCollateral)}</div>
                <div className="text-xs opacity-50">{fmtUsd(existing.csSolCollateral * csSolPrice)}</div>
              </div>
              <div>
                <div className="opacity-60 text-xs">Debt (wSOL)</div>
                <div className="font-mono">{fmt(existing.wsolDebt)}</div>
                <div className="text-xs opacity-50">{fmtUsd(existing.wsolDebt * wsolPrice)}</div>
              </div>
              <div>
                <div className="opacity-60 text-xs">Equity</div>
                <div className="font-mono">{fmtUsd(existing.csSolCollateral * csSolPrice - existing.wsolDebt * wsolPrice)}</div>
              </div>
              <div>
                <div className="opacity-60 text-xs">Current LTV</div>
                <div className="font-mono">
                  {existing.csSolCollateral * csSolPrice > 0
                    ? ((existing.wsolDebt * wsolPrice) / (existing.csSolCollateral * csSolPrice) * 100).toFixed(2) + "%"
                    : "0.00%"}
                </div>
              </div>
            </div>
            <div className="text-xs opacity-60 mt-2">The form below {existing.wsolDebt > 0 ? "will INCREASE" : "will OPEN"} this position.</div>
          </div>
        </div>
      ) : null}

      {/* Close position — two-step (convert → wait → unwind) */}
      {closeStage !== "no-position" ? (
        <div className="card bg-base-300/60">
          <div className="card-body p-4 space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="font-bold text-sm">Close position</span>
              <span className="text-[11px] opacity-60">
                csSOL → csSOL-WT (epoch lock) → wSOL → repay debt
              </span>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-2 text-xs">
              <Step n={1} label="Convert"  active={closeStage === "idle"}    done={closeStage !== "idle"} />
              <span className="opacity-30">→</span>
              <Step n={2} label="Wait"      active={closeStage === "pending"} done={closeStage === "matured"} />
              <span className="opacity-30">→</span>
              <Step n={3} label="Unwind"    active={closeStage === "matured"} done={false} />
            </div>

            {closeStage === "idle" ? (
              <div className="space-y-2">
                <div className="text-xs opacity-70">
                  Convert a csSOL amount into a csSOL withdraw ticket
                  (csSOL-WT). The ticket is epoch-locked by the underlying
                  Jito vault — once mature it's redeemable 1:1 for wSOL,
                  which we'll use to repay your debt in step 3. Type the
                  exact csSOL amount to convert; this size drives the
                  flash-loan and the obligation collateral swap directly.
                </div>
                <div className="flex items-baseline justify-between text-[11px] mb-1">
                  <span className="opacity-60">Available — csSOL collateral</span>
                  <span className="font-mono">{existing ? fmt(existing.csSolCollateral) : "—"} csSOL</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number" step="any" min="0"
                    className="input input-sm input-bordered w-40 font-mono"
                    placeholder="0.00"
                    value={convertAmountStr}
                    onChange={(e) => setConvertAmountStr(e.target.value)}
                    disabled={busy}
                  />
                  <span className="text-xs opacity-60">csSOL</span>
                  <button
                    className="btn btn-xs btn-ghost"
                    disabled={busy || !existing || existing.csSolCollateral <= 0}
                    onClick={() => setConvertAmountStr((existing?.csSolCollateral ?? 0).toFixed(6))}
                  >
                    Max
                  </button>
                  <div className="flex-1" />
                  <button
                    className="btn btn-sm btn-warning"
                    disabled={busy || !existing || existing.csSolCollateral <= 0 || !queue || !convertAmountStr || parseFloat(convertAmountStr) <= 0}
                    onClick={() => void onConvert()}
                  >
                    {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                    Convert {convertAmountStr || "—"} csSOL → csSOL-WT
                  </button>
                </div>
              </div>
            ) : null}

            {closeStage === "pending" ? (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="opacity-60 text-[11px]">csSOL-WT collateral</div>
                    <div className="font-mono">{fmt(csSolWtCollateral)}</div>
                  </div>
                  <div>
                    <div className="opacity-60 text-[11px]">wSOL debt</div>
                    <div className="font-mono">{fmt(existing?.wsolDebt ?? 0)}</div>
                  </div>
                  <div>
                    <div className="opacity-60 text-[11px]">Time to maturity</div>
                    <div className="font-mono text-warning">{fmtCountdown(ticketUnlockSlot)}</div>
                    <div className="text-[10px] opacity-50">
                      unlocks at slot {ticketUnlockSlot?.toString() ?? "—"}
                    </div>
                  </div>
                </div>
                <div className="alert alert-info text-xs">
                  <span>
                    Ticket is in the Jito vault unstake queue. Klend will
                    keep accruing borrow interest until you complete step 3.
                  </span>
                </div>
              </div>
            ) : null}

            {closeStage === "matured" ? (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <div className="opacity-60 text-[11px]">csSOL-WT collateral</div>
                    <div className="font-mono">{fmt(csSolWtCollateral)}</div>
                  </div>
                  <div>
                    <div className="opacity-60 text-[11px]">wSOL debt</div>
                    <div className="font-mono">{fmt(existing?.wsolDebt ?? 0)}</div>
                  </div>
                  <div>
                    <div className="opacity-60 text-[11px]">Status</div>
                    <div className="font-mono text-success">matured ✓</div>
                  </div>
                </div>
                <div>
                  <label className="text-xs opacity-70 block mb-1">
                    Unwind percentage <span className="opacity-60">(100% closes the position and returns margin)</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range" min="1" max="100" step="1"
                      value={closePctStr}
                      onChange={(e) => setClosePctStr(e.target.value)}
                      className="range range-sm range-primary flex-1"
                      disabled={busy}
                    />
                    <span className="font-mono text-sm w-14 text-right">{closePctStr}%</span>
                  </div>
                  <div className="text-[11px] opacity-60 mt-1">
                    redeem ≈ <span className="font-mono">{fmt(csSolWtCollateral * (parseFloat(closePctStr) / 100))}</span> csSOL-WT
                    → repay <span className="font-mono">{fmt(Math.min(existing?.wsolDebt ?? 0, csSolWtCollateral * (parseFloat(closePctStr) / 100)))}</span> wSOL debt
                    {parseFloat(closePctStr) >= 100 ? (
                      <> + withdraw remaining collateral as native SOL</>
                    ) : null}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy || csSolWtCollateral <= 0 || (existing?.wsolDebt ?? 0) <= 0}
                  onClick={() => void onUnwind()}
                >
                  {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                  Unwind {closePctStr}%
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Open form + calculator side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form */}
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-4">
            <div className="font-bold text-sm">{existing && existing.wsolDebt > 0 ? "Increase position" : "Open position"}</div>

            {/* Margin asset */}
            <div>
              <label className="text-xs opacity-70 block mb-1">Margin asset</label>
              <div className="join">
                {(["SOL", "wSOL", "csSOL"] as MarginAsset[]).map((a) => (
                  <button
                    key={a}
                    className={`btn btn-sm join-item ${marginAsset === a ? "btn-primary" : ""}`}
                    onClick={() => setMarginAsset(a)}
                    disabled={busy}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <div className="text-[11px] opacity-60 mt-1 font-mono">
                wallet: {balanceFor(marginAsset).toFixed(4)} {marginAsset}
              </div>
            </div>

            <div>
              <label className="text-xs opacity-70 block mb-1">Margin amount</label>
              <div className="flex items-center gap-2">
                <input type="number" step="0.001" min="0" placeholder="0.05"
                  className="input input-bordered input-sm w-40 font-mono"
                  value={marginAmountStr}
                  onChange={(e) => setMarginAmountStr(e.target.value)}
                  disabled={busy} />
                <span className="text-xs opacity-60">{marginAsset}</span>
                <button className="btn btn-xs btn-ghost"
                  disabled={busy} onClick={() => setMarginAmountStr(balanceFor(marginAsset).toFixed(6))}>max</button>
              </div>
            </div>

            <div>
              <label className="text-xs opacity-70 block mb-1">Trade size (wSOL borrowed = leverage)</label>
              <div className="flex items-center gap-2">
                <input type="number" step="0.001" min="0" placeholder="0.45"
                  className="input input-bordered input-sm w-40 font-mono"
                  value={loanAmountStr}
                  onChange={(e) => setLoanAmountStr(e.target.value)}
                  disabled={busy} />
                <span className="text-xs opacity-60">wSOL</span>
                {effectiveMaxLoan > 0 ? (
                  <button className="btn btn-xs btn-ghost"
                    disabled={busy}
                    onClick={() => setLoanAmountStr((effectiveMaxLoan * 0.95).toFixed(4))}
                  >0.95×max</button>
                ) : null}
              </div>
              {quote && Number.isFinite(quote.maxLoanAmount) ? (
                <div className="text-[11px] opacity-60 mt-1 space-y-0.5">
                  <div>max at 90% LTV: <span className="font-mono">{quote.maxLoanAmount.toFixed(4)}</span> wSOL</div>
                  <div>max from reserve liquidity: <span className="font-mono">{reserveCapWsol.toFixed(4)}</span> wSOL <span className="opacity-50">(½ of {wsolReserveAvailable.toFixed(4)} available)</span></div>
                  <div className="font-bold">effective max: <span className="font-mono">{effectiveMaxLoan.toFixed(4)}</span> wSOL</div>
                </div>
              ) : null}
            </div>

            <button
              className={`btn btn-primary btn-block ${(overCap || overReserveCap) ? "btn-disabled" : ""}`}
              disabled={busy || marginAmount <= 0 || loanAmount <= 0 || overCap || overReserveCap || whitelisted === false}
              onClick={() => void onOpen()}
            >
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              {existing && existing.wsolDebt > 0 ? "Increase position" : "Open position"}
            </button>
            {obligationExists === false ? (
              <div className="text-[11px] opacity-60">First trade — your obligation will be initialized in this tx.</div>
            ) : null}
          </div>
        </div>

        {/* Calculator */}
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-2">
            <div className="font-bold text-sm">Position after open</div>
            {!quote ? (
              <div className="text-xs opacity-60">Enter prices loading…</div>
            ) : (
              <>
                <Row label="Collateral (csSOL)" value={fmt(quote.collateralCsSol)} sub={fmtUsd(quote.collateralUsd)} />
                <Row label="Debt (wSOL)"        value={fmt(quote.debtWsol)}        sub={fmtUsd(quote.debtUsd)} />
                <Row label="Equity"             value={fmtUsd(equityUsd)} />
                <Row label="Leverage"           value={`${quote.leverage.toFixed(2)}×`} />
                <Row label="LTV"                value={`${quote.ltvAfterPct.toFixed(2)}%`} warn={overCap} />
                <Row label="Health"             value={Number.isFinite(quote.health) ? `${quote.health.toFixed(2)}` : "∞"} warn={Number.isFinite(quote.health) && quote.health < 1.1} />
                <Row label="Liquidation csSOL price" value={fmtUsd(quote.liquidationCsSolPriceUsd)} />
                {quote.warnings.length > 0 ? (
                  <div className="alert alert-warning text-xs mt-2">
                    <ul className="list-disc pl-4">
                      {quote.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tx console */}
      {(busy || log.length > 0 || error) ? (
        <div className="card bg-base-200">
          <div className="card-body p-3 gap-2">
            <div className="flex items-center justify-between">
              <div className="font-bold text-sm flex items-center gap-2">
                {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                Transaction console
                {error ? <span className="badge badge-error badge-sm">error</span> : busy ? <span className="badge badge-info badge-sm">running</span> : log.length > 0 ? <span className="badge badge-success badge-sm">done</span> : null}
              </div>
              <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => { setLog([]); setError(null); }}>Clear</button>
            </div>
            {log.length > 0 ? (
              <pre className="bg-base-300 rounded p-2 text-[11px] whitespace-pre-wrap font-mono max-h-40 overflow-auto">{log.join("\n")}</pre>
            ) : null}
            {error ? (
              <pre className="alert alert-error text-[11px] whitespace-pre-wrap p-2 rounded max-h-64 overflow-auto">{error}</pre>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="text-xs opacity-60">
        Pair: csSOL / wSOL · csSOL price: {fmtUsd(csSolPrice)} · wSOL price: {fmtUsd(wsolPrice)} ·
        v3 market · eMode 2 (90% LTV / 92% liq) · flash fee 0
      </div>

      </>) : null}
    </section>
  );
}

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <span className={`badge ${done ? "badge-success" : active ? "badge-primary" : "badge-ghost"} badge-sm gap-1`}>
      {done ? "✓" : n}. {label}
    </span>
  );
}

function Row({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="opacity-70 text-xs">{label}</span>
      <div className="text-right">
        <div className={`font-mono ${warn ? "text-warning" : ""}`}>{value}</div>
        {sub ? <div className="text-[10px] opacity-50">{sub}</div> : null}
      </div>
    </div>
  );
}
