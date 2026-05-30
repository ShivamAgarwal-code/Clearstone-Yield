import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { DEVNET_CONFIG } from "../config/devnet";
import { Button, Card, Input, Snackbar, TokenIcon, TxActionButtons, shortSig } from "@clearstone/design-system";
import type { TokenSymbol } from "@clearstone/design-system";

/**
 * ElevationGroupsPanel — operator surface for klend's per-market EG slots.
 *
 * Reads the LendingMarket account, decodes the `elevation_groups: [ElevationGroup; 32]`
 * slice, and renders every slot. Configured slots show LTV / liq / max_collat /
 * debt_reserve at a glance. Empty slots get a "Register" affordance. The
 * market owner (`AhKNm…aJX` on devnet) can edit any slot in place; non-owner
 * wallets see the data read-only.
 *
 * Wraps the same `update_lending_market(mode = UpdateElevationGroup)` ix
 * that `scripts/setup-margin-egs.ts` uses on the CLI side, so values
 * written here are immediately reflected in the script's checkpoint
 * file the next time it runs.
 */

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const LM_OWNER_OFFSET = 24;
const ELEVATION_GROUPS_OFFSET = 200;
const ELEVATION_GROUP_SIZE = 72;
const ELEVATION_GROUP_SLOTS = 32;

// Anchor discriminator for `update_lending_market` —
// sha256("global:update_lending_market")[0..8]. ix data layout:
//   disc(8) + mode(u64 LE) + value([u8; 72]).
// Mode 9 = `UpdateLendingMarketMode::UpdateElevationGroup`.
//
// The `value` is the borsh-packed `ElevationGroup` struct (same 72-byte
// layout as on-chain — see lib/klend-elevation-group.ts in programs/).
//
// Bug history: this was previously [162, 79, 191, 233, …], which doesn't
// match any klend ix and got rejected with `InstructionFallbackNotFound`
// (Anchor 101 / 0x65). Cross-checked against the working
// `migrate-eg-debt-to-cusdc.ts` script + recomputed locally.
const UPDATE_LENDING_MARKET_DISC = new Uint8Array([209, 157, 53, 210, 97, 180, 31, 45]);

interface DecodedEg {
  /** The slot index in elevation_groups[]. Useful only for debugging. */
  slot: number;
  /** Klend EG id (0 = empty slot, otherwise 1..=32). */
  id: number;
  ltvPct: number;
  liquidationThresholdPct: number;
  allowNewLoans: number;
  maxReservesAsCollateral: number;
  maxLiquidationBonusBps: number;
  debtReserve: PublicKey;
}

function decodeEg(buf: Buffer, slot: number): DecodedEg {
  const off = ELEVATION_GROUPS_OFFSET + slot * ELEVATION_GROUP_SIZE;
  return {
    slot,
    maxLiquidationBonusBps: buf.readUInt16LE(off + 0),
    id: buf.readUInt8(off + 2),
    ltvPct: buf.readUInt8(off + 3),
    liquidationThresholdPct: buf.readUInt8(off + 4),
    allowNewLoans: buf.readUInt8(off + 5),
    maxReservesAsCollateral: buf.readUInt8(off + 6),
    debtReserve: new PublicKey(buf.subarray(off + 8, off + 40)),
  };
}

function packEg(p: {
  id: number;
  ltvPct: number;
  liquidationThresholdPct: number;
  maxLiquidationBonusBps: number;
  allowNewLoans: number;
  maxReservesAsCollateral: number;
  debtReserve: PublicKey;
}): Buffer {
  if (p.id < 1 || p.id > 32) throw new Error("id must be 1..=32");
  if (p.liquidationThresholdPct < p.ltvPct) {
    throw new Error("liq threshold must be ≥ LTV");
  }
  const buf = Buffer.alloc(72);
  buf.writeUInt16LE(p.maxLiquidationBonusBps & 0xffff, 0);
  buf.writeUInt8(p.id, 2);
  buf.writeUInt8(p.ltvPct, 3);
  buf.writeUInt8(p.liquidationThresholdPct, 4);
  buf.writeUInt8(p.allowNewLoans, 5);
  buf.writeUInt8(p.maxReservesAsCollateral, 6);
  buf.writeUInt8(0, 7); // padding
  p.debtReserve.toBuffer().copy(buf, 8);
  // padding1: [u64; 4] — already zeroed.
  return buf;
}

/**
 * Walk an arbitrary error caught from `sendTransaction` /
 * `simulateTransaction` and produce a human-readable detail string for
 * the toast.
 *
 * Wallet adapters routinely wrap the underlying `SendTransactionError`
 * as a generic `"Unexpected error"` and stash the real cause under
 * `e.error` / `e.cause` / `e.originalError` / nested. The adapter chain
 * we bump into is messy:
 *   - `WalletSendTransactionError(message="Unexpected error", error=…)`
 *   - inside: `SendTransactionError(message=…, transactionLogs=…)`
 *   - inside *that*: the actual `RpcResponseError` with the program-
 *     log lines
 *
 * We pull the most descriptive `message` from the chain and the last
 * 14 program-log lines (preferring the deepest non-empty log array),
 * then concat them so the operator gets the actual klend error code +
 * any "Program log: …" lines without opening devtools.
 */
function extractTxErrorDetail(e: any): string {
  // Walk the cause chain to find the most descriptive message + the
  // deepest non-empty `logs` array.
  let bestMessage: string | null = null;
  let bestLogs: string[] | null = null;
  const seen = new Set<any>();
  let cur: any = e;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.message === "string" && cur.message.trim() && cur.message !== "Unexpected error") {
      // Prefer specific messages over the generic wallet-adapter wrap.
      if (bestMessage === null || bestMessage === "Unexpected error") {
        bestMessage = cur.message;
      }
    } else if (bestMessage === null && typeof cur.message === "string") {
      bestMessage = cur.message;
    }
    const logs: unknown =
      cur.transactionLogs ??
      cur.logs ??
      (typeof cur.getLogs === "function" ? null /* async, can't await here */ : null);
    if (Array.isArray(logs) && logs.length > 0) {
      bestLogs = logs as string[];
    }
    // Step into the first non-circular cause we can find.
    cur = cur.error ?? cur.cause ?? cur.originalError ?? cur.innerError ?? null;
  }

  const parts: string[] = [];
  if (bestMessage) parts.push(bestMessage);
  if (bestLogs && bestLogs.length) {
    parts.push("Logs:\n  " + bestLogs.slice(-14).join("\n  "));
  }
  if (parts.length) return parts.join("\n\n");
  // Last-resort fallback — stringify the whole thing so SOMETHING
  // shows up. JSON.stringify swallows non-enumerable props (including
  // `message` on Error subclasses), so we tack it on if present.
  try {
    const json = JSON.stringify(e);
    if (json && json !== "{}") return json;
  } catch { /* fall through */ }
  if (e?.message) return String(e.message);
  return String(e);
}

function buildUpdateElevationGroupIx(
  marketOwner: PublicKey,
  market: PublicKey,
  egValue: Buffer,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 72);
  Buffer.from(UPDATE_LENDING_MARKET_DISC).copy(data, 0);
  data.writeBigUInt64LE(9n, 8); // mode = UpdateElevationGroup
  egValue.copy(data, 16);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: marketOwner, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Reverse-lookup of well-known reserve pubkeys → human-readable label.
 *  Includes the retired wSOL reserve so historical EG members (where
 *  wSOL was the EG-2 debt before the 2026-05-06 cSOL migration) still
 *  render with a name rather than a truncated pubkey. The dropdown
 *  options below filter wSOL out so operators can't pick it for a new
 *  group. */
const RESERVE_LABELS: Record<string, string> = {
  [DEVNET_CONFIG.market.csSolReserve.toBase58()]:    "csSOL",
  [DEVNET_CONFIG.market.csSolWtReserve.toBase58()]:  "csSOL-WT",
  [DEVNET_CONFIG.market.cSolReserve.toBase58()]:     "cSOL",
  [DEVNET_CONFIG.market.wsolReserve.toBase58()]:     "wSOL (legacy)",
  [DEVNET_CONFIG.market.ceUsxReserve.toBase58()]:    "ceUSX",
  [DEVNET_CONFIG.market.cUsdcReserve.toBase58()]:    "cUSDC",
  [DEVNET_CONFIG.market.sUsdcReserve.toBase58()]:    "sUSDC (legacy)",
};
function reserveLabel(r: PublicKey): string {
  return RESERVE_LABELS[r.toBase58()] ?? r.toBase58().slice(0, 6) + "…" + r.toBase58().slice(-4);
}

/** Default presets we surface in the editor — covers the v3 EGs we care
 *  about today. The "Custom" preset just lets the operator type freely. */
const PRESETS: { key: string; label: string; init: Partial<EditorState> }[] = [
  {
    key: "custom",
    label: "Custom",
    init: {},
  },
  {
    key: "stables",
    label: "EG-1 Stables (90/92)",
    // Debt flipped from sUSDC → cUSDC on 2026-05-07 — the cUSDC
    // wrapper carries the on-chain KYC gate that the legacy reserve
    // didn't, so new EG bindings should default to it.
    init: { id: 1, ltvPct: 90, liqPct: 92, maxColl: 1, debtSymbol: "cUSDC" },
  },
  {
    key: "lst-sol",
    label: "EG-2 LST/SOL (90/92)",
    init: { id: 2, ltvPct: 90, liqPct: 92, maxColl: 2, debtSymbol: "cSOL" },
  },
  {
    key: "margin-long",
    label: "EG-3 Margin Long SOL (65/85)",
    init: { id: 3, ltvPct: 65, liqPct: 85, maxColl: 1, debtSymbol: "cUSDC" },
  },
  {
    key: "margin-short",
    label: "EG-4 Margin Short SOL (65/85)",
    init: { id: 4, ltvPct: 65, liqPct: 85, maxColl: 1, debtSymbol: "cSOL" },
  },
];

/** Reserve dropdown options for the debt-side picker. KYC-gated cUSDC
 *  + cSOL come first since those are the live debt assets the v3
 *  market actually uses. wSOL is excluded entirely (retired 2026-05-06,
 *  status=Hidden). sUSDC stays so legacy EGs that haven't been migrated
 *  yet still surface their current debt — but it's flagged so an
 *  operator can't pick it for a new EG by accident. */
interface DebtReserveOption {
  /** Symbol label — what shows in the trigger and the listbox row. */
  label: string;
  /** On-chain klend reserve pubkey, or null when not registered yet
   *  (the option then renders disabled with a "not registered" chip). */
  pubkey: PublicKey | null;
  /** TokenIcon symbol — uniform mark across the dropdown so the
   *  options scan visually as the assets they are, not as text rows. */
  iconSymbol: TokenSymbol;
  /** Set when this reserve has been migrated past on-chain — option
   *  still renders so a stuck obligation can be edited, but the row
   *  is dimmed and tagged so an operator picking a debt asset for a
   *  new EG defaults to the live one above. */
  legacy?: boolean;
}
const DEBT_RESERVE_OPTIONS: DebtReserveOption[] = [
  { label: "cUSDC",    pubkey: DEVNET_CONFIG.market.cUsdcReserve,    iconSymbol: "cUSDC" },
  { label: "cSOL",     pubkey: DEVNET_CONFIG.market.cSolReserve,     iconSymbol: "cSOL"  },
  { label: "ceUSX",    pubkey: DEVNET_CONFIG.market.ceUsxReserve,    iconSymbol: "ceUSX" },
  { label: "csSOL",    pubkey: DEVNET_CONFIG.market.csSolReserve,    iconSymbol: "csSOL" },
  { label: "csSOL-WT", pubkey: DEVNET_CONFIG.market.csSolWtReserve,  iconSymbol: "csSOL-WT" },
  // Legacy / migrated reserves — kept selectable so an operator can
  // edit an EG that still points at one of them, but visually demoted.
  { label: "sUSDC",    pubkey: DEVNET_CONFIG.market.sUsdcReserve,    iconSymbol: "sUSDC", legacy: true },
];

interface EditorState {
  id: number;
  ltvPct: number;
  liqPct: number;
  maxColl: number;
  liqBonusBps: number;
  allowLoans: boolean;
  debtSymbol: string;
}

const DEFAULT_EDITOR: EditorState = {
  // Default debt = cUSDC (the live KYC-gated USD debt asset). sUSDC is
  // legacy in the dropdown — registering a new EG against it would
  // immediately need re-binding the moment its deprecation flips on.
  id: 0, ltvPct: 65, liqPct: 85, maxColl: 1, liqBonusBps: 1000,
  allowLoans: true, debtSymbol: "cUSDC",
};

export default function ElevationGroupsPanel() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const market = DEVNET_CONFIG.market.lendingMarket;

  const [groups, setGroups] = useState<DecodedEg[] | null>(null);
  const [marketOwner, setMarketOwner] = useState<PublicKey | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DecodedEg | null>(null);
  const [editorState, setEditorState] = useState<EditorState>(DEFAULT_EDITOR);
  /** Toast state — mirrors the shape both the institutional + retail
   *  apps use. `sig` lights up the Explorer + Copy-sig action cluster
   *  on success; `detail` carries the long-form error message verbatim
   *  on failure (no slice, the toast's built-in copy button hands the
   *  whole payload to the operator without devtools). */
  const [status, setStatus] = useState<
    | { msg: string; type: "info" | "success" | "error"; sig?: string; detail?: string }
    | null
  >(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const info = await connection.getAccountInfo(market, "confirmed");
      if (!info) throw new Error("market account not found");
      const buf = Buffer.from(info.data);
      setMarketOwner(new PublicKey(buf.subarray(LM_OWNER_OFFSET, LM_OWNER_OFFSET + 32)));
      const decoded: DecodedEg[] = [];
      for (let i = 0; i < ELEVATION_GROUP_SLOTS; i++) {
        decoded.push(decodeEg(buf, i));
      }
      setGroups(decoded);
    } catch (e: any) {
      console.error("EG reload failed:", e);
      setStatus({
        msg: "Failed to load elevation groups",
        type: "error",
        detail: e?.message ?? (typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })()),
      });
    } finally {
      setLoading(false);
    }
  }, [connection, market]);

  useEffect(() => { void reload(); }, [reload]);

  const isOwner = useMemo(
    () => !!publicKey && !!marketOwner && publicKey.toBase58() === marketOwner.toBase58(),
    [publicKey, marketOwner],
  );

  const startEdit = (g: DecodedEg) => {
    setEditing(g);
    setEditorState({
      id: g.id || 0,
      ltvPct: g.ltvPct,
      liqPct: g.liquidationThresholdPct,
      maxColl: g.maxReservesAsCollateral || 1,
      liqBonusBps: g.maxLiquidationBonusBps || 1000,
      allowLoans: !!g.allowNewLoans,
      debtSymbol: reserveLabel(g.debtReserve),
    });
  };
  const startRegister = (slot: number) => {
    // Encourage operator to use slot index + 1 as the EG id (matches the
    // convention we've been using on devnet).
    setEditing({ slot, id: 0, ltvPct: 0, liquidationThresholdPct: 0, maxReservesAsCollateral: 0, allowNewLoans: 0, maxLiquidationBonusBps: 0, debtReserve: PublicKey.default });
    setEditorState({ ...DEFAULT_EDITOR, id: slot + 1 });
  };
  const applyPreset = (presetKey: string) => {
    const p = PRESETS.find((x) => x.key === presetKey);
    if (!p) return;
    setEditorState((cur) => ({ ...cur, ...p.init }));
  };

  const submit = useCallback(async () => {
    if (!publicKey || !sendTransaction || !isOwner) return;
    setStatus({ msg: `Submitting EG-${editorState.id}…`, type: "info" });
    try {
      const debtOption = DEBT_RESERVE_OPTIONS.find((o) => o.label === editorState.debtSymbol);
      if (!debtOption || !debtOption.pubkey) {
        throw new Error(`debt reserve "${editorState.debtSymbol}" not registered yet`);
      }
      const value = packEg({
        id: editorState.id,
        ltvPct: editorState.ltvPct,
        liquidationThresholdPct: editorState.liqPct,
        maxLiquidationBonusBps: editorState.liqBonusBps,
        allowNewLoans: editorState.allowLoans ? 1 : 0,
        maxReservesAsCollateral: editorState.maxColl,
        debtReserve: debtOption.pubkey,
      });
      const ix = buildUpdateElevationGroupIx(publicKey, market, value);
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(ix);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // Pre-flight sim — most wallet adapters wrap the underlying RPC
      // failure as a generic "Unexpected error" by the time
      // `sendTransaction` rejects, swallowing the klend error code +
      // logs. Simulating first lets us surface the real Anchor error
      // (program log + error code) to the operator without depending
      // on the adapter's error-shape gymnastics. `sigVerify: false` so
      // we don't need the wallet to sign just to simulate.
      const sim = await connection.simulateTransaction(tx, undefined, false);
      if (sim.value.err) {
        const err = new Error(`Simulation rejected: ${JSON.stringify(sim.value.err)}`);
        (err as any).transactionLogs = sim.value.logs ?? [];
        throw err;
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus({ msg: `EG-${editorState.id} saved`, type: "success", sig });
      setEditing(null);
      await reload();
    } catch (e: any) {
      // Always full payload to console for triage; the toast carries
      // the long-form error verbatim so the operator can copy it
      // (klend errors plus the last sim log lines rarely fit a
      // one-liner). Wallet adapters love wrapping the actual cause as
      // `e.error` / `e.cause` / `e.originalError`, so we walk the
      // chain to pull whatever's most descriptive — falling back to
      // a stringified payload only as last resort.
      console.error("EG submit failed:", e);
      setStatus({ msg: `EG-${editorState.id} update failed`, type: "error", detail: extractTxErrorDetail(e) });
    }
  }, [publicKey, sendTransaction, connection, isOwner, market, editorState, reload]);

  // --- render ---------------------------------------------------------------

  if (loading && !groups) {
    return <div className="flex items-center justify-center py-12"><span className="loading loading-spinner" /></div>;
  }

  const configured = groups?.filter((g) => g.id !== 0) ?? [];
  const empty = groups?.filter((g) => g.id === 0).slice(0, 8) ?? []; // show up to 8 empty slots

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        {/* Title + status pills. Replaced the daisyUI `badge badge-sm`
            (which read as a tiny coloured rectangle with cramped padding)
            with hand-styled chips that have proper px-2.5 py-1 padding,
            a uniform [11px] uppercase label with letter-spacing so the
            two pills feel like part of the same family, and a leading
            colour dot for the role chip so authority / read-only state
            is parseable at a glance. */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2 className="text-2xl font-bold">Elevation groups</h2>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] bg-info/15 text-info border border-info/25">
            v3 market
          </span>
          {isOwner ? (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] bg-success/15 text-success border border-success/25">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              authority
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] bg-base-200 text-base-content/55 border border-base-300">
              <span className="h-1.5 w-1.5 rounded-full bg-base-content/35" />
              read-only
            </span>
          )}
        </div>
        <p className="text-sm opacity-70 max-w-3xl">
          Klend's per-market EG slots ({ELEVATION_GROUP_SLOTS} total). Each group pins one debt reserve and pairs it with a high-LTV regime over the collateral reserves that opt into it. The lending-market owner edits in-place via{" "}
          <code>update_lending_market(UpdateElevationGroup)</code> — the same ix{" "}
          <code>scripts/setup-margin-egs.ts</code> uses, so changes here are reflected in that script's checkpoint file on its next run.
        </p>
        {marketOwner && (
          <p className="text-xs opacity-50">market owner: <code>{marketOwner.toBase58()}</code></p>
        )}
      </header>

      {/* Configured groups */}
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider opacity-60 mb-2">
          Active ({configured.length + 1 /* +1 for the always-present EG-0 base regime */})
        </h3>
        {/* EG-0 always renders first — it's not a klend slot but the
            "no group" pseudo-state where obligations fall back to
            per-reserve LTV. Listing it makes the panel exhaustive
            (operator sees every regime an obligation can be in) and
            surfaces the full debt-asset set, since EG-0 allows ANY
            registered reserve as debt. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <EgZeroCard />
          {configured.map((g) => (
            <EgCard
              key={g.slot}
              g={g}
              canEdit={isOwner}
              onEdit={() => startEdit(g)}
            />
          ))}
        </div>
      </div>

      {/* Empty slots */}
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider opacity-60 mb-2">
          Empty slots <span className="opacity-40 normal-case font-normal">— click to register</span>
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
          {empty.map((g) => (
            <button
              key={g.slot}
              type="button"
              onClick={() => isOwner && startRegister(g.slot)}
              disabled={!isOwner}
              className={`rounded-lg border-2 border-dashed border-base-300 p-3 text-center transition-all
                ${isOwner ? "hover:border-primary/60 hover:bg-base-200/60 cursor-pointer" : "opacity-40 cursor-not-allowed"}`}
            >
              <div className="text-xs opacity-50 font-mono">slot {g.slot}</div>
              <div className="text-2xl mt-1 opacity-40">+</div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor modal — laid out with explicit vertical rhythm so the
          fields don't crowd. Six numeric/text inputs sit in a 2-col
          grid; the "Allow new loans" toggle is lifted into its own
          row below so it doesn't leave an orphan column on the right
          of the grid. All sections share a consistent y-gap.
          Clicking the backdrop or pressing Esc closes the modal —
          done by listening on the outer container with an early-return
          stopPropagation guard on the inner modal-box. */}
      {editing !== null && (
        <div
          className="modal modal-open"
          onClick={() => setEditing(null)}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
          role="presentation"
        >
          <div
            className="modal-box max-w-2xl bg-base-100 border border-base-300 p-6 sm:p-7"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header className="mb-5">
              <h3 className="font-bold text-xl mb-1">
                {editing.id === 0 ? `Register EG-${editorState.id}` : `Edit EG-${editing.id}`}
              </h3>
              <p className="text-xs opacity-60">
                slot {editing.slot} · klend <code>update_lending_market(UpdateElevationGroup)</code>
              </p>
            </header>

            {/* In-modal status banner — duplicates the page-level alert
                at the top of the section so an error from submit() is
                visible while the modal sits over it. (The page-level
                alert is hidden behind the modal backdrop; raising its
                z-index would float a disconnected message over the
                form.) Only error/info statuses render here — successes
                close the modal, so they only matter on the page. The
                Snackbar's built-in copy button hands the operator the
                full error payload (including klend logs) without
                opening devtools. */}
            {status && status.type !== "success" && (
              <div className="mb-4">
                <Snackbar
                  variant="inline"
                  type={status.type === "error" ? "error" : "info"}
                  message={status.msg}
                  detail={status.detail}
                  onDismiss={() => setStatus(null)}
                />
              </div>
            )}

            <div className="space-y-5">
              {/* Numeric / text fields — explicit y-gap (gap-y-4) so the
                  rows breathe; x-gap stays tighter (gap-x-4) so the
                  two columns visually pair. */}
              {/* Form fields are now design-system <Input> across the
                  board (was a mix of daisyUI `input input-sm input-
                  bordered`). Same numeric / string semantics; the
                  visual difference is that they share the height,
                  radius, focus ring, and font-stack of every other
                  Input + Button + DebtReservePicker on the page. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
                <Field label="EG id (1–32)">
                  <Input
                    inputSize="sm"
                    type="number"
                    min={1}
                    max={32}
                    numeric
                    value={editorState.id}
                    onChange={(e) => setEditorState({ ...editorState, id: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Debt reserve">
                  {/* Custom popover, NOT a native <select>. Native
                      `<select>` popups are owned by the browser/OS so
                      the option panel can render translucent on some
                      Chromium themes regardless of CSS we set on the
                      `<option>` element. The replacement below is a
                      regular div-tree so the panel stacks correctly
                      inside the modal and always has an opaque card
                      background. */}
                  <DebtReservePicker
                    value={editorState.debtSymbol}
                    onChange={(label) => setEditorState((cur) => ({ ...cur, debtSymbol: label }))}
                  />
                </Field>
                <Field label="LTV % (0–100)">
                  <Input
                    inputSize="sm"
                    type="number"
                    min={0}
                    max={100}
                    numeric
                    value={editorState.ltvPct}
                    onChange={(e) => setEditorState({ ...editorState, ltvPct: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Liq threshold % (≥ LTV)">
                  <Input
                    inputSize="sm"
                    type="number"
                    min={0}
                    max={100}
                    numeric
                    value={editorState.liqPct}
                    onChange={(e) => setEditorState({ ...editorState, liqPct: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Max reserves as collateral">
                  <Input
                    inputSize="sm"
                    type="number"
                    min={1}
                    max={5}
                    numeric
                    value={editorState.maxColl}
                    onChange={(e) => setEditorState({ ...editorState, maxColl: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Liq bonus (bps, e.g. 1000 = 10%)">
                  <Input
                    inputSize="sm"
                    type="number"
                    min={0}
                    max={5000}
                    numeric
                    value={editorState.liqBonusBps}
                    onChange={(e) => setEditorState({ ...editorState, liqBonusBps: Number(e.target.value) })}
                  />
                </Field>
              </div>

              {/* Allow-new-loans toggle — own row, full width, with a
                  short explainer next to the switch so the operator
                  knows what flipping it does. The switch itself is
                  hand-rolled (not daisyUI's `toggle`) so the off-state
                  reads as a visible "paused" red rather than a flat
                  grey, and the row gets a status chip that names the
                  effect on the EG (Active / Paused) — those words are
                  what's actually on the line, not just on/off. */}
              {(() => {
                const isOn = editorState.allowLoans;
                const setOn = (v: boolean) => setEditorState({ ...editorState, allowLoans: v });
                return (
                  <div
                    className={[
                      "flex items-start justify-between gap-4 rounded-lg border px-4 py-3 transition-colors",
                      isOn
                        ? "border-success/30 bg-success/5"
                        : "border-warning/35 bg-warning/5",
                    ].join(" ")}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-sm font-medium">Allow new loans</div>
                        <span
                          className={[
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]",
                            isOn
                              ? "bg-success/15 text-success"
                              : "bg-warning/20 text-warning",
                          ].join(" ")}
                        >
                          <span
                            className={[
                              "h-1.5 w-1.5 rounded-full",
                              isOn ? "bg-success" : "bg-warning",
                            ].join(" ")}
                          />
                          {isOn ? "Active" : "Paused"}
                        </span>
                      </div>
                      <div className="text-[11px] opacity-65 mt-1 leading-snug">
                        Off pauses new borrows / deposits in this EG without unwinding existing positions. Toggle off to soft-retire an EG.
                      </div>
                    </div>
                    {/*
                      Hand-rolled switch:
                      - Hidden checkbox owns the value + keyboard a11y
                        (the focus ring lands on the visible track via
                        `peer-focus-visible:`).
                      - Track flips bg colour with a transition so the
                        on/off difference reads visually, not just by
                        position.
                      - Knob translates 24px (from 2px → 26px) and
                        scales subtly on press so the click feels
                        confirmed.
                    */}
                    <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5 select-none">
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={isOn}
                        onChange={(e) => setOn(e.target.checked)}
                        aria-label={isOn ? "Disable new loans" : "Allow new loans"}
                      />
                      <span
                        className={[
                          "relative h-7 w-12 rounded-full transition-colors duration-200 ease-out",
                          "shadow-[inset_0_1px_2px_rgba(31,45,72,0.18)]",
                          "peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-primary/40",
                          isOn ? "bg-success" : "bg-base-300",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "absolute top-0.5 h-6 w-6 rounded-full bg-base-100",
                            "shadow-[0_1px_2px_rgba(31,45,72,0.30),0_0_0_1px_rgba(31,45,72,0.06)]",
                            "transition-transform duration-200 ease-out",
                            isOn ? "translate-x-[22px]" : "translate-x-0.5",
                          ].join(" ")}
                        />
                      </span>
                    </label>
                  </div>
                );
              })()}

              {/* Presets — design-system Card so the inner sub-panels
                  (toggle row + presets) share the same surface family
                  the rest of the console uses. `tone="muted"` recesses
                  it inside the modal-box; `size="sm"` matches the
                  toggle row's compactness. */}
              <Card tone="muted" size="sm">
                <div className="text-xs uppercase tracking-wider opacity-50 font-bold mb-2">Presets</div>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <Button
                      key={p.key}
                      type="button"
                      variant="secondary"
                      size="xs"
                      onClick={() => applyPreset(p.key)}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              </Card>
            </div>

            <div className="modal-action mt-6 pt-4 border-t border-base-300">
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={submit}
                disabled={!isOwner || editorState.id < 1}
                title={!isOwner ? "Read-only — connect the lending-market owner wallet." : undefined}
              >
                {editing.id === 0 ? "Register" : "Update"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Page-level toast — surfaces every status (info / success /
          error) when the modal is closed. The modal carries an inline
          duplicate for active edits so an error from submit() is
          visible while the modal sits over the section. Success toasts
          carry the Explorer + Copy-sig action cluster (institutional /
          retail parity). */}
      {status && (
        <Snackbar
          variant="toast"
          type={status.type}
          message={status.msg}
          detail={status.sig ? `sig=${shortSig(status.sig)}` : status.detail}
          action={status.sig ? <TxActionButtons sig={status.sig} /> : undefined}
          dismissAfterMs={status.type === "success" ? 8000 : undefined}
          onDismiss={() => setStatus(null)}
        />
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="form-control">
      <span className="label-text text-xs opacity-70 mb-1">{label}</span>
      {children}
    </label>
  );
}

/**
 * Hand-rolled debt-reserve picker. Replaces a native `<select>` whose
 * browser-rendered option panel rendered translucent on Chromium —
 * neither `bg-base-100` nor inline `backgroundColor: '#FFF'` on the
 * `<option>` elements fixed it (option backgrounds are advisory, the
 * OS still owns the popup chrome).
 *
 * The popover is a normal absolute-positioned div, so it inherits the
 * modal's stacking context, sits opaque against any theme, and lets us
 * disable un-registered reserves with a clear visual treatment.
 *
 * Behaviour:
 *  - Click the trigger → toggle the panel.
 *  - Click any enabled option → set + close.
 *  - Click outside the trigger or panel → close.
 *  - Esc → close.
 */
function DebtReservePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Esc.
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (!wrapperRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      {/* Trigger — same height + radius + border + focus ring as the
          design-system <Input>'s sm size, so it lines up baseline-wise
          with the surrounding numeric inputs. Hand-rolled (not
          <Input>) because we need a button-with-children, not a text
          input. Padding is `pl-2.5 pr-3` so the icon has room to
          breathe + a `gap-2.5` between icon and label. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          "w-full h-9 pl-2.5 pr-3 rounded-lg",
          "border border-base-300 bg-base-100 text-base-content text-sm",
          "shadow-[inset_0_1px_2px_rgba(31,45,72,0.05)]",
          "flex items-center justify-between gap-2 text-left cursor-pointer outline-none",
          "transition-[border-color,box-shadow,background-color] duration-150 ease-out",
          "hover:border-base-content/35",
          "focus-visible:border-primary/70 focus-visible:shadow-[inset_0_1px_2px_rgba(31,45,72,0.05),0_0_0_3px_rgba(31,45,72,0.10)]",
        ].join(" ")}
      >
        {/* Trigger inner — token icon + label so the trigger matches
            the rendered options. Falls back to "Select…" if value is
            empty. `gap-2.5` + the trigger's pl-2.5 give the icon real
            breathing room (was cramped against the left edge before). */}
        <span className="flex items-center gap-2.5 min-w-0">
          {(() => {
            const opt = DEBT_RESERVE_OPTIONS.find((o) => o.label === value);
            return opt ? (
              <>
                {/* Fixed-width centring slot. TokenIcon's outer wrapper
                    is `inline-block align-middle`, which aligns to the
                    parent text baseline rather than the box centre —
                    inside the trigger's `text-sm` (leading-5) the icon
                    drifts upward by ~2px. `leading-none` on this slot
                    kills the inherited line-height; `className="block"`
                    on TokenIcon (merged via tailwind-merge) replaces
                    its inline-block+align-middle with block-level
                    layout so the slot's flex centring actually pins
                    the icon to the trigger's mid-line. */}
                <span className="inline-flex items-center justify-center w-5 h-5 shrink-0 leading-none">
                  <TokenIcon symbol={opt.iconSymbol} size="xs" className="block" />
                </span>
                <span className="truncate font-mono">{opt.label}</span>
                {opt.legacy && (
                  <span className="text-[9px] uppercase tracking-[0.14em] rounded-full bg-warning/15 text-warning border border-warning/25 px-1.5 py-0.5 font-semibold shrink-0">
                    legacy
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-base-content/55">{value || "Select…"}</span>
            );
          })()}
        </span>
        <svg
          className={`h-3 w-3 text-base-content/55 transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          // z-50 keeps the panel above the modal-box's other rows.
          // Solid bg + border + shadow so it reads as a discrete card
          // regardless of theme tokens.
          className="absolute left-0 right-0 top-full mt-1 z-50 max-h-64 overflow-auto rounded-lg border border-base-300 bg-base-100 shadow-[0_8px_24px_rgba(31,45,72,0.18)] py-1"
        >
          {DEBT_RESERVE_OPTIONS.map((o) => {
            const disabled = !o.pubkey;
            const selected = o.label === value;
            return (
              <li
                key={o.label}
                role="option"
                aria-selected={selected}
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onChange(o.label);
                  setOpen(false);
                }}
                className={[
                  // pl-2.5 / pr-3 mirrors the trigger so the icon's left
                  // margin is identical when the panel is closed vs.
                  // open. gap-2.5 between icon + label matches.
                  "pl-2.5 pr-3 py-2 text-sm flex items-center gap-2.5",
                  disabled
                    ? "opacity-40 cursor-not-allowed"
                    : "cursor-pointer hover:bg-base-200",
                  selected && !disabled ? "bg-primary/10 text-primary" : "",
                  o.legacy && !disabled ? "opacity-75" : "",
                ].join(" ")}
              >
                {/* Same fixed-width centring slot as the trigger so
                    every icon's left edge lines up across the panel. */}
                <span className="inline-flex items-center justify-center w-5 h-5 shrink-0 leading-none">
                  <TokenIcon symbol={o.iconSymbol} size="xs" className="block" />
                </span>
                <span className="truncate font-mono">{o.label}</span>

                {/* Trailing chips — at most one of (legacy, not
                    registered) is rendered, then the selection
                    checkmark. `ml-auto` pushes everything after the
                    label to the right edge. */}
                {o.legacy && !disabled && (
                  <span className="ml-auto text-[10px] uppercase tracking-[0.14em] rounded-full bg-warning/15 text-warning border border-warning/25 px-1.5 py-0.5 font-semibold shrink-0">
                    legacy
                  </span>
                )}
                {disabled && (
                  <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-base-content/45 shrink-0">
                    not registered
                  </span>
                )}
                {selected && !disabled && (
                  <svg className={`h-3.5 w-3.5 shrink-0 ${o.legacy ? "ml-2" : "ml-auto"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface EgCardProps {
  g: DecodedEg;
  canEdit: boolean;
  onEdit: () => void;
}

/**
 * Per-EG visual identity. Each row pins:
 *   * `accent`     — border + faint surface tint for the whole card
 *   * `chip`       — solid colour fill for the EG-N pill on the card
 *   * `name`       — short human label klend itself uses in script names
 *                    (`stables`, `lst-sol`, …) so the card reads as a
 *                    domain object, not just an enum number
 *   * `subtitle`   — what the EG lets a wallet do in plain English
 *
 * Falls back to a neutral palette for any EG outside the v3 set so a
 * future EG-5 doesn't render unstyled.
 */
const EG_THEME: Record<number, { accent: string; chip: string; name: string; subtitle: string }> = {
  1: {
    accent: "border-[#4F8AC9]/55 bg-[#4F8AC9]/5",
    chip:   "bg-[#4F8AC9] text-white",
    name:   "Stables",
    subtitle: "ceUSX → cUSDC borrow",
  },
  2: {
    accent: "border-[#7A5C2F]/55 bg-[#7A5C2F]/5",
    chip:   "bg-[#7A5C2F] text-white",
    name:   "LST / SOL",
    subtitle: "csSOL → cSOL borrow",
  },
  3: {
    accent: "border-[#2E7D5B]/55 bg-[#2E7D5B]/5",
    chip:   "bg-[#2E7D5B] text-white",
    name:   "Margin long SOL",
    subtitle: "cSOL collateral · cUSDC debt",
  },
  4: {
    accent: "border-[#B57F3A]/55 bg-[#B57F3A]/5",
    chip:   "bg-[#B57F3A] text-white",
    name:   "Margin short SOL",
    subtitle: "cUSDC collateral · cSOL debt",
  },
};
const EG_THEME_FALLBACK = {
  accent: "border-base-300 bg-base-200/40",
  chip:   "bg-base-content text-base-100",
  name:   "Custom group",
  subtitle: "Configure in-place",
};

/** Map a reserve label (from RESERVE_LABELS) to a TokenIcon symbol.
 *  Strips the `(legacy)` annotation and `-WT` suffixes that the design-
 *  system icon doesn't carry. Falls back to USDC's mark for unknown
 *  USD-pegged variants and SOL's for any *SOL string. */
function reserveTokenSymbol(label: string): TokenSymbol {
  const cleaned = label.replace(/\s*\(legacy\)$/i, "").trim();
  if (cleaned === "csSOL-WT") return "csSOL-WT";
  if (cleaned === "csSOL")    return "csSOL";
  if (cleaned === "cSOL")     return "cSOL";
  if (cleaned === "wSOL")     return "wSOL";
  if (cleaned === "ceUSX")    return "ceUSX";
  if (cleaned === "ceUSX-WT") return "ceUSX";
  if (cleaned === "cUSDC")    return "cUSDC";
  if (cleaned === "sUSDC")    return "sUSDC";
  if (cleaned.endsWith("SOL")) return "SOL";
  return "USDC";
}

function EgCard({ g, canEdit, onEdit }: EgCardProps) {
  const theme = EG_THEME[g.id] ?? EG_THEME_FALLBACK;
  const debtName = reserveLabel(g.debtReserve);
  const debtSymbol = reserveTokenSymbol(debtName);
  return (
    <div className={`rounded-xl border-2 ${theme.accent} p-4 space-y-3`}>
      {/* Header — solid colour chip with the EG id, semantic name, and
          slot index aligned to the right. The chip is solid (not a
          tint) because it's the dominant visual anchor of the card. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-xs font-bold tabular-nums ${theme.chip}`}>
            EG-{g.id}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">{theme.name}</div>
            <div className="text-[11px] opacity-60 leading-tight truncate">{theme.subtitle}</div>
          </div>
        </div>
        <span className="text-[10px] opacity-45 font-mono shrink-0 mt-0.5">slot {g.slot}</span>
      </div>

      {/* KPI strip — LTV / Liq prominent (it's what the operator
          tweaks), max collat + liq bonus secondary. The labels stay
          uppercase + small so the numbers read as the data. */}
      <div className="grid grid-cols-2 gap-2 rounded-lg bg-base-100/60 border border-base-300/60 px-3 py-2">
        <KpiCell label="LTV"        value={`${g.ltvPct}%`} />
        <KpiCell label="Liq thresh" value={`${g.liquidationThresholdPct}%`} />
        <KpiCell label="Max collat" value={String(g.maxReservesAsCollateral)} />
        <KpiCell label="Liq bonus"  value={`${(g.maxLiquidationBonusBps / 100).toFixed(2)}%`} />
      </div>

      {/* Debt asset row — token icon + symbol so the card answers
          "what does borrowing in this EG return" at a glance, instead
          of forcing the operator to memorise pubkey suffixes. */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-[0.18em] text-base-content/50">Debt</span>
          <TokenIcon symbol={debtSymbol} size="xs" />
          <span className="text-xs font-mono font-semibold truncate">{debtName}</span>
        </div>
        {!g.allowNewLoans && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 text-warning border border-warning/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] shrink-0">
            <span className="h-1 w-1 rounded-full bg-warning" />
            paused
          </span>
        )}
      </div>

      {canEdit ? (
        <Button variant="outline" size="sm" fullWidth onClick={onEdit}>
          Configure
        </Button>
      ) : (
        <div className="text-[10px] opacity-40 text-center pt-1">connect market owner to edit</div>
      )}
    </div>
  );
}

/** EG-0 / "no elevation group" card. Not stored in the on-chain
 *  `elevation_groups[]` array — klend uses `obligation.elevation_group
 *  == 0` as a sentinel meaning "no group, use base per-reserve LTV".
 *  We render it as the first card in the Active grid so the panel is
 *  exhaustive: every regime an obligation can be in is shown. The
 *  card lists every registered debt reserve so the operator can see
 *  the full set of borrow targets that EG-0 unlocks compared to the
 *  one-debt-asset constraint of the configured EGs. */
function EgZeroCard() {
  // Filter out the legacy-flagged options so the chip strip surfaces
  // only currently-supported borrow paths (legacy ones still render
  // in the editor's debt-reserve picker for backwards-edit support,
  // but here we want the operator's eye to land on what's live).
  const liveDebts = DEBT_RESERVE_OPTIONS.filter((o) => !o.legacy && o.pubkey);
  return (
    <div className="rounded-xl border-2 border-base-300 bg-base-200/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center justify-center rounded-md px-2 py-0.5 text-xs font-bold tabular-nums bg-base-content text-base-100">
            EG-0
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">No elevation group</div>
            <div className="text-[11px] opacity-60 leading-tight truncate">Base per-reserve LTV · any debt</div>
          </div>
        </div>
        <span className="text-[10px] opacity-45 font-mono shrink-0 mt-0.5">fallback</span>
      </div>

      {/* No KPI strip — LTV / Liq / Max collat aren't EG-level for
          EG-0; each reserve carries its own values in
          `reserve.config`. We surface that directly so the operator
          isn't tempted to look for a mode-X update_elevation_group ix
          that doesn't apply here. */}
      <div className="rounded-lg bg-base-100/60 border border-base-300/60 px-3 py-2 text-[11px] leading-snug text-base-content/65">
        Obligations with <code className="font-mono">elevation_group == 0</code> use each reserve's own
        <strong className="text-base-content"> loan_to_value_pct</strong> and
        <strong className="text-base-content"> liquidation_threshold_pct</strong>.
        Debt is unconstrained — any borrowable reserve is valid.
      </div>

      <div className="flex items-start gap-2 px-1">
        <span className="text-[10px] uppercase tracking-[0.18em] text-base-content/50 mt-1 shrink-0">Debts</span>
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {liveDebts.map((o) => (
            // Pill height = icon (16px) + py-1 (8px) = 24px so the
            // token icon's circular bg + shadow ring fits cleanly
            // inside the pill's rounded-full edge instead of poking
            // above/below it. Asymmetric pl-1 / pr-2.5 keeps the
            // icon snug to the left curve without squashing it.
            <span
              key={o.label}
              className="inline-flex items-center gap-1.5 rounded-full bg-base-100 border border-base-300 pl-1 pr-2.5 py-1"
            >
              <span className="inline-flex items-center justify-center w-4 h-4 shrink-0 leading-none">
                <TokenIcon symbol={o.iconSymbol} size="xs" className="block" />
              </span>
              <span className="text-[11px] font-mono font-semibold">{o.label}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="text-[10px] opacity-40 text-center pt-1">configured per-reserve · not editable here</div>
    </div>
  );
}

function KpiCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-[0.16em] text-base-content/50">{label}</span>
      <span className="font-mono font-semibold text-sm tabular-nums truncate">{value}</span>
    </div>
  );
}
