/**
 * Keeper ↔ backend-edge contract test.
 *
 * The keeper and the edge live in separate packages and don't share a
 * types module — the edge defines `CuratorVaultDto` in
 * packages/backend-edge/src/fixed-yield.ts, and the keeper re-declares
 * an identically-shaped `CuratorVaultSnapshot` in src/edge.ts. A silent
 * field rename on either side (say, the edge starts emitting
 * `base_escrow` while the keeper still looks for `baseEscrow`) produces
 * a keeper that polls successfully and finds "nothing to do" forever.
 *
 * This test pins the wire shape from the keeper's perspective:
 *
 *   1. A canonical DTO literal is declared in-file and `satisfies` the
 *      keeper's snapshot type. Drift on the keeper side → TypeScript
 *      build failure here.
 *
 *   2. `fetchCuratorVaults` is driven through a fetch mock that returns
 *      the DTO — if the URL shape or envelope changes, this breaks.
 *
 *   3. The decoded snapshot is run through BOTH decide paths
 *      (`decideRoll` + `decideDelegatedRoll`) to confirm every field
 *      the keeper actually reads is populated and well-typed. A silent
 *      drop of `nextAutoRollTs` (for instance) would make decideRoll
 *      return "no-matured-allocation" regardless of state — this test
 *      catches that by verifying a deliberately-ready fixture produces
 *      `reason: "ready"`.
 *
 * There is a companion test on the edge side
 * (packages/backend-edge/test/handlers.test.ts) that asserts the
 * envelope and cache-control for the same endpoint. If the two ever
 * describe different shapes, one of the two test suites fails.
 */
export {};
//# sourceMappingURL=contract-edge.test.d.ts.map