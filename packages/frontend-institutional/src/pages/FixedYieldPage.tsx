import { useMemo, useState } from "react";
import { Tabs } from "@clearstone/design-system";

import { StackContext } from "../fixed-yield/lib/stack-context";
import { loadStack, saveStack, type CanonicalStack } from "../fixed-yield/lib/deployments";
import { Setup } from "../fixed-yield/pages/Setup";
import { Sourcing } from "../fixed-yield/pages/Sourcing";
import { LpProvision } from "../fixed-yield/pages/LpProvision";
import { BuyPt } from "../fixed-yield/pages/BuyPt";
import { IntentFill } from "../fixed-yield/pages/IntentFill";

/**
 * Fixed-yield (PT/YT) institutional surface.
 *
 * Mirrors the playground / console FixedYield panels — the underlying
 * subtree (`fixed-yield/`) is shared verbatim across all three so any
 * fix to `kamino_sy_adapter` / `clearstone_core` / `clearstone_router`
 * call shapes lands once and propagates everywhere.
 *
 * Sub-tabs:
 *  * **Setup** — review / override the active deployment handles +
 *    pin a stack pubkey set in localStorage.
 *  * **Sourcing** — `mint_sy(USDC → SY)` + `strip(SY → PT + YT)`.
 *  * **LP provision** — deposit PT + SY → classic LP token.
 *  * **Buy PT** — base → SY → PT (one-shot via `wrapper_buy_pt`).
 *  * **Self-solve** — sign + (stub) submit a fusion `OrderConfig`.
 *
 * KYC bypass via the test stack defined in Setup. Designed for
 * institutional operators who already hold KYC'd wallets on the
 * Clearstone whitelist bundle (csSOL + csSOL-WT + ceUSX + cSOL).
 */

type SubTab = "setup" | "sourcing" | "lp" | "buy_pt" | "intent_fill";

const SUB_TABS: { id: SubTab; label: string; subtitle: string }[] = [
  { id: "setup",       label: "Setup",         subtitle: "active deployment handles + override JSON" },
  { id: "sourcing",    label: "Sourcing",      subtitle: "USDC → SY (mint_sy) and SY → PT+YT (strip)" },
  { id: "lp",          label: "LP provision",  subtitle: "deposit PT + SY → LP (wrapper_provide_liquidity_classic)" },
  { id: "buy_pt",      label: "Buy PT",        subtitle: "base → SY → PT (wrapper_buy_pt)" },
  { id: "intent_fill", label: "Self-solve",    subtitle: "sign + (stub) submit a fusion OrderConfig" },
];

export default function FixedYieldPage() {
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
            <span className="text-xs font-mono text-base-content/40">v3 stack</span>
          </div>
          <p className="text-sm text-base-content/60 max-w-3xl">
            csSOL / sUSDC PT + YT stack on Kamino. Operator surface — direct
            calls into <code>kamino_sy_adapter</code>, <code>clearstone_core</code>,
            and <code>clearstone_router</code>. KYC bypass via the test stack
            defined in Setup. Wallets here are already whitelisted on the
            unified Clearstone bundle, so the SY adapter's mint/burn checks
            pass without additional onboarding.
          </p>
        </header>

        <Tabs.Root value={sub} onValueChange={(v) => setSub(v as SubTab)} variant="underline">
          <Tabs.List withRail>
            {SUB_TABS.map((t) => (
              <Tabs.Trigger key={t.id} value={t.id} title={t.subtitle}>
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>

        <div className="text-xs text-base-content/50 -mt-3">{active.subtitle}</div>

        <div className="rounded-lg border border-base-300 bg-base-200/40 p-5">
          {sub === "setup"       ? <Setup />       : null}
          {sub === "sourcing"    ? <Sourcing />    : null}
          {sub === "lp"          ? <LpProvision /> : null}
          {sub === "buy_pt"      ? <BuyPt />       : null}
          {sub === "intent_fill" ? <IntentFill />  : null}
        </div>
      </section>
    </StackContext.Provider>
  );
}
