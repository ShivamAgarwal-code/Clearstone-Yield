import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { FixedYieldMarket } from "./useFixedYieldMarkets";

const EDGE_URL = (import.meta as unknown as { env: Record<string, string> })
  .env.VITE_EDGE_URL;

/**
 * A user's position in a specific market. Amounts are strings to
 * survive large-u64 values through JSON without precision loss.
 */
export interface PtPosition {
  market: FixedYieldMarket;
  /** PT balance in base units. */
  ptAmount: string;
  /** YT balance in base units. */
  ytAmount: string;
  /** Next auto-roll timestamp if the user opted in. */
  nextAutoRollTs: number | null;
}

/**
 * Returns the connected wallet's PT positions, joined against the
 * currently-open market list.
 *
 * v0: fixture — mirrors one active position so the UI exercises every
 * state (pre-maturity, near-maturity, matured). v1 swaps to a backend
 * query per (vault, user) via `/fixed-yield/vaults/:id/positions/:user`.
 */
export function usePtPositions(markets: FixedYieldMarket[]): {
  positions: PtPosition[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
} {
  const { publicKey } = useWallet();
  const [state, setState] = useState<{
    positions: PtPosition[];
    loading: boolean;
    error: Error | null;
  }>({ positions: [], loading: false, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!publicKey || markets.length === 0) {
      setState({ positions: [], loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    (async () => {
      // Fixture fallback — if no backend URL, mirror previous behaviour.
      if (!EDGE_URL) {
        const positions = markets
          .filter((m) => !m.kycGated)
          .map((m) => ({
            market: m,
            ptAmount: (100 * 10 ** m.baseDecimals).toString(),
            ytAmount: (100 * 10 ** m.baseDecimals).toString(),
            nextAutoRollTs: null,
          }));
        if (!cancelled) {
          setState({ positions, loading: false, error: null });
        }
        return;
      }

      // Live: one request per vault (markets are per-maturity, but user
      // holdings are per-vault). Dedupe by vault pubkey.
      const byVault = new Map<string, FixedYieldMarket>();
      for (const m of markets) {
        byVault.set(m.vault.toBase58(), m);
      }
      const user = publicKey.toBase58();

      try {
        const results = await Promise.all(
          [...byVault.entries()].map(async ([vault, m]) => {
            const res = await fetch(
              `${EDGE_URL}/fixed-yield/vaults/${vault}/positions/${user}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as {
              position: {
                ptAmount: string;
                ytAmount: string;
                lpAmount: string;
                nextAutoRollTs: number | null;
              };
            };
            return { m, position: body.position };
          })
        );
        if (cancelled) return;
        const positions = results
          .filter(
            ({ position }) =>
              position.ptAmount !== "0" || position.ytAmount !== "0"
          )
          .map(({ m, position }) => ({
            market: m,
            ptAmount: position.ptAmount,
            ytAmount: position.ytAmount,
            nextAutoRollTs: position.nextAutoRollTs,
          }));
        setState({ positions, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          positions: [],
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey?.toBase58(), markets.map((m) => m.id).join(","), nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
