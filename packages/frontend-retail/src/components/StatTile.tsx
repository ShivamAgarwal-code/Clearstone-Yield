import type { CSSProperties, ReactNode } from "react";

/**
 * Hero stat tile with a tinted gradient panel, an accent stripe, and
 * a subtle diagonal-hatch pattern on top. Used by the SavingsApp
 * three-up under the asset toggle. Three tones key to the design
 * system's clearstone-dark palette.
 *
 * The pattern is rendered via a CSS gradient (no SVG asset) so it
 * inherits the surrounding theme without a network round-trip.
 *
 * `highlight` puts the warm gold accent on the value text and a
 * thicker top border. Use it for the headline tile (APY).
 */
export type StatTileTone = "primary" | "info" | "success";

export interface StatTileProps {
  eyebrow: string;
  value: ReactNode;
  caption?: ReactNode;
  tone?: StatTileTone;
  highlight?: boolean;
}

const ACCENT: Record<StatTileTone, { bar: string; glow: string; hatch: string }> = {
  primary: {
    bar: "bg-primary",
    // Warm-gold radial bloom — mirrors the gold accent token.
    glow: "radial-gradient(circle at 100% 0%, rgba(184,153,104,0.18), transparent 55%)",
    hatch:
      "repeating-linear-gradient(45deg, rgba(184,153,104,0.04) 0 1px, transparent 1px 8px)",
  },
  info: {
    bar: "bg-info",
    // Teal-stone bloom for "supporting metric" tiles.
    glow: "radial-gradient(circle at 100% 0%, rgba(124,139,163,0.16), transparent 55%)",
    hatch:
      "repeating-linear-gradient(45deg, rgba(124,139,163,0.04) 0 1px, transparent 1px 8px)",
  },
  success: {
    bar: "bg-success",
    // Cool emerald bloom for TVL / utilization.
    glow: "radial-gradient(circle at 100% 0%, rgba(79,176,136,0.14), transparent 55%)",
    hatch:
      "repeating-linear-gradient(45deg, rgba(79,176,136,0.04) 0 1px, transparent 1px 8px)",
  },
};

export function StatTile({
  eyebrow,
  value,
  caption,
  tone = "info",
  highlight = false,
}: StatTileProps) {
  const accent = ACCENT[tone];
  const bgStyle: CSSProperties = {
    backgroundImage: `${accent.glow}, ${accent.hatch}, linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)`,
  };

  return (
    <div
      className={[
        "relative overflow-hidden rounded-lg border border-base-300/80 bg-base-200/70",
        // Top padding clears the 2-3px accent bar; bottom padding gives
        // the value some breathing room. Horizontal stays compact so a
        // three-up still reads as a strip rather than three loose cards.
        "pt-5 pb-5 px-5",
        "shadow-[0_2px_6px_rgba(0,0,0,0.18),_inset_0_1px_0_rgba(255,255,255,0.03)]",
      ].join(" ")}
      style={bgStyle}
    >
      {/* Top accent bar — thicker on the highlight tile. */}
      <div
        className={`absolute inset-x-0 top-0 ${accent.bar} ${highlight ? "h-[3px]" : "h-[2px]"} opacity-80`}
        aria-hidden
      />
      <div className="eyebrow mb-2 text-base-content/60" style={{ fontSize: "0.625rem" }}>
        {eyebrow}
      </div>
      <div
        className={[
          "figure tabular-nums leading-none",
          highlight
            ? "text-3xl md:text-4xl text-primary"
            : "text-2xl md:text-3xl text-base-content",
        ].join(" ")}
      >
        {value}
      </div>
      {caption ? (
        <div className="text-[11px] opacity-60 mt-2 leading-snug">{caption}</div>
      ) : null}
    </div>
  );
}
