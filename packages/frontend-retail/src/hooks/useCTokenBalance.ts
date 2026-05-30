import { useState, useEffect, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { reserveCollateralMint } from "../lib/klend";
import { DEVNET_CONFIG } from "../config/devnet";

export interface CTokenBalance {
  /** cToken balance in *cToken-mint* native units (i.e. divided by the
   *  cToken mint's `decimals` — NOT the underlying's). For klend
   *  reserves these don't always match: the wSOL reserve on devnet was
   *  init'd with a 6-decimal cToken mint despite the underlying being
   *  9-decimal wSOL, so this number is the cToken mint's uiAmount. */
  cTokens: number;
  /** Raw on-chain cToken balance (u64), without any decimal scaling.
   *  Use this for back-solving the cToken amount to pass into klend's
   *  redeem ix on a max-withdraw — multiplying `cTokens` by anything
   *  decimal-scaled (LAMPORTS_PER_SOL etc.) silently breaks when the
   *  cToken mint's decimals don't equal the underlying's. */
  cTokensRaw: number;
  /** Underlying value at the current exchange rate, in *underlying*
   *  units (USDC, SOL, …). Computed in raw units throughout, so the
   *  cToken-vs-underlying decimals mismatch can't inflate the display. */
  underlyingValue: number;
  /**
   * Backwards-compatible alias for the USDC-only call sites that
   * pre-date multi-asset wiring. Equal to `underlyingValue`. New code
   * should read `underlyingValue` directly.
   */
  usdcValue: number;
  /** cToken mint address */
  cTokenMint: PublicKey;
  loading: boolean;
  /** Call to immediately refresh the balance */
  refresh: () => void;
}

export interface UseCTokenBalanceArgs {
  /** Reserve account whose cToken we read. Defaults to the USDC reserve. */
  reserve?: PublicKey;
  /** Decimals of the *underlying* asset (not the cToken mint). Used to
   *  scale `underlyingValue` correctly when the reserve's cToken mint
   *  was init'd with a different decimals count than its underlying.
   *  Defaults to 6 (USDC) so existing call sites stay valid. */
  underlyingDecimals?: number;
}

/**
 * User's klend cToken balance for a given reserve, plus the implied
 * underlying value at the latest exchange rate. Defaults to USDC so
 * existing call sites stay valid; pass `{ reserve, underlyingDecimals }`
 * for SOL or any other supplied asset whose underlying decimals differ
 * from USDC's 6.
 */
export function useCTokenBalance(
  exchangeRate: number,
  args: UseCTokenBalanceArgs = {},
): CTokenBalance {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [refreshCount, setRefreshCount] = useState(0);
  const refresh = useCallback(() => setRefreshCount((c) => c + 1), []);
  const reserve = args.reserve ?? DEVNET_CONFIG.market.usdcReserve;
  const underlyingDecimals = args.underlyingDecimals ?? 6;
  const reserveKey = reserve.toBase58();

  const empty: CTokenBalance = {
    cTokens: 0, cTokensRaw: 0, underlyingValue: 0, usdcValue: 0,
    cTokenMint: PublicKey.default, loading: true, refresh,
  };
  const [balance, setBalance] = useState<CTokenBalance>(empty);

  useEffect(() => {
    if (!publicKey || !connected) {
      setBalance({ ...empty, loading: false });
      return;
    }

    const cMint = reserveCollateralMint(reserve);

    const fetchBal = async () => {
      try {
        const ata = getAssociatedTokenAddressSync(cMint, publicKey, false, TOKEN_PROGRAM_ID);
        const bal = await connection.getTokenAccountBalance(ata);
        // Raw u64 from chain — independent of the mint's `decimals` field.
        const cTokensRaw = Number(bal.value.amount);
        const cTokens = Number(bal.value.uiAmount || 0);
        // exchangeRate from useReserveData is raw-underlying-per-raw-cToken
        // (totalLiquidity_raw / cTokenSupply_raw). Multiplying raw cToken
        // amount by it yields raw underlying; THEN divide by underlying
        // decimals to land in user-facing units. Doing the divide via
        // `cTokens * exchangeRate` quietly off-by-1000s when cToken mint
        // decimals ≠ underlying decimals (devnet wSOL: cMint=6, wSOL=9).
        const underlyingValue = (cTokensRaw * exchangeRate) / 10 ** underlyingDecimals;
        setBalance({ cTokens, cTokensRaw, underlyingValue, usdcValue: underlyingValue, cTokenMint: cMint, loading: false, refresh });
      } catch {
        // ATA doesn't exist yet — user hasn't deposited
        setBalance({ cTokens: 0, cTokensRaw: 0, underlyingValue: 0, usdcValue: 0, cTokenMint: cMint, loading: false, refresh });
      }
    };

    fetchBal();
    const interval = setInterval(fetchBal, 15_000);
    return () => clearInterval(interval);
    // reserveKey carries the relevant identity; PublicKey objects are
    // reference-unstable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, connected, connection, exchangeRate, refreshCount, refresh, reserveKey, underlyingDecimals]);

  return balance;
}
