import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { TokenSymbol } from "@clearstone/design-system";

import { DEVNET_CONFIG } from "../config/devnet";

/**
 * Wallet-balance context — fetched once at the app root, consumed by:
 *   - `<WalletBalancesBar>` (head bar across every authenticated tab),
 *   - `useTokenBalance(symbol)` for hover-tooltips on every TokenIcon,
 *   - any future panel that wants the canonical wallet snapshot.
 *
 * Action pages still keep their own per-page balance fetch for now —
 * they need it tightly coupled to action handlers — but anything that
 * just needs *display* should read from this context.
 */

const SOLSTICE_USDC = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const SOLSTICE_USDT = new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft");
const USX_MINT     = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const EUSX_MINT    = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const CEUSX_MINT   = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

interface SplTokenSpec {
  symbol: TokenSymbol;
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  priceUsd: number;
}

const SPL_TOKENS: SplTokenSpec[] = [
  { symbol: "USDC",  mint: SOLSTICE_USDC, tokenProgram: TOKEN_PROGRAM_ID,      decimals: 6, priceUsd: 1.00 },
  { symbol: "USDT",  mint: SOLSTICE_USDT, tokenProgram: TOKEN_PROGRAM_ID,      decimals: 6, priceUsd: 1.00 },
  { symbol: "USX",   mint: USX_MINT,      tokenProgram: TOKEN_PROGRAM_ID,      decimals: 6, priceUsd: 1.00 },
  { symbol: "eUSX",  mint: EUSX_MINT,     tokenProgram: TOKEN_PROGRAM_ID,      decimals: 6, priceUsd: 1.08 },
  { symbol: "ceUSX", mint: CEUSX_MINT,    tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6, priceUsd: 1.08 },
];

const SOL_PRICE_USD = 84;

export interface TokenBalance {
  symbol: TokenSymbol;
  amount: number;
  priceUsd: number;
  /** Display decimals — 2 for stables, 4 for SOL family. */
  displayDecimals: number;
}

export interface WalletBalances {
  loading: boolean;
  balances: TokenBalance[];
  /** Filter convenience — non-zero positions only (≥ 0.0001 to ignore dust). */
  nonZero: TokenBalance[];
  /** Aggregate USD value across every supported balance. */
  totalUsd: number;
  /** Re-fetch (e.g. after a deposit / borrow / swap completes). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<WalletBalances | null>(null);

export function WalletBalancesProvider({ children }: { children: ReactNode }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setBalances([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const out: TokenBalance[] = [];

    for (const t of SPL_TOKENS) {
      try {
        const ata = getAssociatedTokenAddressSync(t.mint, publicKey, false, t.tokenProgram);
        const info = await connection.getAccountInfo(ata);
        const amount = info ? Number(info.data.readBigUInt64LE(64)) / 10 ** t.decimals : 0;
        out.push({ symbol: t.symbol, amount, priceUsd: t.priceUsd, displayDecimals: 2 });
      } catch {
        out.push({ symbol: t.symbol, amount: 0, priceUsd: t.priceUsd, displayDecimals: 2 });
      }
    }

    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      out.push({ symbol: "SOL", amount: lamports / 1e9, priceUsd: SOL_PRICE_USD, displayDecimals: 4 });
    } catch {
      out.push({ symbol: "SOL", amount: 0, priceUsd: SOL_PRICE_USD, displayDecimals: 4 });
    }

    try {
      const ata = getAssociatedTokenAddressSync(
        DEVNET_CONFIG.pool.wrappedMint,
        publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const info = await connection.getAccountInfo(ata);
      const amount = info ? Number(info.data.readBigUInt64LE(64)) / 1e9 : 0;
      out.push({ symbol: "csSOL", amount, priceUsd: SOL_PRICE_USD, displayDecimals: 4 });
    } catch {
      out.push({ symbol: "csSOL", amount: 0, priceUsd: SOL_PRICE_USD, displayDecimals: 4 });
    }

    setBalances(out);
    setLoading(false);
  }, [publicKey, connection]);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo<WalletBalances>(() => {
    const nonZero = balances.filter((b) => b.amount > 0.0001);
    const totalUsd = balances.reduce((sum, b) => sum + b.amount * b.priceUsd, 0);
    return { loading, balances, nonZero, totalUsd, refresh };
  }, [balances, loading, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWalletBalances(): WalletBalances {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Friendly fallback so consumers outside the provider (storybook,
    // unit tests) don't crash. Real app paths always have the provider.
    return { loading: false, balances: [], nonZero: [], totalUsd: 0, refresh: async () => {} };
  }
  return ctx;
}

/** Look up a single token's balance + a formatted "12.34 USDC ($12.34)"
 *  string. Returns `null` for tokens we don't track or while loading. */
export function useTokenBalance(symbol: TokenSymbol | string): {
  amount: number;
  formatted: string;
  usd: string;
  /** Render-ready tooltip string, e.g. "12.34 USDC · $12.34". */
  tip: string;
} | null {
  const { balances } = useWalletBalances();
  const b = balances.find((x) => x.symbol === symbol);
  if (!b) return null;
  const formatted = b.amount.toLocaleString(undefined, {
    minimumFractionDigits: b.displayDecimals,
    maximumFractionDigits: b.displayDecimals,
  });
  const usd = (b.amount * b.priceUsd).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return {
    amount: b.amount,
    formatted,
    usd,
    tip: `${formatted} ${b.symbol} · $${usd}`,
  };
}
