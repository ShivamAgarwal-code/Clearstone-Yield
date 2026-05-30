import { useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";
import { GatewayProvider } from "@civic/solana-gateway-react";
import { PublicKey } from "@solana/web3.js";
import { Tabs, cn } from "@clearstone/design-system";
import { SavingsApp } from "./pages/SavingsApp";
import { TermDepositsApp } from "./pages/TermDepositsApp";
import GeoGate from "./components/GeoGate";

import "@solana/wallet-adapter-react-ui/styles.css";

const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);

// Civic Uniqueness gatekeeper network (liveness check, no PII)
const GATEKEEPER_NETWORK = new PublicKey("ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6");

function CivicWrapper({ children }: { children: React.ReactNode }) {
  return (
    <GatewayProvider
      gatekeeperNetwork={GATEKEEPER_NETWORK}
      cluster="devnet"
      clusterUrl={endpoint}
    >
      {children}
    </GatewayProvider>
  );
}

type Tab = "savings" | "term-deposits";

const TAB_ICONS: Record<Tab, JSX.Element> = {
  savings: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M5 10v8a2 2 0 002 2h10a2 2 0 002-2v-8M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2" />
    </svg>
  ),
  "term-deposits": (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l2.5 2.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

function AppShell() {
  const [tab, setTab] = useState<Tab>("savings");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  const TABS: { id: Tab; label: string; icon: JSX.Element }[] = [
    { id: "savings", label: "Savings", icon: TAB_ICONS.savings },
    { id: "term-deposits", label: "Term Deposits", icon: TAB_ICONS["term-deposits"] },
  ];
  const activeTab = TABS.find((t) => t.id === tab)!;

  return (
    <div data-theme="clearstone-dark" className="min-h-screen bg-base-100 text-base-content flex flex-col">
      {/* Single-bar header — brand left, segmented section nav inline at
          md+, hamburger drawer below. The previous nav row beneath the
          header is gone; the savings ↔ term-deposits toggle now lives
          directly alongside the wallet area. */}
      <header className="navbar bg-base-200/60 backdrop-blur-sm border-b border-base-300 px-4 sm:px-6 min-h-16 gap-3">
        {/* Brand — wordmark stacks over the surface/network sub-label
            so the DEVNET badge stops competing for horizontal space
            with the segmented nav next to it. */}
        <div className="flex items-center gap-2.5 min-w-0 flex-shrink-0">
          {/* Logo with a soft halo + brightness lift so the dark stone
              silhouette doesn't blend into the dark navbar. */}
          <div className="relative flex items-center justify-center h-9 w-9">
            <span
              aria-hidden
              className="absolute inset-0 rounded-full opacity-60 blur-md"
              style={{ background: "radial-gradient(closest-side, rgba(166,179,197,0.45), transparent 70%)" }}
            />
            <img
              src="/logo.svg"
              alt="Clearstone Fusion"
              className="relative h-8 w-8"
              style={{ filter: "brightness(1.18) contrast(1.05) drop-shadow(0 1px 2px rgba(0,0,0,0.45))" }}
            />
          </div>
          <div className="hidden sm:flex flex-col leading-none">
            <div className="flex items-baseline gap-1.5">
              <span className="brand-wordmark text-lg text-base-content">Clearstone</span>
              <span className="brand-wordmark-thin text-sm opacity-60">fusion</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]">
              <span className="text-base-content/70">Retail</span>
              <span className="text-base-content/25">·</span>
              <span className="font-mono tracking-normal text-warning/70 normal-case">devnet</span>
            </div>
          </div>
        </div>

        {/* Inline segmented nav (md+). Only two destinations, so the
            segmented variant works without crowding. */}
        <div className="hidden md:flex flex-1 justify-center">
          <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Tab)} variant="segmented">
            <Tabs.List>
              <Tabs.Trigger value="savings" icon={TAB_ICONS.savings}>Savings</Tabs.Trigger>
              <Tabs.Trigger value="term-deposits" icon={TAB_ICONS["term-deposits"]}>Term Deposits</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </div>

        {/* Right-side cluster: cross-surface links + wallet + hamburger. */}
        <div className="ml-auto flex items-center gap-3 flex-shrink-0">
          <div className="hidden lg:flex items-center gap-3 text-xs">
            <a href="https://clearstone.ai" target="_blank" rel="noreferrer"
              className="link link-hover text-base-content/50 hover:text-primary">home</a>
            <span className="text-base-content/20">·</span>
            <a href="https://institutional.clearstone.ai" target="_blank" rel="noreferrer"
              className="link link-hover text-base-content/50 hover:text-primary">institutional</a>
            <span className="text-base-content/20">·</span>
            <a href="https://console.clearstone.ai" target="_blank" rel="noreferrer"
              className="link link-hover text-base-content/50 hover:text-primary">console</a>
          </div>
          <WalletMultiButton />

          <div ref={menuRef} className="relative md:hidden">
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className={cn(
                "inline-flex items-center justify-center h-10 w-10 rounded-lg cursor-pointer",
                "text-base-content/70 hover:text-base-content",
                "hover:bg-base-content/[0.08] transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
                menuOpen && "bg-base-content/[0.08] text-base-content",
              )}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
                {menuOpen
                  ? <path d="M6 6l12 12M18 6 6 18" />
                  : <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>}
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className={cn(
                  "absolute right-0 top-full mt-2 z-40 w-60",
                  "rounded-xl bg-base-200 border border-base-300",
                  "shadow-[var(--shadow-stone-md)] overflow-hidden",
                )}
              >
                <ul className="py-1.5">
                  {TABS.map((t) => {
                    const isActive = t.id === tab;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => { setTab(t.id); setMenuOpen(false); }}
                          className={cn(
                            "flex items-center gap-3 w-full px-4 py-2.5 text-sm font-medium text-left cursor-pointer",
                            "transition-colors",
                            isActive
                              ? "bg-primary/15 text-base-content font-semibold"
                              : "text-base-content/70 hover:bg-base-content/[0.06] hover:text-base-content",
                          )}
                        >
                          <span className="flex-shrink-0 inline-flex">{t.icon}</span>
                          <span className="flex-1">{t.label}</span>
                          {isActive && (
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Mobile-only active-tab confirmation — same pattern as the
          institutional shell. Hidden at md+ where the segmented nav
          is visible inline. */}
      <div className="md:hidden flex items-center gap-2 px-4 sm:px-6 py-2 border-b border-base-300/60 bg-base-200/40">
        <span className="flex-shrink-0 inline-flex text-primary">{activeTab.icon}</span>
        <span className="text-sm font-semibold text-base-content">{activeTab.label}</span>
      </div>

      {tab === "savings" ? <SavingsApp /> : <TermDepositsApp />}
    </div>
  );
}

export default function App() {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter({ network })],
    []
  );

  return (
    <GeoGate>
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <CivicWrapper>
            <AppShell />
          </CivicWrapper>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
    </GeoGate>
  );
}
