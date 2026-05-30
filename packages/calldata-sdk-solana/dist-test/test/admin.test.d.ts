/**
 * Tests for the admin/mint + admin/market instruction builders.
 *
 * These are lower-traffic than the retail surface, but they're the
 * builders the KYC/whitelist admin console and market-init scripts
 * drive. Same risk profile: silent on-chain failure if the wire
 * bytes drift.
 */
export {};
