import { useMemo, useState } from "react";

import { StackContext } from "../fixed-yield/lib/stack-context";
import { loadStack, saveStack, type CanonicalStack } from "../fixed-yield/lib/deployments";
import { Setup } from "../fixed-yield/pages/Setup";
import { Sourcing } from "../fixed-yield/pages/Sourcing";
import { LpProvision } from "../fixed-yield/pages/LpProvision";
import { BuyPt } from "../fixed-yield/pages/BuyPt";
import { IntentFill } from "../fixed-yield/pages/IntentFill";

/**
 * Fixed-yield (PT/YT) operator surface for the console.
 *
 * Mirrors the playground's `FixedYieldTab`, but rendered through the
 * console's chrome (sub-tab pill bar inside a `card`-themed shell so it
 * sits cleanly next to Markets / Rate Curves / Lending). The underlying
 * subtree (`fixed-yield/`) was copied verbatim from the playground —
 * pages, lib helpers, IDL JSON — so any refinement to one surface
 * cleanly diffs against the other.
 *
 * Sub-tabs:
 *  * **Setup** — review / override the active deployment handles
 *    (`kamino_sy_adapter`, `clearstone_core`, `clearstone_router`,
 *    `generic_exchange_rate_sy`) and pin a stack pubkey set in
 *    localStorage.
 *  * **Sourcing** — `mint_sy(USDC → SY)` + `strip(SY → PT + YT)` via
 *    the kamino_sy_adapter.
 *  * **LP provision** — deposit PT + SY → classic LP token
 *    (`wrapper_provide_liquidity_classic`).
 *  * **Buy PT** — base → SY → PT (one-shot via `wrapper_buy_pt`).
 *  * **Self-solve** — sign + (stub) submit a fusion `OrderConfig`
 *    against the local stack.
 */

type SubTab = "setup" | "sourcing" | "lp" | "buy_pt" | "intent_fill";

const SUB_TABS: { id: SubTab; label: string; subtitle: string }[] = [
  { id: "setup",       label: "Setup",         subtitle: "active deployment handles + override JSON" },
  { id: "sourcing",    label: "Sourcing",      subtitle: "USDC → SY (mint_sy) and SY → PT+YT (strip)" },
  { id: "lp",          label: "LP provision",  subtitle: "deposit PT + SY → LP (wrapper_provide_liquidity_classic)" },
  { id: "buy_pt",      label: "Buy PT",        subtitle: "base → SY → PT (wrapper_buy_pt)" },
  { id: "intent_fill", label: "Self-solve",    subtitle: "sign + (stub) submit a fusion OrderConfig" },
];

export default function FixedYieldPanel() {
  const [sub, setSub] = useState<SubTab>("setup");
  const [stack, setStack] = useState<CanonicalStack>(() => loadStack());

  const stackCtx = useMemo(
    () => ({
      stack,
      replace: (next: CanonicalStack) => {
        setStack(next);
        saveStack(next);
      },
    }),
    [stack],
  );

  const active = SUB_TABS.find((t) => t.id === sub) ?? SUB_TABS[0];

  return (
    <StackContext.Provider value={stackCtx}>
      <section className="space-y-6">
        <header>
          <div className="flex items-baseline gap-3 mb-1">
            <h2 className="text-2xl font-bold">Fixed Yield (PT)</h2>
            <span className="badge badge-warning badge-sm">v3 stack</span>
          </div>
          <p className="text-sm opacity-70 max-w-3xl">
            csSOL / sUSDC PT + YT stack on Kamino, surfaced as an operator
            console. Direct calls into <code>kamino_sy_adapter</code>,
            {" "}<code>clearstone_core</code>, and <code>clearstone_router</code>.
            KYC bypass via the test stack defined in Setup. See
            {" "}<code>clearstone-fixed-yield/PORT_TO_CLEARSTONE_FINANCE.md</code>
            {" "}for the full product framing.
          </p>
        </header>

        <nav role="tablist" className="tabs tabs-boxed bg-base-200 w-fit">
          {SUB_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              className={`tab tab-sm ${sub === t.id ? "tab-active" : ""}`}
              onClick={() => setSub(t.id)}
              title={t.subtitle}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="text-xs opacity-60 -mt-3">{active.subtitle}</div>

        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-5">
            {sub === "setup"       ? <Setup />       : null}
            {sub === "sourcing"    ? <Sourcing />    : null}
            {sub === "lp"          ? <LpProvision /> : null}
            {sub === "buy_pt"      ? <BuyPt />       : null}
            {sub === "intent_fill" ? <IntentFill />  : null}
          </div>
        </div>
      </section>
    </StackContext.Provider>
  );
}
