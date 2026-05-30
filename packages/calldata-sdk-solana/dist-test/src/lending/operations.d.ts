import { PublicKey, TransactionInstruction } from "@solana/web3.js";
/**
 * Build `refresh_reserve` instruction.
 * Must be called before any operation that reads reserve state.
 *
 * The klend program expects 6 accounts: reserve, market, plus 4 oracle slots
 * (pyth, switchboard_price, switchboard_twap, scope_prices).
 * Unused oracle slots must be filled with PublicKey.default (system program).
 *
 * @param reserve              The reserve pubkey
 * @param market               The lending market
 * @param pythOracle           Pyth price feed account (or PublicKey.default if unused)
 * @param switchboardPrice     Switchboard price aggregator (default: PublicKey.default)
 * @param switchboardTwap      Switchboard TWAP aggregator (default: PublicKey.default)
 * @param scopePrices          Scope oracle prices account (default: PublicKey.default)
 */
export declare function refreshReserve(reserve: PublicKey, market: PublicKey, pythOracle: PublicKey, switchboardPrice?: PublicKey, switchboardTwap?: PublicKey, scopePrices?: PublicKey): TransactionInstruction;
/**
 * Build `refresh_obligation` instruction.
 * Must be called after refreshing all relevant reserves.
 *
 * @param market  The lending market
 * @param owner   The obligation owner
 * @param seed    Obligation seed (default 0)
 */
export declare function refreshObligation(market: PublicKey, owner: PublicKey, seed?: number): TransactionInstruction;
/**
 * Build `deposit_reserve_liquidity_and_obligation_collateral` instruction.
 *
 * @param owner         User wallet (signer)
 * @param market        Lending market
 * @param reserve       Reserve to deposit into
 * @param mint          Token mint (dUSDY or USDC)
 * @param tokenProgram  TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @param amount        Amount in base units
 * @param seed          Obligation seed (default 0)
 */
export declare function deposit(owner: PublicKey, market: PublicKey, reserve: PublicKey, mint: PublicKey, tokenProgram: PublicKey, amount: bigint, seed?: number): TransactionInstruction;
/**
 * Build `withdraw_obligation_collateral_and_redeem_reserve_collateral`.
 */
export declare function withdraw(owner: PublicKey, market: PublicKey, reserve: PublicKey, mint: PublicKey, tokenProgram: PublicKey, amount: bigint, seed?: number): TransactionInstruction;
/**
 * Build `borrow_obligation_liquidity` instruction.
 *
 * @param owner     User wallet (signer)
 * @param market    Lending market
 * @param reserve   USDC borrow reserve
 * @param mint      USDC mint
 * @param amount    Amount to borrow in base units
 * @param seed      Obligation seed (default 0)
 */
export declare function borrow(owner: PublicKey, market: PublicKey, reserve: PublicKey, mint: PublicKey, amount: bigint, seed?: number): TransactionInstruction;
/**
 * Build `repay_obligation_liquidity` instruction.
 */
export declare function repay(owner: PublicKey, market: PublicKey, reserve: PublicKey, mint: PublicKey, amount: bigint, seed?: number): TransactionInstruction;
