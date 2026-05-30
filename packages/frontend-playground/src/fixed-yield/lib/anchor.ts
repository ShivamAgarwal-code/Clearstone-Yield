// Anchor program loader.
//
// The wallet adapter exposes a `Wallet`-like interface (publicKey +
// signTransaction + signAllTransactions). Anchor's AnchorProvider needs
// the same shape, so we adapt at the boundary instead of pulling in a
// separate `@solana/wallet-adapter-anchor` dep.
//
// Usage:
//   const provider = useAnchorProvider();
//   const router = useMemo(() =>
//     provider ? new Program<ClearstoneRouter>(routerIdl as Idl, provider) : null,
//     [provider]);
//
// Returns null until a wallet is connected — every page that needs a
// program guards on null and renders a "connect wallet" hint.

import { useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";

// Anchor's exported Wallet type lives in the provider module, but the
// ESM entrypoint doesn't always re-export it cleanly. We declare the
// minimum shape we need; matches AnchorProvider's constructor.
interface MinimalAnchorWallet {
  publicKey: import("@solana/web3.js").PublicKey;
  signTransaction<T extends import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction>(
    tx: T
  ): Promise<T>;
  signAllTransactions<T extends import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction>(
    txs: T[]
  ): Promise<T[]>;
}

// Vendored IDLs. These stay in lockstep with `target/idl/*.json` —
// re-copy after every `anchor build` that changes the affected program.
import clearstoneCoreIdl from "../idl/clearstone_core.json";
import clearstoneRouterIdl from "../idl/clearstone_router.json";
import kaminoSyAdapterIdl from "../idl/kamino_sy_adapter.json";
import genericExchangeRateSyIdl from "../idl/generic_exchange_rate_sy.json";

export const idl = {
  clearstoneCore: clearstoneCoreIdl as unknown as Idl,
  clearstoneRouter: clearstoneRouterIdl as unknown as Idl,
  kaminoSyAdapter: kaminoSyAdapterIdl as unknown as Idl,
  genericExchangeRateSy: genericExchangeRateSyIdl as unknown as Idl,
};

/**
 * Build an `AnchorProvider` from the wallet adapter + connection.
 * Returns null until the wallet exposes `signTransaction` (Phantom,
 * Backpack do; ledger via wallet-adapter does too).
 */
export function useAnchorProvider(): AnchorProvider | null {
  const { connection } = useConnection();
  const wallet = useWallet();
  return useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
      return null;
    }
    const adapterWallet: MinimalAnchorWallet = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction.bind(wallet),
      signAllTransactions: wallet.signAllTransactions.bind(wallet),
    };
    return new AnchorProvider(connection, adapterWallet as never, {
      commitment: "confirmed",
    });
  }, [connection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);
}

/**
 * Convenience: wraps `new Program(idl, provider)` so call sites stay
 * one-liners. Returns null when the provider isn't ready.
 *
 * Note: Anchor's `Program` constructor in 0.31 takes (idl, provider) —
 * the program ID is read from `idl.address`. Pass an `addressOverride`
 * if your stack repins the program (e.g. forked workspace with
 * different keys).
 */
export function buildProgram<T extends Idl>(
  programIdl: T,
  provider: AnchorProvider | null
): Program<T> | null {
  if (!provider) return null;
  // Anchor 0.31's Program constructor: (idl, provider) — address comes
  // from idl.address. The typed Program<T> requires generated TS
  // types, which we don't vendor; cast through `unknown` keeps the
  // IDL JSON usable as-is without pulling per-program types into the
  // UI bundle.
  return new Program(programIdl, provider) as unknown as Program<T>;
}
