/**
 * Versioned-transaction packaging helpers.
 *
 * The zap flows frequently push the legacy-tx account list over 1232
 * bytes (`wrapper_strip` + `wrapper_sell_yt` together reference 35+
 * accounts). These helpers produce an unsigned `VersionedTransaction`
 * that inlines the vault's address-lookup-table, so the wire payload
 * stays under the MTU.
 *
 * All helpers are RPC-free. Callers pre-fetch the
 * `AddressLookupTableAccount`s and the latest blockhash and pass them
 * in. That keeps the SDK usable from service workers, CI fixtures, and
 * programs.
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  buildZapInToPt,
  buildZapOutToBase,
  ZapInToPtParams,
  ZapOutToBaseParams,
} from "./zap.js";

/**
 * Compute-budget knobs. Omit for Solana defaults (200k CU / 0 μL). The
 * strip+sell_yt pair typically comes in around ~280k CU, so bump
 * `unitLimit` to 400k for headroom when `sellYt` is set.
 */
export interface ComputeBudget {
  /** CU limit. Sets `SetComputeUnitLimit`. */
  unitLimit?: number;
  /** Priority fee in micro-lamports/CU. Sets `SetComputeUnitPrice`. */
  microLamportsPerCu?: number;
}

export interface PackV0TxParams {
  /** Ixs to include, in execution order. */
  ixs: TransactionInstruction[];
  /** Fee payer (the tx signer). */
  payer: PublicKey;
  /** Recent blockhash. Caller fetches via `connection.getLatestBlockhash()`. */
  recentBlockhash: string;
  /** Address lookup tables to inline for account compression. */
  lookupTables?: AddressLookupTableAccount[];
  /** Optional compute-budget prelude. */
  computeBudget?: ComputeBudget;
}

/**
 * Pack a sequence of instructions into an **unsigned**
 * `VersionedTransaction`. Caller is responsible for `tx.sign([...])`
 * before sending.
 *
 * If `computeBudget` is set, prepends `SetComputeUnitLimit` and/or
 * `SetComputeUnitPrice` ixs — they must come first in the tx per Solana
 * runtime rules.
 */
export function packV0Tx(p: PackV0TxParams): VersionedTransaction {
  const prelude: TransactionInstruction[] = [];
  if (p.computeBudget?.unitLimit !== undefined) {
    prelude.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: p.computeBudget.unitLimit,
      })
    );
  }
  if (p.computeBudget?.microLamportsPerCu !== undefined) {
    prelude.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: p.computeBudget.microLamportsPerCu,
      })
    );
  }

  const message = new TransactionMessage({
    payerKey: p.payer,
    recentBlockhash: p.recentBlockhash,
    instructions: [...prelude, ...p.ixs],
  }).compileToV0Message(p.lookupTables ?? []);

  return new VersionedTransaction(message);
}

// ---------------------------------------------------------------------------
// Zap convenience wrappers
// ---------------------------------------------------------------------------

export interface ZapInToPtTxParams
  extends ZapInToPtParams,
    Omit<PackV0TxParams, "ixs"> {}

/**
 * Build a `VersionedTransaction` for the full "base → pure PT" flow.
 *
 * The returned tx is unsigned. Typical caller:
 *
 *   const tx = await buildZapInToPtV0Tx({ ...zapParams, payer,
 *       recentBlockhash, lookupTables: [vaultAlt] });
 *   tx.sign([userKeypair]);
 *   await connection.sendTransaction(tx);
 *
 * `lookupTables` should include at least the vault's ALT (the one
 * referenced via `addressLookupTable` in the zap params). If the market
 * has its own ALT (used by `sell_yt`'s trade leg), pass it too —
 * compileToV0Message dedupes account refs across all supplied tables.
 */
export function buildZapInToPtV0Tx(
  p: ZapInToPtTxParams
): VersionedTransaction {
  const { payer, recentBlockhash, lookupTables, computeBudget, ...zap } = p;
  return packV0Tx({
    ixs: buildZapInToPt(zap),
    payer,
    recentBlockhash,
    lookupTables,
    computeBudget: computeBudget ?? defaultZapInCompute(zap.sellYt !== undefined),
  });
}

export interface ZapOutToBaseTxParams
  extends ZapOutToBaseParams,
    Omit<PackV0TxParams, "ixs"> {}

/** Build a `VersionedTransaction` for the "PT + YT → base" exit flow. */
export function buildZapOutToBaseV0Tx(
  p: ZapOutToBaseTxParams
): VersionedTransaction {
  const { payer, recentBlockhash, lookupTables, computeBudget, ...zap } = p;
  return packV0Tx({
    ixs: [buildZapOutToBase(zap)],
    payer,
    recentBlockhash,
    lookupTables,
    computeBudget: computeBudget ?? { unitLimit: 300_000 },
  });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Sensible compute-unit defaults. Empirically measured on devnet against
 * the current fork mainline; bump if a future ix adds work.
 */
function defaultZapInCompute(includesSellYt: boolean): ComputeBudget {
  return { unitLimit: includesSellYt ? 400_000 : 250_000 };
}
