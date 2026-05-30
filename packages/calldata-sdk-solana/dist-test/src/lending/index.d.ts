/**
 * Lending namespace
 *
 * User-facing operations for interacting with a configured klend market:
 *   - deposit   — Deposit collateral (dUSDY) into a reserve
 *   - withdraw  — Withdraw collateral from an obligation
 *   - borrow    — Borrow liquidity (USDC) against collateral
 *   - repay     — Repay borrowed liquidity
 *
 * Each function returns TransactionInstruction(s) that can be
 * added to a Transaction and signed by the user's wallet.
 */
export { deposit, withdraw, borrow, repay, refreshReserve, refreshObligation } from "./operations.js";
export { initObligation, initUserMetadata } from "./setup.js";
