/**
 * Low-level instruction builders for `clearstone_router` wrapper_* ixs.
 *
 * Each `build*` returns a single `TransactionInstruction`. Callers are
 * expected to provide a fully-resolved account set — these builders do
 * no PDA derivation or ATA lookup beyond what the router strictly needs
 * to know. For the high-level "just give me a ready-to-sign tx" flow,
 * see `zap.ts`.
 *
 * Why no IDL-generated client? The router IDL is ~100kB and adds a hard
 * runtime dependency on `@coral-xyz/anchor`. Going straight through the
 * discriminator table keeps this SDK framework-free and forward-compatible
 * with either Anchor 0.30 or 0.31 clients.
 */
import { TransactionInstruction, } from "@solana/web3.js";
import BN from "bn.js";
import { CLEARSTONE_ROUTER_PROGRAM_ID, CLEARSTONE_CORE_PROGRAM_ID, GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID, TOKEN_PROGRAM_ID, } from "../common/constants.js";
import { ROUTER_DISC } from "./constants.js";
const ro = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
});
const rw = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
});
const signer = (pubkey, writable = true) => ({
    pubkey,
    isSigner: true,
    isWritable: writable,
});
function u64le(n) {
    const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
    return v.toArrayLike(Buffer, "le", 8);
}
function i64le(n) {
    const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
    return v.toTwos(64).toArrayLike(Buffer, "le", 8);
}
/** Base → PT + YT in one instruction (adapter.mint_sy → core.strip). */
export function buildWrapperStrip(p) {
    const keys = [
        signer(p.user),
        // adapter (mint_sy)
        ro(p.syMarket),
        ro(p.baseMint),
        rw(p.syMint),
        rw(p.baseSrc),
        rw(p.baseVault),
        // core (strip)
        rw(p.authority),
        rw(p.vault),
        rw(p.sySrc),
        rw(p.escrowSy),
        rw(p.ytDst),
        rw(p.ptDst),
        rw(p.mintYt),
        rw(p.mintPt),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.addressLookupTable),
        // program accounts
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        rw(p.yieldPosition),
        ro(p.coreEventAuthority),
        ...(p.remainingAccounts ?? []),
    ];
    return new TransactionInstruction({
        programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
        keys,
        data: Buffer.concat([ROUTER_DISC.wrapperStrip, u64le(p.amountBase)]),
    });
}
/** PT + YT → base (core.merge → adapter.redeem_sy). */
export function buildWrapperMerge(p) {
    const keys = [
        signer(p.user),
        // adapter (redeem_sy)
        ro(p.syMarket),
        ro(p.baseMint),
        rw(p.syMint),
        rw(p.baseDst),
        rw(p.baseVault),
        // core (merge)
        rw(p.authority),
        rw(p.vault),
        rw(p.sySrc),
        rw(p.escrowSy),
        rw(p.ytSrc),
        rw(p.ptSrc),
        rw(p.mintYt),
        rw(p.mintPt),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.addressLookupTable),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        rw(p.yieldPosition),
        ro(p.coreEventAuthority),
        ...(p.remainingAccounts ?? []),
    ];
    return new TransactionInstruction({
        programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
        keys,
        data: Buffer.concat([ROUTER_DISC.wrapperMerge, u64le(p.amountPy)]),
    });
}
/** Base → PT at AMM (mint_sy → trade_pt buy). Leftover SY stays in user's ATA. */
export function buildWrapperBuyPt(p) {
    const keys = [
        signer(p.user),
        // adapter (mint_sy)
        ro(p.syMarket),
        ro(p.baseMint),
        rw(p.syMint),
        rw(p.baseSrc),
        rw(p.baseVault),
        // core (trade_pt)
        rw(p.market),
        rw(p.sySrc),
        rw(p.ptDst),
        rw(p.marketEscrowSy),
        rw(p.marketEscrowPt),
        ro(p.marketAlt),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        rw(p.tokenFeeTreasurySy),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        ro(p.coreEventAuthority),
        ...(p.remainingAccounts ?? []),
    ];
    return new TransactionInstruction({
        programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
        keys,
        data: Buffer.concat([
            ROUTER_DISC.wrapperBuyPt,
            u64le(p.ptAmount),
            u64le(p.maxBase),
            i64le(p.maxSyIn),
        ]),
    });
}
/**
 * Base → YT (adapter.mint_sy → core.buy_yt).
 *
 * buy_yt internally self-CPIs into `strip`, so the vault-side accounts
 * (`vault`, `vault_authority`, `escrow_sy_vault`, `mint_yt/pt`,
 * `vault_alt`, `yield_position`) are required alongside the market
 * trade accounts. This is the complement to `buildWrapperSellYt`.
 */
export function buildWrapperBuyYt(p) {
    const keys = [
        signer(p.user),
        // adapter (mint_sy)
        ro(p.syMarket),
        ro(p.baseMint),
        rw(p.syMint),
        rw(p.baseSrc),
        rw(p.baseVault),
        // core.buy_yt (trade side)
        rw(p.market),
        rw(p.sySrc),
        rw(p.ytDst),
        rw(p.ptDst),
        rw(p.marketEscrowSy),
        rw(p.marketEscrowPt),
        rw(p.tokenFeeTreasurySy),
        ro(p.marketAlt),
        // strip-cascade
        rw(p.vaultAuthority),
        rw(p.vault),
        rw(p.escrowSyVault),
        rw(p.mintYt),
        rw(p.mintPt),
        ro(p.vaultAlt),
        rw(p.yieldPosition),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        ro(p.coreEventAuthority),
        ...(p.remainingAccounts ?? []),
    ];
    return new TransactionInstruction({
        programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
        keys,
        data: Buffer.concat([
            ROUTER_DISC.wrapperBuyYt,
            u64le(p.baseIn),
            u64le(p.syIn),
            u64le(p.ytOut),
        ]),
    });
}
/** PT → base (core.sell_pt → adapter.redeem_sy). */
export function buildWrapperSellPt(p) {
    const keys = [
        signer(p.user),
        // core (trade_pt)
        rw(p.market),
        rw(p.sySrc),
        rw(p.ptSrc),
        rw(p.marketEscrowSy),
        rw(p.marketEscrowPt),
        ro(p.marketAlt),
        rw(p.tokenFeeTreasurySy),
        // adapter (redeem_sy)
        ro(p.syMarket),
        ro(p.baseMint),
        rw(p.syMint),
        rw(p.baseVault),
        rw(p.baseDst),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        ro(p.coreEventAuthority),
        ...(p.remainingAccounts ?? []),
    ];
    return new TransactionInstruction({
        programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
        keys,
        data: Buffer.concat([
            ROUTER_DISC.wrapperSellPt,
            u64le(p.ptIn),
            u64le(p.minSyOut),
        ]),
    });
}
/**
 * YT → base (core.sell_yt → adapter.redeem_sy).
 *
 * sell_yt internally self-CPIs to merge, so the vault-side accounts
 * (`vault`, `vault_authority`, `escrow_sy_vault`, `mint_yt`, `mint_pt`,
 * `vault_alt`, `yield_position`) must be present in addition to the
 * market-side trade accounts.
 *
 * This is the companion piece to `buildWrapperStrip` that unlocks the
 * full `zap.buildZapInToPt` flow (strip → sell_yt → user holds PT only).
 */
export function buildWrapperSellYt(p) {
    const keys = [
        signer(p.user),
        // core.sell_yt (trade side)
        rw(p.market),
        rw(p.ytSrc),
        rw(p.ptSrc),
        rw(p.sySrc),
        rw(p.marketEscrowSy),
        rw(p.marketEscrowPt),
        ro(p.marketAlt),
        rw(p.tokenFeeTreasurySy),
        // merge-cascade
        rw(p.vault),
        rw(p.vaultAuthority),
        rw(p.escrowSyVault),
        rw(p.mintYt),
        rw(p.mintPt),
        ro(p.vaultAlt),
        rw(p.yieldPosition),
        // adapter.redeem_sy
        ro(p.syMarket),
        ro(p.baseMint),
        rw(p.syMint),
        rw(p.baseVault),
        rw(p.baseDst),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        ro(p.coreEventAuthority),
        ...(p.remainingAccounts ?? []),
    ];
    return new TransactionInstruction({
        programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
        keys,
        data: Buffer.concat([
            ROUTER_DISC.wrapperSellYt,
            u64le(p.ytIn),
            u64le(p.minSyOut),
        ]),
    });
}
// ---------------------------------------------------------------------------
// Stubs for the remaining 7 wrappers — account shapes match the Rust
// side; implement on demand. Each follows the exact same pattern.
// ---------------------------------------------------------------------------
export const TODO_BUILDERS = [
    "buildWrapperCollectInterest",
    "buildWrapperProvideLiquidity",
    "buildWrapperProvideLiquidityClassic",
    "buildWrapperProvideLiquidityBase",
    "buildWrapperWithdrawLiquidity",
    "buildWrapperWithdrawLiquidityClassic",
];
