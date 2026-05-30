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
import { PublicKey, TransactionInstruction, AccountMeta } from "@solana/web3.js";
import BN from "bn.js";
/**
 * Accounts that every wrapper needs regardless of direction. The router
 * dedupes these across the inner core/adapter CPIs so callers never list
 * the same pubkey twice.
 */
export interface WrapperCommon {
    /** User signing the tx. Pays for any init-on-demand ATAs upstream. */
    user: PublicKey;
    /** SY market PDA on the adapter (generic_exchange_rate_sy / kamino_sy_adapter). */
    syMarket: PublicKey;
    /** Underlying base mint (e.g. dUSDY / kUSDC). */
    baseMint: PublicKey;
    /** SY mint (authority = sy_market PDA). */
    syMint: PublicKey;
    /** Adapter-owned base vault holding wrapped base tokens. */
    baseVault: PublicKey;
    /** Vault's authority PDA — also the yield-position holder. */
    authority: PublicKey;
    /** Vault account. */
    vault: PublicKey;
    /** Vault's yield_position account (PDA of authority + vault). */
    yieldPosition: PublicKey;
    /** Vault's bound address-lookup-table. */
    addressLookupTable: PublicKey;
    /** core_program event-authority PDA. */
    coreEventAuthority: PublicKey;
    coreProgram?: PublicKey;
    syProgram?: PublicKey;
    routerProgram?: PublicKey;
    tokenProgram?: PublicKey;
}
export interface WrapperStripParams extends WrapperCommon {
    /** User's base-asset ATA (source). */
    baseSrc: PublicKey;
    /** User's SY ATA (pass-through, also the adapter writes the minted SY here). */
    sySrc: PublicKey;
    /** Vault's own SY escrow (destination of core.strip). */
    escrowSy: PublicKey;
    /** User's YT destination ATA. */
    ytDst: PublicKey;
    /** User's PT destination ATA. */
    ptDst: PublicKey;
    /** PT mint (vault PDA). */
    mintPt: PublicKey;
    /** YT mint (vault PDA). */
    mintYt: PublicKey;
    /** Amount of base being stripped. */
    amountBase: BN | bigint | number;
    /**
     * Any additional accounts the adapter or core require beyond the ones
     * in WrapperCommon. Forwarded via `remaining_accounts`.
     */
    remainingAccounts?: AccountMeta[];
}
/** Base → PT + YT in one instruction (adapter.mint_sy → core.strip). */
export declare function buildWrapperStrip(p: WrapperStripParams): TransactionInstruction;
export interface WrapperMergeParams extends WrapperCommon {
    /** User's SY ATA (pass-through). */
    sySrc: PublicKey;
    /** User's base-asset destination ATA. */
    baseDst: PublicKey;
    /** Vault's own SY escrow. */
    escrowSy: PublicKey;
    /** User's YT source ATA. */
    ytSrc: PublicKey;
    /** User's PT source ATA. */
    ptSrc: PublicKey;
    mintPt: PublicKey;
    mintYt: PublicKey;
    /** Amount of PT+YT being merged back (1:1 pre-maturity; PT-only at/after maturity). */
    amountPy: BN | bigint | number;
    remainingAccounts?: AccountMeta[];
}
/** PT + YT → base (core.merge → adapter.redeem_sy). */
export declare function buildWrapperMerge(p: WrapperMergeParams): TransactionInstruction;
export interface WrapperBuyPtParams extends WrapperCommon {
    baseSrc: PublicKey;
    sySrc: PublicKey;
    ptDst: PublicKey;
    market: PublicKey;
    marketEscrowSy: PublicKey;
    marketEscrowPt: PublicKey;
    marketAlt: PublicKey;
    tokenFeeTreasurySy: PublicKey;
    /** Exact PT out the user wants. */
    ptAmount: BN | bigint | number;
    /** Max base to spend (adapter mints up to this much SY). */
    maxBase: BN | bigint | number;
    /**
     * Slippage bound on the AMM. Negative — SY leaves the user when buying
     * PT. Denominated in SY base units.
     */
    maxSyIn: BN | bigint | number;
    remainingAccounts?: AccountMeta[];
}
/** Base → PT at AMM (mint_sy → trade_pt buy). Leftover SY stays in user's ATA. */
export declare function buildWrapperBuyPt(p: WrapperBuyPtParams): TransactionInstruction;
export interface WrapperBuyYtParams extends WrapperCommon {
    baseSrc: PublicKey;
    sySrc: PublicKey;
    ytDst: PublicKey;
    ptDst: PublicKey;
    market: PublicKey;
    marketEscrowSy: PublicKey;
    marketEscrowPt: PublicKey;
    marketAlt: PublicKey;
    tokenFeeTreasurySy: PublicKey;
    /** Vault authority PDA. */
    vaultAuthority: PublicKey;
    /** Vault's own SY escrow (distinct from the market escrows). */
    escrowSyVault: PublicKey;
    mintYt: PublicKey;
    mintPt: PublicKey;
    /** Vault's address_lookup_table. */
    vaultAlt: PublicKey;
    /** Base to wrap into SY up-front (adapter.mint_sy amount). */
    baseIn: BN | bigint | number;
    /** Max SY spend on the AMM leg (buy_yt's slippage bound). */
    syIn: BN | bigint | number;
    /** Exact YT out the trade should produce. */
    ytOut: BN | bigint | number;
    remainingAccounts?: AccountMeta[];
}
/**
 * Base → YT (adapter.mint_sy → core.buy_yt).
 *
 * buy_yt internally self-CPIs into `strip`, so the vault-side accounts
 * (`vault`, `vault_authority`, `escrow_sy_vault`, `mint_yt/pt`,
 * `vault_alt`, `yield_position`) are required alongside the market
 * trade accounts. This is the complement to `buildWrapperSellYt`.
 */
export declare function buildWrapperBuyYt(p: WrapperBuyYtParams): TransactionInstruction;
export interface WrapperSellPtParams extends WrapperCommon {
    /** User's SY ATA (pass-through: trade lands SY here, redeem drains it). */
    sySrc: PublicKey;
    /** User's PT source ATA. */
    ptSrc: PublicKey;
    /** User's base destination ATA. */
    baseDst: PublicKey;
    market: PublicKey;
    marketEscrowSy: PublicKey;
    marketEscrowPt: PublicKey;
    marketAlt: PublicKey;
    tokenFeeTreasurySy: PublicKey;
    /** PT amount being sold. Positive u64. */
    ptIn: BN | bigint | number;
    /** Slippage floor on the AMM leg (minimum SY out before redeem). */
    minSyOut: BN | bigint | number;
    remainingAccounts?: AccountMeta[];
}
/** PT → base (core.sell_pt → adapter.redeem_sy). */
export declare function buildWrapperSellPt(p: WrapperSellPtParams): TransactionInstruction;
export interface WrapperSellYtParams {
    user: PublicKey;
    market: PublicKey;
    /** User's YT source ATA. */
    ytSrc: PublicKey;
    /** User's PT source ATA (sell_yt self-CPIs to merge, which burns matched PT+YT). */
    ptSrc: PublicKey;
    /** User's SY ATA — pass-through for the AMM proceeds before redeem. */
    sySrc: PublicKey;
    marketEscrowSy: PublicKey;
    marketEscrowPt: PublicKey;
    marketAlt: PublicKey;
    tokenFeeTreasurySy: PublicKey;
    vault: PublicKey;
    /** Vault authority PDA. */
    vaultAuthority: PublicKey;
    /** Vault's SY escrow (per-vault, distinct from the market escrows). */
    escrowSyVault: PublicKey;
    mintYt: PublicKey;
    mintPt: PublicKey;
    /** Vault's address_lookup_table. */
    vaultAlt: PublicKey;
    /** Vault's yield_position (PDA of authority + vault). */
    yieldPosition: PublicKey;
    syMarket: PublicKey;
    baseMint: PublicKey;
    syMint: PublicKey;
    baseVault: PublicKey;
    /** User's base-asset destination ATA. */
    baseDst: PublicKey;
    /** YT amount being sold. */
    ytIn: BN | bigint | number;
    /** Slippage floor on the AMM leg (minimum SY out before redeem). */
    minSyOut: BN | bigint | number;
    coreProgram?: PublicKey;
    syProgram?: PublicKey;
    routerProgram?: PublicKey;
    tokenProgram?: PublicKey;
    coreEventAuthority: PublicKey;
    remainingAccounts?: AccountMeta[];
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
export declare function buildWrapperSellYt(p: WrapperSellYtParams): TransactionInstruction;
export declare const TODO_BUILDERS: readonly ["buildWrapperCollectInterest", "buildWrapperProvideLiquidity", "buildWrapperProvideLiquidityClassic", "buildWrapperProvideLiquidityBase", "buildWrapperWithdrawLiquidity", "buildWrapperWithdrawLiquidityClassic"];
