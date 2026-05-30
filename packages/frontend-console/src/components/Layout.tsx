import { ReactNode, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Badge,
  Card,
  Eyebrow,
  Stat,
  Tabs,
  cn,
} from "@clearstone/design-system";
import { useAuthority } from "../hooks/useAuthority";
import AdminPanel from "../pages/AdminPanel";
import ElevationGroupsPanel from "../pages/ElevationGroupsPanel";
import FixedYieldPanel from "../pages/FixedYieldPanel";
import OraclePanel from "../pages/OraclePanel";
import MarketPanel from "../pages/MarketPanel";
import RateCurvePanel from "../pages/RateCurvePanel";

/**
 * Console always renders in the brand light theme. The retail surface
 * is the only one that opts into `clearstone-dark` (set on its
 * index.html). Single-bar header pattern matches institutional /
 * retail — tabs inline at lg+, hamburger menu on smaller widths.
 */

type Tab =
  | "admin"
  | "oracles"
  | "market"
  | "rates"
  | "elevation"
  | "fixed_yield";

const ICON: Record<Tab, ReactNode> = {
  admin: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M12 21a9 9 0 100-18 9 9 0 000 18z" />
    </svg>
  ),
  market: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h3l3-9 4 18 3-9h5" />
    </svg>
  ),
  rates: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l6-6 4 4 8-8M14 7h7v7" />
    </svg>
  ),
  elevation: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19h14M7 19V9l5-5 5 5v10" />
    </svg>
  ),
  oracles: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zM12 8v4l3 2" />
    </svg>
  ),
  fixed_yield: (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13l4 4L19 5M3 19h18" />
    </svg>
  ),
};

const TABS: { key: Tab; label: string; desc: string }[] = [
  { key: "admin",       label: "Governance",  desc: "KYC & admin participants" },
  { key: "market",      label: "Markets",     desc: "v3 reserves, caps, oracles" },
  { key: "rates",       label: "Rate Curves", desc: "IRM utilisation curve config" },
  { key: "elevation",   label: "Elevation",   desc: "EG-1..EG-4 manager" },
  { key: "oracles",     label: "Oracles",     desc: "Pyth price feed pinning" },
  { key: "fixed_yield", label: "Fixed Yield", desc: "PT / YT stack operator" },
];

export default function Layout() {
  const { connected } = useWallet();
  const authority = useAuthority();
  const [tab, setTab] = useState<Tab>("admin");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Pin console to the brand light theme. Clears any legacy
  // localStorage from the retired multi-theme switcher.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "clearstone");
    if (typeof window !== "undefined") {
      try { localStorage.removeItem("delta-theme"); } catch {}
    }
  }, []);

  // Outside-click + Escape closes the mobile menu.
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

  const activeTab = TABS.find((t) => t.key === tab);

  return (
    <div className="min-h-screen bg-base-100 text-base-content flex flex-col">
      {/* Single-bar header — brand left (with admin sub-line), inline
          tabs centered (lg+), cross-surface links + wallet right.
          Hamburger drawer below lg. Mirrors the institutional/retail
          pattern so the three surfaces share chrome conventions. */}
      <div className="sticky top-0 z-30 bg-base-200/85 backdrop-blur-md border-b border-base-300">
        <header className="navbar px-4 sm:px-6 min-h-16 gap-3">
          {/* Brand */}
          <div className="flex items-center gap-2.5 min-w-0 flex-shrink-0">
            <img src="/logo.svg" alt="Clearstone Fusion" className="h-8 w-8" />
            <div className="hidden sm:flex flex-col leading-none">
              <div className="flex items-baseline gap-1 font-display">
                <span className="brand-wordmark text-lg text-primary">clearstone</span>
                <span className="brand-wordmark-thin text-sm text-base-content/50">fusion</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]">
                <span className="text-primary/70">Admin Console</span>
                <span className="text-base-content/25">·</span>
                <span className="font-mono tracking-normal text-base-content/35 normal-case">devnet</span>
              </div>
            </div>
          </div>

          {/* Inline tabs (lg+) — only when connected since the tabs route
              into wallet-gated panels. */}
          {connected && (
            <div className="hidden lg:flex flex-1 justify-center">
              <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Tab)} variant="underline">
                <Tabs.List className="flex-nowrap">
                  {TABS.map((t) => (
                    <Tabs.Trigger
                      key={t.key}
                      value={t.key}
                      icon={ICON[t.key]}
                      title={t.desc}
                    >
                      {t.label}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
              </Tabs.Root>
            </div>
          )}

          {/* Right cluster */}
          <div className="ml-auto flex items-center gap-3 flex-shrink-0">
            <div className="hidden md:flex items-center gap-3 text-xs">
              <a href="https://clearstone.ai" target="_blank" rel="noreferrer"
                className="link link-hover text-base-content/50 hover:text-primary">home</a>
              <span className="text-base-content/20">·</span>
              <a href="https://retail.clearstone.ai" target="_blank" rel="noreferrer"
                className="link link-hover text-base-content/50 hover:text-primary">retail</a>
              <span className="text-base-content/20">·</span>
              <a href="https://institutional.clearstone.ai" target="_blank" rel="noreferrer"
                className="link link-hover text-base-content/50 hover:text-primary">institutional</a>
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
                      "absolute right-0 top-full mt-2 z-40 w-72",
                      "rounded-xl bg-base-200 border border-base-300",
                      "shadow-[var(--shadow-stone-md)] overflow-hidden",
                    )}
                  >
                    <ul className="py-1.5">
                      {TABS.map((t) => {
                        const isActive = t.key === tab;
                        return (
                          <li key={t.key}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => { setTab(t.key); setMenuOpen(false); }}
                              className={cn(
                                "flex items-start gap-3 w-full px-4 py-3 text-left cursor-pointer",
                                "transition-colors",
                                isActive
                                  ? "bg-primary/[0.08] text-base-content"
                                  : "text-base-content/70 hover:bg-base-content/[0.04] hover:text-base-content",
                              )}
                            >
                              <span className="flex-shrink-0 inline-flex mt-0.5">{ICON[t.key]}</span>
                              <span className="flex-1 min-w-0">
                                <span className={cn("block text-sm leading-none", isActive && "font-semibold")}>{t.label}</span>
                                <span className="block text-[11px] text-base-content/55 mt-1 leading-snug">{t.desc}</span>
                              </span>
                              {isActive && (
                                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary mt-2" />
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

        {/* Mobile-only active-surface confirmation strip. */}
        {connected && activeTab && (
          <div className="lg:hidden flex items-center gap-2 px-4 sm:px-6 py-2 border-t border-base-300/60 bg-base-200/40">
            <span className="flex-shrink-0 inline-flex text-primary">{ICON[activeTab.key]}</span>
            <span className="text-sm font-semibold text-base-content">{activeTab.label}</span>
          </div>
        )}

        {/* Read-only banner — connected, but not an admin or market owner.
            All panels render fully; write controls disable themselves
            via useAuthority. The banner just makes the state explicit
            so the user isn't confused by greyed-out buttons. */}
        {connected && !authority.canWrite && !authority.loading && (
          <div className="flex items-start gap-3 px-4 sm:px-6 py-2.5 border-t border-warning/30 bg-warning/10 text-warning-content">
            <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 mt-0.5 text-warning"
              fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 9v4m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
            <div className="text-xs leading-snug min-w-0 flex-1 text-base-content/75">
              <span className="font-semibold text-base-content">Read-only mode.</span>{" "}
              This wallet is not the governor admin or market owner — every page is
              browseable, but write actions (whitelist, reserve config, EG, oracle
              pin) are disabled. Connect an authorised wallet to enable edits.
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 lg:px-8 py-8">
        {!connected ? <DisconnectedHero /> : (
          <>
            {tab === "admin" && <AdminPanel />}
            {tab === "market" && <MarketPanel />}
            {tab === "rates" && <RateCurvePanel />}
            {tab === "elevation" && <ElevationGroupsPanel />}
            {tab === "oracles" && <OraclePanel />}
            {tab === "fixed_yield" && <FixedYieldPanel />}
          </>
        )}
      </main>

      <footer className="footer footer-center p-6 text-base-content/20 text-xs border-t border-base-300">
        <p>Clearstone Fusion · Admin Console · Solana Devnet</p>
      </footer>
    </div>
  );
}

/** Disconnected landing — admin-context hero + a glance at the surfaces
 *  the wallet unlocks. Mirrors the institutional disconnected hero
 *  (Eyebrow + multi-line title + value prop + Select Wallet + tile
 *  grid + security note) so the three surfaces feel like one product. */
function DisconnectedHero() {
  return (
    <div className="space-y-10 pb-12 pt-2">
      <div className="text-center space-y-5 max-w-2xl mx-auto">
        <Eyebrow as="div" className="!text-base-content/55">
          Clearstone Fusion · Admin Console
        </Eyebrow>
        <h1 className="font-display text-4xl font-light tracking-[-0.014em] leading-tight text-base-content">
          Govern the protocol.
          <br />
          Configure the markets.
        </h1>
        <p className="text-base text-base-content/60 leading-relaxed max-w-xl mx-auto">
          Operator surface for the Clearstone v3 deployment — KYC participant
          management, klend reserve config, IRM curves, elevation-group bundles,
          oracle pinning, and the fixed-yield PT/YT stack. Wallet-gated to the
          governor multisig.
        </p>
        <div className="pt-3 flex justify-center">
          <WalletMultiButton />
        </div>
        <div className="pt-1 flex items-center justify-center gap-2 flex-wrap">
          <Badge tone="primary" variant="soft" size="xs">Governor multisig</Badge>
          <Badge tone="success" variant="soft" size="xs">v3 deployment</Badge>
          <Badge tone="neutral" variant="soft" size="xs">Solana devnet</Badge>
        </div>
      </div>

      <div className="space-y-3">
        <div className="text-center">
          <Eyebrow as="div">Surfaces</Eyebrow>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {TABS.map((t) => (
            <Stat
              key={t.key}
              size="sm"
              icon={
                <span className="inline-flex items-center justify-center h-9 w-9 rounded-full bg-primary/[0.08] text-primary">
                  {ICON[t.key]}
                </span>
              }
              label={t.label}
              value={
                <span className="font-display text-base font-medium tracking-[-0.01em] text-base-content">
                  {t.desc}
                </span>
              }
            />
          ))}
        </div>
      </div>

      <Card tone="muted" size="md">
        <div className="flex items-start gap-3">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 text-warning flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
          >
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M12 9v4m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
          </svg>
          <div className="min-w-0">
            <div className="font-semibold text-sm">Admin-only</div>
            <p className="text-xs text-base-content/60 mt-1 leading-relaxed">
              The console issues governance and config calls — `update_reserve_config`,
              `request_elevation_group`, KYC whitelist mutations, oracle pinning. Connect
              a wallet that is a governor admin or an authorised root for the relevant
              MintConfig; non-admin wallets land on read-only views.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
