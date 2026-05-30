/**
 * HTTP-handler tests for /kyc.
 *
 * The on-chain whitelisting path in kyc.ts is heavy (ed25519 signing,
 * PDA derivation, raw tx construction) and requires an `ADMIN_KEYPAIR_JSON`
 * env plus a reachable RPC. These tests cover the *lifecycle*
 * (submit → status → approve) under the `no_admin_key_configured`
 * branch — i.e. the development/fixture path. That's the only branch
 * we can test without a real cluster; on-chain whitelisting is covered
 * by DEPLOY.md's manual smoke test.
 */
export {};
//# sourceMappingURL=kyc.test.d.ts.map