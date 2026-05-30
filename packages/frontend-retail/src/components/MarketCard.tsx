import { useMemo } from "react";
import { fixedYield } from "@delta/calldata-sdk-solana";
import { Badge, Button, TokenIcon, type TokenSymbol } from "@clearstone/design-system";
import type { FixedYieldMarket } from "../hooks/useFixedYieldMarkets";

interface Props {
  market: FixedYieldMarket;
  /** True when the user is whitelisted on the underlying delta-mint. Drives
   *  the deposit-button gate for kyc-gated markets. */
  kycApproved: boolean;
  onDeposit: (m: FixedYieldMarket) => void;
}

export function MarketCard({ market, kycApproved, onDeposit }: Props) {
  const nowTs = Math.floor(Date.now() / 1000);
  const quote = useMemo(
    () =>
      fixedYield.quote.quoteFixedApy({
        ptPrice: market.ptPrice,
        maturityTs: market.maturityTs,
        nowTs,
        syExchangeRate: market.syExchangeRate,
      }),
    [market.ptPrice, market.maturityTs, market.syExchangeRate, nowTs]
  );

  const maturityDate = new Date(market.maturityTs * 1000);
  const daysToMaturity = Math.max(0, Math.round(quote.timeToMaturity / 86400));
  const blockedByKyc = market.kycGated && !kycApproved;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm hover:border-base-content/15 transition-colors">
      <div className="card-body p-5 gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <TokenIcon symbol={market.baseSymbol as TokenSymbol} size="sm" />
            <div className="min-w-0">
              <span className="eyebrow opacity-60" style={{ fontSize: "0.625rem" }}>
                Term deposit
              </span>
              <h3 className="font-display text-base font-medium truncate">{market.label}</h3>
            </div>
          </div>
          {market.kycGated ? (
            <Badge tone="warning" variant="soft" size="xs">KYC</Badge>
          ) : (
            <Badge tone="neutral" variant="soft" size="xs">Open</Badge>
          )}
        </div>

        <div className="flex items-baseline gap-2 mt-1">
          <span className="figure tabular-nums text-3xl text-success">
            {(quote.apy * 100).toFixed(2)}%
          </span>
          <span className="text-xs opacity-70">fixed APY · {daysToMaturity}d</span>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Row label="Matures" value={maturityDate.toLocaleDateString()} />
          <Row label="Term" value={`${daysToMaturity}d`} />
          <Row label="PT price" value={market.ptPrice.toFixed(4)} />
          <Row label="Payoff" value={`${quote.payoffRatio.toFixed(4)}×`} />
        </div>

        <Button
          variant="primary"
          size="sm"
          fullWidth
          disabled={blockedByKyc}
          onClick={() => onDeposit(market)}
          className="mt-2"
        >
          {blockedByKyc ? "KYC required" : `Deposit ${market.baseSymbol}`}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="opacity-55">{label}</span>
      <span className="font-mono tabular-nums opacity-90">{value}</span>
    </div>
  );
}
