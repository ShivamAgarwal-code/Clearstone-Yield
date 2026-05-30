import { useMemo, useState } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

import { RPC_URL } from "./lib/addresses";
import CreditTradeTab from "./tabs/CreditTradeTab";
import JitoRestakingTab from "./tabs/JitoRestakingTab";
import LendingPositionTab from "./tabs/LendingPositionTab";
import MarginTradeTab from "./tabs/MarginTradeTab";
import OneStepDepositTab from "./tabs/OneStepDepositTab";
import OneStepUnwindTab from "./tabs/OneStepUnwindTab";
import FixedYieldTab from "./tabs/FixedYieldTab";

type TabId =
  | "credit-trade"
  | "jito-restaking"
  | "margin-trade"
  | "one-step-deposit"
  | "lending-position"
  | "unwind"
  | "fixed-yield";

type Category = "lending" | "credit" | "yield";

interface Tab {
  id: TabId;
  label: string;
  short: string;
  category: Category;
  description: string;
  render: () => JSX.Element;
}

const TABS: Tab[] = [
  {
    id: "lending-position",
    label: "Lending position",
    short: "Position",
    category: "lending",
    description: "Klend balance-sheet view across all reserves you've touched.",
    render: () => <LendingPositionTab />,
  },
  {
    id: "one-step-deposit",
    label: "1-tx SOL → klend collateral",
    short: "Deposit",
    category: "lending",
    description: "Atomic SOL → csSOL wrap → klend collateral deposit in one signature.",
    render: () => <OneStepDepositTab />,
  },
  {
    id: "unwind",
    label: "Unwind",
    short: "Unwind",
    category: "lending",
    description: "csSOL → wSOL exit path (redeem-or-trade router).",
    render: () => <OneStepUnwindTab />,
  },
  {
    id: "credit-trade",
    label: "Credit trade",
    short: "Credit",
    category: "credit",
    description: "1-tx leveraged csSOL/wSOL or ceUSX/sUSDC position via flash + wrap + klend.",
    render: () => <CreditTradeTab />,
  },
  {
    id: "margin-trade",
    label: "Margin trade",
    short: "Margin",
    category: "credit",
    description: "SOL/USDC long & short via klend EG-3 / EG-4 (65/85 LTV). Design preview until cSOL reserve lands; sUSDC reused as-is.",
    render: () => <MarginTradeTab />,
  },
  {
    id: "jito-restaking",
    label: "Jito restaking",
    short: "Restaking",
    category: "yield",
    description: "Direct Jito vault deposits / withdraw-ticket lifecycle.",
    render: () => <JitoRestakingTab />,
  },
  {
    id: "fixed-yield",
    label: "Fixed yield (PT)",
    short: "PT yield",
    category: "yield",
    description: "Kamino PT/YT stack — Setup, Sourcing, LP, Buy PT, intent self-solve.",
    render: () => <FixedYieldTab />,
  },
];

const CATEGORIES: { id: Category; label: string; accent: string }[] = [
  { id: "lending", label: "Lending",          accent: "border-info/60 bg-info/10" },
  { id: "credit",  label: "Credit & leverage", accent: "border-warning/60 bg-warning/10" },
  { id: "yield",   label: "Yield",            accent: "border-success/60 bg-success/10" },
];

function categoryDot(cat: Category): string {
  return cat === "lending" ? "bg-info"
       : cat === "credit"  ? "bg-warning"
       :                     "bg-success";
}

function Shell({ children, tab, setTab }: { children: React.ReactNode; tab: TabId; setTab: (t: TabId) => void }) {
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="min-h-screen bg-base-100 text-base-content">
      <header className="border-b border-base-300 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="badge badge-warning badge-sm">DEV PLAYGROUND</span>
          <span className="font-bold">Clearstone Playground</span>
          <span className="text-xs opacity-60">— not for institutions or retail; this is a developer testing tool.</span>
        </div>
        <WalletMultiButton style={{ height: 36, fontSize: 13 }} />
      </header>

      <nav role="tablist" aria-label="Playground sections" className="px-6 pt-4 pb-3 border-b border-base-300 bg-base-200/40">
        <div className="flex flex-wrap gap-x-6 gap-y-3 items-end">
          {CATEGORIES.map((cat) => {
            const tabs = TABS.filter((t) => t.category === cat.id);
            if (tabs.length === 0) return null;
            return (
              <div key={cat.id} className={`rounded-md border ${cat.accent} px-3 pt-1.5 pb-2`}>
                <div className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1.5">
                  {cat.label}
                </div>
                <div className="join">
                  {tabs.map((t) => {
                    const isActive = tab === t.id;
                    return (
                      <button
                        key={t.id}
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setTab(t.id)}
                        title={t.description}
                        className={`join-item btn btn-sm ${isActive ? "btn-primary" : "btn-ghost bg-base-100/60"} gap-2 normal-case`}
                      >
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${categoryDot(cat.id)}`} />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-xs opacity-60 mt-3 flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${categoryDot(active.category)}`} />
          <span className="font-semibold">{active.label}</span>
          <span className="opacity-60">— {active.description}</span>
        </div>
      </nav>

      <main className="px-6 py-6">{children}</main>

      <footer className="px-6 py-4 text-xs opacity-60 border-t border-base-300 mt-12">
        RPC: {RPC_URL}
      </footer>
    </div>
  );
}

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const [tab, setTab] = useState<TabId>(TABS[0].id);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Shell tab={tab} setTab={setTab}>{active.render()}</Shell>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
