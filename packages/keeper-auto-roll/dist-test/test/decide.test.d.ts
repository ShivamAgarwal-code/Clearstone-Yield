/**
 * Unit tests for the keeper's decision logic.
 *
 * `decideRoll` (curator-signed path) and `decideDelegatedRoll`
 * (permissionless path) are discriminated-union returning pure
 * functions — no RPC, no keypair. That makes them trivial to
 * table-test, and they're the only code paths that can silently
 * mis-route a keeper run.
 */
export {};
//# sourceMappingURL=decide.test.d.ts.map