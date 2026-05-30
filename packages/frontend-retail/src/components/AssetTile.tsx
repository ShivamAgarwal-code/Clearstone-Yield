import type { CSSProperties, ReactNode } from "react";
import { Badge, TokenIcon } from "@clearstone/design-system";

/**
 * Asset selector tile — same pattern frontend-institutional uses for
 * elevation-group selection (see ElevationGroupPicker.tsx). Each
 * supported asset is a clickable card carrying its own auxiliary
 * metrics (APY, utilization, TVL) so the selector and the headline
 * stat strip collapse into a single surface.
 *
 *   - Idle:    soft border, drop shadow, hover-lift.
 *   - Selected: accent halo bloom + bookmark stripe + thicker border.
 *
 * The accent colour is keyed to the asset (info=USDC, success=SOL) and
 * is exposed via `--cs-asset-halo` so child elements (badge, stripe)
 * pick it up without prop-drilling.
 */

export type AssetAccent = "info" | "success" | "primary";

const ACCENT_CSS: Record<AssetAccent, string> = {
  info: "var(--color-info, #7C8BA3)",
  success: "var(--color-success, #4FB088)",
  primary: "var(--color-primary, #B89968)",
};

const ACCENT_RING: Record<AssetAccent, string> = {
  info: "border-info/60",
  success: "border-success/60",
  primary: "border-primary/60",
};

export interface AssetTileProps {
  symbol: "USDC" | "SOL";
  label: string;
  accent: AssetAccent;
  selected: boolean;
  onSelect: () => void;
  /** Live supply APY (decimal, e.g. 0.0067 for 0.67%). */
  supplyAPY: number;
  /** Live utilization (decimal). */
  utilization: number;
  /** Total deposited, in underlying base units. */
  totalDeposited: number;
  /** Optional small-print badge — e.g. "KYC gated". */
  tag?: ReactNode;
  loading?: boolean;
}

export function AssetTile({
  symbol,
  label,
  accent,
  selected,
  onSelect,
  supplyAPY,
  utilization,
  totalDeposited,
  tag,
  loading,
}: AssetTileProps) {
  const apyDisplay = loading ? "…" : `${(supplyAPY * 100).toFixed(2)}%`;
  const utilDisplay = loading ? "…" : `${(utilization * 100).toFixed(1)}%`;
  const tvlDisplay = loading
    ? "…"
    : symbol === "USDC"
      ? `$${totalDeposited.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : `${totalDeposited.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL`;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{ "--cs-asset-halo": ACCENT_CSS[accent] } as CSSProperties}
      className={[
        "group/tile relative text-left rounded-2xl px-5 py-4",
        "transition-[transform,box-shadow,border-color] duration-300 ease-out",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
        selected
          ? `bg-base-200 border-2 ${ACCENT_RING[accent]} shadow-[0_2px_6px_rgba(0,0,0,0.20),_0_18px_36px_-10px_rgba(0,0,0,0.55)]`
          : "bg-base-200/60 border border-base-300/60 shadow-[0_1px_3px_rgba(0,0,0,0.18)] hover:-translate-y-0.5 hover:bg-base-200 hover:border-base-content/20 hover:shadow-[0_2px_6px_rgba(0,0,0,0.22),_0_14px_28px_-10px_rgba(0,0,0,0.45)] cursor-pointer",
      ].join(" ")}
    >
      {selected && (
        <>
          {/* Accent halo bloom — clipped to the tile's rounded corners. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl overflow-hidden"
          >
            <span
              className="absolute -top-12 -right-12 h-40 w-40 rounded-full opacity-25 blur-2xl"
              style={{
                background:
                  "radial-gradient(closest-side, var(--cs-asset-halo), transparent 70%)",
              }}
            />
          </span>
          {/* Bookmark stripe — same pattern as the EG picker. */}
          <span
            aria-hidden
            className="absolute left-2.5 top-3 bottom-3 w-[3px] rounded-full"
            style={{ background: "var(--cs-asset-halo)" }}
          />
        </>
      )}

      <div className="relative z-10 pl-3">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <TokenIcon symbol={symbol} size="md" />
            <div className="flex flex-col min-w-0">
              <span className="font-display text-lg font-medium tracking-[-0.01em] leading-tight">
                {symbol}
              </span>
              <span className="text-[11px] opacity-60 leading-tight truncate">{label}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {selected ? (
              <Badge tone="primary" variant="soft" size="xs">selected</Badge>
            ) : null}
            {tag}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Metric
            eyebrow="APY"
            value={apyDisplay}
            highlight
          />
          <Metric eyebrow="Utilization" value={utilDisplay} />
          <Metric eyebrow="TVL" value={tvlDisplay} />
        </div>
      </div>
    </button>
  );
}

function Metric({
  eyebrow,
  value,
  highlight,
}: {
  eyebrow: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div
        className="eyebrow opacity-55 mb-0.5"
        style={{ fontSize: "0.5625rem", letterSpacing: "0.18em" }}
      >
        {eyebrow}
      </div>
      <div
        className={[
          "figure tabular-nums leading-none truncate",
          highlight ? "text-primary text-lg" : "text-sm text-base-content/85",
        ].join(" ")}
      >
        {value}
      </div>
    </div>
  );
}
