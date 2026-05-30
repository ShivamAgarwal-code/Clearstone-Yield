/**
 * Integration tests for `fetchCuratorUserPosition` — the per-user
 * position endpoint the retail UI polls.
 *
 * This is where the pro-rata NAV math lives:
 *
 *   baseValue = shares × vault.totalAssets ÷ vault.totalShares
 *
 * Plus an earliest-maturity resolver over the vault's allocations. Both
 * are silent-drift risks: a bigint precision slip or `max < min` swap
 * would produce a plausible-looking but wrong display value for every
 * retail user.
 */
export {};
//# sourceMappingURL=on-chain-curator-user-position.test.d.ts.map