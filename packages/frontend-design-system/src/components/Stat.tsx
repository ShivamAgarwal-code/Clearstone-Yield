import { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Stat — KPI tile.
 *
 * Two main shapes:
 *   * Hero (when `icon` is provided) — clean white card, large icon
 *     top-left with a soft coloured halo, generous value type. The
 *     halo + a subtle top-right bloom give the card its "premium /
 *     finance hero" feel without using semantic colours on the surface
 *     itself. Five hero tiles in a row read as a deliberate palette,
 *     not a rack of greyscale rectangles.
 *   * Plain (no icon) — same white card with an optional 3px coloured
 *     accent stripe. For KPIs without a natural icon (APY, TVL).
 *
 * `accent` is intentionally limited to brand-safe tones (primary,
 * accent, info). Severity tones (warning, error) are reserved for
 * actual severity signals — never KPIs.
 *
 * `iconHalo` (optional) lets a hero tile pick a CSS colour for the
 * radial halo behind the icon. Defaults to a neutral warm glow.
 */

export type StatAccent = "primary" | "info" | "accent" | "neutral";
export type StatSize = "sm" | "md" | "lg";

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  caption?: ReactNode;
  trailing?: ReactNode;
  /** Slot for a TokenIcon (or other 32–48px badge). Triggers hero layout. */
  icon?: ReactNode;
  /** CSS colour for the halo behind the icon. Defaults to the warm accent. */
  iconHalo?: string;
  accent?: StatAccent;
  size?: StatSize;
  /** Add a subtle hover lift — defaults to true on hero variant. */
  interactive?: boolean;
}

const VALUE_SIZE: Record<StatSize, string> = {
  sm: "text-xl",
  md: "text-3xl",
  lg: "text-4xl",
};

const PADDING: Record<StatSize, string> = {
  sm: "p-4",
  md: "p-6",
  lg: "p-7",
};

const ACCENT_BAR: Record<StatAccent, string> = {
  primary: "bg-primary",
  info: "bg-info",
  accent: "bg-accent",
  neutral: "bg-base-300",
};

const INTERACTIVE = cn(
  "transition-[transform,box-shadow,border-color] duration-300 ease-out",
  "hover:-translate-y-1 hover:shadow-[var(--shadow-stone-lg)] hover:border-[#A6B3C5]",
);

export function Stat({
  label,
  value,
  unit,
  caption,
  trailing,
  icon,
  iconHalo,
  accent,
  size = "md",
  interactive,
  className,
  style,
  ...rest
}: StatProps) {
  const isHero = !!icon;
  const showAccentBar = !isHero && accent && accent !== "neutral";
  const liftOnHover = interactive ?? isHero;

  // Halo colour falls through to the landing's hero-halo navy when no
  // token tint is supplied — the navy at low opacity carries the same
  // "lit from below" feel the marketing hero uses, so dashboard tiles
  // visually continue the same brand language.
  const halo = iconHalo ?? "#1F2D48";

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl bg-base-200",
        "border border-base-300/80 shadow-[var(--shadow-stone-md)]",
        liftOnHover && INTERACTIVE,
        PADDING[size],
        className,
      )}
      style={
        isHero
          ? ({
              ...style,
              // Soft radial bloom from top-right + halo behind the icon.
              // Layered behind content via z-index 0 / contents at z-10.
              "--cs-stat-halo": halo,
            } as CSSProperties)
          : style
      }
      {...rest}
    >
      {showAccentBar && (
        <span
          aria-hidden
          className={cn("absolute left-0 right-0 top-0 h-[3px]", ACCENT_BAR[accent!])}
        />
      )}

      {isHero && (
        <>
          {/* Top-right bloom — picks up the icon's halo colour, fades to
              transparent. Non-disruptive at low opacity but gives the
              card a "lit" feel that flat shadows alone don't. */}
          <span
            aria-hidden
            className="pointer-events-none absolute -top-16 -right-16 h-44 w-44 rounded-full opacity-30 blur-2xl"
            style={{ background: `radial-gradient(closest-side, var(--cs-stat-halo), transparent 70%)` }}
          />
          {/* Halo behind the icon — same colour at slightly higher opacity. */}
          <span
            aria-hidden
            className="pointer-events-none absolute -left-2 -top-2 h-20 w-20 rounded-full opacity-25 blur-xl"
            style={{ background: `radial-gradient(closest-side, var(--cs-stat-halo), transparent 70%)` }}
          />
        </>
      )}

      <div className="relative z-10">
        {isHero ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-shrink-0 drop-shadow-[0_4px_10px_rgba(31,45,72,0.18)]">
                {icon}
              </div>
              {trailing && <div className="flex-shrink-0">{trailing}</div>}
            </div>
            <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.2em] text-base-content/55">
              {label}
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span
                className={cn(
                  "font-display font-medium tabular-nums tracking-[-0.025em] text-base-content leading-none",
                  VALUE_SIZE[size],
                )}
              >
                {value}
              </span>
              {unit && (
                <span className="text-xs font-semibold text-base-content/55 leading-none">
                  {unit}
                </span>
              )}
            </div>
            {caption && (
              <div className="mt-2.5 text-xs text-base-content/55 leading-snug">
                {caption}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-base-content/55">
                {label}
              </div>
              {trailing && <div className="flex-shrink-0">{trailing}</div>}
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span
                className={cn(
                  "font-display font-medium tabular-nums tracking-[-0.02em] text-base-content leading-none",
                  VALUE_SIZE[size],
                )}
              >
                {value}
              </span>
              {unit && (
                <span className="text-xs font-semibold text-base-content/55 leading-none">
                  {unit}
                </span>
              )}
            </div>
            {caption && (
              <div className="mt-2 text-xs text-base-content/55 leading-snug">{caption}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
