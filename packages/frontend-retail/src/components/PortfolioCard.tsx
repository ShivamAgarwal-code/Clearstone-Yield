import { Badge, TokenIcon } from "@clearstone/design-system";

interface PortfolioCardProps {
  usdcBalance: number | null;
  depositedUsdc: number;
  supplyAPY: number;
}

export function PortfolioCard({ usdcBalance, depositedUsdc, supplyAPY }: PortfolioCardProps) {
  const totalValue = (usdcBalance || 0) + depositedUsdc;
  const monthlyYield = depositedUsdc * supplyAPY / 12;
  const yearlyYield = depositedUsdc * supplyAPY;
  const dailyYield = depositedUsdc * supplyAPY / 365;
  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="eyebrow">Position</span>
            <h3 className="font-display text-lg mt-0.5">Your Portfolio</h3>
          </div>
          <TokenIcon symbol="USDC" size="sm" />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-sm opacity-70">Wallet</span>
            <span className="text-sm font-mono tabular-nums">
              {usdcBalance !== null ? `$${fmt(usdcBalance)}` : "—"}
            </span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-sm opacity-70">Deposited</span>
            <span className="text-sm font-mono tabular-nums">
              ${fmt(depositedUsdc)}
            </span>
          </div>

          <div className="flex justify-between items-center border-t border-base-300/70 pt-3 mt-2">
            <span className="text-sm font-semibold">Total</span>
            <span className="figure tabular-nums text-lg">
              ${fmt(totalValue)}
            </span>
          </div>
        </div>

        {depositedUsdc > 0 && (
          <div className="mt-2 space-y-3">
            {/* Headline yield row — accent-colored, generous padding,
                figure typography. Replaces the awkward Stat box that
                bordered weirdly against the dark theme. */}
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
                  +${fmt(monthlyYield)}
                </span>
                <span className="text-xs opacity-60">/ month</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <YieldStat label="Yearly yield" value={`$${fmt(yearlyYield)}`} />
              <YieldStat
                label="Daily yield"
                value={`$${dailyYield.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`}
              />
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

function YieldStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-base-300/60 bg-base-100/40 px-3 py-2">
      <div className="eyebrow opacity-60 mb-0.5" style={{ fontSize: "0.625rem" }}>{label}</div>
      <div className="font-mono tabular-nums text-sm font-semibold">{value}</div>
    </div>
  );
}
