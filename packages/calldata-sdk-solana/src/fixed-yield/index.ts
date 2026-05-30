/**
 * Fixed-Yield namespace
 *
 * Calldata builders for the clearstone-fixed-yield stack (PT/YT on top of
 * Kamino interest-bearing tokens via a KYC-pass-through SY adapter).
 *
 * Layering (bottom → top):
 *
 *   core/adapter    ← clearstone_core + generic_exchange_rate_sy / kamino_sy_adapter
 *      │
 *      ▼
 *   router          ← clearstone_router wrapper_* instructions (base ↔ PT/YT/LP)
 *      │
 *      ▼
 *   zap             ← composed single-tx flows (buy-and-hold PT, redeem PT → base)
 *
 * Consumers will typically drive everything through the `zap` API; the
 * `builders` export is there for frontends that want to stitch custom
 * sequences (e.g. partial redemptions, liquidity provision).
 *
 *   import { fixedYield } from "@delta/calldata-sdk-solana";
 *
 *   // Quote fixed APY for a 90d term at 1000 base-units in
 *   const q = fixedYield.quoteFixedApy({ ... });
 *
 *   // Build a one-click "buy PT at discount, hold to maturity" tx
 *   const ixs = fixedYield.buildZapInToPt({ ... });
 */

export * from "./constants.js";
export * from "./pda.js";
export * as builders from "./builders.js";
export * as zap from "./zap.js";
export * as quote from "./quote.js";
export * as tx from "./tx.js";
export * as curator from "./curator.js";
export * as curatorAdmin from "./curator-admin.js";
export * as delegation from "./delegation.js";
