import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";

const EDGE_URL = (import.meta as unknown as { env: Record<string, string> })
  .env.VITE_EDGE_URL;

export interface CuratorVaultAllocation {
  market: PublicKey;
  weightBps: number;
  deployedBase: string;
}

/**
 * Curator auto-roll vault — the "savings account" product. User
 * deposits base, holds shares; curator rebalances across underlying
 * PT markets so rollovers happen automatically at each maturity.
 */
export interface CuratorVault {
  id: string;
  label: string;
  baseSymbol: string;
  baseMint: PublicKey;
  baseDecimals: number;
  kycGated: boolean;

  vault: PublicKey;
  curator: PublicKey;
  baseEscrow: PublicKey;

  totalAssets: string;
  totalShares: string;
  feeBps: number;
  nextAutoRollTs: number | null;

  allocations: CuratorVaultAllocation[];
}

/**
 * Fetches curator vaults from `${EDGE_URL}/fixed-yield/curator-vaults`.
 * Returns an empty list (not an error) if the env var is unset or the
 * backend hasn't been configured — keeps dev UX smooth.
 */
export function useCuratorVaults(): {
  vaults: CuratorVault[];
  loading: boolean;
  error: Error | null;
} {
  const [state, setState] = useState<{
    vaults: CuratorVault[];
    loading: boolean;
    error: Error | null;
  }>({ vaults: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!EDGE_URL) {
        setState({ vaults: [], loading: false, error: null });
        return;
      }

      try {
        const res = await fetch(`${EDGE_URL}/fixed-yield/curator-vaults`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          vaults: Array<{
            id: string;
            label: string;
            baseSymbol: string;
            baseMint: string;
            baseDecimals: number;
            kycGated: boolean;
            vault: string;
            curator: string;
            baseEscrow: string;
            totalAssets: string;
            totalShares: string;
            feeBps: number;
            nextAutoRollTs: number | null;
            allocations: Array<{
              market: string;
              weightBps: number;
              deployedBase: string;
            }>;
          }>;
        };
        if (cancelled) return;
        const vaults: CuratorVault[] = body.vaults.map((v) => ({
          ...v,
          baseMint: new PublicKey(v.baseMint),
          vault: new PublicKey(v.vault),
          curator: new PublicKey(v.curator),
          baseEscrow: new PublicKey(v.baseEscrow),
          allocations: v.allocations.map((a) => ({
            market: new PublicKey(a.market),
            weightBps: a.weightBps,
            deployedBase: a.deployedBase,
          })),
        }));
        setState({ vaults, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState({
          vaults: [],
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export interface CuratorVaultPosition {
  vault: CuratorVault;
  shares: string;
  baseValue: string;
  nextAutoRollTs: number | null;
}

/**
 * Fetches the connected wallet's per-vault share balance for each
 * curator vault. One request per vault — dedupe happens server-side
 * by PDA.
 */
export function useCuratorVaultPositions(
  vaults: CuratorVault[],
  user: PublicKey | null
): {
  positions: CuratorVaultPosition[];
  loading: boolean;
  error: Error | null;
} {
  const [state, setState] = useState<{
    positions: CuratorVaultPosition[];
    loading: boolean;
    error: Error | null;
  }>({ positions: [], loading: false, error: null });

  useEffect(() => {
    if (!user || vaults.length === 0 || !EDGE_URL) {
      setState({ positions: [], loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    (async () => {
      try {
        const results = await Promise.all(
          vaults.map(async (v) => {
            const res = await fetch(
              `${EDGE_URL}/fixed-yield/curator-vaults/${v.vault.toBase58()}/positions/${user.toBase58()}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as {
              position: {
                shares: string;
                baseValue: string;
                nextAutoRollTs: number | null;
              };
            };
            return { v, position: body.position };
          })
        );
        if (cancelled) return;
        const positions = results
          .filter(({ position }) => position.shares !== "0")
          .map(({ v, position }) => ({
            vault: v,
            shares: position.shares,
            baseValue: position.baseValue,
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
  }, [user?.toBase58(), vaults.map((v) => v.id).join(",")]);

  return state;
}
