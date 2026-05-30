import { useMemo, useState } from "react";
import { fixedYield } from "@delta/calldata-sdk-solana";
import BN from "bn.js";
import {
  Badge,
  Button,
  Input,
  TokenIcon,
  type TokenSymbol,
} from "@clearstone/design-system";
import type { FixedYieldMarket } from "../hooks/useFixedYieldMarkets";

interface Props {
  market: FixedYieldMarket | null;
  /** User's wallet balance in human units (UI decimals already applied). */
  walletBalance?: number | null;
  onClose: () => void;
  /** Caller implements wallet signing + RPC dispatch. */
  onSubmit: (args: { market: FixedYieldMarket; amountBase: BN }) => void;
  submitting?: boolean;
}

/**
 * Deposit-into-PT modal.
 *
 * Reframed per the port doc (clearstone-fixed-yield/PORT_TO_CLEARSTONE_FINANCE.md §5.3):
 *
 *   - Don't show raw `trade_pt` numbers. Frame as "Deposit X → receive
 *     Y at maturity / Fixed yield Z% (≈APY%)".
 *   - Show the discount in retail-friendly terms (X% over face).
 *   - 1% max slippage cap surfaced explicitly.
 *
 * The on-chain quote freshness is whatever the caller's snapshot is —
 * once the `/fixed-yield/quote` endpoint lands we'll wire it here for
 * a live AMM-simulated quote with the slippage check enforced.
 */
const SLIPPAGE_CAP_PCT = 1.0;

export function DepositPtModal({
  market,
  walletBalance,
  onClose,
  onSubmit,
  submitting,
}: Props) {
  const [amountStr, setAmountStr] = useState("");

  const amountBase = useMemo<BN | null>(() => {
    if (!market) return null;
    const n = Number.parseFloat(amountStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    const units = BigInt(Math.round(n * Math.pow(10, market.baseDecimals)));
    return new BN(units.toString());
  }, [amountStr, market]);

  const nowTs = Math.floor(Date.now() / 1000);
  const quote = useMemo(() => {
    if (!market || !amountBase) return null;
    return fixedYield.quote.quoteTermDeposit(
      {
        ptPrice: market.ptPrice,
        maturityTs: market.maturityTs,
        nowTs,
        syExchangeRate: market.syExchangeRate,
      },
      amountBase
    );
  }, [market, amountBase, nowTs]);

  if (!market) return null;

  const amountNum = Number.parseFloat(amountStr) || 0;
  const payoffNum = quote
    ? Number(quote.amountBaseOutAtMaturity.toString()) /
      Math.pow(10, market.baseDecimals)
    : 0;
  const payoffDelta = payoffNum - amountNum;

  const fmt = (n: number, dp = 4) =>
    n.toLocaleString(undefined, { maximumFractionDigits: dp });

  const maturityDate = new Date(market.maturityTs * 1000);
  const daysToMaturity = Math.max(
    0,
    Math.round((market.maturityTs - nowTs) / 86400),
  );
  const overBalance =
    walletBalance != null && amountNum > walletBalance && amountNum > 0;

  return (
    <div className="modal modal-open" role="dialog">
      <div className="modal-box max-w-md bg-base-200 border border-base-300">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <TokenIcon symbol={market.baseSymbol as TokenSymbol} size="md" />
            <div className="min-w-0">
              <span className="eyebrow opacity-60" style={{ fontSize: "0.625rem" }}>
                Term deposit
              </span>
              <h3 className="font-display text-lg font-medium truncate">
                {market.label}
              </h3>
            </div>
          </div>
          <Badge tone="warning" variant="soft" size="xs">
            Locks until {maturityDate.toLocaleDateString()}
          </Badge>
        </div>

        <p className="text-xs opacity-65 mb-4 leading-relaxed">
          Deposit {market.baseSymbol} now, redeem at maturity for a fixed
          payout. You can exit early at the prevailing PT price on the AMM —
          the quoted APY assumes you hold to maturity.
        </p>

        <label className="block">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-base-content/55 mb-2">
            Deposit amount ({market.baseSymbol})
          </div>
          <Input
            inputSize="lg"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0.00"
            numeric
            addonRight={
              walletBalance != null && walletBalance > 0 ? (
                <button
                  type="button"
                  onClick={() => setAmountStr(String(walletBalance))}
                  className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary hover:text-primary-content hover:bg-primary px-2 py-1 -mx-1 rounded-md transition-colors cursor-pointer"
                >
                  MAX
                </button>
              ) : undefined
            }
          />
          {walletBalance != null ? (
            <div className="text-[11px] text-base-content/50 mt-2 text-right tabular-nums">
              Wallet: {fmt(walletBalance, 4)} {market.baseSymbol}
            </div>
          ) : null}
        </label>

        {/* Headline payoff panel — port doc §5.3 framing. */}
        <div
          className="mt-4 rounded-lg px-4 py-3 border border-success/30"
          style={{
            background:
              "linear-gradient(135deg, rgba(79,176,136,0.10) 0%, rgba(79,176,136,0.02) 100%)",
          }}
        >
          <div className="eyebrow text-success/90 mb-1" style={{ fontSize: "0.625rem" }}>
            Receive at maturity
          </div>
          <div className="flex items-baseline gap-2">
            <span className="figure tabular-nums text-2xl text-success">
              {amountNum > 0 ? fmt(payoffNum, 4) : "—"} {market.baseSymbol}
            </span>
            {amountNum > 0 ? (
              <span className="text-xs opacity-70 font-mono">
                (+{fmt(payoffDelta, 4)})
              </span>
            ) : null}
          </div>
          <div className="text-[11px] opacity-65 mt-1">
            {quote && amountNum > 0
              ? `Fixed yield ${((payoffDelta / amountNum) * 100).toFixed(2)}% · ≈${(quote.apy * 100).toFixed(2)}% APY · ${daysToMaturity}d term`
              : "Enter an amount above to see the payoff"}
          </div>
        </div>

        {/* Compact tx-summary footer */}
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Row label="Maturity" value={maturityDate.toLocaleDateString()} />
          <Row label="Term" value={`${daysToMaturity}d`} />
          <Row label="PT price" value={market.ptPrice.toFixed(4)} />
          <Row
            label="Slippage cap"
            value={`${SLIPPAGE_CAP_PCT.toFixed(1)}%`}
            hint="max deviation from quoted PT price"
          />
        </div>

        {overBalance ? (
          <div className="mt-3 text-xs text-error">
            Insufficient {market.baseSymbol} balance — wallet has{" "}
            {fmt(walletBalance ?? 0, 4)}.
          </div>
        ) : null}

        <div className="modal-action mt-5">
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={submitting}
            disabled={!amountBase || overBalance}
            onClick={() => amountBase && onSubmit({ market, amountBase })}
          >
            Deposit {market.baseSymbol}
          </Button>
        </div>
      </div>
      <div
        className="modal-backdrop"
        role="button"
        tabIndex={0}
        onClick={submitting ? undefined : onClose}
        onKeyDown={(e) =>
          (e.key === "Escape" || e.key === "Enter") && !submitting && onClose()
        }
      />
    </div>
  );
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={hint}>
      <span className="opacity-55">{label}</span>
      <span className="font-mono tabular-nums opacity-90">{value}</span>
    </div>
  );
}
