import { useState } from "react";
import { Button } from "./Button";

/**
 * Shorten a base58 signature for display in a toast `detail` line —
 * enough characters on each end that the user can sanity-check the sig
 * matches what they see in the explorer without breaking the toast's
 * fixed-width layout.
 */
export function shortSig(sig: string): string {
  if (sig.length <= 22) return sig;
  return `${sig.slice(0, 12)}…${sig.slice(-8)}`;
}

export interface TxActionButtonsProps {
  /** Base58 transaction signature to link / copy. */
  sig: string;
  /** Solana cluster — drives the explorer URL. Defaults to devnet
   *  since both retail + institutional apps run on devnet today. */
  cluster?: "devnet" | "testnet" | "mainnet-beta";
}

/**
 * Two-button cluster meant for a tx-success Snackbar's `action` slot —
 * an "Explorer ↗" anchor (proper `<a>` so middle-click / cmd-click /
 * right-click all work) and a "Copy sig" fallback for sharing the full
 * signature into a support thread or a manual explorer search.
 *
 * Lives here in the design-system so every product surface that
 * surfaces tx results (retail, institutional, console, deck) renders
 * the same shape. Pair with `<Snackbar variant="toast" />` and
 * `shortSig(sig)` in the `detail` slot.
 */
export function TxActionButtons({ sig, cluster = "devnet" }: TxActionButtonsProps) {
  const [copied, setCopied] = useState(false);
  const explorerUrl =
    cluster === "mainnet-beta"
      ? `https://explorer.solana.com/tx/${sig}`
      : `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
  return (
    <div className="flex items-center gap-1.5">
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-base-300 bg-base-200 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-base-content/80 transition-colors hover:bg-base-300 hover:text-base-content"
        title="Open transaction on Solana Explorer"
      >
        Explorer
        <svg
          className="h-3 w-3 -mt-0.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14 4h6v6M20 4l-9 9M5 5h6M5 5v14h14v-6" />
        </svg>
      </a>
      <Button
        size="xs"
        variant="ghost"
        onClick={async () => {
          try {
            if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(sig);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked — silent */
          }
        }}
      >
        {copied ? "Copied ✓" : "Copy sig"}
      </Button>
    </div>
  );
}
