/**
 * Integration test for `getCuratorVaults` — the endpoint the auto-roll
 * keeper polls in production. Exercises the full on-chain decode:
 *
 *   1. `CURATOR_VAULT_REGISTRY` JSON parsed.
 *   2. Batch 1: fetch every CuratorVault account. Decode header + allocations.
 *   3. Batch 2: fetch every *distinct* allocation market. Read
 *      `financials.expiration_ts` @ 365 to resolve per-market maturity.
 *   4. Emit the DTO with `nextAutoRollTs` = earliest-maturity allocation.
 *
 * This is the keeper-facing contract: a drift in step 3's offset or
 * step 4's `min` resolution would produce an nextAutoRollTs that's
 * wrong by months, and the keeper would either roll early (slippage
 * loss) or sit indefinitely. Pin it.
 *
 * The handlers.test.ts suite already covers the empty-registry + URL
 * envelope path; this file complements with the live-decode branch.
 */
export {};
//# sourceMappingURL=on-chain-curator-vaults.test.d.ts.map