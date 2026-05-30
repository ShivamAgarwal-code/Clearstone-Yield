/**
 * @delta/calldata-sdk-solana
 *
 * Transaction builder SDK for the Delta KYC-gated lending protocol on Solana.
 *
 * Two namespaces:
 *   - `admin`   — Governance: mint setup, whitelist, market creation, reserve config
 *   - `lending` — User-facing: deposit, withdraw, borrow, repay
 *
 * Usage:
 *   import { admin, lending } from "@delta/calldata-sdk-solana";
 *
 *   // Admin: create market
 *   const ix = admin.createLendingMarket(owner, marketKp);
 *
 *   // User: deposit collateral
 *   const ix = lending.deposit(owner, market, reserve, mint, tokenProg, amount);
 */
export * as admin from "./admin/index.js";
export * as lending from "./lending/index.js";
export * as fixedYield from "./fixed-yield/index.js";
export * from "./common/index.js";
