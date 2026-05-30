/**
 * Tx-assembly tests for the keeper's execute paths.
 *
 * `decide*` tests cover WHETHER to roll; these cover WHAT tx gets built.
 * The risk is in `deriveReallocateAccounts` / `deriveCrankAccountsFor`:
 * both pull ~6-8 pubkeys out of MarketTwo + core Vault account buffers
 * at hard-coded offsets. A silent offset drift here produces a tx that
 * passes client-side checks but fails on-chain with opaque AccountNotFound
 * or ConstraintSeeds errors — which the keeper then retries forever.
 *
 * Strategy: mock `Connection.getAccountInfo` + `getLatestBlockhash` with
 * in-memory fixtures matching the documented MarketTwo / Vault layouts.
 * Run execute* in dryRun mode so nothing hits the wire. Assert the
 * compiled tx has the right ixs, right signer, and a plausible size.
 */
export {};
//# sourceMappingURL=execute.test.d.ts.map