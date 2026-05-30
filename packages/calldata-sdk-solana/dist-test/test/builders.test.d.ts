/**
 * Unit tests for the router wrapper_* builders in src/fixed-yield/builders.ts.
 *
 * These are the widest untested wire-format surface in the SDK. Each
 * wrapper is a single-ix cascade: adapter (mint_sy / redeem_sy) CPI'ing
 * into core (strip / merge / trade / sell_yt). The router dedupes
 * accounts across the inner CPIs, so the ix layout is non-obvious —
 * a swap of two accounts silently breaks every retail tx.
 *
 * Test strategy: pin discriminator bytes, arg serialization, account
 * count, signer/writability per slot, and program defaults for each
 * builder. BN/bigint/number equivalence checked once — it's shared
 * helper behavior, not per-builder.
 */
export {};
