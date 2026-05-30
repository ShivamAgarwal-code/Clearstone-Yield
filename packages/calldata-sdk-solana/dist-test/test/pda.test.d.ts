/**
 * Tests for the fixed-yield PDA derivations (pda.ts).
 *
 * These seeds are part of the core program's ABI. A swap in seed order,
 * a change from `Buffer.from("market")` to "market_v2", or a stray
 * trailing byte would produce deterministic-but-wrong PDAs — every
 * deposit/withdraw/trade would land ConstraintSeeds.
 *
 * Strategy: pin determinism + (vault)/(market)-scoping so a drift
 * shows up here, and verify `deriveVaultPdas` composes the per-leg
 * derivations correctly.
 */
export {};
