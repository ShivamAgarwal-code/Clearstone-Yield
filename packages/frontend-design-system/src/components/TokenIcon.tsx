import { HTMLAttributes, ReactNode, useState } from "react";
import { cn } from "../lib/cn";

/**
 * TokenIcon — small circular badge for a token symbol.
 *
 * Two render modes per token:
 *   - `image` — fetches a CDN PNG (e.g. Kamino's static asset bucket)
 *     and renders it inside a white circle. Used for tokens with real
 *     brand marks (USDC, USDT, USX, eUSX). Falls back to the glyph
 *     mode if the image fails to load.
 *   - `glyph` — colored circle with a single character / short label.
 *     Used for tokens without a public mark (csSOL, custom LSTs) or
 *     when CDN access is unavailable.
 *
 * KYC-wrapped variants (`ceUSX`, `csSOL`) carry a soft warm-gold ring
 * around the icon as a visual signal that the underlying asset is the
 * KYC-gated wrapper. The ring uses our brand `accent-warm` so it reads
 * as "regulated / restricted" rather than as a generic UI accent.
 *
 * Brand colours are exposed via `tokenBrandColor()` so callers
 * (`<Stat iconHalo>`, sparklines, etc.) can match a halo to the icon.
 */

export type TokenSymbol =
  | "USDC" | "sUSDC" | "cUSDC" | "USDT" | "DAI" | "USX" | "eUSX" | "ceUSX"
  | "SOL"  | "wSOL" | "csSOL" | "csSOL-WT" | "cSOL" | "JitoSOL"
  | "BTC"  | "ETH";

export type TokenIconSize = "xs" | "sm" | "md" | "lg";

interface CornerLabel {
  /** Short text rendered inside a small corner badge (1–3 chars). */
  text: string;
  /** Tailwind background class for the badge. */
  bg: string;
  /** Tailwind foreground class for the badge text. */
  fg: string;
}

interface ImageStyle {
  kind: "image";
  /** Public CDN image URL. */
  src: string;
  /** Container background — visible behind transparent PNGs. */
  bg: string;
  /** Glyph used as a fallback when the image fails to load. */
  fallback: string;
  /** Foreground colour for the fallback glyph. */
  fallbackFg: string;
  /** Brand colour exposed for halos / sparklines. */
  brandColor: string;
  /** True for KYC-wrapped variants (ceUSX, csSOL). */
  wrapped?: boolean;
  /** Optional CSS `filter` string applied to the <img>. Used to tint
   *  derived tokens that share an asset image — e.g. SOL LST receipts
   *  reuse the canonical SOL mark with a hue-rotate so cSOL / csSOL /
   *  csSOL-WT each read as a distinct token without redrawing the
   *  underlying glyph. */
  filter?: string;
  /** Optional small text badge in the bottom-right corner — used to
   *  distinguish tokens that share the same base mark (e.g. csSOL vs
   *  csSOL-WT, where WT marks the wallet-token sibling). */
  cornerLabel?: CornerLabel;
}

interface GlyphStyle {
  kind: "glyph";
  bg: string;
  fg: string;
  glyph: string;
  brandColor: string;
  wrapped?: boolean;
  cornerLabel?: CornerLabel;
}

type IconStyle = ImageStyle | GlyphStyle;

const STYLES: Record<TokenSymbol, IconStyle> = {
  USDC: {
    kind: "image",
    src: "https://assets.coingecko.com/coins/images/6319/standard/USDC.png?1769615602",
    bg: "bg-[#2775CA]",
    fallback: "$", fallbackFg: "text-white",
    brandColor: "#2775CA",
  },
  // sUSDC — Solstice-yield USDC reserve token. Same on-chain mint as
  // Clearstone's Solstice USDC, but rendered with a yield-bearing ring
  // + "s" corner badge so the lending market doesn't visually conflate
  // it with raw USDC. Used for EG-1 / EG-3 debt legs.
  sUSDC: {
    kind: "image",
    src: "https://assets.coingecko.com/coins/images/6319/standard/USDC.png?1769615602",
    bg: "bg-[#2775CA]",
    fallback: "s", fallbackFg: "text-white",
    brandColor: "#2775CA",
    wrapped: true,
    cornerLabel: { text: "s", bg: "bg-[#1F2D48]", fg: "text-white" },
  },
  // cUSDC — KYC-wrapped USDC. Renders as the plain Circle USDC mark
  // by user preference (no `wrapped` ring, no corner badge). The
  // wrapper distinction is conveyed by the cUSDC text label next to
  // the icon, so a dedicated visual marker would be redundant.
  cUSDC: {
    kind: "image",
    src: "https://assets.coingecko.com/coins/images/6319/standard/USDC.png?1769615602",
    bg: "bg-[#2775CA]",
    fallback: "$", fallbackFg: "text-white",
    brandColor: "#2775CA",
  },
  USDT: {
    kind: "image",
    src: "https://assets.coingecko.com/coins/images/37603/standard/USDT.png?1714986572",
    bg: "bg-[#26A17B]",
    fallback: "₮", fallbackFg: "text-white",
    brandColor: "#26A17B",
  },
  DAI: {
    kind: "glyph",
    bg: "bg-[#F4B731]", fg: "text-[#1F2D48]", glyph: "◈",
    brandColor: "#F4B731",
  },
  USX: {
    kind: "image",
    src: "https://cdn.kamino.com/assets/USX.png",
    bg: "bg-base-200",
    fallback: "X", fallbackFg: "text-base-content",
    brandColor: "#1F2D48",
  },
  eUSX: {
    kind: "image",
    src: "https://cdn.kamino.com/assets/eUSX.png",
    bg: "bg-base-200",
    fallback: "e", fallbackFg: "text-[#B89968]",
    brandColor: "#B89968",
  },
  // ceUSX shares eUSX's mark — it's the *KYC-wrapped* version of eUSX.
  // The wrapped ring is what differentiates the two visually.
  ceUSX: {
    kind: "image",
    src: "https://cdn.kamino.com/assets/eUSX.png",
    bg: "bg-base-200",
    fallback: "c", fallbackFg: "text-[#7A5C2F]",
    brandColor: "#7A5C2F",
    wrapped: true,
  },
  SOL: {
    kind: "image",
    src: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    bg: "bg-black",
    fallback: "◎", fallbackFg: "text-white",
    brandColor: "#9945FF",
  },
  wSOL: {
    kind: "image",
    src: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    bg: "bg-black",
    fallback: "w", fallbackFg: "text-white",
    brandColor: "#9945FF",
  },
  // csSOL — our custom KYC-wrapped LST. Full negative-image of the
  // canonical SOL mark (`invert(1)` flips every channel), so the
  // recognisable Solana glyph is preserved while the colour identity
  // is unmistakably *not native SOL*. Black bg becomes white, the
  // purple→green gradient flips into a yellow→magenta inverse, paired
  // with the gold KYC ring this gives csSOL a strong, distinct
  // signature even before the user reads the label.
  csSOL: {
    kind: "image",
    src: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    bg: "bg-white",
    fallback: "cs", fallbackFg: "text-[#1F2D48]",
    brandColor: "#0E7C9E",
    wrapped: true,
    filter: "invert(1)",
  },
  // cSOL — Kamino's SOL collateral receipt. Same SOL mark with a
  // pinkish hue-shift so it reads as a Kamino-tinted derivative
  // (Kamino's brand sits in the magenta range). No KYC ring — it's a
  // standard kToken, not a Clearstone wrap.
  "cSOL": {
    kind: "image",
    src: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    bg: "bg-black",
    fallback: "c", fallbackFg: "text-white",
    brandColor: "#FF35A1",
    filter: "hue-rotate(-25deg) saturate(1.05)",
  },
  // csSOL-WT — Wallet-Token sibling of csSOL. Shares the inverted SOL
  // mark; the explicit "WT" corner badge is what tells the eye it's the
  // sibling rather than another csSOL. Bottom-right placement, primary
  // navy chip with white text — sits comfortably alongside the gold
  // KYC ring without colliding.
  "csSOL-WT": {
    kind: "image",
    src: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
    bg: "bg-white",
    fallback: "WT", fallbackFg: "text-[#1F2D48]",
    brandColor: "#0E7C9E",
    wrapped: true,
    filter: "invert(1) saturate(0.65) brightness(1.05)",
    cornerLabel: { text: "WT", bg: "bg-[#1F2D48]", fg: "text-white" },
  },
  JitoSOL: {
    kind: "glyph",
    bg: "bg-gradient-to-br from-[#FF6B35] to-[#F7931E]",
    fg: "text-white", glyph: "J",
    brandColor: "#F7931E",
  },
  BTC: {
    kind: "glyph",
    bg: "bg-[#F7931A]", fg: "text-white", glyph: "₿",
    brandColor: "#F7931A",
  },
  ETH: {
    kind: "glyph",
    bg: "bg-[#627EEA]", fg: "text-white", glyph: "Ξ",
    brandColor: "#627EEA",
  },
};

/** Brand colour for a known token (CSS hex). Falls back to a neutral
 *  warm grey for unknown symbols. */
export function tokenBrandColor(symbol: TokenSymbol | string): string {
  return STYLES[symbol as TokenSymbol]?.brandColor ?? "#94A2B8";
}

const SIZE: Record<TokenIconSize, string> = {
  xs: "h-5 w-5  text-[9px]",
  sm: "h-7 w-7  text-[11px]",
  md: "h-9 w-9  text-sm",
  lg: "h-12 w-12 text-base",
};

// Inline pixel fallback. Tailwind v4 only generates h-/w- utilities
// when it scans a source that uses them — workspace-symlinked DS
// imports break that on some consumers (notably retail). The inline
// style guarantees the icon renders at the intended pixel size even
// when the utility class drops out, so a stray CDN-loaded image can
// never blow up to its natural 512px.
const SIZE_PX: Record<TokenIconSize, number> = {
  xs: 20,
  sm: 28,
  md: 36,
  lg: 48,
};

// Wrapped ring: warm gold from the brand accent, slightly transparent.
// `ring-offset-2 ring-offset-base-200` gives a 2px gap between the
// icon and the ring so it reads as a *frame* around the mark, not as
// a halo bleeding into it.
const WRAP_RING = "ring-2 ring-offset-2 ring-offset-[var(--color-base-200,#FFFFFF)] ring-[#B89968]/80";

/**
 * `kind` decorates the icon with a small corner badge that signals
 * the token's role in a position view:
 *   - `wallet` (default) — no indicator. The token is in your wallet.
 *   - `claim` — emerald ↓ — supplied as collateral; you hold a
 *     redemption claim against the reserve.
 *   - `debt` — amber ↑ — borrowed; the position represents an
 *     outstanding obligation.
 *
 * The corner badge sits *outside* the inner icon's clipped circle so
 * it composes cleanly with `wrapped` (KYC gold ring) — both can show
 * simultaneously without colliding.
 */
export type TokenIconKind = "wallet" | "claim" | "debt";

export interface TokenIconProps extends HTMLAttributes<HTMLDivElement> {
  symbol: TokenSymbol | string;
  size?: TokenIconSize;
  /** Force the wrapped indicator on/off. Defaults to the per-token setting. */
  wrapped?: boolean;
  /** Position role — adds a small directional corner badge. */
  kind?: TokenIconKind;
  /** When set, the icon scales up on hover and a small popover floats
   *  above showing this content. Used by the institutional app to
   *  surface live wallet balances on every token icon without each
   *  callsite re-implementing a tooltip. */
  tip?: ReactNode;
}

function CornerBadge({ kind }: { kind: Exclude<TokenIconKind, "wallet"> }) {
  const isClaim = kind === "claim";
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-0.5 -right-0.5 z-10 inline-flex items-center justify-center rounded-full",
        "h-3.5 w-3.5 ring-2 ring-[var(--color-base-200,#FFFFFF)]",
        isClaim ? "bg-[#2E7D5B] text-white" : "bg-[#B57F3A] text-white",
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-2 w-2"
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {isClaim ? <path d="M5 12l7 7 7-7M12 4v15" /> : <path d="M5 12l7-7 7 7M12 20V5" />}
      </svg>
    </span>
  );
}

/** Per-token corner label — used to distinguish tokens that share the
 *  same base mark (e.g. csSOL vs csSOL-WT). Always-on identity badge,
 *  separate from the contextual `kind` arrow. Sized off the icon's
 *  scale via SIZE_PX so xs / sm / md / lg all carry the badge legibly. */
function IdentityBadge({
  label,
  bg,
  fg,
  size,
}: {
  label: string;
  bg: string;
  fg: string;
  size: TokenIconSize;
}) {
  const dim = size === "xs" ? "h-3 px-1 text-[7px]"
            : size === "sm" ? "h-3.5 px-1 text-[8px]"
            : size === "md" ? "h-4 px-1.5 text-[9px]"
            :                 "h-5 px-1.5 text-[10px]";
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-1 -right-1 z-10 inline-flex items-center justify-center",
        "rounded-full font-bold tracking-tight leading-none",
        "ring-2 ring-[var(--color-base-200,#FFFFFF)]",
        dim,
        bg,
        fg,
      )}
    >
      {label}
    </span>
  );
}

/** Hover emphasis applied when a tooltip is wired up. Uses Tailwind v4
 *  named groups (`group/icon` / `group-hover/icon:`) so the styles only
 *  trigger when *this* icon is hovered — not when any ancestor that
 *  also has a plain `group` class (e.g. the EG tile button) is hovered.
 *  The unscoped `group-hover:` would otherwise fire for every icon
 *  inside the same tile at once. */
const HOVER_EMPHASIS = cn(
  "transition-[transform,box-shadow] duration-200 ease-out",
  "group-hover/icon:scale-110",
  "group-hover/icon:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_4px_12px_rgba(31,45,72,0.28)]",
);

/** Tooltip popover — small dark chip that floats above the icon. CSS-only
 *  via the named `group/icon` so no JS state / focus-trap needed and
 *  ancestors with plain `group` classes can't trigger us. */
function HoverTip({ children }: { children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50",
        "opacity-0 translate-y-1 group-hover/icon:opacity-100 group-hover/icon:translate-y-0",
        "transition-[opacity,transform] duration-150 ease-out",
        "px-2.5 py-1.5 rounded-md whitespace-nowrap",
        "bg-base-content text-base-100 text-[11px] font-mono tabular-nums leading-tight",
        "shadow-[0_8px_20px_-6px_rgba(31,45,72,0.45)]",
      )}
    >
      {children}
    </span>
  );
}

export function TokenIcon({
  symbol,
  size = "md",
  wrapped: wrappedOverride,
  kind = "wallet",
  tip,
  className,
  ...rest
}: TokenIconProps) {
  const style = STYLES[symbol as TokenSymbol];
  const [imageFailed, setImageFailed] = useState(false);

  const wrapped = wrappedOverride ?? style?.wrapped ?? false;
  const showBadge = kind !== "wallet";
  const hasTip = tip !== undefined && tip !== null && tip !== false && tip !== "";

  const px = SIZE_PX[size];
  const sizeStyle = { width: px, height: px } as const;

  // Unknown symbol fallback.
  if (!style) {
    return (
      <span
        aria-label={hasTip && typeof tip === "string" ? tip : undefined}
        className={cn("group/icon relative inline-block align-middle", className)}
        {...rest}
      >
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full font-bold tracking-tight select-none",
            "bg-base-300 text-base-content/70",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(31,45,72,0.20)]",
            SIZE[size],
            wrapped && WRAP_RING,
            hasTip && HOVER_EMPHASIS,
          )}
          style={sizeStyle}
          aria-hidden
        >
          {symbol.slice(0, 2).toUpperCase()}
        </span>
        {showBadge && <CornerBadge kind={kind as Exclude<TokenIconKind, "wallet">} />}
        {hasTip && <HoverTip>{tip}</HoverTip>}
      </span>
    );
  }

  const isImage = style.kind === "image" && !imageFailed;
  const surfaceBg = style.kind === "image" ? style.bg : style.bg;
  const fg = style.kind === "image" ? style.fallbackFg : style.fg;
  const glyph = style.kind === "image" ? style.fallback : style.glyph;

  return (
    <span
      aria-label={hasTip && typeof tip === "string" ? tip : undefined}
      className={cn("group/icon relative inline-block align-middle", className)}
      {...rest}
    >
      <span
        className={cn(
          "relative inline-flex items-center justify-center rounded-full font-bold tracking-tight select-none overflow-hidden",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(31,45,72,0.20)]",
          SIZE[size],
          isImage ? "bg-white" : cn(surfaceBg, fg),
          wrapped && WRAP_RING,
          hasTip && HOVER_EMPHASIS,
        )}
        style={sizeStyle}
        aria-hidden
      >
        {isImage ? (
          <img
            src={(style as ImageStyle).src}
            alt=""
            className="w-full h-full object-cover"
            style={(style as ImageStyle).filter ? { filter: (style as ImageStyle).filter } : undefined}
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="leading-none">{glyph}</span>
        )}
      </span>
      {/* Identity badge wins over the kind arrow when both apply — a
          token's identity (e.g. WT) is always more important than the
          contextual claim/debt direction. */}
      {style.cornerLabel ? (
        <IdentityBadge
          label={style.cornerLabel.text}
          bg={style.cornerLabel.bg}
          fg={style.cornerLabel.fg}
          size={size}
        />
      ) : showBadge ? (
        <CornerBadge kind={kind as Exclude<TokenIconKind, "wallet">} />
      ) : null}
      {hasTip && <HoverTip>{tip}</HoverTip>}
    </span>
  );
}
