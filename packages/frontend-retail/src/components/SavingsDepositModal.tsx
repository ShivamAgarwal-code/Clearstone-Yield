import { useMemo, useState } from "react";
import BN from "bn.js";
import { fixedYield } from "@delta/calldata-sdk-solana";
import { Input } from "@clearstone/design-system";
import type { CuratorVault } from "../hooks/useCuratorVaults";

export interface SavingsDepositSubmission {
  vault: CuratorVault;
  amountBase: BN;
  /** When true, the deposit tx includes a `create_delegation` ix. */
  enableAutoRoll: boolean;
  /** Slippage cap for the delegation, bps. Only meaningful when enableAutoRoll. */
  maxSlippageBps: number;
  /** Delegation lifetime in slots. Only meaningful when enableAutoRoll. */
  ttlSlots: number;
}

interface Props {
  vault: CuratorVault | null;
  onClose: () => void;
  onSubmit: (args: SavingsDepositSubmission) => void;
  submitting?: boolean;
}

const DEFAULTS = fixedYield.delegation.RETAIL_DELEGATION_DEFAULTS;

const TTL_PRESETS = [
  { label: "7 days", slots: 1_512_000 },
  { label: "30 days", slots: 6_480_000 },
  { label: "100 days", slots: 21_600_000 },
] as const;

const SLIPPAGE_PRESETS = [
  { label: "0.1%", bps: 10 },
  { label: "0.5%", bps: 50 },
  { label: "1.0%", bps: 100 },
] as const;

/**
 * Deposit-into-savings-account modal. Adds an "enable auto-roll"
 * toggle that, when on, bundles a `create_delegation` ix alongside
 * the `deposit` ix — single signature, auto-roll on.
 */
export function SavingsDepositModal({
  vault,
  onClose,
  onSubmit,
  submitting,
}: Props) {
  const [amountStr, setAmountStr] = useState("");
  const [enableAutoRoll, setEnableAutoRoll] = useState(true);
  const [maxSlippageBps, setMaxSlippageBps] = useState<number>(
    DEFAULTS.maxSlippageBps
  );
  const [ttlSlots, setTtlSlots] = useState<number>(DEFAULTS.ttlSlots);

  const amountBase = useMemo<BN | null>(() => {
    if (!vault) return null;
    const n = Number.parseFloat(amountStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    const units = BigInt(Math.round(n * Math.pow(10, vault.baseDecimals)));
    return new BN(units.toString());
  }, [amountStr, vault]);

  const expectedShares = useMemo(() => {
    if (!vault || !amountBase) return null;
    const totalAssets = BigInt(vault.totalAssets);
    const totalShares = BigInt(vault.totalShares);
    if (totalAssets === 0n || totalShares === 0n) {
      return amountBase.toString();
    }
    const amt = BigInt(amountBase.toString());
    return ((amt * totalShares) / totalAssets).toString();
  }, [vault, amountBase]);

  if (!vault) return null;

  const ttlDays = Math.round(ttlSlots * 0.4 / 86_400);
  const slippagePct = (maxSlippageBps / 100).toFixed(2);

  return (
    <div className="modal modal-open" role="dialog">
      <div className="modal-box max-w-md">
        <h3 className="font-bold text-lg">Deposit into {vault.label}</h3>
        <p className="text-sm opacity-70 mt-1">
          The curator rebalances across PT markets; your position auto-rolls
          at each maturity. Withdraw any time up to the vault's idle
          liquidity.
        </p>

        <div className="mt-4">
          <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-base-content/55 mb-2">
            Amount ({vault.baseSymbol})
          </label>
          <Input
            inputSize="md"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0.00"
            numeric
          />
        </div>

        <div className="mt-4 rounded-lg bg-base-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="opacity-70">Curator fee</span>
            <span className="font-mono">
              {(vault.feeBps / 100).toFixed(2)}%
            </span>
          </div>
          <div className="flex justify-between mt-1">
            <span className="opacity-70">Shares minted</span>
            <span className="font-mono">{expectedShares ?? "—"}</span>
          </div>
        </div>

        {/* Auto-roll section */}
        <div className="mt-4 rounded-lg border border-base-300 p-3">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="label-text">Enable permissionless auto-roll</span>
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={enableAutoRoll}
              onChange={(e) => setEnableAutoRoll(e.target.checked)}
              disabled={submitting}
            />
          </label>
          <p className="text-xs opacity-70 mt-1">
            Sign a user-bounded delegation alongside this deposit so any keeper
            can crank rolls on your behalf. You can revoke any time.
          </p>

          {enableAutoRoll && (
            <div className="mt-3 space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="opacity-70">Max slippage per roll</span>
                  <span className="font-mono">{slippagePct}%</span>
                </div>
                <div className="flex gap-1 mt-1">
                  {SLIPPAGE_PRESETS.map((p) => (
                    <button
                      key={p.bps}
                      type="button"
                      disabled={submitting}
                      onClick={() => setMaxSlippageBps(p.bps)}
                      className={`btn btn-xs flex-1 ${
                        maxSlippageBps === p.bps
                          ? "btn-primary"
                          : "btn-ghost"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <span className="opacity-70">Delegation lifetime</span>
                  <span className="font-mono">{ttlDays}d</span>
                </div>
                <div className="flex gap-1 mt-1">
                  {TTL_PRESETS.map((p) => (
                    <button
                      key={p.slots}
                      type="button"
                      disabled={submitting}
                      onClick={() => setTtlSlots(p.slots)}
                      className={`btn btn-xs flex-1 ${
                        ttlSlots === p.slots ? "btn-primary" : "btn-ghost"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-xs opacity-60">
                Keepers can roll you only into markets the curator has already
                whitelisted, with slippage capped at {slippagePct}%. Delegation
                expires in {ttlDays} days; re-sign to extend.
              </p>
            </div>
          )}
        </div>

        <div className="modal-action">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!amountBase || submitting}
            onClick={() =>
              amountBase &&
              onSubmit({
                vault,
                amountBase,
                enableAutoRoll,
                maxSlippageBps,
                ttlSlots,
              })
            }
          >
            {submitting ? "Submitting…" : "Deposit"}
          </button>
        </div>
      </div>
      <div
        className="modal-backdrop"
        role="button"
        tabIndex={0}
        onClick={submitting ? undefined : onClose}
        onKeyDown={(e) =>
          (e.key === "Escape" || e.key === "Enter") &&
          !submitting &&
          onClose()
        }
      />
    </div>
  );
}
