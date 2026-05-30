/**
 * Integration tests for the `fetchMarketsOnChain` branch of
 * `/fixed-yield/markets` — the path that takes over once an operator
 * populates `MARKET_REGISTRY`.
 *
 * Coverage here complements fixed-yield-decoders.test.ts: the decoders
 * run against hand-built buffers, but this test also exercises the
 * orchestration (registry parse → batched getMultipleAccountsInfo →
 * per-entry decoration → JSON envelope). A drift between documented
 * field indices and the handler's orchestration-level indexing (e.g.
 * `infos[i * 2]` vs `infos[i * 2 + 1]`) only shows up here.
 *
 * Strategy: patch `Connection.prototype.getMultipleAccountsInfo` for the
 * duration of the test. Supplies hand-built Vault + MarketTwo buffers
 * at the documented offsets. Every handler creates its own Connection
 * inside the route, so a prototype patch is the simplest shim.
 */
export {};
//# sourceMappingURL=on-chain-markets.test.d.ts.map