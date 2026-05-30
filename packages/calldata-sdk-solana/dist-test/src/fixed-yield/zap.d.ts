/**
 * High-level "zap" composers — what the retail UI drives.
 *
 * A zap is a single-tx flow that turns the user's raw base asset into a
 * position with the desired risk profile, without asking them to think
 * about PT / YT / SY. Two flows ship in v1:
 *
 *   buildZapInToPt — base → pure PT at a discount. Fixed yield if held.
 *                    Composes [wrapper_strip, wrapper_sell_yt] so the
 *                    user walks away holding PT only.
 *
 *   buildZapOutToBase — PT + YT → base. One-shot exit, works before and
 *                       after maturity (core.merge handles both).
 *
 * Callers should wrap these in a v0 transaction with the market's
 * address_lookup_table to fit under the 1232-byte MTU.
 */
import { TransactionInstruction, AccountMeta, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { WrapperStripParams, WrapperMergeParams } from "./builders.js";
export interface ZapInToPtParams extends WrapperStripParams {
    /**
     * Additional inputs for the sell-YT leg. Required for the full
     * "zap in to pure PT" path — strip mints 1:1 PT+YT, then sell_yt
     * trades YT back to base on the AMM, leaving the user with PT only.
     *
     * Omit (`sellYt: undefined`) to get just strip + hold both halves.
     * That's useful for users who want to hold YT themselves to collect
     * accruing yield.
     */
    sellYt?: {
        /**
         * YT amount to sell. By construction this equals the PT amount
         * minted by `strip` (they come out 1:1 from the same base amount).
         * Caller computes from `amountBase * syExchangeRate` or reads back
         * from strip's return data in a two-tx flow.
         */
        ytIn: BN | bigint | number;
        /** AMM slippage floor: minimum SY-denominated base out. */
        minSyOut: BN | bigint | number;
        market: PublicKey;
        marketEscrowSy: PublicKey;
        marketEscrowPt: PublicKey;
        marketAlt: PublicKey;
        tokenFeeTreasurySy: PublicKey;
        /** Any extra accounts the sell_yt CPI chain requires. */
        remainingAccounts?: AccountMeta[];
    };
}
/**
 * Return the ix sequence for a zap-in.
 *
 * - With `sellYt` unset → returns `[wrapper_strip]`. User holds 1:1 PT+YT.
 * - With `sellYt` set → returns `[wrapper_strip, wrapper_sell_yt]`. User
 *   holds only PT, which they redeem for a fixed yield at maturity.
 *
 * Pack the returned ixs into a v0 transaction using the vault's ALT so
 * the account list fits under the 1232-byte MTU.
 */
export declare function buildZapInToPt(p: ZapInToPtParams): TransactionInstruction[];
export type ZapOutToBaseParams = WrapperMergeParams;
/**
 * Exit a PT + YT position back to base. Works pre- and post-maturity:
 *
 *   - pre-maturity:  PT and YT redeem 1:1 for SY.
 *   - post-maturity: YT is zero-valued; merge just drains PT at the
 *     frozen `final_sy_exchange_rate`.
 *
 * The caller supplies `amountPy`. For post-maturity redemption, pass PT
 * balance and zero YT — merge tolerates asymmetry.
 */
export declare function buildZapOutToBase(p: ZapOutToBaseParams): TransactionInstruction;
