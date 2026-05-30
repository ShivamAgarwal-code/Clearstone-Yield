/**
 * CreditVariantPicker — 2-tile selector for the Credit Trade tab.
 * Mirrors the visual vocabulary of ElevationGroupPicker (halo bloom +
 * bookmark stripe) but trimmed to just the credit-trade variants
 * (EG-1 Stables, EG-2 LST/SOL). Pure UX: clicking only updates the
 * parent's selectedVariant state — no on-chain switch is fired here
 * (the active panel handles its own EG entry as part of the open flow).
 */

import { CSSProperties } from "react";
import { Badge, FieldGroupHeading, cn } from "@clearstone/design-system";
import BalanceIcon from "../BalanceIcon";

export type CreditVariant = "stables" | "lstSol";

interface VariantSpec {
  id: CreditVariant;
  egGroup: number;
  name: string;
  product: string;
  ltvPct: number;
  liqPct: number;
  description: string;
  collaterals: ("ceUSX" | "csSOL")[];
  debts: ("USDC" | "wSOL")[];
  accent: "info" | "primary";
  haloVar: string;
}

const VARIANTS: VariantSpec[] = [
  {
    id: "stables",
    egGroup: 1,
    name: "Stables credit trade",
    product: "ceUSX collateral · sUSDC debt",
    ltvPct: 90, liqPct: 92,
    description: "Yield-on-stables. Manual deposit + borrow (Solstice's USX program is multisig-gated, so the open leg can't be CPI'd into a single tx). Close uses the ceUSX-WT redemption flash loop.",
    collaterals: ["ceUSX"], debts: ["USDC"],
    accent: "info",
    haloVar: "var(--color-info, #4F607C)",
  },
  {
    id: "lstSol",
    egGroup: 2,
    name: "LST / SOL credit trade",
    product: "csSOL collateral · wSOL debt",
    ltvPct: 90, liqPct: 92,
    description: "Atomic 1-tx leveraged loop. Flash-borrow wSOL → wrap (margin + loan) via Jito vault → deposit csSOL → enter EG-2 → borrow wSOL → flash-repay. Close uses the csSOL-WT epoch-locked redemption.",
    collaterals: ["csSOL"], debts: ["wSOL"],
    accent: "primary",
    haloVar: "var(--color-primary, #1F2D48)",
  },
];

interface Props {
  selected: CreditVariant;
  onSelect: (v: CreditVariant) => void;
  /** EG currently set on the obligation on-chain. Used to surface a
   *  badge so the user knows whether picking the other variant will
   *  require switching elevation groups. */
  currentEg: number | null;
}

export function CreditVariantPicker({ selected, onSelect, currentEg }: Props) {
  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <FieldGroupHeading className="!mb-0">Pick a credit-trade variant</FieldGroupHeading>
          <p className="mt-1 text-xs text-base-content/55 leading-relaxed max-w-2xl">
            Each variant maps to one klend elevation group and exposes its own open / close
            mechanics. Switching variants doesn't fire an on-chain tx — it just swaps the active
            panel below.
          </p>
        </div>
        {currentEg !== null && currentEg > 0 && (
          <Badge tone="primary" variant="solid" size="md">EG-{currentEg} active</Badge>
        )}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {VARIANTS.map((v) => {
          const isSelected = selected === v.id;
          const isOnChain = currentEg === v.egGroup;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelect(v.id)}
              aria-pressed={isSelected}
              style={{ "--cs-eg-halo": v.haloVar } as CSSProperties}
              className={cn(
                "group relative overflow-hidden text-left rounded-2xl px-4 py-4",
                "transition-[transform,box-shadow,border-color] duration-300 ease-out",
                "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
                isSelected
                  ? cn(
                      "bg-base-200 border-2 border-primary/60",
                      "shadow-[0_1px_3px_rgba(31,45,72,0.10),0_14px_32px_-12px_rgba(31,45,72,0.32)]",
                    )
                  : cn(
                      "bg-base-200 border border-base-300/60",
                      "shadow-[var(--shadow-stone)]",
                      "hover:-translate-y-0.5 hover:shadow-[var(--shadow-stone-md)]",
                      "hover:border-base-content/15 cursor-pointer",
                    ),
              )}
            >
              {isSelected && (
                <>
                  <span aria-hidden className="pointer-events-none absolute -top-12 -right-12 h-36 w-36 rounded-full opacity-25 blur-2xl"
                    style={{ background: `radial-gradient(closest-side, var(--cs-eg-halo), transparent 70%)` }} />
                  <span aria-hidden className="absolute left-2.5 top-3 bottom-3 w-[3px] rounded-full" style={{ background: `var(--cs-eg-halo)` }} />
                </>
              )}

              <div className="relative z-10 pl-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-[0.18em] rounded px-1.5 py-0.5 leading-none inline-flex items-center",
                    v.accent === "info"
                      ? "bg-info text-info-content"
                      : "bg-primary text-primary-content",
                  )}>
                    EG-{v.egGroup}
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {isOnChain && <Badge tone="primary" variant="soft" size="xs">on-chain active</Badge>}
                    {isSelected && !isOnChain && (
                      <Badge tone="info" variant="soft" size="xs">selected</Badge>
                    )}
                  </div>
                </div>

                <div className="font-display text-base font-medium tracking-[-0.01em] leading-tight">
                  {v.name}
                </div>
                <div className="mt-0.5 text-xs text-base-content/65 font-mono">{v.product}</div>

                <div className="mt-1 text-xs font-mono tabular-nums text-base-content/65">
                  LTV <b className="text-base-content">{v.ltvPct}%</b> · Liq <b className="text-base-content">{v.liqPct}%</b>
                </div>

                <div className="mt-3 flex items-end gap-5 flex-wrap">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-base-content/45 leading-none">Collateral</span>
                    <div className="flex items-center -space-x-2">
                      {v.collaterals.map((sym) => <BalanceIcon key={sym} symbol={sym} size="sm" />)}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-base-content/45 leading-none">Debt</span>
                    <div className="flex items-center -space-x-2">
                      {v.debts.map((sym) => <BalanceIcon key={sym} symbol={sym} size="sm" />)}
                    </div>
                  </div>
                </div>

                <p className="mt-3 text-[11px] text-base-content/55 leading-snug">
                  {v.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
