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
import { buildWrapperStrip, buildWrapperMerge, buildWrapperSellYt, } from "./builders.js";
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
export function buildZapInToPt(p) {
    const stripIx = buildWrapperStrip(p);
    if (!p.sellYt)
        return [stripIx];
    // Compose strip → sell_yt in the same tx. sell_yt consumes the YT
    // strip just minted (p.ytDst) and the matched PT for the self-merge
    // leg (p.ptDst, since sell_yt burns equal amounts of PT+YT while
    // trading). Proceeds land in p.sySrc, then the adapter's redeem_sy
    // drains to p.baseSrc.
    const sellParams = {
        user: p.user,
        market: p.sellYt.market,
        ytSrc: p.ytDst,
        ptSrc: p.ptDst,
        sySrc: p.sySrc,
        marketEscrowSy: p.sellYt.marketEscrowSy,
        marketEscrowPt: p.sellYt.marketEscrowPt,
        marketAlt: p.sellYt.marketAlt,
        tokenFeeTreasurySy: p.sellYt.tokenFeeTreasurySy,
        // merge-cascade: the vault-side context strip used, reused here.
        vault: p.vault,
        vaultAuthority: p.authority,
        escrowSyVault: p.escrowSy,
        mintYt: p.mintYt,
        mintPt: p.mintPt,
        vaultAlt: p.addressLookupTable,
        yieldPosition: p.yieldPosition,
        // adapter leg — strip's base_src is sell_yt's base_dst (same user ATA).
        syMarket: p.syMarket,
        baseMint: p.baseMint,
        syMint: p.syMint,
        baseVault: p.baseVault,
        baseDst: p.baseSrc,
        ytIn: p.sellYt.ytIn,
        minSyOut: p.sellYt.minSyOut,
        coreProgram: p.coreProgram,
        syProgram: p.syProgram,
        routerProgram: p.routerProgram,
        tokenProgram: p.tokenProgram,
        coreEventAuthority: p.coreEventAuthority,
        remainingAccounts: p.sellYt.remainingAccounts,
    };
    return [stripIx, buildWrapperSellYt(sellParams)];
}
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
export function buildZapOutToBase(p) {
    return buildWrapperMerge(p);
}
