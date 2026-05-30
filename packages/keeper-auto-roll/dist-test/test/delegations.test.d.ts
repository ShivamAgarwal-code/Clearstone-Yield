/**
 * Unit tests for the keeper's delegation scan / filter logic.
 *
 * `scanDelegations` is the only bridge between the RPC view of
 * `RollDelegation` accounts and the keeper's tick loop. A decode drift
 * (wrong size, wrong field order) would silently hide every live
 * delegation — the keeper would keep ticking and finding "nothing to do."
 *
 * `filterLive` is a one-liner, but the comparison is on bigints across
 * a slot boundary — worth pinning to avoid an off-by-one that leaves
 * keepers cranking an expired delegation (which the on-chain check
 * would reject, but burns fee + logs spam).
 */
export {};
//# sourceMappingURL=delegations.test.d.ts.map