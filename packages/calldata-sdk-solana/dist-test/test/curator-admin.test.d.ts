/**
 * Unit tests for the curator-admin instruction builders.
 *
 * These are the keeper hot-path: reallocate_to_market, reallocate_from_market,
 * mark_to_market. A wire-format drift here silently breaks every rebalance
 * the keeper tries to land, so pin discriminator bytes, account slots, and
 * argument encoding to the spec.
 */
export {};
