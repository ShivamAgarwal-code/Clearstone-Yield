/**
 * CssolWsolCreditPanel — atomic 1-tx leveraged loop on EG-2.
 * Post-2026-05-06 the EG-2 debt asset is cSOL (KYC-wrapped wSOL via the
 * v3 native pool); wSOL only appears as a transient inside the bundle
 * (Jito vault input).
 *
 * Open: flash-borrow cSOL → unwrap_native → Jito-wrap (margin + loan) →
 * deposit csSOL → request_elevation_group(2) → borrow cSOL → flash-repay.
 * Close: two-step Convert (csSOL → csSOL-WT, queues Jito unstake) →
 * wait for Jito epoch + 2 → Unwind (redeem WT → wSOL → wrap_native cSOL
 * → repay cSOL debt).
 *
 * Internal variable names (`wsolReserveAvailable`, `wsolDebt`, etc.)
 * predate the 2026-05-06 migration and carry cSOL values today —
 * renaming is a separate cleanup; user-facing strings have already
 * been switched to "cSOL".
 *
 * Mirrors `frontend-playground/src/tabs/CreditTradeTab.tsx` UX, rebuilt
 * with `@clearstone/design-system` primitives.
 */

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  KeyValue,
  SectionHeader,
  Snackbar,
  Stat,
  TokenAmountInput,
  TokenIcon,
  TokenSymbol,
  cn,
} from "@clearstone/design-system";

import {
  CREDIT_TRADE_LUT,
  CSOL_RESERVE,
  CSOL_RESERVE_ORACLE,
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_VRT_MINT,
  CSSOL_WT_RESERVE,
  DELTA_MINT_PROGRAM,
  DM_MINT_CONFIG,
  JITO_VAULT_PROGRAM,
  POOL_PENDING_WSOL_ACCOUNT,
} from "../../lib/credit-trade/addresses";
import { obligationPda, userMetadataPda } from "../../lib/credit-trade/klendIx";
import { readVaultState } from "../../lib/credit-trade/jitoVault";
import {
  buildCloseStep1ConvertIxes,
  buildCloseStep2UnwindIxes,
  buildOpenCreditTradeIxes,
  quoteCreditTrade,
  type MarginAsset,
} from "../../lib/credit-trade/creditTrade";
import {
  cTokensToUnderlying,
  readObligation,
  readReserve,
  sfToNumber,
} from "../../lib/credit-trade/obligationView";
import {
  buildMatureWithdrawalTicketsIx,
  decodeJitoConfigEpochLength,
  decodeJitoConfigProgramFeeBps,
  decodeJitoConfigProgramFeeWallet,
  decodeWithdrawQueue,
  withdrawQueuePda,
  type DecodedQueue,
} from "../../lib/credit-trade/cssolWt";
import { ObligationSwitcher } from "../ObligationSwitcher";
import { useObligationCatalog } from "../../hooks/useObligationCatalog";

// Default credit-trade obligation seed-id. Klend allows up to 256
// obligations per (wallet, market). Each id derives a distinct PDA via
// `obligationPda(owner, 0, id)`. The panel defaults to id=0 (the
// historical credit-trade obligation); the user can flip to any other
// id via the ObligationSwitcher. PositionsPage's "manage" obligation
// at id=3 is also surfaced in the catalog (see `useObligationCatalog`)
// so the desk can hop between manage and credit-trade slots in one
// place.
const CREDIT_TRADE_DEFAULT_OB_ID = 0;

const SLOT_DURATION_MS = 400;

// Yield / cost rates surfaced in the position summary so the desk sees
// the live carry maths at a glance. csSOL inherits the Jito restaking
// yield; the cSOL borrow APR comes from the klend reserve curve in
// future, hard-coded here as a representative devnet rate. Update as
// the live wiring lands. (Constant name kept as `WSOL_*` for now —
// renaming is a separate cleanup; the rate semantically applies to
// cSOL since 2026-05-06.)
const CSSOL_RESTAKING_APR = 0.0581;     // 5.81% — Jito-style restaking
const WSOL_BORROW_APR_PLACEHOLDER = 0.045;  // 4.50% — cSOL borrow APR placeholder until live curve wired
const fmtApr = (a: number) => `${(a * 100).toFixed(2)}%`;

function fmt(n: number, dp = 4): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type CloseStage = "idle" | "pending" | "matured" | "no-position";

interface CssolWsolCreditPanelProps {
  /** Controlled obligation id from the parent page. When supplied the
   *  panel hands selection back to the parent (so the page can snap
   *  the credit-trade variant when the user picks an EG-1 / EG-2
   *  obligation, etc.). Falls back to internal state for standalone
   *  usage. */
  obligationId?: number;
  onObligationChange?: (id: number) => void;
}

export default function CssolWsolCreditPanel({ obligationId, onObligationChange }: CssolWsolCreditPanelProps = {}) {
  const { connection } = useConnection();
  const wallet = useWallet();

  // ── Active obligation id ──
  // Klend keys obligations by `(wallet, tag, id)` so a single wallet
  // can run multiple parallel positions on the same market. The panel
  // defaults to id=0 (credit-trade convention), with a switcher above
  // the form to pick any id and a `+ New` action that allocates the
  // lowest unused slot. Every action below threads the selected id
  // into the bundle builders so they target the right PDA.
  // Controlled-with-fallback: if the parent supplies `obligationId`,
  // the panel uses it (and reports changes upstream); otherwise it
  // owns its own state.
  const [internalObligationId, setInternalObligationId] = useState<number>(CREDIT_TRADE_DEFAULT_OB_ID);
  const selectedObligationId = obligationId ?? internalObligationId;
  const setSelectedObligationId = (id: number) => {
    setInternalObligationId(id);
    onObligationChange?.(id);
  };
  const [catalogNonce, setCatalogNonce] = useState(0);
  const { catalog: obligationCatalog } = useObligationCatalog({
    selected: selectedObligationId,
    nonce: catalogNonce,
  });

  // Live state
  const [csSolPrice, setCsSolPrice] = useState(0);
  const [wsolPrice, setWsolPrice] = useState(0);
  const [solBal, setSolBal] = useState(0);
  const [wsolBal, setWsolBal] = useState(0);
  const [csSolBal, setCsSolBal] = useState(0);
  const [wsolReserveAvailable, setWsolReserveAvailable] = useState(0);
  /** Live cSOL borrow APR — interpolated from the on-chain 11-point
   *  curve at the reserve's current utilization. Falls back to the
   *  WSOL_BORROW_APR_PLACEHOLDER until the first refresh() lands so
   *  the carry-maths surface doesn't flicker zeros on cold mount. */
  const [csolBorrowApr, setCsolBorrowApr] = useState<number>(WSOL_BORROW_APR_PLACEHOLDER);
  const [existing, setExisting] = useState<{ csSolCollateral: number; wsolDebt: number }>({ csSolCollateral: 0, wsolDebt: 0 });
  const [obligationExists, setObligationExists] = useState<boolean | null>(null);
  const [obligationDeposits, setObligationDeposits] = useState<PublicKey[]>([]);
  const [obligationBorrows, setObligationBorrows] = useState<PublicKey[]>([]);
  const [obligationEg, setObligationEg] = useState<number>(0);
  const [whitelisted, setWhitelisted] = useState<boolean | null>(null);
  const [whitelistPda, setWhitelistPda] = useState<PublicKey | null>(null);
  // Jito vault `fee_wallet` — needed only when calling
  // `mature_withdrawal_tickets` (the ix sweeps Jito + program fees out
  // of the maturing ticket, and the program reads them off the vault
  // record). Cached on first refresh; doesn't change.
  const [feeWallet, setFeeWallet] = useState<PublicKey | null>(null);
  // Jito **Config**'s `program_fee_wallet` — distinct from the vault's
  // own `fee_wallet`. The mature-ticket Jito CPI takes two fee ATAs;
  // the program-fee one MUST be derived from this pubkey. Mismatch
  // surfaces as Jito's "Account is not the associated token account".
  const [programFeeWallet, setProgramFeeWallet] = useState<PublicKey | null>(null);
  // JitoConfig.program_fee_bps — the wSOL Jito withholds from each
  // burn payout. Governor's mature_withdrawal_tickets sweeps the
  // FULL ticket amount from the user's wSOL ATA, so the frontend
  // must pre-fund the fee delta or the sweep fails with Token
  // program custom 0x1 ("insufficient funds"). 10 bps on devnet.
  const [programFeeBps, setProgramFeeBps] = useState<number>(0);

  // Form
  const [marginAsset, setMarginAsset] = useState<MarginAsset>("SOL");
  const [marginAmountStr, setMarginAmountStr] = useState("0.05");
  const [loanAmountStr, setLoanAmountStr] = useState("0.45");

  // Close-mechanic state
  const [csSolWtCollateral, setCsSolWtCollateral] = useState(0);
  const [queue, setQueue] = useState<DecodedQueue | null>(null);
  const [epochLength, setEpochLength] = useState<bigint | null>(null);
  const [clusterSlot, setClusterSlot] = useState<bigint | null>(null);
  const [clusterNowMs, setClusterNowMs] = useState<number>(Date.now());
  const [, forceTick] = useState(0);
  const [closePctStr, setClosePctStr] = useState<string>("100");
  // Collateral-unwind form state — the inline panel that lets the user
  // pull csSOL out of klend and into a wallet-level withdraw ticket.
  const [unwindOpen, setUnwindOpen] = useState(false);
  const [unwindAmountStr, setUnwindAmountStr] = useState<string>("");
  // Inline WT redeem (matured-ticket flash unwind, mirrors the csSOL
  // row's collateral-unwind toggle but redeems WT → wSOL → repays debt).
  const [wtUnwindOpen, setWtUnwindOpen] = useState(false);
  const [wtUnwindAmountStr, setWtUnwindAmountStr] = useState<string>("");
  // Expand-collapse for the per-ticket detail view inside the csSOL-WT
  // collateral row. The on-chain WT collateral is fungible across all
  // queued tickets — this view is read-only inspection that lets the
  // user see exactly how much is matured-now vs. still pending.
  const [wtTicketsExpanded, setWtTicketsExpanded] = useState(false);

  // Tx state
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Short human-readable description of what the user just kicked off
  // (e.g. "Unwinding 0.001 csSOL collateral"). Forwarded to both the
  // console log AND the failure / success toast so the user knows which
  // action bounced or landed when multiple panels are stacked.
  const [intent, setIntent] = useState<string | null>(null);
  // Confirmed signature of the most recent action — drives the success
  // toast. Set by sendVtx on the confirmation-success path so every
  // handler (open/convert/unwind/collateral-unwind) gets a toast for
  // free without each one having to wire it.
  const [confirmedSig, setConfirmedSig] = useState<string | null>(null);

  const refresh = async () => {
    if (!wallet.publicKey) return;
    setError(null);
    try {
      // Post-migration: the EG-2 debt-side numbers come from the cSOL
      // reserve, not wSOL. cSOL's Pyth feed is the same wSOL feed
      // (1:1 wrapper), so the price reading is identical — the diff
      // is just which reserve's `availableAmount` drives the
      // open-path liquidity cap.
      const [csSolReserveView, csolReserveView] = await Promise.all([
        readReserve(connection, CSSOL_RESERVE, CSSOL_RESERVE_ORACLE),
        readReserve(connection, CSOL_RESERVE,  CSOL_RESERVE_ORACLE),
      ]);
      if (csSolReserveView) setCsSolPrice(sfToNumber(csSolReserveView.marketPriceSf));
      if (csolReserveView) {
        setWsolPrice(sfToNumber(csolReserveView.marketPriceSf));
        setWsolReserveAvailable(Number(csolReserveView.availableAmount) / LAMPORTS_PER_SOL);
        // Live cSOL borrow APR off the on-chain curve at the reserve's
        // current utilization. Replaces the WSOL_BORROW_APR_PLACEHOLDER
        // hard-code so the carry-maths surface tracks rate changes when
        // the curve gets retuned via the console RateCurvePanel.
        setCsolBorrowApr(csolReserveView.borrowApr);
      }

      const userCsSolAta = getAssociatedTokenAddressSync(
        CSSOL_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userWsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const [solLamports, csSolInfo, wsolInfo] = await Promise.all([
        connection.getBalance(wallet.publicKey, "confirmed"),
        connection.getAccountInfo(userCsSolAta, "confirmed"),
        connection.getAccountInfo(userWsolAta, "confirmed"),
      ]);
      setSolBal(solLamports / LAMPORTS_PER_SOL);
      setCsSolBal(csSolInfo && csSolInfo.data.length >= 72 ? Number(csSolInfo.data.readBigUInt64LE(64)) / LAMPORTS_PER_SOL : 0);
      setWsolBal(wsolInfo && wsolInfo.data.length >= 72 ? Number(wsolInfo.data.readBigUInt64LE(64)) / LAMPORTS_PER_SOL : 0);

      // KYC gate
      const [wlPda] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("whitelist"), DM_MINT_CONFIG.toBuffer(), wallet.publicKey.toBuffer()],
        DELTA_MINT_PROGRAM,
      );
      setWhitelistPda(wlPda);
      const wlInfo = await connection.getAccountInfo(wlPda, "confirmed");
      setWhitelisted(!!wlInfo);

      // Obligation — read the SELECTED slot (default 0).
      const ob = await readObligation(connection, wallet.publicKey, selectedObligationId);
      setObligationExists(ob.exists);
      if (ob.exists) {
        const csSolDeposit = ob.deposits.find((d) => d.reserve.equals(CSSOL_RESERVE));
        const wsolBorrow = // Post-2026-05-06 migration: EG-2 debt is cSOL. Legacy wSOL-debt
// obligations no longer exist (drain confirmed; reserve is Hidden
// with limits zeroed). If a legacy obligation somehow surfaces it
// won't show debt here — that's intentional, the close path can
// only operate on cSOL-debt obligations now.
ob.borrows.find((b) => b.reserve.equals(CSOL_RESERVE));
        const wtReserve = CSSOL_WT_RESERVE;
        const csSolWtDeposit = wtReserve ? ob.deposits.find((d) => d.reserve.equals(wtReserve)) : undefined;
        setExisting({
          csSolCollateral: csSolDeposit ? Number(cTokensToUnderlying(csSolDeposit.depositedCtokens)) / LAMPORTS_PER_SOL : 0,
          wsolDebt: wsolBorrow ? sfToNumber(wsolBorrow.borrowedAmountSf) / LAMPORTS_PER_SOL : 0,
        });
        setCsSolWtCollateral(csSolWtDeposit ? Number(cTokensToUnderlying(csSolWtDeposit.depositedCtokens)) / LAMPORTS_PER_SOL : 0);
        setObligationDeposits(ob.deposits.map((d) => d.reserve));
        setObligationBorrows(ob.borrows.map((b) => b.reserve));
        setObligationEg(ob.elevationGroup);
      } else {
        setExisting({ csSolCollateral: 0, wsolDebt: 0 });
        setCsSolWtCollateral(0);
        setObligationDeposits([]);
        setObligationBorrows([]);
        setObligationEg(0);
      }

      // Catalog refresh — pull the live obligation summaries via the
      // shared `useObligationCatalog` hook by bumping its nonce. The
      // hook already runs on selection change; this trigger keeps it
      // in lockstep with the panel's own refresh after deposits/
      // borrows so the displayed collateralUsd reflects the new state.
      setCatalogNonce((n) => n + 1);

      try {
        const [queueInfo, jitoCfgInfo] = await connection.getMultipleAccountsInfo(
          [withdrawQueuePda(), PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], JITO_VAULT_PROGRAM)[0]],
          "confirmed",
        );
        setQueue(queueInfo ? decodeWithdrawQueue(queueInfo.data) : null);
        if (jitoCfgInfo) {
          setEpochLength(decodeJitoConfigEpochLength(jitoCfgInfo.data));
          // Cache program_fee_wallet so the mature-ticket builder can
          // construct the program-fee ATA correctly. Stable across
          // refreshes; doesn't change without an admin update.
          setProgramFeeWallet(decodeJitoConfigProgramFeeWallet(jitoCfgInfo.data));
          setProgramFeeBps(decodeJitoConfigProgramFeeBps(jitoCfgInfo.data));
        } else {
          setEpochLength(null);
        }
        const slot = await connection.getSlot("confirmed");
        setClusterSlot(BigInt(slot));
        setClusterNowMs(Date.now());
      } catch { /* timer skipped */ }

      // Cache the Jito vault's fee_wallet — used only by the per-ticket
      // Mature handler. Read once and stash; the field never changes
      // for a live vault.
      if (!feeWallet) {
        try {
          const v = await readVaultState(connection, CSSOL_VAULT);
          setFeeWallet(v.feeWallet);
        } catch { /* fee wallet read skipped — Mature button stays disabled */ }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  };

  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function projectedSlot(): bigint | null {
    if (clusterSlot === null) return null;
    const elapsedMs = Date.now() - clusterNowMs;
    return clusterSlot + BigInt(Math.floor(elapsedMs / SLOT_DURATION_MS));
  }

  useEffect(() => {
    void refresh();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [wallet.publicKey?.toBase58(), connection, selectedObligationId]);

  const marginAmount = parseFloat(marginAmountStr) || 0;
  const loanAmount = parseFloat(loanAmountStr) || 0;

  const [closeStage, ticketUnlockSlot, ticketCreatedSlot] = useMemo<[CloseStage, bigint | null, bigint | null]>(() => {
    const hasPosition = existing.csSolCollateral > 0 || existing.wsolDebt > 0 || csSolWtCollateral > 0;
    if (!hasPosition) return ["no-position", null, null];
    if (csSolWtCollateral <= 0) return ["idle", null, null];
    if (!queue || !epochLength || epochLength === 0n || !wallet.publicKey) return ["pending", null, null];
    const userTickets = queue.tickets.filter((t) => !t.redeemed && t.staker.equals(wallet.publicKey!));
    if (userTickets.length === 0) return ["pending", null, null];
    // Pair each ticket with its unlock slot; pick the earliest (the
    // one that gates Step 3 readiness).
    const paired = userTickets.map((t) => {
      const unstakeEpoch = t.createdAtSlot / epochLength;
      return { createdAtSlot: t.createdAtSlot, unlock: (unstakeEpoch + 2n) * epochLength };
    });
    paired.sort((a, b) => (a.unlock < b.unlock ? -1 : a.unlock > b.unlock ? 1 : 0));
    const earliest = paired[0];
    const now = projectedSlot();
    return [
      now !== null && now >= earliest.unlock ? "matured" : "pending",
      earliest.unlock,
      earliest.createdAtSlot,
    ];
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [existing, csSolWtCollateral, queue, epochLength, clusterSlot, clusterNowMs, wallet.publicKey?.toBase58()]);

  /** Per-ticket breakdown of the user's queued unstakes, sorted earliest
   *  unlock first. Drives the expandable detail view inside the
   *  csSOL-WT collateral row. The aggregate `csSolWtCollateral` is the
   *  klend obligation's fungible balance — this list is the on-chain
   *  queue, which is what determines maturity per-ticket.
   *
   *  Caveat: `governor.redeem_cssol_wt` burns WT fungibly against the
   *  pool's matured wSOL; there is no per-ticket redeem ix. So this
   *  view is read-only inspection — its value is letting the user see
   *  the matured-fraction (`maturedTotal / queuedTotal`) and size their
   *  Step-2 unwind to fit. */
  type UserTicket = {
    ticketPda: PublicKey;
    cssolWtAmount: bigint;
    createdAtSlot: bigint;
    unlockSlot: bigint;
    status: "pending" | "matured";
  };
  const userTickets = useMemo<UserTicket[]>(() => {
    if (!queue || !epochLength || epochLength === 0n || !wallet.publicKey) return [];
    const now = projectedSlot();
    const items: UserTicket[] = queue.tickets
      .filter((t) => !t.redeemed && t.staker.equals(wallet.publicKey!))
      .map((t) => {
        const unstakeEpoch = t.createdAtSlot / epochLength;
        const unlockSlot = (unstakeEpoch + 2n) * epochLength;
        const status: "pending" | "matured" = now !== null && now >= unlockSlot ? "matured" : "pending";
        return { ticketPda: t.ticketPda, cssolWtAmount: t.cssolWtAmount, createdAtSlot: t.createdAtSlot, unlockSlot, status };
      });
    items.sort((a, b) => (a.unlockSlot < b.unlockSlot ? -1 : a.unlockSlot > b.unlockSlot ? 1 : 0));
    return items;
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [queue, epochLength, clusterSlot, clusterNowMs, wallet.publicKey?.toBase58()]);

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
      existing,
    });
  }, [marginAsset, marginAmount, loanAmount, csSolPrice, wsolPrice, existing]);

  const reserveCapWsol = Math.max(wsolReserveAvailable / 2 - 0.001, 0);
  // Only flag the cap when the user has actually entered a loan size.
  // Empty / zero amounts shouldn't trip the warning — the user hasn't
  // proposed a trade yet, so there's nothing to validate against.
  const overReserveCap = loanAmount > 0 && loanAmount > reserveCapWsol;
  const effectiveMaxLoan = quote && Number.isFinite(quote.maxLoanAmount)
    ? Math.min(quote.maxLoanAmount, reserveCapWsol)
    : reserveCapWsol;

  function balanceFor(asset: MarginAsset): number {
    return asset === "SOL" ? solBal : asset === "wSOL" ? wsolBal : csSolBal;
  }

  async function sendVtx(label: string, ixes: TransactionInstruction[]) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    const owner = wallet.publicKey;
    const lutAccountInfo = await connection.getAccountInfo(CREDIT_TRADE_LUT, "confirmed");
    if (!lutAccountInfo) throw new Error(`credit-trade LUT ${CREDIT_TRADE_LUT.toBase58()} not found on-chain`);
    const lutAccount = new AddressLookupTableAccount({
      key: CREDIT_TRADE_LUT,
      state: AddressLookupTableAccount.deserialize(lutAccountInfo.data),
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: owner, recentBlockhash: blockhash, instructions: ixes,
    }).compileToV0Message([lutAccount]);
    const vtx = new VersionedTransaction(message);
    // serialize() throws RangeError("encoding overruns Uint8Array") when
    // the v0 message exceeds the 1232-byte packet cap. That happens when
    // the LUT doesn't cover enough static accounts, so the message
    // header still carries too many keys. Translate the raw range error
    // into a labelled failure so the panel surfaces it instead of
    // crashing the React tree (the caller's try/catch only triggers if
    // the throw escapes — wrapping serialize keeps the error in scope).
    let sizedBytes: number;
    try {
      sizedBytes = vtx.serialize().byteLength;
    } catch (e: any) {
      if (e instanceof RangeError && /overruns/i.test(e.message)) {
        const msgKeys = message.staticAccountKeys.length;
        const luts = message.addressTableLookups?.reduce((s, l) => s + l.readonlyIndexes.length + l.writableIndexes.length, 0) ?? 0;
        throw new Error(
          `${label} tx exceeds Solana's 1232-byte size limit ` +
          `(static keys ${msgKeys}, LUT keys ${luts}, ${ixes.length} ixes). ` +
          `Add the missing static accounts to the credit-trade LUT (${CREDIT_TRADE_LUT.toBase58()}) ` +
          `or split the unwind into multiple transactions.`,
        );
      }
      throw e;
    }
    setLog((l) => [...l, `signing ${label} v0 tx (${sizedBytes} bytes via LUT)…`]);
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
      const errStr = typeof txErr === "string" ? txErr : (txErr as { message?: string }).message ?? JSON.stringify(txErr);
      throw new Error(`${label} failed: ${errStr}\nsig=${sig}\nexplorer: https://explorer.solana.com/tx/${sig}?cluster=devnet\n\n${logs.slice(-14).join("\n")}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
    setConfirmedSig(sig);
  }

  async function onOpen() {
    if (!wallet.publicKey || !wallet.signTransaction) { setError("connect a wallet"); return; }
    // "Leverage up" path: margin = 0 is valid when the obligation
    // already has csSOL collateral. The flash-loop just adds another
    // round-trip on top of the existing position — the new csSOL
    // deposit comes entirely from the loan side, no fresh wallet
    // funds touched. We still require margin > 0 for a fresh open
    // (no collateral to lever against, the loop's deposit would be
    // zero on net once the flash-repay closes).
    const isLeverageUp = marginAmount === 0 && hasPosition && existing.csSolCollateral > 0;
    if (loanAmount <= 0) { setError("Trade size must be > 0"); return; }
    if (!isLeverageUp && marginAmount <= 0) {
      setError("Margin must be > 0 (or open a position with margin first to enable margin-free leverage-up).");
      return;
    }
    // Wallet-balance check — skip on the leverage-up path since margin=0.
    if (marginAmount > 0 && marginAmount > balanceFor(marginAsset)) {
      setError(`Insufficient ${marginAsset}: have ${balanceFor(marginAsset).toFixed(4)}, need ${marginAmount}`);
      return;
    }
    if (whitelisted === false) {
      setError("Wallet is not whitelisted on the csSOL pool — the wrap CPI will fail with AccountNotInitialized: whitelist_entry. Get whitelisted first.");
      return;
    }
    if (overReserveCap) {
      setError(`Trade size ${loanAmount.toFixed(4)} cSOL exceeds the cSOL reserve's in-flight cap (${reserveCapWsol.toFixed(4)} cSOL).`);
      return;
    }
    const desc = isLeverageUp
      ? `Increasing leverage: ${loanAmount} cSOL extra (margin = 0, levered against existing csSOL)`
      : `Opening credit trade: ${marginAmount} ${marginAsset} margin + ${loanAmount} cSOL leverage`;
    setBusy(true); setError(null); setIntent(desc); setLog([`${desc}…`]);
    try {
      const owner = wallet.publicKey;
      const vaultState = await readVaultState(connection, CSSOL_VAULT);

      const obAddr = obligationPda(owner, 0, selectedObligationId);
      const umAddr = userMetadataPda(owner);
      const [obInfo, umInfo] = await connection.getMultipleAccountsInfo([obAddr, umAddr], "confirmed");

      const { ixes, notes } = await buildOpenCreditTradeIxes({
        user: owner,
        marginAsset,
        marginAmount: BigInt(Math.round(marginAmount * LAMPORTS_PER_SOL)),
        loanAmount: BigInt(Math.round(loanAmount * LAMPORTS_PER_SOL)),
        vaultState,
        obligationDepositReserves: obligationDeposits,
        obligationBorrowReserves: obligationBorrows,
        currentElevationGroup: obligationEg,
        needsInitUserMetadata: !umInfo,
        needsInitObligation: !obInfo,
        closeWsolAtaAtEnd: false,
        obligationId: selectedObligationId,
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex}, expected csSOL deposit = ${(Number(notes.expectedCsSolDeposit) / LAMPORTS_PER_SOL).toFixed(6)})`]);
      await sendVtx("open", ixes);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e, null, 2);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onConvert() {
    if (!wallet.publicKey) return;
    if (existing.csSolCollateral <= 0) { setError("No csSOL collateral to convert."); return; }
    if (!queue) { setError("Withdraw queue not loaded — refresh and retry."); return; }
    const desc = `Converting ${existing.csSolCollateral.toFixed(6)} csSOL → csSOL-WT`;
    setBusy(true); setError(null); setIntent(desc); setLog([`${desc}…`]);
    try {
      const owner = wallet.publicKey;
      const vaultState = await readVaultState(connection, CSSOL_VAULT);
      const amount = BigInt(Math.floor(existing.csSolCollateral * LAMPORTS_PER_SOL));
      // Read the obligation's wSOL debt in raw lamports so the
      // wSOL-flash bridge can size the flash loan precisely.
      const ob = await readObligation(connection, owner, selectedObligationId);
      const wsolBor = // Post-2026-05-06 migration: EG-2 debt is cSOL. Legacy wSOL-debt
// obligations no longer exist (drain confirmed; reserve is Hidden
// with limits zeroed). If a legacy obligation somehow surfaces it
// won't show debt here — that's intentional, the close path can
// only operate on cSOL-debt obligations now.
ob.borrows.find((b) => b.reserve.equals(CSOL_RESERVE));
      const SF = 60n;
      const wsolDebtLamports = wsolBor
        ? (wsolBor.borrowedAmountSf + ((1n << SF) - 1n)) >> SF
        : 0n;
      const { ixes, notes } = await buildCloseStep1ConvertIxes({
        user: owner, amount, vaultState,
        queueTotalMinted: queue.totalCssolWtMinted,
        preDepositReserves: obligationDeposits,
        preBorrowReserves: obligationBorrows,
        wsolDebtLamports,
        obligationId: selectedObligationId,
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex}, debt-bridge ${(Number(wsolDebtLamports) / LAMPORTS_PER_SOL).toFixed(6)} cSOL)`]);
      await sendVtx("convert", ixes);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e, null, 2);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onUnwind() {
    if (!wallet.publicKey) return;
    const pct = parseFloat(closePctStr) / 100;
    if (!(pct > 0 && pct <= 1)) { setError("Pick a percentage between 1 and 100."); return; }
    if (csSolWtCollateral <= 0) { setError("No csSOL-WT collateral to unwind."); return; }
    if (existing.wsolDebt <= 0) { setError("No cSOL debt to repay."); return; }
    // Fuzziness buffer for the flash bundle:
    //   repayAmount = min(scaledDebt, redeemAmount) + OVERREPAY_BUFFER
    //
    // Why bump above the bottleneck:
    //   • Over-redeem case (redeem ≥ debt — e.g. user picks 0.5 SOL
    //     unwind on a 0.3 SOL debt): debt accrues second-by-second,
    //     so repaying exactly the on-chain-read debt leaves dust.
    //     Bumping by buffer lets klend's internal clamp settle on the
    //     true current debt; the unused slice comes back to the user
    //     as cSOL surplus (klend caps repay at borrowed_amount).
    //   • Redeem-limited case (redeem < debt — partial close): bump
    //     absorbs floor() rounding in the panel's amount math. The
    //     buffer is funded from native SOL via wsolPrefund.
    //
    // 50_000 lamports = 0.00005 SOL ≈ 50× per-second cSOL accrual on
    // a 1-SOL-debt position. Negligible cost; covers ~1 minute of
    // accrual + any rounding fuzz.
    const OVERREPAY_BUFFER_LAMPORTS = 50_000n;
    const redeemAmount = BigInt(Math.floor(csSolWtCollateral * pct * LAMPORTS_PER_SOL));
    const scaledDebt = BigInt(Math.floor(existing.wsolDebt * pct * LAMPORTS_PER_SOL));
    const bottleneck = scaledDebt < redeemAmount ? scaledDebt : redeemAmount;
    const repayAmount = bottleneck + OVERREPAY_BUFFER_LAMPORTS;
    // wSOL prefund: only fund the slice of repayAmount above
    // redeemAmount. In the over-redeem case (redeem > debt + buffer)
    // this is zero — the redeem already covers the buffer.
    const wsolPrefund = repayAmount > redeemAmount ? repayAmount - redeemAmount : 0n;
    const desc = `Unwinding ${(pct * 100).toFixed(0)}%: repay ${(Number(repayAmount) / LAMPORTS_PER_SOL).toFixed(6)} cSOL, redeem ${(csSolWtCollateral * pct).toFixed(6)} csSOL-WT`;
    setBusy(true); setError(null); setIntent(desc);
    setLog([`${desc}…`]);
    try {
      const owner = wallet.publicKey;
      // Auto-mature: redeem_cssol_wt rejects with RedeemExceedsPending
      // 6010 when redeemAmount > pool.pending_wsol. The bundle doesn't
      // mature tickets itself (byte/CU budget), so chain a mature tx
      // ahead of the unwind for each ticket needed to cover the gap.
      // User signs each mature + the final unwind via wallet adapter.
      await ensurePendingCovers(redeemAmount);
      setIntent(desc);
      const { ixes, notes } = await buildCloseStep2UnwindIxes({
        user: owner,
        repayAmount, redeemAmount,
        obligationDepositReserves: obligationDeposits,
        obligationBorrowReserves: obligationBorrows,
        closeWsolAtaAtEnd: pct >= 1,
        obligationId: selectedObligationId,
        wsolPrefundLamports: wsolPrefund,
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex})`]);
      await sendVtx("unwind", ixes);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e, null, 2);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  /** Permissionless mature-ticket ix construction. Burns the matured
   *  Jito staker withdrawal ticket and sweeps its wSOL into the pool's
   *  `pending_wsol` account, which is what `redeem_cssol_wt` draws from.
   *
   *  Why this exists: `redeem_cssol_wt` rejects with
   *  `RedeemExceedsPending 6010` when the requested redeem amount is
   *  greater than `withdraw_queue.pending_wsol`. The unwind flash bundle
   *  doesn't (and can't, due to byte/CU budget) include this step
   *  itself — so this runs as a separate prerequisite tx. Anyone can
   *  mature (Jito enforces only that the staker matches the ticket's
   *  recorded staker), so this is a no-stakeholder gate.
   *
   *  Returns the ix array so callers can wrap it with their own
   *  busy/intent/error scaffolding (the inline Unwind handlers chain
   *  multiple matures back-to-back; the per-ticket button is a
   *  one-shot). */
  async function buildMatureTicketIxes(ticketPda: PublicKey, ticketAmount: bigint): Promise<TransactionInstruction[]> {
    if (!wallet.publicKey) throw new Error("connect a wallet");
    if (!feeWallet) throw new Error("Jito vault fee_wallet not loaded yet — refresh first.");
    if (!programFeeWallet) throw new Error("Jito config program_fee_wallet not loaded yet — refresh first.");
    if (!POOL_PENDING_WSOL_ACCOUNT) throw new Error("POOL_PENDING_WSOL_ACCOUNT not configured.");
    const owner = wallet.publicKey;
    const [jitoConfig] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("config")],
      JITO_VAULT_PROGRAM,
    );
    // Compute the prefund needed to cover Jito's program-fee
    // withholding. Jito pays out only `ticketAmount × (1 - bps/10_000)`
    // wSOL, but governor sweeps the FULL `ticketAmount`. Pre-fund the
    // delta so the sweep TransferChecked has the lamports it needs.
    // Round UP and add a tiny safety lamport for arithmetic edge cases
    // (Jito uses `mul_div_with_rounding(Up)` on the withheld side which
    // can yield 1 lamport more than `floor(amount × bps / 10000)`).
    const bps = BigInt(programFeeBps);
    const feeLamports = (ticketAmount * bps + 9_999n) / 10_000n; // ceil
    const prefundLamports = feeLamports + 1n; // +1 lamport rounding cushion
    // The ticket's VRT-token account is the ATA over (CSSOL_VRT_MINT,
    // ticketPda) with allowOwnerOffCurve=true (ticket is a PDA, so the
    // ATA must allow off-curve owners).
    const ticketTokenAccount = getAssociatedTokenAddressSync(
      CSSOL_VRT_MINT, ticketPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    // Vault fee ATA: ATA(VRT, vault.fee_wallet). vault.fee_wallet is a
    // wallet pubkey on the live devnet vault but pass allowOffCurve=true
    // defensively — admin rotations can flip it to a PDA.
    const vaultFeeAta = getAssociatedTokenAddressSync(
      CSSOL_VRT_MINT, feeWallet, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    // Program fee ATA: ATA(VRT, jitoConfig.program_fee_wallet). The
    // program_fee_wallet is a Jito-restaking PDA → allowOffCurve=true
    // is required (curve check would throw). Distinct from vaultFeeAta;
    // confirmed mismatch on devnet 2026-05-08.
    const programFeeAta = getAssociatedTokenAddressSync(
      CSSOL_VRT_MINT, programFeeWallet, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const ixes: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      // Pre-create the user's wSOL ATA — Jito's BurnWithdrawalTicket
      // CPI sends wSOL here as the staker_token_account.
      createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsolAta, owner, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      // Pre-create both fee ATAs idempotently. Jito's BurnWithdrawalTicket
      // takes them as `mut` and credits VRT into them; the on-chain
      // assert_associated_token_account check passes on the address
      // alone but the underlying TransferChecked CPI needs an
      // initialized token account. The vault-fee ATA usually already
      // exists (it accumulates over time), but the program-fee ATA
      // often doesn't on freshly-init'd vaults. Idempotent creation
      // is ~5K CU each — cheap insurance.
      createAssociatedTokenAccountIdempotentInstruction(
        owner, vaultFeeAta, feeWallet, CSSOL_VRT_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        owner, programFeeAta, programFeeWallet, CSSOL_VRT_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ];
    // Pre-fund the wSOL ATA with the Jito program-fee delta. Skipped
    // when bps=0 (zero fee → governor's full sweep matches Jito's full
    // payout, no shortfall). Done as native SOL transfer + sync so the
    // ATA's recorded amount reflects the underlying lamports — Jito's
    // own ATA-init can't do this on its own.
    if (prefundLamports > 0n) {
      ixes.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: userWsolAta,
          lamports: Number(prefundLamports),
        }),
        createSyncNativeInstruction(userWsolAta, TOKEN_PROGRAM_ID),
      );
    }
    ixes.push(
      await buildMatureWithdrawalTicketsIx({
        user: owner,
        vaultStakerWithdrawalTicket: ticketPda,
        vaultStakerWithdrawalTicketTokenAccount: ticketTokenAccount,
        vaultFeeTokenAccount: vaultFeeAta,
        programFeeTokenAccount: programFeeAta,
        jitoVaultConfig: jitoConfig,
        poolPendingWsolAccount: POOL_PENDING_WSOL_ACCOUNT,
      }),
    );
    return ixes;
  }

  /** User-facing per-ticket Mature button. One ticket → one tx. */
  async function onMatureTicket(ticketPda: PublicKey) {
    if (!wallet.publicKey) { setError("connect a wallet"); return; }
    const t = userTickets.find((x) => x.ticketPda.equals(ticketPda));
    if (!t) { setError("Ticket not found in queue."); return; }
    const desc = `Maturing ticket ${ticketPda.toBase58().slice(0, 4)}…${ticketPda.toBase58().slice(-4)}`;
    setIntent(desc);
    setBusy(true); setError(null);
    setLog((l) => [...l, desc]);
    try {
      const ixes = await buildMatureTicketIxes(ticketPda, t.cssolWtAmount);
      await sendVtx("mature ticket", ixes);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`mature failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  /** Auto-mature matured tickets in order until the pool's pending_wsol
   *  covers `needLamports`. Each mature is a separate user-signed tx;
   *  most positions need exactly one. Returns the projected
   *  pending_wsol after all matures land (used to verify coverage
   *  before submitting the final unwind tx).
   *
   *  Throws if the user's matured tickets can't cover the deficit, so
   *  the unwind handler aborts before asking for a signature on a tx
   *  that would revert with RedeemExceedsPending 6010. */
  async function ensurePendingCovers(needLamports: bigint): Promise<bigint> {
    if (!queue) throw new Error("withdraw queue not loaded — refresh first.");
    let pending = queue.pendingWsol;
    if (pending >= needLamports) return pending;
    const matured = userTickets.filter((t) => t.status === "matured");
    if (matured.length === 0) {
      throw new Error(
        `Pool has only ${(Number(pending) / LAMPORTS_PER_SOL).toFixed(6)} wSOL pending and you have no matured tickets to mature. ` +
        `Wait for the Jito vault unstake queue to mature.`,
      );
    }
    // Greedy: largest matured ticket first → fewest signatures.
    const sorted = [...matured].sort((a, b) =>
      a.cssolWtAmount > b.cssolWtAmount ? -1 : a.cssolWtAmount < b.cssolWtAmount ? 1 : 0,
    );
    for (const t of sorted) {
      if (pending >= needLamports) break;
      const desc = `Maturing ticket ${t.ticketPda.toBase58().slice(0, 4)}…${t.ticketPda.toBase58().slice(-4)} (${(Number(t.cssolWtAmount) / LAMPORTS_PER_SOL).toFixed(6)} wSOL)`;
      setIntent(desc);
      setLog((l) => [...l, desc]);
      const ixes = await buildMatureTicketIxes(t.ticketPda, t.cssolWtAmount);
      await sendVtx("mature ticket", ixes);
      pending = pending + t.cssolWtAmount;
    }
    if (pending < needLamports) {
      throw new Error(
        `Even after maturing every available ticket, pending wSOL (${(Number(pending) / LAMPORTS_PER_SOL).toFixed(6)}) ` +
        `still doesn't cover the redeem (${(Number(needLamports) / LAMPORTS_PER_SOL).toFixed(6)}). ` +
        `Reduce the unwind size or wait for more tickets to mature.`,
      );
    }
    return pending;
  }

  /** Inline-row WT redeem. Same atomic flash-loop as the bottom-of-card
   *  Step-3 Unwind (`onUnwind`) — flash-borrow wSOL → repay obligation
   *  → withdraw csSOL-WT collateral → redeem the matured Jito ticket
   *  → flash-repay. The user only signs once; no wallet wSOL needed.
   *
   *  Sized off the user's amount input rather than the bottom-card's
   *  closePctStr percentage, so the row-level UX mirrors the csSOL
   *  row's `onCollateralUnwind`. Partial redeems are allowed — useful
   *  if the user wants to repay only a slice of the debt now and let
   *  the rest keep earning (well, the WT slice doesn't earn — but the
   *  csSOL portion of remaining collateral does). */
  async function onWtRedeemAmount() {
    if (!wallet.publicKey) return;
    if (closeStage !== "matured") {
      setError("Ticket hasn't matured yet — wait for the Jito vault unstake queue.");
      return;
    }
    const amount = parseFloat(wtUnwindAmountStr) || 0;
    if (amount <= 0) { setError("Amount must be > 0"); return; }
    if (amount > csSolWtCollateral) {
      setError(`You only have ${csSolWtCollateral.toFixed(6)} csSOL-WT collateral.`);
      return;
    }
    if (existing.wsolDebt <= 0) {
      setError("No cSOL debt to repay — close the obligation directly.");
      return;
    }
    // Fuzziness buffer for the flash bundle — see `onUnwind` for the
    // full rationale. repayAmount = min(debt, redeem) + buffer, with
    // any slice above redeemAmount funded from native SOL via the
    // bundle's wsolPrefund hook. klend caps repay at actual debt
    // internally, so the buffer turns into cSOL surplus when the
    // over-redeem case lands.
    const OVERREPAY_BUFFER_LAMPORTS = 50_000n;
    const redeemAmount = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
    const debtLamports = BigInt(Math.floor(existing.wsolDebt * LAMPORTS_PER_SOL));
    const bottleneck = debtLamports < redeemAmount ? debtLamports : redeemAmount;
    const repayAmount = bottleneck + OVERREPAY_BUFFER_LAMPORTS;
    const wsolPrefund = repayAmount > redeemAmount ? repayAmount - redeemAmount : 0n;
    const repayUi = Number(repayAmount) / LAMPORTS_PER_SOL;
    // Used downstream to gate `closeWsolAtaAtEnd` — only close on full
    // unwinds (where the user is exiting the entire WT position and
    // won't re-use the wSOL ATA).
    const pct = amount / csSolWtCollateral;
    const desc = `Unwinding ${amount.toFixed(6)} csSOL-WT → repay ${repayUi.toFixed(6)} cSOL (atomic flash)`;
    setBusy(true); setError(null); setIntent(desc);
    setLog([`${desc}…`]);
    try {
      const owner = wallet.publicKey;
      // Auto-mature ahead of the unwind — see `onUnwind` for rationale.
      await ensurePendingCovers(redeemAmount);
      setIntent(desc);
      const { ixes, notes } = await buildCloseStep2UnwindIxes({
        user: owner,
        repayAmount, redeemAmount,
        obligationDepositReserves: obligationDeposits,
        obligationBorrowReserves: obligationBorrows,
        closeWsolAtaAtEnd: pct >= 1,
        obligationId: selectedObligationId,
        wsolPrefundLamports: wsolPrefund,
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash_borrow @ ${notes.borrowInstructionIndex})`]);
      await sendVtx("wt redeem", ixes);
      setWtUnwindOpen(false);
      setWtUnwindAmountStr("");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e, null, 2);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  /** Partial collateral unwind via the leveraged-Convert flash loop.
   *  Identical mechanic to onConvert but with a user-chosen amount
   *  instead of full-balance. Net effect:
   *
   *    csSOL collateral  →  −X
   *    csSOL-WT collateral → +X
   *    Jito unstake ticket → +X queued
   *    Wallet WT          →   0 (flash-loan returns the borrow)
   *    LTV               →  unchanged (csSOL ≈ csSOL-WT 1:1 by oracle)
   *
   *  After Jito's epoch boundary + 2, the matured WT collateral feeds
   *  the leveraged-close Step 2 (Unwind) which redeems WT → wSOL and
   *  repays/withdraws.
   *
   *  Multiple partial unwinds queue separate Jito tickets — each has
   *  its own unlock slot. The Step-2 Unwind redeems whatever fungible
   *  csSOL-WT collateral is currently redeemable. */
  async function onCollateralUnwind() {
    if (!wallet.publicKey) return;
    if (!queue) { setError("Withdraw queue not loaded — refresh and retry."); return; }
    const amount = parseFloat(unwindAmountStr) || 0;
    if (amount <= 0) { setError("Amount must be > 0"); return; }
    if (amount > existing.csSolCollateral) {
      setError(`You only have ${existing.csSolCollateral.toFixed(6)} csSOL collateral.`);
      return;
    }
    const desc = `Unwinding ${amount} csSOL collateral → csSOL-WT (queues unstake ticket)`;
    setBusy(true); setError(null); setIntent(desc);
    setLog([`${desc} via flash loan…`]);
    try {
      const owner = wallet.publicKey;
      const vaultState = await readVaultState(connection, CSSOL_VAULT);
      const lamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
      // Live obligation read for precise wSOL debt — the flash bridge
      // sizes off this number, so any drift between cached + on-chain
      // breaks the round-trip.
      const ob = await readObligation(connection, owner, selectedObligationId);
      const wsolBor = // Post-2026-05-06 migration: EG-2 debt is cSOL. Legacy wSOL-debt
// obligations no longer exist (drain confirmed; reserve is Hidden
// with limits zeroed). If a legacy obligation somehow surfaces it
// won't show debt here — that's intentional, the close path can
// only operate on cSOL-debt obligations now.
ob.borrows.find((b) => b.reserve.equals(CSOL_RESERVE));
      const SF = 60n;
      const totalDebtLamports = wsolBor
        ? (wsolBor.borrowedAmountSf + ((1n << SF) - 1n)) >> SF
        : 0n;
      // Proportional bridge sizing — the flash-borrowed cSOL is just the
      // slice of debt that corresponds to the csSOL slice we're swapping
      // out. Bridging the full debt for a partial unwind wastes reserve
      // liquidity (which scales with cumulative bridge sizes, not user
      // positions) and trips InsufficientLiquidity when other users have
      // a position bigger than the cSOL reserve's available_amount.
      const totalCollLamports = BigInt(Math.floor(existing.csSolCollateral * LAMPORTS_PER_SOL));
      const wsolDebtLamports = totalCollLamports > 0n
        ? (totalDebtLamports * lamports) / totalCollLamports
        : 0n;
      const { ixes, notes } = await buildCloseStep1ConvertIxes({
        user: owner, amount: lamports, vaultState,
        queueTotalMinted: queue.totalCssolWtMinted,
        preDepositReserves: obligationDeposits,
        preBorrowReserves: obligationBorrows,
        wsolDebtLamports,
        obligationId: selectedObligationId,
      });
      setLog((l) => [...l, `built ${ixes.length} ixes (flash @ ${notes.borrowInstructionIndex >= 0 ? notes.borrowInstructionIndex : "n/a"}, debt-bridge ${(Number(wsolDebtLamports) / LAMPORTS_PER_SOL).toFixed(6)} cSOL)`]);
      await sendVtx("collateral unwind", ixes);
      setUnwindOpen(false);
      setUnwindAmountStr("");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e, null, 2);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <Card tone="muted" size="md">
        <p className="text-sm text-base-content/65">Connect a wallet to start a credit trade.</p>
      </Card>
    );
  }

  const equityUsd = quote ? Math.max(quote.collateralUsd - quote.debtUsd, 0) : 0;
  const overCap = quote ? quote.ltvAfterPct >= 90 : false;
  const hasPosition = existing.csSolCollateral > 0 || existing.wsolDebt > 0 || csSolWtCollateral > 0;

  return (
    <div className="space-y-6 pb-12">
      {/* KYC banner */}
      {whitelisted === false && (
        <Snackbar
          variant="inline"
          type="warning"
          message="Wallet not whitelisted on the csSOL pool"
          detail={
            "The credit-trade open tx mints csSOL via delta-mint, which requires this wallet's whitelist_entry PDA. Onboard via the institutional portal."
            + (whitelistPda ? ` PDA: ${whitelistPda.toBase58().slice(0, 8)}…` : "")
          }
        />
      )}

      {/* Obligation switcher — same primitive PositionsPage uses, so a
          desk running multiple parallel positions can flip between
          them in one click. The `+ New` action allocates the lowest
          unused id; the next deposit ix lazily inits the obligation
          PDA on first use. Every form / action below keys off
          `selectedObligationId`. */}
      {wallet.publicKey && (
        <ObligationSwitcher
          value={selectedObligationId}
          onChange={setSelectedObligationId}
          catalog={obligationCatalog}
          onCreate={() => {
            // Pick the lowest id not already in the catalog. Same
            // strategy as PositionsPage's `nextUnusedId`.
            const used = new Set(obligationCatalog.map((e) => e.id));
            for (let i = 0; i < 256; i++) {
              if (!used.has(i)) { setSelectedObligationId(i); return; }
            }
          }}
        />
      )}

      {/* Pool liquidity */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat size="sm" label="cSOL pool available" value={fmt(wsolReserveAvailable, 4)} accent="primary" />
        <Stat size="sm" label="Open-path cap" value={fmt(reserveCapWsol, 4)} accent={overReserveCap ? "info" : "accent"} />
        <Stat size="sm" label="csSOL price" value={fmtUsd(csSolPrice)} accent="info" />
        <Stat size="sm" label="cSOL price" value={fmtUsd(wsolPrice)} accent="info" />
      </div>

      {/* Open position — split-ledger card. Collateral side stacks
          csSOL + csSOL-WT entries; the WT row inlines the maturity
          breakdown (status badge, countdown, progress bar, slot
          footnotes) so the user can read ticket state in the same
          glance as their position. Debt side stays single-asset. */}
      {hasPosition && (() => {
        const csSolUsd = existing.csSolCollateral * csSolPrice;
        const csSolWtUsd = csSolWtCollateral * csSolPrice;
        const collValueUsd = csSolUsd + csSolWtUsd;
        const debtValueUsd = existing.wsolDebt * wsolPrice;
        const equityUsd = collValueUsd - debtValueUsd;
        const currentLtvPct = collValueUsd > 0 ? (debtValueUsd / collValueUsd) * 100 : 0;
        const liqThresholdPct = 92;
        const ltvCapPct = 90;
        const healthFactor = debtValueUsd > 0 ? (collValueUsd * (liqThresholdPct / 100)) / debtValueUsd : Infinity;
        const ltvBarPct = Math.min(currentLtvPct, 100);
        const ltvBarTone =
          currentLtvPct < ltvCapPct * 0.7 ? "bg-success" :
          currentLtvPct < ltvCapPct * 0.95 ? "bg-warning" :
          "bg-error";
        const hfTone =
          !Number.isFinite(healthFactor) ? "text-base-content/40" :
          healthFactor > 1.5 ? "text-success" :
          healthFactor > 1.1 ? "text-warning" :
          "text-error";

        // Ticket maturity progress (mirrors the close card's logic so
        // the inline WT row can show the same indicator). 0 → 100%.
        const isTicketMatured = closeStage === "matured";
        const isTicketPending = closeStage === "pending";
        const nowSlot = projectedSlot();
        let ticketProgressPct = 0;
        if (isTicketMatured) {
          ticketProgressPct = 100;
        } else if (ticketCreatedSlot !== null && ticketUnlockSlot !== null && nowSlot !== null) {
          const span = Number(ticketUnlockSlot - ticketCreatedSlot);
          const elapsed = Number(nowSlot - ticketCreatedSlot);
          ticketProgressPct = span > 0 ? Math.max(0, Math.min(100, (elapsed / span) * 100)) : 0;
        } else if (ticketUnlockSlot !== null && nowSlot !== null && epochLength) {
          const total = Number(epochLength) * 2;
          const remaining = Number(ticketUnlockSlot - nowSlot);
          ticketProgressPct = total > 0 ? Math.max(0, Math.min(100, (1 - remaining / total) * 100)) : 0;
        }
        const wtTicketLabel = isTicketMatured
          ? "MATURED"
          : isTicketPending
            ? `PENDING · ${fmtCountdown(ticketUnlockSlot)}`
            : "QUEUED";
        const wtBarTone = isTicketMatured ? "bg-success" : "bg-warning";

        return (
          <Card tone="elevated" size="lg">
            <CardHeader
              title="Open position"
              eyebrow="EG-2 · LST/SOL · 90% LTV cap · 92% liq threshold"
              actions={<Badge tone="primary" variant="solid" size="md">EG-2 active</Badge>}
            />

            <div className="grid md:grid-cols-2 gap-3 items-start">
              {/* COLLATERAL side — stacked entries.
                  Note on overflow: the panel itself is *not* clipped so
                  hover popovers (e.g. the WT status-badge tooltip) can
                  escape its bounds. The halo bloom is wrapped in a
                  dedicated absolute layer with its own `overflow-hidden
                  rounded-2xl` so it still hugs the rounded edge. */}
              <div className="relative rounded-2xl border border-success/30 bg-gradient-to-br from-success/10 via-success/[0.04] to-transparent">
                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl overflow-hidden">
                  <span className="absolute -top-10 -right-10 h-32 w-32 rounded-full opacity-25 blur-2xl"
                    style={{ background: "radial-gradient(closest-side, var(--color-success, #2E7D5B), transparent 70%)" }} />
                </span>
                <div className="relative">
                  <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <Badge tone="success" variant="soft" size="xs">collateral</Badge>
                    <span className="text-[10px] text-base-content/40 font-mono uppercase tracking-[0.18em]">supplied</span>
                  </div>

                  {/* csSOL row — only when > 0. After Convert, this can be 0
                      while csSOL-WT carries the value. Hosts the
                      collateral-unwind button + inline form. */}
                  {existing.csSolCollateral > 0 && (
                    <div className="px-5 py-3 border-t border-success/20">
                      <div className="flex items-center gap-3">
                        <TokenIcon symbol={"csSOL" as TokenSymbol} size="md" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-display text-xl tabular-nums leading-none tracking-tight">
                              {fmt(existing.csSolCollateral)}
                            </span>
                            <span className="text-xs text-base-content/55 font-mono tabular-nums">{fmtUsd(csSolUsd)}</span>
                          </div>
                          <div className="flex items-center justify-between mt-1 gap-2">
                            <span className="text-[11px] text-base-content/55 font-mono">
                              csSOL · liquid · <span className="text-success">{fmtApr(CSSOL_RESTAKING_APR)} APY</span>
                            </span>
                            <Button
                              variant={unwindOpen ? "ghost" : "secondary"}
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setUnwindOpen((o) => !o);
                                setUnwindAmountStr(existing.csSolCollateral.toFixed(6));
                              }}
                            >
                              {/* Renamed: the action queues a Jito
                                  unstake — collateral becomes csSOL-WT
                                  immediately, SOL only arrives after
                                  the ticket matures + the WT-row Unwind
                                  step. "Unstake to csSOL-WT" describes
                                  this leg precisely. */}
                              {unwindOpen ? "Cancel" : "Unstake to csSOL-WT →"}
                            </Button>
                          </div>

                          {unwindOpen && (
                            <div className="mt-3 rounded-lg bg-base-100/60 border border-base-300/60 p-3 space-y-2">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/55 font-bold">
                                Unwind csSOL collateral via flash loan
                              </div>
                              <p className="text-[11px] text-base-content/55 leading-snug">
                                Atomically swaps X csSOL collateral → X csSOL-WT collateral and queues a Jito
                                unstake ticket — leverage and LTV preserved (csSOL ≈ csSOL-WT 1:1 by oracle).
                                The matured ticket is redeemable via the leveraged-close Unwind step after
                                Jito's epoch boundary + 2.
                              </p>
                              <TokenAmountInput
                                symbol={"csSOL" as TokenSymbol}
                                value={unwindAmountStr}
                                onChange={setUnwindAmountStr}
                                balance={existing.csSolCollateral}
                                balanceDecimals={6}
                                balanceUnit="csSOL collateral"
                                onMax={() => setUnwindAmountStr(existing.csSolCollateral.toFixed(6))}
                              />
                              <Button
                                variant="primary"
                                size="md"
                                fullWidth
                                loading={busy}
                                disabled={
                                  busy ||
                                  !queue ||
                                  !unwindAmountStr ||
                                  parseFloat(unwindAmountStr) <= 0 ||
                                  parseFloat(unwindAmountStr) > existing.csSolCollateral
                                }
                                onClick={() => void onCollateralUnwind()}
                              >
                                Unwind {unwindAmountStr || "0"} csSOL → csSOL-WT collateral
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* csSOL-WT row — inline ticket breakdown + matured
                      redeem button. Mirrors the csSOL row's "Unwind to
                      SOL →" pattern: button toggles an inline TokenAmountInput
                      form, submit fires an atomic flash-loop close
                      (no wallet wSOL needed). Button is disabled until
                      the Jito ticket has matured. */}
                  {csSolWtCollateral > 0 && (
                    <div className="px-5 py-3 border-t border-success/20 bg-warning/[0.04]">
                      <div className="flex items-start gap-3">
                        <TokenIcon symbol={"csSOL-WT" as TokenSymbol} size="md" />
                        <div className="flex-1 min-w-0">
                          {/* Two-column layout: timelock metadata + progress
                              on the left, status badge + redeem button on
                              the right. Mirrors the csSOL row's right-edge
                              button placement so the two action affordances
                              line up vertically across the rows. */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0 space-y-2">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="font-display text-xl tabular-nums leading-none tracking-tight">
                                  {fmt(csSolWtCollateral)}
                                </span>
                                <span className="text-xs text-base-content/55 font-mono tabular-nums">
                                  ≈ {fmtUsd(csSolWtUsd)}
                                </span>
                              </div>
                              <div className="text-[11px] text-base-content/55 font-mono">
                                csSOL-WT ·{" "}
                                {/* No APY — yield accrual stops the moment
                                    the unstake is queued. */}
                                <span className="text-base-content/40">no yield · pending unstake</span>
                              </div>

                              {(isTicketPending || isTicketMatured) && (
                                <div className="space-y-1 pt-1">
                                  <div className="h-1 rounded-full bg-base-300 overflow-hidden">
                                    <div
                                      className={cn("h-full transition-all duration-500", wtBarTone)}
                                      style={{ width: `${ticketProgressPct}%` }}
                                    />
                                  </div>
                                  <div className="flex justify-between items-center text-[10px] text-base-content/45 font-mono gap-2">
                                    <span>queued slot {ticketCreatedSlot?.toString() ?? "—"}</span>
                                    <div className="flex items-center gap-2">
                                      <span>unlocks slot {ticketUnlockSlot?.toString() ?? "—"}</span>
                                      {userTickets.length > 0 && (
                                        <button
                                          type="button"
                                          onClick={() => setWtTicketsExpanded((e) => !e)}
                                          className="text-base-content/55 hover:text-base-content/85 transition-colors uppercase tracking-[0.14em] text-[9px] font-bold inline-flex items-center gap-0.5 cursor-pointer"
                                          title={`${wtTicketsExpanded ? "Collapse" : "Expand"} per-ticket breakdown (${userTickets.length} ticket${userTickets.length === 1 ? "" : "s"})`}
                                        >
                                          {userTickets.length} ticket{userTickets.length === 1 ? "" : "s"}
                                          <span aria-hidden className="text-base-content/45">{wtTicketsExpanded ? "▴" : "▾"}</span>
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Per-ticket detail — only when the user
                                      asked for it. The matured-fraction line
                                      at the top is the key takeaway: it tells
                                      the user how much they can safely unwind
                                      right now. The fungible-redemption note
                                      below the list explains why there's no
                                      per-ticket redeem button. */}
                                  {wtTicketsExpanded && userTickets.length > 0 && (() => {
                                    const totalLamports   = userTickets.reduce((s, t) => s + t.cssolWtAmount, 0n);
                                    const maturedLamports = userTickets
                                      .filter((t) => t.status === "matured")
                                      .reduce((s, t) => s + t.cssolWtAmount, 0n);
                                    const total   = Number(totalLamports)   / LAMPORTS_PER_SOL;
                                    const matured = Number(maturedLamports) / LAMPORTS_PER_SOL;
                                    const maturedPct = total > 0 ? (matured / total) * 100 : 0;
                                    return (
                                      <div className="mt-2 space-y-1.5 pt-2 border-t border-base-300/60">
                                        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                                          <span className="text-base-content/55">Matured · redeemable now</span>
                                          <span>
                                            <span className={cn(matured > 0 ? "text-success" : "text-base-content/40")}>
                                              {matured.toFixed(6)}
                                            </span>
                                            <span className="text-base-content/45"> / {total.toFixed(6)}</span>
                                            <span className="text-base-content/45 ml-1.5">({maturedPct.toFixed(0)}%)</span>
                                          </span>
                                        </div>
                                        <div className="space-y-1">
                                          {userTickets.map((t, i) => {
                                            const wt = Number(t.cssolWtAmount) / LAMPORTS_PER_SOL;
                                            return (
                                              <div
                                                key={t.ticketPda.toBase58()}
                                                className={cn(
                                                  "flex items-center justify-between gap-2 px-2 py-1.5 rounded text-[11px]",
                                                  t.status === "matured"
                                                    ? "bg-success/[0.07] border border-success/20"
                                                    : "bg-base-200/60 border border-base-300/40",
                                                )}
                                              >
                                                <div className="flex items-center gap-2 min-w-0">
                                                  <span className="text-base-content/40 font-mono tabular-nums w-5 text-right">#{i + 1}</span>
                                                  <span className="font-mono tabular-nums text-base-content">
                                                    {wt.toFixed(6)}
                                                  </span>
                                                  <span className="text-base-content/40 font-mono">csSOL-WT</span>
                                                </div>
                                                <div className="flex items-center gap-2 flex-shrink-0">
                                                  <span className={cn(
                                                    "font-mono tabular-nums",
                                                    t.status === "matured" ? "text-success" : "text-warning",
                                                  )}>
                                                    {t.status === "matured" ? "matured ✓" : fmtCountdown(t.unlockSlot)}
                                                  </span>
                                                  <span className="text-base-content/35 font-mono text-[9px] tracking-tight" title={`unlock slot ${t.unlockSlot.toString()}`}>
                                                    @{t.unlockSlot.toString().slice(-6)}
                                                  </span>
                                                  {t.status === "matured" && (
                                                    <Button
                                                      variant="ghost"
                                                      size="xs"
                                                      disabled={busy || !feeWallet || !programFeeWallet}
                                                      title={
                                                        !feeWallet || !programFeeWallet
                                                          ? "Loading Jito vault state…"
                                                          : "Burn this ticket and sweep its wSOL into the pool's pending pool. Required before Unwind when pending_wsol is empty."
                                                      }
                                                      onClick={() => void onMatureTicket(t.ticketPda)}
                                                    >
                                                      Mature
                                                    </Button>
                                                  )}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                        <p className="text-[10px] text-base-content/45 leading-snug pt-1">
                                          Tickets queue independently but redeem fungibly — `governor.redeem_cssol_wt` burns
                                          csSOL-WT against whichever wSOL is matured pool-side, so there's no per-ticket redeem.
                                          Use the matured fraction above to size your Unwind safely.
                                        </p>
                                      </div>
                                    );
                                  })()}
                                </div>
                              )}

                              {/* Ticket status badge — moved out of the
                                  right column so the right side carries
                                  only the action button. Reads as a
                                  natural status footer for the row,
                                  flush under the slot footnotes / per-
                                  ticket breakdown. Hover the badge for
                                  a popover explaining the current stage
                                  + what comes next. */}
                              <div className="pt-1">
                                <span className="group/badge relative inline-block">
                                  <Badge
                                    tone={isTicketMatured ? "success" : "warning"}
                                    variant="solid"
                                    size="xs"
                                    className="cursor-help"
                                  >
                                    {wtTicketLabel}
                                  </Badge>
                                  <span
                                    role="tooltip"
                                    className={cn(
                                      "pointer-events-none absolute left-0 top-full mt-2 z-50 w-64",
                                      "opacity-0 translate-y-1 group-hover/badge:opacity-100 group-hover/badge:translate-y-0",
                                      "transition-[opacity,transform] duration-150 ease-out",
                                      "px-3 py-2 rounded-lg whitespace-normal text-left",
                                      "bg-base-content text-base-100 text-[11px] leading-snug",
                                      "shadow-[0_8px_20px_-6px_rgba(31,45,72,0.45)]",
                                    )}
                                  >
                                    {isTicketMatured
                                      ? "Ticket is ready. Press Unwind to SOL → to redeem the csSOL-WT for wSOL, repay the debt, and (at 100%) withdraw the remaining margin as native SOL — all in one tx."
                                      : "Waiting for the Jito vault unstake queue to mature (timer + progress shown above). Klend continues to accrue borrow interest on the wSOL debt until the Unwind step closes the position."}
                                  </span>
                                </span>
                              </div>
                            </div>

                            <div className="flex flex-col items-end gap-2 flex-shrink-0">
                              <Button
                                variant={wtUnwindOpen ? "ghost" : "secondary"}
                                size="sm"
                                disabled={busy || !isTicketMatured || existing.wsolDebt <= 0}
                                title={
                                  !isTicketMatured
                                    ? "Wait for the Jito vault unstake queue to mature"
                                    : existing.wsolDebt <= 0
                                      ? "No wSOL debt to repay"
                                      : undefined
                                }
                                onClick={() => {
                                  setWtUnwindOpen((o) => !o);
                                  setWtUnwindAmountStr(csSolWtCollateral.toFixed(6));
                                }}
                              >
                                {wtUnwindOpen ? "Cancel" : "Unwind to SOL →"}
                              </Button>
                            </div>
                          </div>

                          {/* Inline redeem form — atomic flash-loop. */}
                          {wtUnwindOpen && (
                            <div className="mt-3 rounded-lg bg-base-100/60 border border-base-300/60 p-3 space-y-2">
                              <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/55 font-bold">
                                Redeem csSOL-WT → wSOL · atomic flash close
                              </div>
                              <p className="text-[11px] text-base-content/55 leading-snug">
                                Klend flash-borrows cSOL, repays your debt, withdraws the WT
                                collateral, redeems via the Jito ticket → wSOL, wraps to cSOL,
                                and flash-repays. Self-funded by the position — no wallet wSOL
                                needed. Repay caps at min(debt, redeem) + a tiny buffer; any
                                redeemed wSOL above that stays in your wSOL ATA.
                              </p>
                              <TokenAmountInput
                                symbol={"csSOL-WT" as TokenSymbol}
                                value={wtUnwindAmountStr}
                                onChange={setWtUnwindAmountStr}
                                balance={csSolWtCollateral}
                                balanceDecimals={6}
                                balanceUnit="csSOL-WT collateral"
                                onMax={() => setWtUnwindAmountStr(csSolWtCollateral.toFixed(6))}
                              />
                              {(() => {
                                // Pool's pending_wsol counter — what's already
                                // matured-and-swept and immediately redeemable
                                // without another mature tx. Mature sweeps a
                                // ticket's FULL amount; partial redeems leave
                                // the surplus here for the next click. The
                                // user-facing cap is min(WT collateral, pending).
                                const poolPending = queue ? Number(queue.pendingWsol) / LAMPORTS_PER_SOL : 0;
                                const maturedSum = userTickets
                                  .filter((t) => t.status === "matured")
                                  .reduce((s, t) => s + Number(t.cssolWtAmount), 0) / LAMPORTS_PER_SOL;
                                const noMatureCap = Math.min(csSolWtCollateral, poolPending);
                                const fullCap = Math.min(csSolWtCollateral, poolPending + maturedSum);
                                const amount = parseFloat(wtUnwindAmountStr) || 0;
                                const debtLamports = BigInt(Math.floor(existing.wsolDebt * LAMPORTS_PER_SOL));
                                const redeemLamports = BigInt(Math.floor(amount * LAMPORTS_PER_SOL));
                                const bottleneck = debtLamports < redeemLamports ? debtLamports : redeemLamports;
                                const previewRepayLamports = bottleneck + 50_000n;
                                const previewRepay = Number(previewRepayLamports) / LAMPORTS_PER_SOL;
                                const needsMature = redeemLamports > (queue?.pendingWsol ?? 0n);
                                return (
                                  <div className="space-y-1.5 text-[11px] font-mono tabular-nums">
                                    {/* Already-redeemable pool surplus */}
                                    <div className="flex items-center justify-between text-base-content/65">
                                      <span>pool pending (no mature needed)</span>
                                      <span>
                                        <span className={cn(poolPending > 0 ? "text-success" : "text-base-content/40")}>
                                          {poolPending.toFixed(6)}
                                        </span>
                                        <span className="text-base-content/45"> wSOL</span>
                                      </span>
                                    </div>
                                    {/* Caps */}
                                    <div className="flex items-center justify-between text-base-content/65">
                                      <span>max without maturing</span>
                                      <span>
                                        <span className="text-base-content">{noMatureCap.toFixed(6)}</span>
                                        <span className="text-base-content/45"> csSOL-WT</span>
                                      </span>
                                    </div>
                                    <div className="flex items-center justify-between text-base-content/65">
                                      <span>max after maturing every ticket</span>
                                      <span>
                                        <span className="text-base-content">{fullCap.toFixed(6)}</span>
                                        <span className="text-base-content/45"> csSOL-WT</span>
                                      </span>
                                    </div>
                                    {/* Repay preview */}
                                    <div className="flex items-center justify-between text-base-content/65 pt-1 border-t border-base-300/50">
                                      <span>repays</span>
                                      <span>
                                        <span className="text-base-content">{previewRepay.toFixed(6)}</span>
                                        <span className="text-base-content/45"> cSOL</span>
                                        <span className="text-base-content/45 ml-2">
                                          {redeemLamports < debtLamports ? "(redeem-limited)" : "(debt-limited)"}
                                        </span>
                                      </span>
                                    </div>
                                    {needsMature && amount > 0 && (
                                      <p className="text-[10px] text-warning leading-snug pt-1">
                                        Auto-mature will run first to top up the pool — adds one
                                        wallet signature per ticket needed.
                                      </p>
                                    )}
                                  </div>
                                );
                              })()}
                              <Button
                                variant="primary"
                                size="md"
                                fullWidth
                                loading={busy}
                                disabled={
                                  busy ||
                                  !isTicketMatured ||
                                  !wtUnwindAmountStr ||
                                  parseFloat(wtUnwindAmountStr) <= 0 ||
                                  parseFloat(wtUnwindAmountStr) > csSolWtCollateral ||
                                  existing.wsolDebt <= 0
                                }
                                onClick={() => void onWtRedeemAmount()}
                              >
                                Unwind {wtUnwindAmountStr || "0"} csSOL-WT → wSOL · repay debt
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* DEBT side — mirrors the COLLATERAL side's hierarchy
                  exactly: same outer padding (`px-5 pt-4 pb-3` for the
                  header, `px-5 py-3 border-t` for the row), same icon
                  size, same `text-xl` amount + USD-on-the-right top
                  line, same caption row. The two halves now read as a
                  matched ledger pair instead of competing layouts. */}
              <div className="relative rounded-2xl border border-warning/30 bg-gradient-to-br from-warning/10 via-warning/[0.04] to-transparent">
                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl overflow-hidden">
                  <span className="absolute -top-10 -right-10 h-32 w-32 rounded-full opacity-25 blur-2xl"
                    style={{ background: "radial-gradient(closest-side, var(--color-warning, #B57F3A), transparent 70%)" }} />
                </span>
                <div className="relative">
                  <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <Badge tone="warning" variant="soft" size="xs">debt</Badge>
                    <span className="text-[10px] text-base-content/40 font-mono uppercase tracking-[0.18em]">borrowed</span>
                  </div>

                  <div className="px-5 py-3 border-t border-warning/20">
                    <div className="flex items-center gap-3">
                      <TokenIcon symbol="cSOL" size="md" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-display text-xl tabular-nums leading-none tracking-tight">
                            {fmt(existing.wsolDebt)}
                          </span>
                          <span className="text-xs text-base-content/55 font-mono tabular-nums">
                            {fmtUsd(debtValueUsd)}
                          </span>
                        </div>
                        <div className="text-[11px] text-base-content/55 font-mono mt-1">
                          cSOL · KYC-wrapped · <span className="text-warning">{fmtApr(csolBorrowApr)} APR</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Equity / LTV / Health summary + health bar — uses TOTAL
                collateral (csSOL + csSOL-WT) so the LTV reflects what
                klend actually sees. */}
            <div className="mt-4 pt-4 border-t border-base-300/60 space-y-3">
              {/* Carry summary — collateral yield, borrow cost, net.
                  The net is the headline metric for a leveraged-csSOL
                  desk: it's the APR they actually earn on equity after
                  paying for the borrow. */}
              {(() => {
                // Only the liquid csSOL earns. csSOL-WT is a queued
                // withdraw ticket — accrual stops the moment Convert
                // runs, so it must be excluded from the yield maths
                // even though klend still counts it as collateral.
                const collateralYieldUsd =
                  existing.csSolCollateral * csSolPrice * CSSOL_RESTAKING_APR;
                const borrowCostUsd = existing.wsolDebt * wsolPrice * csolBorrowApr;
                const netUsdYr = collateralYieldUsd - borrowCostUsd;
                const netAprOnEquity = equityUsd > 0 ? netUsdYr / equityUsd : 0;
                return (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-4 pb-3 border-b border-base-300/40">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Collateral APY</div>
                      <div className="font-mono tabular-nums text-base mt-1 text-success">{fmtApr(CSSOL_RESTAKING_APR)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Borrow APR</div>
                      <div className="font-mono tabular-nums text-base mt-1 text-warning">{fmtApr(csolBorrowApr)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Net carry</div>
                      <div className={cn(
                        "font-mono tabular-nums text-base mt-1",
                        netAprOnEquity > 0 ? "text-success" : netAprOnEquity < 0 ? "text-error" : "text-base-content/55",
                      )}>
                        {netAprOnEquity > 0 ? "+" : ""}{fmtApr(netAprOnEquity)}
                        <span className="text-[10px] text-base-content/40 ml-1.5">on equity</span>
                      </div>
                    </div>
                    <div className="hidden sm:block">
                      <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Annualised P/L</div>
                      <div className={cn(
                        "font-mono tabular-nums text-base mt-1",
                        netUsdYr > 0 ? "text-success" : netUsdYr < 0 ? "text-error" : "text-base-content/55",
                      )}>
                        {netUsdYr >= 0 ? "+" : ""}{fmtUsd(netUsdYr)}
                      </div>
                    </div>
                  </div>
                );
              })()}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Equity</div>
                  <div className="font-mono tabular-nums text-base mt-1">{fmtUsd(equityUsd)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Current LTV</div>
                  <div className="font-mono tabular-nums text-base mt-1">{currentLtvPct.toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Health factor</div>
                  <div className={cn("font-mono tabular-nums text-base mt-1", hfTone)}>
                    {Number.isFinite(healthFactor) ? healthFactor.toFixed(2) : "∞"}
                  </div>
                </div>
              </div>

              <div>
                <div className="relative h-2 rounded-full bg-base-300 overflow-hidden">
                  <div
                    className={cn("h-full transition-all duration-500", ltvBarTone)}
                    style={{ width: `${ltvBarPct}%` }}
                  />
                  <div aria-hidden className="absolute top-0 bottom-0 w-px bg-warning/70"
                    style={{ left: `${ltvCapPct}%` }} title={`${ltvCapPct}% LTV cap`} />
                  <div aria-hidden className="absolute top-0 bottom-0 w-px bg-error/80"
                    style={{ left: `${liqThresholdPct}%` }} title={`${liqThresholdPct}% liq threshold`} />
                </div>
                <div className="flex justify-between text-[10px] text-base-content/45 font-mono mt-1">
                  <span>0%</span>
                  <span className="text-warning/80">cap {ltvCapPct}%</span>
                  <span className="text-error/80">liq {liqThresholdPct}%</span>
                </div>
              </div>
            </div>
          </Card>
        );
      })()}

      {/* Close-position step card removed — its three actions
          (Convert / Wait / Unwind) are now driven entirely from the
          inline buttons on the Open Position card above:
            - csSOL row → "Unstake to csSOL-WT →" (Convert)
            - csSOL-WT row → progress bar + countdown (Wait)
            - csSOL-WT row → "Unwind to SOL →" (Unwind, matured-only)
          Keeping a duplicate step ladder beneath the rows was redundant
          and made the page longer than it needed to be. */}

      {/* Open form + calculator */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card tone="elevated" size="lg">
          <CardHeader
            title={hasPosition && existing.wsolDebt > 0 ? "Increase position" : "Open position"}
            eyebrow="Atomic 1-tx leveraged loop"
          />
          <div className="space-y-4">
            <div>
              <label className="text-xs text-base-content/65 block mb-1">Margin asset</label>
              <div className="flex gap-1.5">
                {(["SOL", "wSOL", "csSOL"] as MarginAsset[]).map((a) => (
                  <Button
                    key={a}
                    variant={marginAsset === a ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setMarginAsset(a)}
                    disabled={busy}
                  >{a}</Button>
                ))}
              </div>
            </div>

            <TokenAmountInput
              symbol={marginAsset as TokenSymbol}
              value={marginAmountStr}
              onChange={setMarginAmountStr}
              balance={balanceFor(marginAsset)}
              balanceDecimals={4}
              balanceUnit={marginAsset}
              onMax={() => setMarginAmountStr(balanceFor(marginAsset).toFixed(6))}
            />

            {/* Leverage-up shortcut — only meaningful when there's
                already csSOL collateral. Sets margin = 0, the flash-
                loop then just adds another round-trip of (borrow →
                deposit → borrow-to-repay) on top of the existing
                position. The trade-size input above still drives the
                amount, gated by the LTV-bounded `effectiveMaxLoan`. */}
            {hasPosition && existing.csSolCollateral > 0 && (
              <button
                type="button"
                onClick={() => setMarginAmountStr("0")}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                  marginAmount === 0
                    ? "border-primary/40 bg-primary/5"
                    : "border-base-300 bg-base-200/40 hover:border-base-content/30 hover:bg-base-200/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Leverage up · no new margin</span>
                  {marginAmount === 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 text-primary border border-primary/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                      active
                    </span>
                  )}
                </div>
                <div className="text-[11px] opacity-65 mt-0.5 leading-snug">
                  Borrow against your existing {existing.csSolCollateral.toFixed(4)} csSOL — adds debt + collateral atomically. LTV cap still applies.
                </div>
              </button>
            )}

            <div>
              <label className="text-xs text-base-content/65 block mb-1">Trade size (wSOL borrowed = leverage)</label>
              <TokenAmountInput
                symbol={"wSOL" as TokenSymbol}
                value={loanAmountStr}
                onChange={setLoanAmountStr}
                balance={effectiveMaxLoan}
                balanceDecimals={4}
                balanceUnit="wSOL effective max"
                onMax={() => setLoanAmountStr((effectiveMaxLoan * 0.95).toFixed(4))}
                invalid={overReserveCap || overCap}
                errorText={overReserveCap ? "Exceeds open-path reserve cap." : overCap ? "Exceeds 90% LTV cap — borrow will fail." : undefined}
              />
              {quote && Number.isFinite(quote.maxLoanAmount) && (
                <div className="mt-1 text-[11px] text-base-content/55 space-y-0.5">
                  <div>Max at 90% LTV: <span className="font-mono">{quote.maxLoanAmount.toFixed(4)}</span> wSOL</div>
                  <div>Max from reserve liquidity: <span className="font-mono">{reserveCapWsol.toFixed(4)}</span> cSOL <span className="opacity-50">(½ of {wsolReserveAvailable.toFixed(4)} available)</span></div>
                </div>
              )}
              {overReserveCap && (
                <div className="mt-3">
                  <Snackbar
                    variant="inline"
                    type="warning"
                    message={`Trade size ${loanAmount.toFixed(4)} cSOL exceeds the open-path cap of ${reserveCapWsol.toFixed(4)} cSOL.`}
                    detail="Flash + borrow consumes 2× loan in-flight. Reduce trade size or wait for more cSOL liquidity."
                    action={
                      <Button
                        variant="link"
                        size="xs"
                        className="!font-bold !tracking-wider uppercase"
                        onClick={() => setLoanAmountStr((reserveCapWsol * 0.95).toFixed(4))}
                      >
                        Use cap
                      </Button>
                    }
                  />
                </div>
              )}
            </div>

            {/* Margin = 0 is OK when there's csSOL collateral to lever
                against (the flash-loop can deposit purely from the
                loan side); otherwise the fresh-open path needs margin
                > 0 to leave net collateral after the flash-repay. */}
            {(() => {
              const isLeverageUp = marginAmount === 0 && hasPosition && existing.csSolCollateral > 0;
              const ctaLabel = isLeverageUp
                ? "Leverage up"
                : hasPosition && existing.wsolDebt > 0
                  ? "Increase position"
                  : "Open position";
              const disabled = busy
                || (!isLeverageUp && marginAmount <= 0)
                || loanAmount <= 0
                || overCap
                || overReserveCap
                || whitelisted === false;
              return (
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={busy}
                  disabled={disabled}
                  onClick={() => void onOpen()}
                >
                  {ctaLabel}
                </Button>
              );
            })()}

            {obligationExists === false && (
              <p className="text-[11px] text-base-content/55">First trade — your obligation will be initialized in this tx.</p>
            )}
          </div>
        </Card>

        <Card tone="elevated" size="lg">
          <CardHeader title="Position after open" eyebrow="Calculator" />
          {!quote ? (
            <p className="text-xs text-base-content/55">Loading prices…</p>
          ) : (
            <div className="space-y-2 text-sm">
              <KeyValue compact label="Collateral (csSOL)" value={`${fmt(quote.collateralCsSol)} (${fmtUsd(quote.collateralUsd)})`} />
              <KeyValue compact label="Debt (cSOL)" value={`${fmt(quote.debtWsol)} (${fmtUsd(quote.debtUsd)})`} />
              <KeyValue compact label="Equity" value={fmtUsd(equityUsd)} />
              <KeyValue compact label="Leverage" value={`${quote.leverage.toFixed(2)}×`} />
              <KeyValue compact label="LTV" value={
                <span className={cn(quote.ltvAfterPct >= 90 && "text-warning")}>{quote.ltvAfterPct.toFixed(2)}%</span>
              } />
              <KeyValue compact label="Health factor" value={
                <span className={cn(Number.isFinite(quote.health) && quote.health < 1.1 && "text-warning")}>
                  {Number.isFinite(quote.health) ? quote.health.toFixed(2) : "∞"}
                </span>
              } />
              <KeyValue compact label="Liquidation csSOL price" value={<span className="text-error">{fmtUsd(quote.liquidationCsSolPriceUsd)}</span>} />
              {quote.warnings.length > 0 && (
                <ul className="text-[11px] text-warning list-disc pl-4 space-y-0.5 mt-2">
                  {quote.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Tx console */}
      {(busy || log.length > 0 || error) && (
        <Card tone="muted" size="md">
          <SectionHeader
            title="Transaction console"
            actions={
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setLog([]); setError(null); }}>Clear</Button>
            }
          />
          {log.length > 0 && (
            <pre className="bg-base-300 rounded p-2 text-[11px] whitespace-pre-wrap font-mono max-h-40 overflow-auto">
              {log.join("\n")}
            </pre>
          )}
          {error && (
            <Snackbar
              variant="inline"
              type="error"
              message={intent ? `${intent} — failed` : "Transaction failed"}
              detail={error}
              action={
                <CopyErrorButton
                  text={[
                    intent ? `Action: ${intent}` : null,
                    `Error: ${error}`,
                    log.length > 0 ? `\nLogs:\n${log.join("\n")}` : null,
                  ].filter(Boolean).join("\n")}
                />
              }
            />
          )}
        </Card>
      )}

      {/* Floating toast — mirrors `error` so failures pop above the
          fold instead of being buried under the long credit-trade
          form. The headline carries the action intent ("Unwinding 0.001
          csSOL …") so a user juggling several tx flows can tell which
          one bounced without scrolling to the console. The "Copy"
          action puts the full error string + intent + tx logs onto
          the clipboard so the user can paste it directly into a
          support thread / GitHub issue without re-typing the truncated
          toast detail. */}
      {error && (
        <Snackbar
          variant="toast"
          type="error"
          message={intent ? `${intent} — failed` : "Transaction failed"}
          detail={error}
          action={
            <CopyErrorButton
              text={[
                intent ? `Action: ${intent}` : null,
                `Error: ${error}`,
                log.length > 0 ? `\nLogs:\n${log.join("\n")}` : null,
              ].filter(Boolean).join("\n")}
            />
          }
          onDismiss={() => setError(null)}
        />
      )}
      {/* Success toast — same shape as the error one but auto-dismisses
          after 8s so it doesn't pile up after a multi-step flow. The
          detail line shows the truncated signature; the action slot
          carries a proper one-click link to the explorer (and a copy
          button for the full signature) so the user doesn't have to
          select-text out of a toast. */}
      {confirmedSig && !error && (
        <Snackbar
          variant="toast"
          type="success"
          message={intent ? `${intent} — confirmed` : "Transaction confirmed"}
          detail={`sig=${confirmedSig.slice(0, 12)}…${confirmedSig.slice(-8)}`}
          action={<TxActionButtons sig={confirmedSig} />}
          dismissAfterMs={8000}
          onDismiss={() => setConfirmedSig(null)}
        />
      )}
    </div>
  );
}

function StepBadge({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <Badge
      tone={done ? "success" : active ? "primary" : "neutral"}
      variant={done || active ? "soft" : "outline"}
      size="xs"
    >
      {done ? "✓" : n}. {label}
    </Badge>
  );
}

/**
 * Two-button cluster for the success toast — an "Explorer ↗" link
 * (proper anchor so middle-click / cmd-click / right-click all work)
 * and a "Copy sig" fallback for users who want to paste the full
 * signature into a support thread or the explorer's own search box.
 *
 * Rendered inline in the Snackbar's action slot so the toast itself
 * stays minimal: the detail line shows a short truncated sig, and the
 * actions handle "go look at this on chain" / "share this sig".
 */
function TxActionButtons({ sig }: { sig: string }) {
  const [copied, setCopied] = useState(false);
  const explorerUrl = `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  return (
    <div className="flex items-center gap-1.5">
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-base-300 bg-base-200 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-base-content/80 transition-colors hover:bg-base-300 hover:text-base-content"
        title="Open transaction on Solana Explorer"
      >
        Explorer
        <svg
          className="h-3 w-3 -mt-0.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14 4h6v6M20 4l-9 9M5 5h6M5 5v14h14v-6" />
        </svg>
      </a>
      <Button
        size="xs"
        variant="ghost"
        onClick={async () => {
          try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(sig);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { /* clipboard blocked */ }
        }}
      >
        {copied ? "Copied ✓" : "Copy sig"}
      </Button>
    </div>
  );
}

/**
 * Small copy-to-clipboard button for the error toast / inline error.
 * Renders as a 2-state Button: "Copy" → "Copied ✓" for ~1.5s, then
 * resets. Falls back to a textarea select-all if the modern Clipboard
 * API isn't available (e.g. non-secure-origin previews).
 */
function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="secondary"
      onClick={async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked; the user can still select the toast text */
        }
      }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </Button>
  );
}
