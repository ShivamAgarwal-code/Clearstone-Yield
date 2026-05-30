/**
 * HTTP-handler tests for /whitelist.
 *
 * The whitelist module shells out to Solana RPC via raw `fetch` (not
 * `@solana/web3.js`), so the fetch shim pattern from edge.test.ts
 * transfers cleanly.
 *
 * Coverage focus:
 *   - Cache-hit path (KV returns JSON, no RPC call).
 *   - RPC happy path (parse WhitelistEntry layout, attach POOL_NAMES).
 *   - Per-wallet filter.
 *   - Error path (RPC returns JSON-RPC error).
 */
export {};
//# sourceMappingURL=whitelist.test.d.ts.map