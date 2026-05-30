/**
 * Unit tests for the hand-rolled account-offset decoders in
 * src/fixed-yield.ts.
 *
 * These are the mission-critical bits — if the offsets drift vs. the
 * clearstone_core state layout, the indexer will silently return garbage
 * maturity dates and PT prices and the retail UI will quote nonsense APYs.
 *
 * Run:  pnpm --filter backend-edge run test
 *
 * Test strategy: hand-build a byte buffer matching the documented
 * layout, write known sentinel values at the target offsets (and
 * adversarial patterns everywhere else so we catch off-by-one),
 * and assert the decoders return exactly the sentinels.
 */
export {};
//# sourceMappingURL=fixed-yield-decoders.test.d.ts.map