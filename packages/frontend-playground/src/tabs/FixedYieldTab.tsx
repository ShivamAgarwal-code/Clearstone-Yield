import { useMemo, useState } from "react";

import { StackContext } from "../fixed-yield/lib/stack-context";
import { loadStack, saveStack, type CanonicalStack } from "../fixed-yield/lib/deployments";
import { Setup } from "../fixed-yield/pages/Setup";
import { Sourcing } from "../fixed-yield/pages/Sourcing";
import { LpProvision } from "../fixed-yield/pages/LpProvision";
import { BuyPt } from "../fixed-yield/pages/BuyPt";
import { IntentFill } from "../fixed-yield/pages/IntentFill";

type SubTab = "setup" | "sourcing" | "lp" | "buy_pt" | "intent_fill";

const SUB_TABS: { id: SubTab; label: string; subtitle: string }[] = [
  { id: "setup",       label: "Setup",         subtitle: "active deployment handles + override JSON" },
  { id: "sourcing",    label: "Sourcing",      subtitle: "USDC → SY (mint_sy) and SY → PT+YT (strip)" },
  { id: "lp",          label: "LP provision",  subtitle: "deposit PT + SY → LP (wrapper_provide_liquidity_classic)" },
  { id: "buy_pt",      label: "Buy PT",        subtitle: "base → SY → PT (wrapper_buy_pt)" },
  { id: "intent_fill", label: "Self-solve",    subtitle: "sign + (stub) submit a fusion OrderConfig" },
];

export default function FixedYieldTab() {
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
      <section className="max-w-6xl space-y-4">
        <header>
          <h2 className="text-2xl font-bold">Fixed Yield (PT)</h2>
          <p className="opacity-70 mt-1 text-sm">
            csSOL PT + YT stack on Kamino. Operator/triage surface — direct
            calls into <code>kamino_sy_adapter</code>, <code>clearstone_core</code>{" "}
            and <code>clearstone_router</code>. First successful{" "}
            <code>trade_pt</code> against the live cssol reserve landed on
            seedId=5 market <code>ER2Z72XM…</code> (sig <code>5XD1ojbZ…</code>,
            ≈16% APY at 90d). KYC bypass via the test stack in Setup. See{" "}
            <code>clearstone-fixed-yield/PORT_TO_CLEARSTONE_FINANCE.md</code> +{" "}
            <code>orchestrate.md</code> for the cross-repo handoff.
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

        <div className="text-xs opacity-60 -mt-2">{active.subtitle}</div>

        <div className="card bg-base-200">
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
