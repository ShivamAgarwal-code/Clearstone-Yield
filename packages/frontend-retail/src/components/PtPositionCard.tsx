import { useMemo } from "react";
import BN from "bn.js";
import type { PtPosition } from "../hooks/usePtPositions";

interface Props {
  position: PtPosition;
  onRedeem: (p: PtPosition, amountPy: BN) => void;
  redeeming?: boolean;
}

/**
 * A single PT+YT position row with a Redeem action.
 *
 * Before maturity, "Redeem" burns matched PT+YT for the underlying
 * (via core.merge → adapter.redeem_sy). After maturity the same path
 * still works — YT is zero-valued and the merge drains PT at the
 * frozen final_sy_exchange_rate.
 */
export function PtPositionCard({ position, onRedeem, redeeming }: Props) {
  const { market, ptAmount, ytAmount } = position;

  const nowTs = Math.floor(Date.now() / 1000);
  const matured = nowTs >= market.maturityTs;
  const daysToMaturity = Math.max(
    0,
    Math.round((market.maturityTs - nowTs) / 86400)
  );

  const { ptHuman, ytHuman, redeemAmount } = useMemo(() => {
    const pt = new BN(ptAmount);
    const yt = new BN(ytAmount);
    const divisor = 10 ** market.baseDecimals;
    const toHuman = (b: BN) =>
      (Number(b.toString()) / divisor).toLocaleString(undefined, {
        maximumFractionDigits: 4,
      });
    // Pre-maturity: redeem min(PT, YT) since merge burns matched amounts.
    // Post-maturity: redeem full PT balance (YT is worthless).
    const amt = matured ? pt : BN.min(pt, yt);
    return {
      ptHuman: toHuman(pt),
      ytHuman: toHuman(yt),
      redeemAmount: amt,
    };
  }, [ptAmount, ytAmount, market.baseDecimals, matured]);

  const maturityLabel = new Date(market.maturityTs * 1000).toLocaleDateString();

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-base">{market.label}</h3>
          {matured ? (
            <span className="badge badge-sm badge-success">Matured</span>
          ) : (
            <span className="badge badge-sm">{daysToMaturity}d left</span>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="opacity-60">PT balance</div>
            <div className="font-mono text-lg">{ptHuman}</div>
          </div>
          <div>
            <div className="opacity-60">YT balance</div>
            <div className="font-mono text-lg">{ytHuman}</div>
          </div>
          <div className="col-span-2">
            <div className="opacity-60">Matures</div>
            <div className="font-mono">{maturityLabel}</div>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-sm mt-4"
          disabled={redeemAmount.isZero() || redeeming}
          onClick={() => onRedeem(position, redeemAmount)}
        >
          {redeeming
            ? "Redeeming…"
            : matured
              ? `Redeem ${market.baseSymbol}`
              : `Redeem ${market.baseSymbol} (early exit)`}
        </button>
      </div>
    </div>
  );
}
