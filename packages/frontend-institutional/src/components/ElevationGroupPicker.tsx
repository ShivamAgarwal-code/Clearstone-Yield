import { CSSProperties, ReactNode, useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import { DEVNET_CONFIG } from "../config/devnet";
import { findObligationReserves, getObligationPda, OB_ID } from "../lib/obligation";
import {
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRequestElevationGroupIx,
} from "../lib/lib/klend";

import {
  Badge,
  Button,
  FieldGroupHeading,
  Snackbar,
  TokenSymbol,
  cn,
} from "@clearstone/design-system";
import BalanceIcon from "./BalanceIcon";

/**
 * UI for previewing and switching the obligation between klend elevation
 * groups. Selection (which EG the page is *previewing*) is decoupled from
 * the active on-chain group:
 *
 *   * Clicking a tile only updates `selectedGroup` (local state in the
 *     parent) — no transaction is sent.
 *   * The selected tile, if different from the active group, exposes an
 *     explicit "Switch on-chain" CTA. That's the only path that fires
 *     `request_elevation_group`.
 *
 * The v3 market exposes four EGs today:
 *   * EG-1 stables (90 / 92) — ceUSX collateral, sUSDC debt.
 *   * EG-2 LST/SOL (90 / 92) — csSOL + csSOL-WT collateral, cSOL debt.
 *   * EG-3 margin long-SOL (65 / 85) — cSOL collateral, sUSDC debt.
 *   * EG-4 margin short-SOL (65 / 85) — sUSDC collateral, cSOL debt.
 *
 * Plus EG-0 (no group) — base per-reserve LTV applies.
 */

type Accent = "info" | "success" | "primary" | "warning" | "neutral";

interface ElevationOption {
  group: number;
  name: string;
  ltvPct: number | null;
  liqPct: number | null;
  description: string;
  accent: Accent;
  /** True when the EG isn't yet registered on-chain (Stage E pending). */
  pending?: boolean;
  /** Tokens that act as collateral inside this EG. */
  collaterals: TokenSymbol[];
  /** Tokens that can be borrowed inside this EG. EG-0 has many; others
   *  typically have one. Empty array = no debt path (display only). */
  debts: TokenSymbol[];
}

// Tokens available across all EGs — shown on the EG-0 tile so the
// "no elevation group" state visually communicates "any combination
// of these works at base reserve LTV", instead of being a blank tile.
// wSOL deliberately excluded here — the wSOL reserve was retired
// 2026-05-06 (status=Hidden, deposit_limit=0) and showing it as a
// supportable EG-0 asset implies the operator can still mix it in,
// which they can't. cSOL is the live SOL-side collateral / debt path.
const ALL_COLLATERAL_TOKENS: TokenSymbol[] = ["ceUSX", "csSOL", "csSOL-WT", "cSOL", "USDC"];
const ALL_DEBT_TOKENS: TokenSymbol[] = ["USDC", "cSOL"];

export const ELEVATION_OPTIONS: ElevationOption[] = [
  {
    group: 0,
    name: "No elevation group",
    ltvPct: null,
    liqPct: null,
    description: "Per-reserve base LTV. Mix any collateral with any debt — use when holding assets that don't share a single EG.",
    accent: "neutral",
    collaterals: ALL_COLLATERAL_TOKENS,
    debts: ALL_DEBT_TOKENS,
  },
  {
    group: 1,
    name: "Stables",
    ltvPct: 90,
    liqPct: 92,
    description: "ceUSX collateral, sUSDC debt. Yield-on-stables institutional flows.",
    accent: "info",
    collaterals: ["ceUSX"],
    debts: ["USDC"],
  },
  {
    group: 2,
    name: "LST / SOL",
    ltvPct: 90,
    liqPct: 92,
    description: "csSOL + csSOL-WT collateral, cSOL debt. Powers leveraged-csSOL.",
    accent: "primary",
    collaterals: ["csSOL", "csSOL-WT"],
    debts: ["cSOL"],
  },
  {
    group: 3,
    name: "Margin long SOL",
    ltvPct: 65,
    liqPct: 85,
    description: "cSOL collateral, sUSDC debt. Conservative LTV for a negatively-correlated SOL/USD pair.",
    accent: "success",
    pending: true,
    collaterals: ["cSOL"],
    debts: ["USDC"],
  },
  {
    group: 4,
    name: "Margin short SOL",
    ltvPct: 65,
    liqPct: 85,
    description: "sUSDC collateral, cSOL debt. Mirror of EG-3 for short-SOL exposure.",
    accent: "warning",
    pending: true,
    collaterals: ["USDC"],
    debts: ["cSOL"],
  },
];

/** Lookup helper for parents that need the metadata (collaterals/debts/ltv)
 *  for the currently-selected group without re-importing the whole list. */
export function getElevationOption(group: number): ElevationOption | undefined {
  return ELEVATION_OPTIONS.find((o) => o.group === group);
}

/**
 * Robust error → string. The previous `e.message ?? String(e)` rendered
 * "[object Object]" for any non-Error throw (wallet adapter rejections,
 * RPC error envelopes, klend `SendTransactionError` wrappers that don't
 * expose `.message` at the top level). Falls through:
 *   1. Error instances → `.message`
 *   2. Strings → as-is
 *   3. SendTransactionError / SolanaJSONRPCError → log dump if available
 *   4. Plain objects → JSON-stringify
 *   5. Anything else → String(...)
 */
function formatTxError(e: unknown): string {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    const anyE = e as any;
    // SendTransactionError includes .logs that explain the on-chain
    // failure better than `.message` alone (which is usually the
    // generic preflight rejection sentence).
    if (Array.isArray(anyE.logs) && anyE.logs.length > 0) {
      const tail = anyE.logs.slice(-4).join(" | ");
      return `${e.message} — ${tail}`;
    }
    return e.message || e.name || "Error";
  }
  if (typeof e === "object") {
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}

/** Pyth oracle pinned to each reserve in the v3 market. */
const RESERVE_ORACLES: Record<string, PublicKey> = {
  [DEVNET_CONFIG.market.csSolReserve.toBase58()]:    DEVNET_CONFIG.oracles.csSolOracle,
  [DEVNET_CONFIG.market.csSolWtReserve.toBase58()]:  DEVNET_CONFIG.oracles.csSolOracle,
  [DEVNET_CONFIG.market.wsolReserve.toBase58()]:     DEVNET_CONFIG.oracles.wsolOracle,
  [DEVNET_CONFIG.market.cSolReserve.toBase58()]:     DEVNET_CONFIG.oracles.wsolOracle,
  [DEVNET_CONFIG.market.ceUsxReserve.toBase58()]:    DEVNET_CONFIG.oracles.ceUsxOracle,
  [DEVNET_CONFIG.market.cUsdcReserve.toBase58()]:    DEVNET_CONFIG.oracles.usdcOracle,
  // Legacy sUSDC entry kept so the picker can refresh any straggler
  // obligation that hasn't been repaid since the 2026-05-07 cUSDC flip.
  [DEVNET_CONFIG.market.sUsdcReserve.toBase58()]:    DEVNET_CONFIG.oracles.usdcOracle,
};

interface Props {
  /** EG currently set on the obligation on-chain. */
  currentGroup: number | null;
  /** EG the page is previewing — drives the bottom tables' filter. */
  selectedGroup: number;
  /** Local-state setter for the previewed EG. Called on tile click. */
  onSelect: (group: number) => void;
  /** Fired after a successful on-chain switch so the parent can refetch. */
  onSwitched?: () => void;
  /** Obligation id the picker should operate on. Defaults to the page
   *  default (`OB_ID`) — caller should pass the active id from the
   *  ObligationSwitcher so a switch fired from a "+ New" empty
   *  obligation lands on THAT obligation rather than overwriting the
   *  page-default one. */
  obligationId?: number;
  /** True when the active obligation has at least one deposit. Klend's
   *  `request_elevation_group` rejects with `ObligationDepositsEmpty
   *  (6020)` on an empty obligation — there's nothing to grant the
   *  elevated LTV against — so the on-chain Switch CTA is disabled
   *  with a tooltip when this is false. Selection (preview-only) is
   *  always allowed. */
  hasDeposits?: boolean;
}

const ACCENT_CHIP: Record<Accent, string> = {
  info:    "bg-info text-info-content",
  success: "bg-success text-success-content",
  primary: "bg-primary text-primary-content",
  warning: "bg-warning text-warning-content",
  neutral: "bg-base-300 text-base-content",
};

/** Per-EG glyph — picked so each strategy reads at a glance instead of
 *  the chips all looking like generic "EG-N" badges. Stroke / fill
 *  uses `currentColor` so they tint with the chip's accent automatically. */
const EG_GLYPH: Record<number, ReactNode> = {
  // EG-0 — three stacked rules: "any combination, no constraints".
  0: (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <path d="M5 7h14M5 12h14M5 17h14" />
    </svg>
  ),
  // EG-1 — stacked coins (stables yield).
  1: (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v5c0 1.4 3.13 2.5 7 2.5s7-1.1 7-2.5V6" strokeLinecap="round" />
      <path d="M5 12v5c0 1.4 3.13 2.5 7 2.5s7-1.1 7-2.5v-5" strokeLinecap="round" />
    </svg>
  ),
  // EG-2 — diamond / staked-asset crystal (LST).
  2: (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor">
      <path d="M12 2.4 21 10 12 21.6 3 10z" />
    </svg>
  ),
  // EG-3 — long: chart trending up.
  3: (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-6 4 4 7-8" />
      <path d="M14 7h7v7" />
    </svg>
  ),
  // EG-4 — short: chart trending down.
  4: (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7l6 6 4-4 7 8" />
      <path d="M14 17h7v-7" />
    </svg>
  ),
};

const ACCENT_HALO: Record<Accent, string> = {
  info:    "var(--color-info, #4F607C)",
  success: "var(--color-success, #2E7D5B)",
  primary: "var(--color-primary, #1F2D48)",
  warning: "var(--color-warning, #B57F3A)",
  neutral: "var(--color-base-300, #94A2B8)",
};

/** Renders the collateral and debt token stacks for an EG tile. The
 *  micro-headers ("Collaterals" / "Debts") name each side, so we don't
 *  need an explicit arrow to convey direction. */
function FlowRow({ collaterals, debts }: { collaterals: TokenSymbol[]; debts: TokenSymbol[] }) {
  if (collaterals.length === 0 && debts.length === 0) return null;
  return (
    <div className="flex items-end gap-5 flex-wrap">
      {collaterals.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-base-content/45 leading-none">
            Collaterals
          </span>
          <div className="flex items-center -space-x-2">
            {collaterals.map((sym) => (
              <BalanceIcon key={sym} symbol={sym} size="sm" />
            ))}
          </div>
        </div>
      )}
      {debts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-base-content/45 leading-none">
            Debts
          </span>
          <div className="flex items-center -space-x-2">
            {debts.map((sym) => (
              <BalanceIcon key={sym} symbol={sym} size="sm" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ElevationGroupPicker({
  currentGroup,
  selectedGroup,
  onSelect,
  onSwitched,
  obligationId = OB_ID,
  hasDeposits = false,
}: Props) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  /** Set on confirmed switch — drives the success toast. */
  const [confirmedSig, setConfirmedSig] = useState<string | null>(null);
  /** "Switching to EG-2…" / "Activating EG-1…" — narrates the toast so
   *  success/failure messages reference *which* switch the user fired. */
  const [intent, setIntent] = useState<string | null>(null);

  const handleSwitch = useCallback(async (group: number) => {
    if (!publicKey || !signTransaction) return;
    const desc = group === 0 ? "Activating EG-0 (no group)" : `Activating EG-${group}`;
    setLoading(true);
    setError(null);
    setConfirmedSig(null);
    setIntent(desc);
    setPending(group);
    try {
      const market = DEVNET_CONFIG.market.lendingMarket;
      const obligation = getObligationPda(publicKey, obligationId);

      const obAcc = await connection.getAccountInfo(obligation, "confirmed");
      // Klend's `request_elevation_group` rejects with
      // `ObligationDepositsEmpty (6020)` on an obligation that has no
      // deposits — even a freshly-init'd one. Lazy-init can't bypass
      // that, so we don't try; the parent disables the Switch CTA via
      // `hasDeposits=false` when the obligation is empty and surfaces
      // a "deposit first" hint. This branch only runs when the parent
      // has confirmed there's something to elevate against.
      if (!obAcc) {
        throw new Error("Obligation account not found — supply collateral first to create it.");
      }
      const obReserves = findObligationReserves(Buffer.from(obAcc.data));

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

      for (const r of obReserves) {
        const oracle = RESERVE_ORACLES[r.toBase58()];
        if (!oracle) {
          throw new Error(`unknown reserve oracle for ${r.toBase58()} — update RESERVE_ORACLES`);
        }
        tx.add(buildRefreshReserveIx(r, market, oracle));
      }
      tx.add(buildRefreshObligationIx(market, obligation, obReserves));
      tx.add(buildRequestElevationGroupIx(publicKey, market, obligation, group, obReserves));

      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(sig, "confirmed");

      const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (receipt?.meta?.err) {
        const logs = receipt.meta.logMessages?.slice(-6).join(" | ") ?? "";
        throw new Error(`klend rejected the EG switch: ${JSON.stringify(receipt.meta.err)}${logs ? ` — ${logs}` : ""}`);
      }
      setConfirmedSig(sig);
      onSwitched?.();
    } catch (e: any) {
      setError(formatTxError(e));
    } finally {
      setLoading(false);
      setPending(null);
    }
  }, [publicKey, signTransaction, connection, onSwitched, obligationId]);

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <FieldGroupHeading className="!mb-0">Elevation group</FieldGroupHeading>
          <p className="mt-1 text-xs text-base-content/55 leading-relaxed max-w-2xl">
            Click a tile to preview the assets supported by that group — the
            collateral table below filters to match. Use the explicit
            <span className="font-semibold text-base-content"> Switch on-chain </span>
            button on the selected tile to actually update the obligation.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {currentGroup !== null && currentGroup > 0 && (
            <Badge tone="primary" variant="solid" size="md">
              EG-{currentGroup} active
            </Badge>
          )}
          {currentGroup === 0 && (
            <Badge tone="neutral" variant="soft" size="md">
              no EG
            </Badge>
          )}
          {selectedGroup !== currentGroup && (
            <Badge tone="info" variant="soft" size="md">
              previewing EG-{selectedGroup}
            </Badge>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ELEVATION_OPTIONS.map((opt) => {
          const isActive = currentGroup === opt.group;
          const isSelected = selectedGroup === opt.group;
          const isPending = pending === opt.group;
          // EG-0 is always "active" in the sense that any obligation can
          // sit in it, so disable its tile only when we're already there
          // for switching purposes — selection is always allowed.
          const selectable = !opt.pending;
          const showSwitchCta = isSelected && !isActive && !opt.pending;
          return (
            <button
              key={opt.group}
              type="button"
              onClick={() => selectable && onSelect(opt.group)}
              disabled={!selectable}
              aria-pressed={isSelected}
              style={{ "--cs-eg-halo": ACCENT_HALO[opt.accent] } as CSSProperties}
              className={cn(
                // No `overflow-hidden` here — that would clip the
                // TokenIcon hover tooltips inside the FlowRow. The halo
                // bloom + bookmark stripe live in a dedicated inner
                // clipped container below so the rounded corners stay
                // tidy without trapping descendants.
                "group/tile relative text-left rounded-2xl px-4 py-4",
                "transition-[transform,box-shadow,border-color] duration-300 ease-out",
                "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
                isActive
                  ? cn(
                      "bg-base-200 border border-base-300/80",
                      "shadow-[0_1px_3px_rgba(31,45,72,0.10),0_14px_32px_-12px_rgba(31,45,72,0.32)]",
                    )
                  : isSelected
                    ? cn(
                        "bg-base-200 border-2 border-primary/60",
                        "shadow-[0_1px_3px_rgba(31,45,72,0.10),0_14px_32px_-12px_rgba(31,45,72,0.32)]",
                      )
                    : selectable
                      ? cn(
                          "bg-base-200 border border-base-300/60",
                          "shadow-[var(--shadow-stone)]",
                          "hover:-translate-y-0.5 hover:shadow-[var(--shadow-stone-md)]",
                          "hover:border-base-content/15 cursor-pointer",
                        )
                      : cn(
                          "bg-base-200/60 border border-base-300/40",
                          "shadow-none cursor-default opacity-70",
                        ),
              )}
            >
              {(isActive || isSelected) && (
                <>
                  {/* Inner clipped container — only the halo bloom needs
                      to be cropped by the rounded card edge. Tooltips
                      from descendant TokenIcons live above the parent
                      button and stay free to overflow. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-2xl overflow-hidden"
                  >
                    <span
                      className="absolute -top-12 -right-12 h-36 w-36 rounded-full opacity-25 blur-2xl"
                      style={{ background: `radial-gradient(closest-side, var(--cs-eg-halo), transparent 70%)` }}
                    />
                  </span>
                  {/* Bookmark stripe along the left edge. */}
                  <span
                    aria-hidden
                    className="absolute left-2.5 top-3 bottom-3 w-[3px] rounded-full"
                    style={{ background: `var(--cs-eg-halo)` }}
                  />
                </>
              )}

              <div className="relative z-10 pl-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span
                    className={cn(
                      "text-[10px] font-bold uppercase tracking-[0.18em] rounded-md px-2 py-1 leading-none inline-flex items-center gap-1.5",
                      ACCENT_CHIP[opt.accent],
                    )}
                  >
                    {EG_GLYPH[opt.group]}
                    <span>EG-{opt.group}</span>
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {isActive && <Badge tone="primary" variant="soft" size="xs">active</Badge>}
                    {isSelected && !isActive && (
                      <Badge tone="info" variant="soft" size="xs">selected</Badge>
                    )}
                    {opt.pending && !isActive && (
                      <Badge tone="neutral" variant="outline" size="xs">deploy pending</Badge>
                    )}
                    {isPending && (
                      <span
                        className="inline-block h-3.5 w-3.5 rounded-full border-2 border-primary border-r-transparent"
                        style={{ animation: "cs-spin 700ms linear infinite" }}
                      />
                    )}
                  </div>
                </div>

                <div className="font-display text-base font-medium tracking-[-0.01em] leading-tight">
                  {opt.name}
                </div>

                {opt.ltvPct !== null && opt.liqPct !== null ? (
                  <div className="mt-1 text-xs font-mono tabular-nums text-base-content/65">
                    LTV <b className="text-base-content">{opt.ltvPct}%</b> · Liq <b className="text-base-content">{opt.liqPct}%</b>
                  </div>
                ) : (
                  <div className="mt-1 text-xs italic text-base-content/45">base reserve LTV</div>
                )}

                <div className="mt-3">
                  <FlowRow collaterals={opt.collaterals} debts={opt.debts} />
                </div>

                <p className="mt-3 text-[11px] text-base-content/55 leading-snug">
                  {opt.description}
                </p>

                {showSwitchCta && (
                  <div className="mt-3 space-y-2">
                    <Button
                      variant="primary"
                      size="sm"
                      fullWidth
                      loading={isPending}
                      // Klend's `request_elevation_group` rejects with
                      // ObligationDepositsEmpty (6020) on an empty
                      // obligation — there's nothing to grant the
                      // elevated LTV against. The Supply buttons in the
                      // collateral table below auto-bundle the EG
                      // switch into the first deposit when this CTA
                      // is disabled, so the user still gets a one-tx
                      // path; we just route it through Supply instead
                      // of through this button.
                      disabled={loading || (opt.group !== 0 && !hasDeposits)}
                      title={
                        opt.group !== 0 && !hasDeposits
                          ? "Supply collateral first — the EG switch is bundled into the first deposit on this obligation."
                          : undefined
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSwitch(opt.group);
                      }}
                    >
                      Switch on-chain → EG-{opt.group}
                    </Button>
                    {opt.group !== 0 && !hasDeposits && (
                      <p className="text-[10px] leading-snug text-base-content/55">
                        Empty obligation — supply a {opt.collaterals.slice(0, 2).join(" / ")} collateral row below
                        and the deposit tx will atomically activate EG-{opt.group}.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Error + success surface as fixed-position toasts (same pattern
          as the credit-trade panel) — keeps the picker tidy and the
          feedback consistent across actions on this page. */}
      {error && (
        <Snackbar
          variant="toast"
          type="error"
          message={intent ? `${intent} — failed` : "EG switch failed"}
          detail={error}
          onDismiss={() => setError(null)}
        />
      )}
      {confirmedSig && !error && (
        <Snackbar
          variant="toast"
          type="success"
          message={intent ? `${intent} — confirmed` : "EG switch confirmed"}
          detail={`sig=${confirmedSig.slice(0, 12)}…${confirmedSig.slice(-8)}`}
          dismissAfterMs={6000}
          onDismiss={() => setConfirmedSig(null)}
        />
      )}
      {loading && pending !== null && (
        <p className="text-xs text-base-content/55">
          Submitting EG-{pending} switch — refreshing reserves + obligation + request_elevation_group …
        </p>
      )}
    </section>
  );
}
