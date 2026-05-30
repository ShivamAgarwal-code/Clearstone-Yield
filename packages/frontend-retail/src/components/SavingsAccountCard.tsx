import { useMemo } from "react";
import type { CuratorVault } from "../hooks/useCuratorVaults";

interface Props {
  vault: CuratorVault;
  onDeposit: (v: CuratorVault) => void;
}

/**
 * "Savings account" card — auto-roll product driven by a curator vault.
 * Distinct from MarketCard (which shows a single maturity): this shows
 * current NAV yield estimate + next rebalance countdown.
 */
export function SavingsAccountCard({ vault, onDeposit }: Props) {
  const nowTs = Math.floor(Date.now() / 1000);

  const {
    nextRollLabel,
    utilizationPct,
    navPerShare,
  } = useMemo(() => {
    const totalAssets = BigInt(vault.totalAssets);
    const totalShares = BigInt(vault.totalShares);
    const divisor = 10 ** vault.baseDecimals;

    const nav =
      totalShares > 0n
        ? Number((totalAssets * 10_000n) / totalShares) / 10_000
        : 1.0;

    const deployed = vault.allocations.reduce(
      (s, a) => s + Number(BigInt(a.deployedBase)),
      0
    );
    const util =
      totalAssets > 0n ? (deployed / Number(totalAssets)) * 100 : 0;

    let rollLabel = "—";
    if (vault.nextAutoRollTs && vault.nextAutoRollTs > nowTs) {
      const days = Math.round((vault.nextAutoRollTs - nowTs) / 86400);
      rollLabel = `${days}d`;
    } else if (vault.nextAutoRollTs) {
      rollLabel = "due";
    }

    return {
      nextRollLabel: rollLabel,
      utilizationPct: util,
      navPerShare: nav / divisor,
    };
  }, [vault, nowTs]);

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-base">{vault.label}</h3>
          <span className="badge badge-sm badge-accent">Auto-roll</span>
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-mono font-semibold">
            {navPerShare.toFixed(4)}
          </span>
          <span className="text-xs opacity-70">{vault.baseSymbol} / share</span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs opacity-80">
          <div>
            <div className="opacity-60">Next rebalance</div>
            <div className="font-mono">{nextRollLabel}</div>
          </div>
          <div>
            <div className="opacity-60">Utilization</div>
            <div className="font-mono">{utilizationPct.toFixed(1)}%</div>
          </div>
          <div>
            <div className="opacity-60">Fee</div>
            <div className="font-mono">
              {(vault.feeBps / 100).toFixed(2)}%
            </div>
          </div>
          <div>
            <div className="opacity-60">Allocations</div>
            <div className="font-mono">{vault.allocations.length}</div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onDeposit(vault)}
          className="btn btn-primary btn-sm mt-4"
        >
          Deposit {vault.baseSymbol}
        </button>
      </div>
    </div>
  );
}
