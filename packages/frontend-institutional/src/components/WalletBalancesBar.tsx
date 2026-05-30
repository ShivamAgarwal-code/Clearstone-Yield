import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Badge,
  TokenIcon,
  cn,
} from "@clearstone/design-system";

import { useWalletBalances } from "../hooks/useWalletBalances";
import BalanceIcon from "./BalanceIcon";

/**
 * Wallet balances head bar — renders above the page content on every
 * authenticated tab.
 *
 *   * Collapsed (default): aggregate USD total + a horizontal stack of
 *     token icons for everything the user actually holds (zeros are
 *     hidden). Single line, low ink.
 *   * Expanded: the same icons rendered as a per-token grid showing the
 *     ticker, amount, and USD value of each position.
 *
 * The component owns its own fetch via `useWalletBalances` so any tab
 * can render the bar without prop-drilling balances. Action pages keep
 * their own balance state for now (they need it tightly coupled to
 * action handlers); this bar is purely a passive readout.
 */
export default function WalletBalancesBar() {
  const { connected } = useWallet();
  const { nonZero, totalUsd, loading } = useWalletBalances();
  const [open, setOpen] = useState(false);

  if (!connected) return null;

  return (
    <div className="bg-base-200/70 border-b border-base-300 backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-6">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "flex items-center justify-between w-full gap-4 py-3",
            "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/50 rounded",
          )}
        >
          <div className="flex items-center gap-4 min-w-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-base-content/55">
              Wallet
            </span>
            <span className="font-display font-medium text-lg tabular-nums tracking-[-0.02em] text-base-content leading-none">
              {loading && nonZero.length === 0 ? "—" : `$${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-base-content/45 leading-none">
              total
            </span>

            {nonZero.length > 0 && (
              <div className="hidden sm:flex items-center pl-3 ml-1 border-l border-base-300/70">
                <div className="flex items-center -space-x-2">
                  {nonZero.slice(0, 6).map((b) => (
                    <BalanceIcon key={b.symbol} symbol={b.symbol} size="xs" />
                  ))}
                </div>
                {nonZero.length > 6 && (
                  <span className="ml-3 text-[11px] font-mono tabular-nums text-base-content/55">
                    +{nonZero.length - 6}
                  </span>
                )}
              </div>
            )}
            {!loading && nonZero.length === 0 && (
              <span className="text-xs text-base-content/45">No balances</span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge tone="neutral" variant="soft" size="xs">
              {nonZero.length} {nonZero.length === 1 ? "asset" : "assets"}
            </Badge>
            <span
              aria-hidden
              className={cn(
                "inline-flex items-center justify-center h-5 w-5 rounded text-base-content/45",
                "transition-transform duration-200",
                open && "rotate-180",
              )}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
        </button>

        {open && (
          <div className="pb-4 -mt-1">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2">
              {nonZero.length === 0 ? (
                <div className="col-span-full text-xs text-base-content/45 py-3">
                  Connected wallet holds no supported tokens.
                </div>
              ) : (
                nonZero.map((b) => (
                  <BalanceChip key={b.symbol} balance={b} />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BalanceChip({
  balance,
}: {
  balance: { symbol: import("@clearstone/design-system").TokenSymbol; amount: number; priceUsd: number; displayDecimals: number };
}) {
  const usd = balance.amount * balance.priceUsd;
  const formatted = balance.amount.toLocaleString(undefined, {
    minimumFractionDigits: balance.displayDecimals,
    maximumFractionDigits: balance.displayDecimals,
  });
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2",
        "bg-base-200 border border-base-300/70",
        "transition-[border-color,box-shadow] duration-200 hover:border-base-content/15 hover:shadow-[var(--shadow-stone)]",
      )}
    >
      <BalanceIcon symbol={balance.symbol} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-base-content/55 leading-none">
          {balance.symbol}
        </div>
        <div className="font-display font-medium text-sm tabular-nums tracking-[-0.01em] text-base-content leading-tight mt-1 truncate">
          {formatted}
        </div>
        <div className="text-[10px] font-mono tabular-nums text-base-content/45 leading-none mt-0.5">
          ${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
    </div>
  );
}
