import { Connection, PublicKey } from "@solana/web3.js";
import { useRollDelegation } from "../hooks/useRollDelegation";
import type { CuratorVaultPosition } from "../hooks/useCuratorVaults";

interface Props {
  position: CuratorVaultPosition;
  user: PublicKey;
  connection: Connection;
  onRevoke: () => void;
}

/**
 * Renders a single curator-vault position with delegation status +
 * revoke action. The delegation status is a direct on-chain read
 * (no backend hop) so the UI reflects revokes instantly.
 */
export function CuratorPositionCard({
  position,
  user,
  connection,
  onRevoke,
}: Props) {
  const { vault, shares, baseValue } = position;
  const div = 10 ** vault.baseDecimals;
  const sharesHuman = (Number(BigInt(shares)) / div).toLocaleString(
    undefined,
    { maximumFractionDigits: 4 }
  );
  const valueHuman = (Number(BigInt(baseValue)) / div).toLocaleString(
    undefined,
    { maximumFractionDigits: 4 }
  );

  const { info: delegation, loading } = useRollDelegation(
    connection,
    vault.vault,
    user
  );

  let delegationLabel = "Off";
  let delegationDetail: string | null = null;
  if (loading) {
    delegationLabel = "…";
  } else if (delegation?.exists && delegation.expiresAtSlot) {
    // Estimate days-until-expiry. 0.4s/slot; current slot unknown
    // client-side without another RPC hop, so use the total TTL span
    // (created_at not parsed here — that's the v1.1 extension).
    const slippage = (delegation.maxSlippageBps ?? 0) / 100;
    delegationLabel = "On";
    delegationDetail = `${slippage.toFixed(2)}% slippage cap`;
  }

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-base">{vault.label}</h3>
          <div className="flex items-center gap-2">
            <span
              className={`badge badge-sm ${
                delegation?.exists ? "badge-success" : "badge-ghost"
              }`}
            >
              Auto-roll: {delegationLabel}
            </span>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="opacity-60">Shares</div>
            <div className="font-mono text-lg">{sharesHuman}</div>
          </div>
          <div>
            <div className="opacity-60">Value</div>
            <div className="font-mono text-lg">
              {valueHuman} {vault.baseSymbol}
            </div>
          </div>
        </div>

        {delegationDetail && (
          <p className="text-xs opacity-70 mt-2">{delegationDetail}</p>
        )}

        {delegation?.exists && (
          <button
            type="button"
            className="btn btn-xs btn-ghost mt-3"
            onClick={onRevoke}
          >
            Revoke auto-roll
          </button>
        )}

        {/* TODO: withdraw flow — wire buildCuratorWithdraw when the
            backend returns the idle-liquidity cap so we can warn on
            insufficient escrow. */}
      </div>
    </div>
  );
}
