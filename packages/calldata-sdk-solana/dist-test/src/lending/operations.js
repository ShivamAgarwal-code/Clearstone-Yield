import { PublicKey, TransactionInstruction, } from "@solana/web3.js";
import { KLEND_PROGRAM_ID, TOKEN_PROGRAM_ID, DISC, } from "../common/constants.js";
import { marketAuthorityPda, obligationPda, reserveCollateralSupplyPda, reserveLiquiditySupplyPda, reserveFeeVaultPda, reserveCollateralMintPda, ata, } from "../common/pda.js";
// ── Refresh instructions (must precede deposit/borrow/withdraw/repay) ──
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
export function refreshReserve(reserve, market, pythOracle, switchboardPrice = PublicKey.default, switchboardTwap = PublicKey.default, scopePrices = PublicKey.default) {
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: pythOracle, isSigner: false, isWritable: false },
            { pubkey: switchboardPrice, isSigner: false, isWritable: false },
            { pubkey: switchboardTwap, isSigner: false, isWritable: false },
            { pubkey: scopePrices, isSigner: false, isWritable: false },
        ],
        data: DISC.refreshReserve,
    });
}
/**
 * Build `refresh_obligation` instruction.
 * Must be called after refreshing all relevant reserves.
 *
 * @param market  The lending market
 * @param owner   The obligation owner
 * @param seed    Obligation seed (default 0)
 */
export function refreshObligation(market, owner, seed = 0) {
    const oblig = obligationPda(market, owner, seed);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: oblig, isSigner: false, isWritable: true },
        ],
        data: DISC.borrowObligationLiquidity, // TODO: use correct refresh_obligation disc
    });
}
// ── Core lending operations ──
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
export function deposit(owner, market, reserve, mint, tokenProgram, amount, seed = 0) {
    const oblig = obligationPda(market, owner, seed);
    const mAuth = marketAuthorityPda(market);
    const userAta = ata(mint, owner, tokenProgram);
    const cMint = reserveCollateralMintPda(reserve, market);
    const userCta = ata(cMint, owner, TOKEN_PROGRAM_ID);
    const data = Buffer.alloc(16);
    DISC.depositReserveLiquidity.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: oblig, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: mAuth, isSigner: false, isWritable: false },
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: reserveLiquiditySupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: cMint, isSigner: false, isWritable: true },
            { pubkey: reserveCollateralSupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: userCta, isSigner: false, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), isSigner: false, isWritable: false },
        ],
        data,
    });
}
/**
 * Build `withdraw_obligation_collateral_and_redeem_reserve_collateral`.
 */
export function withdraw(owner, market, reserve, mint, tokenProgram, amount, seed = 0) {
    const oblig = obligationPda(market, owner, seed);
    const mAuth = marketAuthorityPda(market);
    const userAta = ata(mint, owner, tokenProgram);
    const cMint = reserveCollateralMintPda(reserve, market);
    const userCta = ata(cMint, owner, TOKEN_PROGRAM_ID);
    const data = Buffer.alloc(16);
    DISC.withdrawObligationCollateral.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: oblig, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: mAuth, isSigner: false, isWritable: false },
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: reserveLiquiditySupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: cMint, isSigner: false, isWritable: true },
            { pubkey: reserveCollateralSupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: userCta, isSigner: false, isWritable: true },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
    });
}
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
export function borrow(owner, market, reserve, mint, amount, seed = 0) {
    const oblig = obligationPda(market, owner, seed);
    const mAuth = marketAuthorityPda(market);
    const userAta = ata(mint, owner, TOKEN_PROGRAM_ID);
    const data = Buffer.alloc(16);
    DISC.borrowObligationLiquidity.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: oblig, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: mAuth, isSigner: false, isWritable: false },
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: reserveLiquiditySupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: reserveFeeVaultPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
    });
}
/**
 * Build `repay_obligation_liquidity` instruction.
 */
export function repay(owner, market, reserve, mint, amount, seed = 0) {
    const oblig = obligationPda(market, owner, seed);
    const userAta = ata(mint, owner, TOKEN_PROGRAM_ID);
    const data = Buffer.alloc(16);
    DISC.repayObligationLiquidity.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: oblig, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: reserveLiquiditySupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
    });
}
