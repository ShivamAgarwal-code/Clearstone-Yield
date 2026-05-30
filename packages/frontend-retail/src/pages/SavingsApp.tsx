import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Badge, TokenIcon } from "@clearstone/design-system";
import { AssetTile } from "../components/AssetTile";
import { usePrograms } from "../hooks/usePrograms";
import { useReserveData } from "../hooks/useReserveData";
import { useCTokenBalance } from "../hooks/useCTokenBalance";
import { useKycStatus } from "../hooks/useKycStatus";
import { KycGate } from "../components/KycGate";
import { DepositCard } from "../components/DepositCard";
import { WithdrawCard } from "../components/WithdrawCard";
import { PortfolioCard } from "../components/PortfolioCard";
import { FaucetCard } from "../components/FaucetCard";
import { SolDepositCard } from "../components/SolDepositCard";
import { SolWithdrawCard } from "../components/SolWithdrawCard";
import { SolAirdropCard } from "../components/SolAirdropCard";

type Asset = "USDC" | "SOL";

export function SavingsApp() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const { governor, config } = usePrograms();

  // Asset toggle. Drives the hero copy + which deposit/withdraw stack
  // is rendered. Both reserves stay live in the background so toggling
  // doesn't cause a fresh fetch every time.
  const [asset, setAsset] = useState<Asset>("USDC");

  // USDC reserve (default — sUSDC on the v1 Stables market).
  const usdcReserve = useReserveData();
  const usdcCToken = useCTokenBalance(usdcReserve.exchangeRate);

  // SOL reserve — post-2026-05-06 retail SOL deposits land on cSOL
  // (the EG-2 debt asset; wSOL was retired). Same 9-decimal underlying,
  // same Pyth oracle as wSOL since cSOL is a 1:1 KYC wrapper.
  const solReserve = useReserveData({
    reserve: config.marketSol.cSolReserve,
    decimals: config.wsol.decimals,
  });
  const solCToken = useCTokenBalance(solReserve.exchangeRate, {
    reserve: config.marketSol.cSolReserve,
    // cSOL underlying = 9 decimals; cToken mint may be 6 decimals so
    // pass the underlying explicitly to keep the displayed
    // `underlyingValue` in proper SOL units.
    underlyingDecimals: config.wsol.decimals,
  });

  const { status: kycStatus, refresh: refreshKyc } = useKycStatus();
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);

  const refreshUsdcBalance = useCallback(() => {
    if (!publicKey || !connected) { setUsdcBalance(null); return; }
    // The retail wallet's "USDC balance" is the underlying sUSDC the
    // user spends — DepositCard wraps it to cUSDC inside the deposit
    // tx, so we never want to display the (always-zero) cUSDC ATA
    // balance here. sUSDC is legacy SPL → TOKEN_PROGRAM_ID. Source
    // of truth is `config.usdcUnderlying.mint`.
    const ata = getAssociatedTokenAddressSync(
      config.usdcUnderlying.mint, publicKey, false, TOKEN_PROGRAM_ID,
    );
    connection.getTokenAccountBalance(ata)
      .then((bal) => setUsdcBalance(Number(bal.value.uiAmount)))
      .catch(() => setUsdcBalance(0));
  }, [publicKey, connected, connection, config]);

  const refreshSolBalance = useCallback(() => {
    if (!publicKey || !connected) { setSolBalance(null); return; }
    connection.getBalance(publicKey, "confirmed")
      .then((lamports) => setSolBalance(lamports / LAMPORTS_PER_SOL))
      .catch(() => setSolBalance(0));
  }, [publicKey, connected, connection]);

  useEffect(() => { refreshUsdcBalance(); }, [refreshUsdcBalance]);
  useEffect(() => { refreshSolBalance(); }, [refreshSolBalance]);

  // Civic-gated self-register on the v3 cSOL pool. Single ix, single
  // signature — USDY/dtUSDY was deprecated 2026-05-06 so retail no
  // longer dual-onboards. USDC supply on the v3 sUSDC reserve doesn't
  // require any whitelist, so this single registration unlocks every
  // KYC-gated retail flow (today: just cSOL wrap).
  const handleSelfRegister = useCallback(async () => {
    if (!publicKey || !governor) return;
    const CIVIC_GATEWAY = new PublicKey("Gtwph6B4yrNFi2E7VEVoE3bSEEj1CFBRFBZodvmBp59K");
    const gkNetwork = config.civic.gatekeeperNetwork;
    const [gatewayToken] = PublicKey.findProgramAddressSync(
      [publicKey.toBuffer(), Buffer.from("gateway"), Buffer.alloc(8), gkNetwork.toBuffer()],
      CIVIC_GATEWAY,
    );
    const [cSolWhitelist] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), config.csolPool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
      config.programs.deltaMint,
    );

    const sig = await (governor.methods as any)
      .selfRegisterNative()
      .accounts({
        user: publicKey,
        poolConfig: config.csolPool.poolConfig,
        gatewayToken,
        dmMintConfig: config.csolPool.dmMintConfig,
        whitelistEntry: cSolWhitelist,
        deltaMintProgram: config.programs.deltaMint,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    sessionStorage.setItem(`kyc_retail_v2_${publicKey.toBase58()}`, "approved");
    refreshKyc();
    return sig;
  }, [publicKey, governor, config, refreshKyc]);

  // Pulls every UI surface that changes on a deposit/withdraw —
  // wallet balances, the user's cToken position (deposited amount),
  // AND the reserve metrics (TVL + supply APY + utilization). The
  // last bit was previously stuck on a 30s polling cadence, so the
  // dashboard would lag behind the user's own action; refreshing
  // here drops that to the confirmation roundtrip.
  const refreshAll = useCallback(() => {
    refreshUsdcBalance();
    refreshSolBalance();
    usdcCToken.refresh();
    solCToken.refresh();
    usdcReserve.refresh();
    solReserve.refresh();
  }, [
    refreshUsdcBalance, refreshSolBalance,
    usdcCToken.refresh, solCToken.refresh,
    usdcReserve.refresh, solReserve.refresh,
  ]);

  return (
    <div className="flex flex-col flex-1">
      {/* Hero */}
      <section className="px-8 pt-10 pb-6 max-w-5xl mx-auto w-full">
        <div className="text-center mb-6">
          <span className="eyebrow">Regulated DeFi savings</span>
          <h1 className="font-display text-4xl md:text-5xl font-light mt-2 mb-3 tracking-tight">
            Earn yield on your{" "}
            <span className="text-primary font-medium">{asset}</span>
          </h1>
          <p className="text-base-content/60 max-w-lg mx-auto text-sm leading-relaxed">
            Pick an asset to deposit. Each tile shows the current rate,
            utilization, and TVL — click to switch the deposit panel below.
            KYC-gated, withdraw anytime.
          </p>
        </div>

        {/* Asset selector — same pattern as the institutional EG picker.
            Each tile carries its own auxiliary metrics so the picker and
            the headline stat strip collapse into one surface. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-3xl mx-auto">
          <AssetTile
            symbol="USDC"
            label="Solstice USDC · stables"
            accent="info"
            selected={asset === "USDC"}
            onSelect={() => setAsset("USDC")}
            supplyAPY={usdcReserve.supplyAPY}
            utilization={usdcReserve.utilization}
            totalDeposited={usdcReserve.totalDeposited}
            loading={usdcReserve.loading}
          />
          <AssetTile
            symbol="SOL"
            // Post-2026-05-06: SOL deposits route through the cSOL
            // klend reserve (the EG-2 debt asset; wSOL was retired and
            // replaced 1:1 by KYC-wrapped cSOL). The deposit card
            // wraps SOL → cSOL → DepositReserveLiquidity in a single
            // signature; cSOL whitelist precheck gates the flow.
            label="Native SOL · cSOL"
            accent="success"
            selected={asset === "SOL"}
            onSelect={() => setAsset("SOL")}
            supplyAPY={solReserve.supplyAPY}
            utilization={solReserve.utilization}
            totalDeposited={solReserve.totalDeposited}
            loading={solReserve.loading}
          />
        </div>
      </section>

      {/* Main */}
      <main className="flex-1 px-8 py-8 max-w-4xl mx-auto w-full">
        {!connected ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center text-center">
              <h2 className="card-title text-2xl mb-2">Get Started</h2>
              <p className="text-base-content/60 mb-6">
                Connect your Solana wallet to start earning yield on your deposits.
              </p>
              <WalletMultiButton />
            </div>
          </div>
        ) : kycStatus === "checking" || kycStatus === "unknown" ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center">
              <span className="loading loading-spinner loading-lg text-primary"></span>
              <p className="text-base-content/60 mt-4">Checking verification status...</p>
            </div>
          </div>
        ) : kycStatus === "not_approved" ? (
          <KycGate onRegister={handleSelfRegister} />
        ) : asset === "USDC" ? (
          /* Two-column track. Left = portfolio summary (short, sticks
             while the user scrolls the action column). `items-start` so
             the left card no longer stretches to match the right
             column's stack height — that produced ~50vh of empty space
             below the portfolio totals. */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            <div className="md:sticky md:top-20">
              <PortfolioCard
                usdcBalance={usdcBalance}
                depositedUsdc={usdcCToken.underlyingValue}
                supplyAPY={usdcReserve.supplyAPY}
              />
            </div>
            <div className="flex flex-col gap-6">
              <FaucetCard usdcBalance={usdcBalance} onMinted={refreshUsdcBalance} />
              <DepositCard
                usdcBalance={usdcBalance}
                config={config}
                supplyAPY={usdcReserve.supplyAPY}
                onSuccess={refreshAll}
              />
              <WithdrawCard
                depositedUsdc={usdcCToken.underlyingValue}
                cTokenBalance={usdcCToken.cTokens}
                exchangeRate={usdcReserve.exchangeRate}
                config={config}
                onSuccess={refreshAll}
              />
            </div>
          </div>
        ) : (
          /* SOL track — same shape as the USDC track. The PortfolioCard
             stays USDC-only for v1 (it carries the KYC verified badge
             which is shared, so we don't duplicate it for the SOL view).
             A unified PortfolioCard that lists both balances is a
             follow-up. */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            <div className="md:sticky md:top-20">
              <SolPortfolioCard
                solBalance={solBalance}
                depositedSol={solCToken.underlyingValue}
                supplyAPY={solReserve.supplyAPY}
              />
            </div>
            <div className="flex flex-col gap-6">
              <SolAirdropCard solBalance={solBalance} onMinted={refreshSolBalance} />
              <SolDepositCard
                solBalance={solBalance}
                config={config}
                supplyAPY={solReserve.supplyAPY}
                onSuccess={refreshAll}
              />
              <SolWithdrawCard
                depositedSol={solCToken.underlyingValue}
                cTokenBalanceRaw={solCToken.cTokensRaw}
                exchangeRate={solReserve.exchangeRate}
                config={config}
                onSuccess={refreshAll}
              />
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="footer footer-center p-6 text-base-content/40 text-sm border-t border-base-300 mt-8">
        <div>
          <p>Clearstone Fusion — Regulated DeFi Savings</p>
          <p className="text-xs mt-1 opacity-70">Powered by Kamino Finance on Solana Devnet</p>
        </div>
      </footer>
    </div>
  );
}

/** SOL counterpart to <PortfolioCard>. Same layout, SOL units. */
function SolPortfolioCard({
  solBalance,
  depositedSol,
  supplyAPY,
}: {
  solBalance: number | null;
  depositedSol: number;
  supplyAPY: number;
}) {
  const totalValue = (solBalance || 0) + depositedSol;
  const monthlyYield = depositedSol * supplyAPY / 12;
  const yearlyYield = depositedSol * supplyAPY;
  const dailyYield = depositedSol * supplyAPY / 365;
  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const fmt6 = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="eyebrow">Position</span>
            <h3 className="font-display text-lg mt-0.5">Your Portfolio</h3>
          </div>
          <TokenIcon symbol="SOL" size="sm" />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm opacity-70">Wallet</span>
            <span className="text-sm font-mono tabular-nums">
              {solBalance !== null ? `${fmt(solBalance)} SOL` : "—"}
            </span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-sm opacity-70">
              Deposited <span className="opacity-50 text-xs">(wSOL)</span>
            </span>
            <span className="text-sm font-mono tabular-nums">
              {fmt(depositedSol)} SOL
            </span>
          </div>

          <div className="flex justify-between items-center border-t border-base-300/70 pt-3 mt-2">
            <span className="text-sm font-semibold">Total</span>
            <span className="figure tabular-nums text-lg">
              {fmt(totalValue)} SOL
            </span>
          </div>
        </div>

        {depositedSol > 0 && (
          <div className="mt-2 space-y-3">
            <div
              className="rounded-lg px-4 py-3 border border-success/30"
              style={{
                background:
                  "linear-gradient(135deg, rgba(79,176,136,0.10) 0%, rgba(79,176,136,0.02) 100%)",
              }}
            >
              <div className="eyebrow text-success/90 mb-1" style={{ fontSize: "0.625rem" }}>
                Earning {(supplyAPY * 100).toFixed(2)}% APY
              </div>
              <div className="flex items-baseline gap-2">
                <span className="figure tabular-nums text-2xl text-success">
                  +{fmt(monthlyYield)} SOL
                </span>
                <span className="text-xs opacity-60">/ month</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SolYieldStat label="Yearly yield" value={`${fmt(yearlyYield)} SOL`} />
              <SolYieldStat label="Daily yield" value={`${fmt6(dailyYield)} SOL`} />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 mt-2 pt-3 border-t border-base-300/70">
          <Badge tone="success" variant="soft" size="sm">KYC Verified</Badge>
        </div>
      </div>
    </div>
  );
}

function SolYieldStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-base-300/60 bg-base-100/40 px-3 py-2">
      <div className="eyebrow opacity-60 mb-0.5" style={{ fontSize: "0.625rem" }}>{label}</div>
      <div className="font-mono tabular-nums text-sm font-semibold">{value}</div>
    </div>
  );
}
