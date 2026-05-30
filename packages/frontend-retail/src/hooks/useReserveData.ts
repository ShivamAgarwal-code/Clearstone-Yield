import { useState, useEffect, useCallback } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_CONFIG } from "../config/devnet";
import { decodeReserveInfo, reserveCollateralMint } from "../lib/klend";

export interface ReserveData {
  supplyAPY: number;
  exchangeRate: number;
  cTokenMint: string;
  totalDeposited: number;
  utilization: number;
  loading: boolean;
  /** Manual on-demand refresh — call after a deposit/withdraw lands so
   *  TVL + supply APY surfaces update immediately instead of waiting
   *  for the 30s background poll. */
  refresh: () => void;
}

export interface UseReserveDataArgs {
  /** Reserve account PDA. Defaults to the USDC reserve on the stables market. */
  reserve?: PublicKey;
  /** Underlying decimals — used to render `availableAmount` / `borrowedAmount`. */
  decimals?: number;
}

/**
 * Live klend reserve metrics. Polls the on-chain account every 30s and
 * decodes supply APY, exchange rate (cToken → underlying), TVL, and
 * utilization. Also exposes a manual `refresh()` for callers (deposit
 * / withdraw card) that just landed a tx and want the dashboard to
 * reflect the new state without the 30s polling lag.
 *
 * Defaults to the USDC reserve so existing call sites keep working;
 * pass `{ reserve, decimals }` to read SOL or any other reserve.
 */
export function useReserveData(args: UseReserveDataArgs = {}): ReserveData {
  const { connection } = useConnection();
  const reserve = args.reserve ?? DEVNET_CONFIG.market.usdcReserve;
  const decimals = args.decimals ?? DEVNET_CONFIG.usdc.decimals;
  const reserveKey = reserve.toBase58();

  const [data, setData] = useState<Omit<ReserveData, "refresh">>({
    supplyAPY: 0,
    exchangeRate: 1,
    cTokenMint: "",
    totalDeposited: 0,
    utilization: 0,
    loading: true,
  });

  // Stable fetch callback — depends only on the address-as-string and
  // decimals so the identity stays stable across renders. Also serves
  // as the public `refresh` exposed below.
  const fetchOnce = useCallback(async () => {
    const cMint = reserveCollateralMint(reserve);
    const scale = 10 ** decimals;
    try {
      const info = await connection.getAccountInfo(reserve);
      if (!info) return;
      const decoded = decodeReserveInfo(info.data as Buffer);
      if (!decoded) return;
      const available = Number(decoded.availableAmount) / scale;
      const borrowed = Number(decoded.borrowedAmountSf >> 60n) / scale;
      const total = available + borrowed;
      const util = total > 0 ? borrowed / total : 0;
      setData({
        supplyAPY: decoded.supplyAPY,
        exchangeRate: decoded.exchangeRate,
        cTokenMint: cMint.toBase58(),
        totalDeposited: total,
        utilization: util,
        loading: false,
      });
    } catch (e) {
      console.warn(`Failed to fetch reserve data (${reserveKey.slice(0, 8)}…):`, e);
      setData((prev) => ({ ...prev, loading: false }));
    }
    // Identity governed by reserveKey + decimals + connection — `reserve`
    // is a PublicKey object which is reference-unstable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, reserveKey, decimals]);

  useEffect(() => {
    fetchOnce();
    const interval = setInterval(fetchOnce, 30_000);
    return () => clearInterval(interval);
  }, [fetchOnce]);

  return { ...data, refresh: fetchOnce };
}
