import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import {
  CSOL_DM_MINT_CONFIG,
  CSOL_MINT,
  CSOL_POOL_PDA,
  CSOL_RESERVE,
  CSSOL_WHITELIST_BUNDLE,
  DELTA_MINT_PROGRAM,
  ELEVATION_GROUP_MARGIN_LONG,
  ELEVATION_GROUP_MARGIN_SHORT,
  KLEND_MARKET,
  MARGIN_PAIR_LIQ_THRESHOLD_PCT,
  MARGIN_PAIR_LTV_PCT,
  SUSDC_MINT,
  SUSDC_RESERVE,
  WSOL_RESERVE,
} from "../lib/addresses";

function short(p: string | PublicKey | null | undefined, n = 6): string {
  if (!p) return "—";
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

type DeployStage = {
  id: string;
  label: string;
  ready: boolean;
  detail?: string;
};

/**
 * Margin-pair (EG-3 long SOL / EG-4 short SOL) preview tab.
 *
 * Renders in three progressively-enabled modes depending on deploy state:
 *   1. **Design preview** (cSOL not yet a klend reserve) — shows the EG
 *      configs, stage checklist, whitelist coverage, and pitch. No
 *      live trading.
 *   2. **Whitelist coverage** (always available once a wallet is
 *      connected) — surfaces per-MintConfig whitelist status from the
 *      bundle so the user can request whitelisting before reserves land.
 *   3. **Live trading** (cSOL reserve registered, EG-3 + EG-4 active)
 *      — full trade panel with long/short toggle, position health, and
 *      flash-loan-driven open/close paths. Wired in a follow-up after
 *      Stage E lands; for now the buttons stay disabled.
 *
 * No second wrap (csUSDC) — the USD side reuses the existing sUSDC
 * reserve; gating flows through the cSOL wrap requirement on the
 * collateral leg, mirroring EG-1 (ceUSX/sUSDC) and EG-2 (csSOL/wSOL).
 * See docs/operations/MARGIN_PAIR.md.
 */
export default function MarginTradeTab() {
  const { connection } = useConnection();
  const wallet = useWallet();

  // ---- Stage tracking ---------------------------------------------------
  // Each stage maps to a deploy step in docs/operations/MARGIN_PAIR.md.
  const stages: DeployStage[] = [
    {
      id: "A",
      label: "A. Design memo + market-config JSON",
      ready: true,
      detail: "docs/operations/MARGIN_PAIR.md, cssol-market-v3.json EG-3 / EG-4 entries",
    },
    {
      id: "D'",
      label: "D'. Klend reserve: cSOL",
      ready: !!CSOL_RESERVE,
      detail: CSOL_RESERVE
        ? `cSOL reserve ${short(CSOL_RESERVE)}`
        : "VITE_CSOL_RESERVE unset — register via scripts/setup-margin-pair.ts",
    },
    {
      id: "E",
      label: "E. Elevation group registration (EG-3 + EG-4)",
      // EG-3 + EG-4 are both registered on-chain (per
      // configs/devnet/margin-egs-deployed.json). The per-reserve
      // `elevation_groups` arrays still need a final mode-34 update so
      // request_elevation_group(3 or 4) validates against an obligation;
      // surfacing that as a separate caveat below the badge.
      ready: !!CSOL_RESERVE,
      detail: CSOL_RESERVE
        ? "EG-3 (debt=sUSDC) + EG-4 (debt=cSOL) live on the v3 market — see configs/devnet/margin-egs-deployed.json"
        : "scripts/setup-margin-egs.ts — fires update_lending_market(UpdateElevationGroup)",
    },
  ];
  const liveTrading = stages.every((s) => s.ready);
  const previewOnly = stages[0].ready && !liveTrading;

  // ---- Whitelist coverage from the bundle -------------------------------
  // Reuses CSSOL_WHITELIST_BUNDLE so the gating story is one source of
  // truth across deposit, unwind, and margin tabs.
  const [whitelistStatus, setWhitelistStatus] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!wallet.publicKey) { setWhitelistStatus(null); return; }
    void (async () => {
      const status: Record<string, boolean> = {};
      const pdas = CSSOL_WHITELIST_BUNDLE.map((e) =>
        PublicKey.findProgramAddressSync(
          [new TextEncoder().encode("whitelist"), e.mintConfig.toBuffer(), wallet.publicKey!.toBuffer()],
          DELTA_MINT_PROGRAM,
        )[0],
      );
      const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
      CSSOL_WHITELIST_BUNDLE.forEach((entry, i) => {
        status[entry.label] = !!infos[i];
      });
      if (!cancelled) setWhitelistStatus(status);
    })();
    return () => { cancelled = true; };
  }, [wallet.publicKey, connection]);

  const missingWhitelist = useMemo(
    () => whitelistStatus
      ? Object.entries(whitelistStatus).filter(([, v]) => !v).map(([k]) => k)
      : null,
    [whitelistStatus],
  );

  // ---- Render ----------------------------------------------------------
  return (
    <section className="max-w-4xl space-y-6">
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-2xl font-bold">Margin trading — SOL/USDC long & short</h2>
          {previewOnly ? (
            <span className="badge badge-warning badge-sm">design preview · deploy pending</span>
          ) : (
            <span className="badge badge-success badge-sm">live</span>
          )}
        </div>
        <p className="opacity-70 mt-1 text-sm">
          Two new klend elevation groups (<code>EG-{ELEVATION_GROUP_MARGIN_LONG}</code> long /{" "}
          <code>EG-{ELEVATION_GROUP_MARGIN_SHORT}</code> short) at{" "}
          <code>{MARGIN_PAIR_LTV_PCT}% / {MARGIN_PAIR_LIQ_THRESHOLD_PCT}%</code> over the existing v3 market.
          Cross-margin capital efficiency comes from sharing the same
          underlying liquidity pool with EG-1 stables and EG-2 csSOL leverage —
          the marginal cost of adding margin trading is just registering the
          cSOL reserve and two EGs (sUSDC reuses the existing reserve).
          Gate flows through the cSOL wrap-time whitelist; the USD side stays
          unwrapped, matching EG-1 / EG-2 asymmetry.
        </p>
        <p className="text-xs opacity-60 mt-1">
          Full design memo:{" "}
          <a className="link" href="https://github.com/1delta-DAO/clearstone-finance/blob/main/docs/operations/MARGIN_PAIR.md" target="_blank" rel="noreferrer">
            docs/operations/MARGIN_PAIR.md
          </a>
        </p>
      </header>

      {/* EG cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <EgCard
          number={ELEVATION_GROUP_MARGIN_LONG}
          name="Margin Long SOL"
          collateral={{
            label: "cSOL",
            mint: CSOL_MINT,
            underlying: "wSOL",
            reserve: CSOL_RESERVE,
            fallbackReserve: WSOL_RESERVE,
            fallbackLabel: "wSOL (proxy)",
            wrapped: true,
          }}
          debt={{
            label: "sUSDC",
            mint: SUSDC_MINT,
            underlying: "—",
            reserve: SUSDC_RESERVE,
            wrapped: false,
          }}
          accent="border-success/60 bg-success/5"
          tagline="Deposit SOL (wrapped to cSOL), borrow USDC, swap USDC → SOL externally, redeposit. Each loop layers leverage; net exposure is +long SOL by leverage factor."
          live={liveTrading}
        />
        <EgCard
          number={ELEVATION_GROUP_MARGIN_SHORT}
          name="Margin Short SOL"
          collateral={{
            label: "sUSDC",
            mint: SUSDC_MINT,
            underlying: "—",
            reserve: SUSDC_RESERVE,
            wrapped: false,
          }}
          debt={{
            label: "cSOL",
            mint: CSOL_MINT,
            underlying: "wSOL",
            reserve: CSOL_RESERVE,
            fallbackReserve: WSOL_RESERVE,
            fallbackLabel: "wSOL (proxy)",
            wrapped: true,
          }}
          accent="border-error/60 bg-error/5"
          tagline="Deposit USDC, borrow cSOL → unwrap to wSOL → swap SOL → USDC externally → redeposit. Final state nets to -short SOL exposure."
          live={liveTrading}
        />
      </div>

      {/* Stage checklist */}
      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-2">
          <div className="font-bold text-sm">Deploy stages</div>
          <p className="text-xs opacity-70">
            Trimmed from five stages to three after the v2 design unwound the redundant{" "}
            <code>csUSDC</code> wrapper — sUSDC's existing v3 reserve is reused as-is, and gating flows entirely through the cSOL wrap requirement on the collateral leg. Each remaining stage maps to a script under <code>packages/programs/scripts/</code>.
          </p>
          <ul className="text-xs space-y-1.5 mt-2">
            {stages.map((s) => (
              <li key={s.id} className="flex items-start gap-2">
                <span className={`badge badge-sm ${s.ready ? "badge-success" : "badge-ghost"} mt-0.5`}>
                  {s.ready ? "✓" : "·"}
                </span>
                <div>
                  <span className={s.ready ? "" : "opacity-70"}>{s.label}</span>
                  {s.detail ? <div className="opacity-60 text-[10px] font-mono mt-0.5">{s.detail}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Whitelist coverage */}
      {wallet.publicKey ? (
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-2">
            <div className="font-bold text-sm">Whitelist coverage</div>
            <p className="text-xs opacity-70">
              Margin trading reuses the same delta-mint whitelist bundle as csSOL deposits and unwinds — KYC retail, KYB institutional, and playground users all converge to the same Holder PDAs. Run{" "}
              <code className="text-[10px]">DEPLOY_KEYPAIR=… npx tsx scripts/whitelist-wallet.ts {wallet.publicKey.toBase58()}</code>{" "}
              to fan out across every MintConfig in the bundle.
            </p>
            {whitelistStatus ? (
              <div className="flex flex-wrap gap-2 mt-2">
                {Object.entries(whitelistStatus).map(([label, status]) => (
                  <span
                    key={label}
                    className={`badge badge-sm ${status ? "badge-success" : "badge-error badge-outline"}`}
                  >
                    {label}: {status ? "✓" : "missing"}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs opacity-60">Loading…</span>
            )}
            {missingWhitelist && missingWhitelist.length > 0 ? (
              <p className="text-xs text-warning mt-2">
                Wallet missing on: <code>{missingWhitelist.join(", ")}</code>. Trades will fail at the wrap step.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Live-trading panel placeholder */}
      <div className={`card border ${liveTrading ? "border-primary/50 bg-base-300" : "border-base-300 bg-base-200/30 opacity-60"}`}>
        <div className="card-body p-4 space-y-2">
          <div className="font-bold text-sm">Trade panel</div>
          {liveTrading ? (
            <p className="text-xs opacity-80">
              All deploy stages green. The full long/short trade UI lands in a follow-up — wiring{" "}
              <code>flashBorrow → wrap → deposit → borrow → (unwrap) → swap</code> open paths and the mirror close path through the existing v2 wSOL-flash machinery.
            </p>
          ) : (
            <p className="text-xs opacity-80">
              Trade UI unlocks once Stages D' + E land. Until then the cards
              above show the *intended* collateral / debt assets; the
              fallback (wSOL proxy) entries reflect the underlying wSOL
              reserve already in v3 and serve as a sanity check that the
              underlying liquidity is in place.
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button className="btn btn-sm btn-primary" disabled>
              {liveTrading ? "Open long" : "Trade panel — pending Stage E"}
            </button>
            <button className="btn btn-sm btn-secondary" disabled>
              {liveTrading ? "Open short" : "Trade panel — pending Stage E"}
            </button>
          </div>
        </div>
      </div>

      {/* Reference / debug */}
      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">Live config (debug)</summary>
        <ul className="mt-2 space-y-1 font-mono text-[10px]">
          <li>klend market: <code>{short(KLEND_MARKET)}</code></li>
          <li>EG-{ELEVATION_GROUP_MARGIN_LONG} (long): collateral=cSOL, debt=sUSDC, ltv={MARGIN_PAIR_LTV_PCT}%, liq={MARGIN_PAIR_LIQ_THRESHOLD_PCT}%</li>
          <li>EG-{ELEVATION_GROUP_MARGIN_SHORT} (short): collateral=sUSDC, debt=cSOL, ltv={MARGIN_PAIR_LTV_PCT}%, liq={MARGIN_PAIR_LIQ_THRESHOLD_PCT}%</li>
          <li>cSOL pool: <code>{short(CSOL_POOL_PDA)}</code> · MintConfig <code>{short(CSOL_DM_MINT_CONFIG)}</code> · reserve <code>{short(CSOL_RESERVE)}</code></li>
          <li>sUSDC mint: <code>{short(SUSDC_MINT)}</code> · reserve <code>{short(SUSDC_RESERVE)}</code> (already live in EG-1)</li>
        </ul>
      </details>
    </section>
  );
}

interface AssetSlot {
  label: string;
  mint: PublicKey | null;
  underlying: string;
  reserve: PublicKey | null;
  fallbackReserve?: PublicKey | null;
  fallbackLabel?: string;
  wrapped: boolean;
}

function EgCard({
  number, name, collateral, debt, accent, tagline, live,
}: {
  number: number;
  name: string;
  collateral: AssetSlot;
  debt: AssetSlot;
  accent: string;
  tagline: string;
  live: boolean;
}) {
  return (
    <div className={`card border ${accent}`}>
      <div className="card-body p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="badge badge-sm">EG-{number}</span>
          <span className="font-bold text-sm">{name}</span>
          {!live ? <span className="badge badge-ghost badge-sm">pending</span> : null}
        </div>
        <p className="text-xs opacity-80">{tagline}</p>
        <div className="grid grid-cols-2 gap-2 text-xs mt-2">
          <SlotView title="Collateral" slot={collateral} />
          <SlotView title="Debt" slot={debt} />
        </div>
      </div>
    </div>
  );
}

function SlotView({ title, slot }: { title: string; slot: AssetSlot }) {
  const live = !!slot.mint && !!slot.reserve;
  return (
    <div className="bg-base-200/40 rounded p-2 space-y-0.5">
      <div className="opacity-60 uppercase tracking-wider text-[9px]">{title}</div>
      <div className="font-bold flex items-center gap-1">
        {slot.label}
        {slot.wrapped ? (
          <span className="badge badge-xs badge-info">KYC-wrapped</span>
        ) : (
          <span className="badge badge-xs badge-ghost">plain SPL</span>
        )}
      </div>
      {slot.underlying !== "—" ? (
        <div className="opacity-70 text-[10px]">underlying: {slot.underlying}</div>
      ) : null}
      <div className="font-mono text-[10px] opacity-80">
        mint: <code>{short(slot.mint)}</code>
      </div>
      <div className="font-mono text-[10px] opacity-80">
        reserve: <code>{short(slot.reserve)}</code>
      </div>
      {!live && slot.fallbackReserve ? (
        <div className="text-[10px] opacity-60 italic mt-1">
          v3 fallback: <code>{slot.fallbackLabel}</code> ({short(slot.fallbackReserve)})
        </div>
      ) : null}
    </div>
  );
}
