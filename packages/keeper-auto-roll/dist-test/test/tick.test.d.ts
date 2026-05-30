/**
 * Tests for the top-level `runTick` dispatcher.
 *
 * The tick loop is where delegation scan / decide / execute are wired
 * together. Critical branches to pin:
 *
 *   - Delegated crank fires when there's a live, ready delegation
 *     (Path 1). A curator-signed fallback should NOT run in that case.
 *   - Curator-signed fallback fires when no delegations exist AND the
 *     decide path says ready.
 *   - SKIP_CURATOR_FALLBACK=1 suppresses path 2 entirely — needed for
 *     keepers running without the curator key.
 *   - A thrown delegated crank doesn't starve other delegations in the
 *     same vault.
 *   - scanDelegations errors are swallowed (the keeper still services
 *     the curator-signed path).
 *
 * Harness: mock Connection + globalThis.fetch, patch executeRoll /
 * executeDelegatedRoll via spy wrappers. `runTick` is exported
 * specifically for this.
 */
export {};
//# sourceMappingURL=tick.test.d.ts.map