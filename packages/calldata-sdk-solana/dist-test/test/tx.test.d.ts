/**
 * Unit tests for tx.ts — versioned-transaction packaging.
 *
 * These helpers are the last mile before the frontend signs and sends.
 * They (1) prepend ComputeBudget ixs per Solana's "first-ix" rule,
 * (2) wire LUTs into compileToV0Message, and (3) return unsigned
 * VersionedTransactions. A drift in prelude ordering, LUT plumbing,
 * or payer wiring silently breaks every retail tx.
 */
export {};
