import { ReactNode, useEffect, useRef, useState } from "react";
import { Badge, Button, TokenIcon, type TokenSymbol } from "@clearstone/design-system";

/**
 * ObligationSwitcher — pick which obligation drives the page.
 *
 * Klend allows up to 256 obligations per (wallet, market). Treating
 * them as a flat list (rather than hardcoding "lending" / "credit
 * trade" labels) keeps the UX consistent regardless of how the
 * obligation was opened — same primitive for the user, and the page
 * dispatches behavior based on the obligation's actual EG / debt-asset
 * data, not based on which tab created it.
 *
 * Each catalog entry carries a summary so the pill can show at-a-glance
 * status (active / empty + collateral USD + EG number). The trailing
 * `+ New` button surfaces the lowest unused id and selects it; init is
 * lazy — the next deposit ix auto-runs `init_obligation` if the PDA
 * hasn't been written yet.
 *
 * Layout invariants:
 *   - The container has `overflow: visible`. The earlier `overflow-x:
 *     auto` quietly forced `overflow-y: auto` (CSS spec — when one axis
 *     is non-visible, the other can't stay visible), which clipped the
 *     EG info popover and produced a phantom vertical scrollbar.
 *   - When `catalog.length > maxVisible`, the surplus pills collapse
 *     into a `+N more` dropdown so the row never grows past the
 *     parent's width and never needs horizontal scroll either.
 *   - The active pill is always visible — if it would have been
 *     clipped into the overflow set, it gets pinned to the visible
 *     slice and one of the previously-visible pills moves into the
 *     "more" dropdown to make room.
 */

export interface ObligationSummary {
  exists: boolean;
  /** Total collateral USD. Shown as a small mono caption when > 0. */
  collateralUsd?: number;
  /** EG number; rendered as a tiny outline badge when > 0. */
  elevationGroup?: number;
}

export interface ObligationCatalogEntry {
  id: number;
  summary: ObligationSummary;
  /** Optional human-readable label suffix (e.g. the role this id is
   *  conventionally used for: "lending" / "credit trade"). Pure
   *  cosmetic; the switcher works without it. */
  label?: string;
}

interface Props {
  value: number;
  onChange: (id: number) => void;
  catalog: ObligationCatalogEntry[];
  /** Called when the user clicks `+ New`. Caller computes the next
   *  unused id, switches to it, and shows the empty-state hint. */
  onCreate: () => void;
  className?: string;
  /** Optional per-entry trailing slot — receives the entry, returns a
   *  node rendered INSIDE the pill (after the badges) when non-null.
   *  Used by the EG info popover so the (i) icon sits glued to the
   *  active pill's chrome rather than dangling outside it. */
  trailingSlot?: (entry: ObligationCatalogEntry) => ReactNode;
  /** Cap on visible pills before the rest collapse into a "more"
   *  dropdown. Default 4 — fits comfortably in a desktop row alongside
   *  the leading "Positions" label and trailing "+ New" button. */
  maxVisible?: number;
}

/**
 * Compact USD formatter for the pill caption. Uses K/M/B suffixes for
 * anything above $10k so a high-collateral obligation doesn't overrun
 * the pill width, while sub-$10k positions still show their cents.
 */
function fmtPillUsd(v: number): string {
  if (!Number.isFinite(v) || v < 0) return "$—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Two-token overlap glyph for an elevation group. Renders the
 * collateral-side token half-eclipsed by the debt-side token —
 * deliberately small so it sits inside the pill at the same visual
 * weight as the Eg badge. Each EG has a known asset pair on the v3
 * market; unknown ids fall back to the EG number badge alone.
 *
 *   EG-1 (stables)         ceUSX collateral, sUSDC debt
 *   EG-2 (LST/SOL)         csSOL collateral, cSOL  debt
 *   EG-3 (margin long)     cSOL  collateral, sUSDC debt
 *   EG-4 (margin short)    sUSDC collateral, cSOL  debt
 */
function EgPairIcon({ eg }: { eg: number }) {
  const pair: { collateral: TokenSymbol; debt: TokenSymbol } | null =
    eg === 1 ? { collateral: "ceUSX", debt: "sUSDC" } :
    eg === 2 ? { collateral: "csSOL", debt: "cSOL"  } :
    eg === 3 ? { collateral: "cSOL",  debt: "sUSDC" } :
    eg === 4 ? { collateral: "sUSDC", debt: "cSOL"  } :
    null;
  if (!pair) return null;
  // Each TokenIcon's outermost span is `inline-block align-middle`,
  // which carries an implicit text-baseline descender gap from the
  // surrounding line-box (≈ font-size × 0.2). Wrapping each icon in
  // `inline-flex` (NOT `block` — block still creates a fresh line-box
  // that inherits the parent's font-size) drops it onto the flex
  // cross-axis with no descender space, so the icon's actual 28px
  // box is also its rendered height. Negative margin handles the
  // overlap reveal between the two icons.
  return (
    <span
      className="relative inline-flex items-center align-middle leading-none text-[0px]"
      aria-hidden
    >
      <span className="relative z-0 inline-flex">
        <TokenIcon symbol={pair.collateral} size="sm" />
      </span>
      <span className="relative z-10 inline-flex -ml-3 ring-2 ring-base-200 rounded-full">
        <TokenIcon symbol={pair.debt} size="sm" />
      </span>
    </span>
  );
}

function StatusBadge({ s, active }: { s: ObligationSummary; active: boolean }) {
  // The "empty" state intentionally bypasses Badge: the DS solid neutral
  // resolves to `bg-base-content/85 text-base-100`, which on an active
  // pill (filled with primary navy) makes the badge bg merge with the
  // pill and the light text reads as floating white-on-white. A bordered
  // span with explicit per-context colours is robust on both surfaces.
  if (!s.exists) {
    return (
      <span
        className={[
          "inline-flex items-center px-1.5 h-5 rounded-md",
          "text-[11px] font-semibold whitespace-nowrap",
          active
            ? "border border-primary-content/45 text-primary-content/85 bg-primary-content/10"
            : "border border-base-content/20 text-base-content/55 bg-base-200",
        ].join(" ")}
      >
        empty
      </span>
    );
  }
  const variant = active ? "solid" : "soft";
  if (s.collateralUsd !== undefined && s.collateralUsd > 0) {
    return <Badge tone="success" variant={variant} size="xs">{fmtPillUsd(s.collateralUsd)}</Badge>;
  }
  return <Badge tone="info" variant={variant} size="xs">active</Badge>;
}

function EgBadge({ eg, active }: { eg: number; active: boolean }) {
  const variant = active ? "solid" : "outline";
  const tone: "info" | "primary" | "warning" = eg === 1 ? "info" : eg === 2 ? "primary" : "warning";
  return <Badge tone={tone} variant={variant} size="xs">EG-{eg}</Badge>;
}

/**
 * Single pill — extracted so the same render path serves the inline
 * row AND the "more" dropdown. The trailing slot is rendered INSIDE
 * the pill (after the badges) when non-null. Because the slot is
 * rendered as a non-button child, clicks on it bubble to the pill's
 * own onClick — which is intentional: the slot only appears on the
 * already-active pill, so re-selecting it is a no-op.
 */
function PositionPill({
  entry,
  active,
  onSelect,
  trailing,
}: {
  entry: ObligationCatalogEntry;
  active: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  // The pill is a `<div role="tab">` rather than `<button>` so the
  // optional `trailing` slot (the EG info icon, itself a real
  // `<button>`) can nest validly — `<button>` inside `<button>` is
  // invalid HTML and several browsers respond by clipping the inner
  // button's overflowing absolute descendants (the EG info popover
  // got cropped at the pill border). With `role="tab"` + tabIndex +
  // keyboard handling we keep the same a11y semantics without the
  // nesting hazard.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      // Don't fire pill-select when the user activated the nested
      // info button — that lives inside `trailing` and has its own
      // handler. The info button stops propagation, but the keyboard
      // case is safer with an explicit target check.
      if ((e.target as HTMLElement).closest("[data-pill-info]")) return;
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={[
        "flex items-center gap-2 px-3 py-1.5 rounded-xl whitespace-nowrap cursor-pointer",
        "text-xs font-semibold transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
        // Active = "selected card" pattern (same family as the EG
        // picker tiles): white surface with a primary-tinted 2px
        // border + halo shadow. The earlier full-navy `bg-primary`
        // fill read as a heavy black blob next to inactive pills and
        // didn't fit the rest of the design system. Inactive pills
        // get opacity-70 + softer border so they recede.
        // Note: NO `filter`/`transform` on hover — those create
        // stacking contexts that scope the EG info popover's z-index,
        // causing it to render below the cards on the next row.
        active
          ? [
              "bg-base-100 text-base-content border-2 border-primary/55",
              "shadow-[0_1px_3px_rgba(31,45,72,0.10),0_8px_22px_-8px_rgba(31,45,72,0.35)]",
              "hover:border-primary/70 hover:bg-base-100",
            ].join(" ")
          : [
              "bg-base-100 border-2 border-base-300/50 text-base-content/55 opacity-70",
              "hover:opacity-100 hover:bg-base-100 hover:text-base-content hover:border-base-content/25",
              "hover:shadow-[0_1px_2px_rgba(31,45,72,0.08)]",
            ].join(" "),
      ].join(" ")}
    >
      <span className="flex items-center gap-1.5">
        <span>
          <span className={active ? "opacity-70" : "opacity-60"}>#</span>
          {entry.id}
        </span>
        {entry.label && (
          <span className={active ? "opacity-70 font-normal" : "opacity-60 font-normal"}>
            · {entry.label}
          </span>
        )}
      </span>
      {entry.summary.elevationGroup !== undefined && entry.summary.elevationGroup > 0 && (
        <>
          <EgPairIcon eg={entry.summary.elevationGroup} />
          <EgBadge eg={entry.summary.elevationGroup} active={active} />
        </>
      )}
      <StatusBadge s={entry.summary} active={active} />
      {trailing}
    </div>
  );
}

/**
 * Overflow dropdown — only renders when the visible-pills budget is
 * exceeded. Simple click-toggle pattern with outside-click + Escape
 * close; no need for the heavier popover library since the menu is
 * lazy and short-lived. */
function MoreMenu({
  hidden,
  value,
  onSelect,
}: {
  hidden: ObligationCatalogEntry[];
  value: number;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  if (hidden.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={[
          "flex items-center gap-1 px-2.5 py-1.5 rounded-lg whitespace-nowrap cursor-pointer",
          "text-xs font-semibold text-base-content/65",
          "hover:bg-base-200 hover:text-base-content transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
        ].join(" ")}
      >
        +{hidden.length} more
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className={[
            "absolute right-0 top-full mt-2 z-30 min-w-[220px]",
            "rounded-xl bg-base-200 border border-base-300",
            "shadow-[var(--shadow-stone-md)] overflow-hidden",
          ].join(" ")}
        >
          <ul className="py-1.5 max-h-80 overflow-y-auto">
            {hidden.map((entry) => {
              const active = entry.id === value;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { onSelect(entry.id); setOpen(false); }}
                    className={[
                      "flex items-center gap-2 w-full px-3 py-2 text-left cursor-pointer text-xs",
                      active
                        ? "bg-primary/[0.08] text-base-content font-semibold"
                        : "text-base-content/75 hover:bg-base-content/[0.04] hover:text-base-content",
                    ].join(" ")}
                  >
                    <span><span className="opacity-60">#</span>{entry.id}</span>
                    {entry.label && <span className="opacity-55 font-normal">· {entry.label}</span>}
                    <span className="ml-auto inline-flex items-center gap-1.5">
                      {entry.summary.elevationGroup !== undefined && entry.summary.elevationGroup > 0 && (
                        <EgBadge eg={entry.summary.elevationGroup} active={false} />
                      )}
                      <StatusBadge s={entry.summary} active={false} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Compute which catalog entries fit in the visible row vs. spill into
 * the overflow dropdown. The active entry is *always* visible — if a
 * naive `slice(0, max)` would have hidden it, we swap it in for the
 * last visible slot so the user never has to open the dropdown to see
 * what they currently have selected.
 */
function partitionCatalog(
  catalog: ObligationCatalogEntry[],
  active: number,
  max: number,
): { visible: ObligationCatalogEntry[]; hidden: ObligationCatalogEntry[] } {
  if (catalog.length <= max) return { visible: catalog, hidden: [] };
  const head = catalog.slice(0, max);
  const tail = catalog.slice(max);
  if (head.some((e) => e.id === active) || !tail.some((e) => e.id === active)) {
    return { visible: head, hidden: tail };
  }
  // Active is in the tail — pin it to the visible slice and demote the
  // last visible entry into the overflow set in its place.
  const activeEntry = tail.find((e) => e.id === active)!;
  const newHead = [...head.slice(0, max - 1), activeEntry];
  const newTail = catalog.filter((e) => !newHead.includes(e));
  return { visible: newHead, hidden: newTail };
}

export function ObligationSwitcher({
  value,
  onChange,
  catalog,
  onCreate,
  className,
  trailingSlot,
  maxVisible = 4,
}: Props) {
  const { visible, hidden } = partitionCatalog(catalog, value, maxVisible);

  return (
    <div
      className={[
        // Elevated Card-family chrome (was a recessed inset-shadow
        // container) so the switcher reads as a first-class component
        // rather than a sunken control well. Matches `<Card tone="elevated">`.
        "flex items-center gap-2 p-2 rounded-2xl",
        "bg-base-200 border border-base-300",
        "shadow-[var(--shadow-stone-md)]",
        // overflow-visible (NOT overflow-x-auto). The latter quietly
        // promotes overflow-y to auto and clips the EG info popover +
        // adds a phantom vertical scrollbar. Excess pills are absorbed
        // by the MoreMenu instead of by horizontal scrolling.
        "overflow-visible",
        className ?? "",
      ].join(" ")}
      role="tablist"
    >
      {/* Inline label — sits inside the container as the first item so
          the switcher reads as one self-labelled component. Followed by
          a hairline divider that visually separates the label from the
          interactive pills. */}
      <span className="px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-base-content/55 select-none">
        Positions
      </span>
      <span aria-hidden className="self-stretch w-px bg-base-300/70 mx-0.5" />

      {visible.map((entry) => (
        <PositionPill
          key={entry.id}
          entry={entry}
          active={entry.id === value}
          onSelect={() => onChange(entry.id)}
          trailing={trailingSlot?.(entry)}
        />
      ))}

      {hidden.length > 0 && (
        <MoreMenu hidden={hidden} value={value} onSelect={onChange} />
      )}

      {/* `ml-auto` pushes the divider + `+ New` to the far right so the
          row reads as "[label] [pills] … [more] | [+ New]" when used
          full-width, and stays compact when the row is content-sized. */}
      <span aria-hidden className="self-stretch w-px bg-base-300/70 mx-1 ml-auto" />

      <Button
        variant="secondary"
        size="xs"
        onClick={onCreate}
        className="whitespace-nowrap"
      >
        + New
      </Button>
    </div>
  );
}
