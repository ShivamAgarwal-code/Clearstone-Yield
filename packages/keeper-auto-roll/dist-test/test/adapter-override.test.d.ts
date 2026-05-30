/**
 * Tests for the `CuratorVaultSnapshot.adapter` override path.
 *
 * Background: the keeper originally derived `sy_market` with the seed
 * `[b"sy_market", base_mint]` under the vault's SY program. That seed
 * matches `generic_exchange_rate_sy` only — Kamino's SY adapter uses a
 * different seed, so any Kamino-backed market would hit ConstraintSeeds
 * on crank.
 *
 * Fix: `CuratorVaultSnapshot` now carries an optional `adapter` bundle.
 * When the backend-edge populates it (for Kamino or any other
 * non-generic adapter), the keeper threads those pubkeys directly into
 * the reallocate / crank ixs instead of deriving.
 *
 * These tests pin both paths:
 *   - without `adapter`: derivation matches the generic seed (historical).
 *   - with `adapter`: snapshot pubkeys flow into the compiled ixs verbatim.
 */
export {};
//# sourceMappingURL=adapter-override.test.d.ts.map