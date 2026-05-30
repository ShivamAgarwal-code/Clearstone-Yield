import { ReactNode, useEffect, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { Tabs, cn } from "@clearstone/design-system";
import WalletBalancesBar from "./WalletBalancesBar";

export type Tab = "prepare" | "positions" | "credit_trade" | "fixed_yield";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  {
    id: "prepare", label: "Overview",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
  },
  {
    id: "positions", label: "Manage Positions",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
  },
  {
    id: "credit_trade", label: "Credit Trade",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>,
  },
  {
    id: "fixed_yield", label: "Fixed Yield",
    icon: <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 13l4 4L19 5M3 19h18" /></svg>,
  },
];

export default function Layout({
  children,
  tab,
  setTab,
}: {
  children: ReactNode;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const { connected } = useWallet();

  // Mobile hamburger state — single navbar at lg+, dropdown menu below.
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

  const activeTab = TABS.find((t) => t.id === tab);

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col">
      {/* Sticky chrome — single navbar (logo + inline tabs + cross-app
          links + wallet) at lg+, hamburger drawer on smaller widths.
          Removed the separate tab row that used to sit beneath the
          header — the merge gives ~48px of vertical space back to the
          page content without losing affordance. */}
      <div className="sticky top-0 z-30 bg-base-200/85 backdrop-blur-md border-b border-base-300">
        <header className="navbar px-4 sm:px-6 min-h-16 gap-3">
          {/* Brand — wordmark stacks over the surface/network sub-label
              so the tag-line stops eating horizontal space next to the
              tabs. Logo aligns to the column's vertical center. */}
          <div className="flex items-center gap-2.5 min-w-0 flex-shrink-0">
            <img src="/logo.svg" alt="Clearstone Fusion" className="h-8 w-8" />
            <div className="hidden sm:flex flex-col leading-none">
              <div className="flex items-baseline gap-1 font-display">
                <span className="brand-wordmark text-lg text-primary">clearstone</span>
                <span className="brand-wordmark-thin text-sm text-base-content/50">fusion</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]">
                <span className="text-primary/70">Institutional</span>
                <span className="text-base-content/25">·</span>
                <span className="font-mono tracking-normal text-base-content/35 normal-case">devnet</span>
              </div>
            </div>
          </div>

          {/* Inline tabs (lg+) — same underline variant as before so the
              active-state vocabulary is shared with every other tab strip
              in the app. Pushed left with `mr-auto` so the wallet area
              stays right-anchored. */}
          {connected && (
            <div className="hidden lg:flex flex-1 justify-center">
              <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Tab)} variant="underline">
                <Tabs.List>
                  {TABS.map((t) => (
                    <Tabs.Trigger key={t.id} value={t.id} icon={t.icon}>
                      {t.label}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </Tabs.Root>
            </div>
          )}

          {/* Right-side cluster: cross-surface links (md+) + wallet
              button + hamburger (mobile only when connected). */}
          <div className="ml-auto flex items-center gap-3 flex-shrink-0">
            <div className="hidden md:flex items-center gap-3 text-xs">
              <a href="https://clearstone.ai" target="_blank" rel="noreferrer"
                className="link link-hover text-base-content/50 hover:text-primary">home</a>
              <span className="text-base-content/20">·</span>
              <a href="https://retail.clearstone.ai" target="_blank" rel="noreferrer"
                className="link link-hover text-base-content/50 hover:text-primary">retail</a>
              <span className="text-base-content/20">·</span>
              <a href="https://console.clearstone.ai" target="_blank" rel="noreferrer"
                className="link link-hover text-base-content/50 hover:text-primary">console</a>
            </div>
            <WalletMultiButton />

            {connected && (
              <div ref={menuRef} className="relative lg:hidden">
                <button
                  type="button"
                  aria-label="Open menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                  className={cn(
                    "inline-flex items-center justify-center h-10 w-10 rounded-lg cursor-pointer",
                    "text-base-content/70 hover:text-base-content",
                    "hover:bg-base-content/[0.06] transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
                    menuOpen && "bg-base-content/[0.06] text-base-content",
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
                      "absolute right-0 top-full mt-2 z-40 w-64",
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
                                  ? "bg-primary/[0.08] text-base-content font-semibold"
                                  : "text-base-content/70 hover:bg-base-content/[0.04] hover:text-base-content",
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
            )}
          </div>
        </header>

        {/* Mobile-only active-tab indicator strip — gives narrow-screen
            users a confirmation of which page they're on without having
            to open the hamburger. Hidden at lg+ where the tab is
            highlighted inline. */}
        {connected && activeTab && (
          <div className="lg:hidden flex items-center gap-2 px-4 sm:px-6 py-2 border-t border-base-300/60 bg-base-200/40">
            <span className="flex-shrink-0 inline-flex text-primary">{activeTab.icon}</span>
            <span className="text-sm font-semibold text-base-content">{activeTab.label}</span>
          </div>
        )}

        {connected && <WalletBalancesBar />}
      </div>

      {/* Main */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">{children}</main>

      {/* Footer */}
      <footer className="border-t border-base-300 bg-base-200 py-4 px-6 text-center text-xs text-base-content/40">
        Clearstone Fusion &middot; Institutional Lending &middot; Powered by Kamino (klend) on Solana &middot; Devnet
      </footer>
    </div>
  );
}
