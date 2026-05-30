/**
 * Wrapper instruction discriminators for clearstone_router.
 *
 * Each is the first 8 bytes of `sha256("global:<snake_case_name>")`, the
 * Anchor convention. Duplicated here (rather than read from IDL at
 * runtime) so the SDK has no runtime IDL dependency.
 */
/**
 * Curator-program ix discriminators. Same sha256("global:…")[0..8]
 * convention as ROUTER_DISC. Only the user-facing ixs are included;
 * curator-auth ops (initialize_vault, set_allocations, reallocate_*,
 * mark_to_market, harvest_fees) are out of SDK scope.
 */
export declare const CURATOR_DISC: {
    readonly deposit: Buffer<ArrayBuffer>;
    readonly withdraw: Buffer<ArrayBuffer>;
    readonly createDelegation: Buffer<ArrayBuffer>;
    readonly closeDelegation: Buffer<ArrayBuffer>;
    readonly crankRollDelegated: Buffer<ArrayBuffer>;
};
/**
 * Curator-admin ix discriminators — for the keeper service. These
 * all require the curator wallet as signer. See KEEPER_PERMISSIONS.md.
 */
export declare const CURATOR_ADMIN_DISC: {
    readonly reallocateToMarket: Buffer<ArrayBuffer>;
    readonly reallocateFromMarket: Buffer<ArrayBuffer>;
    readonly markToMarket: Buffer<ArrayBuffer>;
    readonly setAllocations: Buffer<ArrayBuffer>;
    readonly harvestFees: Buffer<ArrayBuffer>;
};
export declare const ROUTER_DISC: {
    readonly wrapperStrip: Buffer<ArrayBuffer>;
    readonly wrapperMerge: Buffer<ArrayBuffer>;
    readonly wrapperBuyPt: Buffer<ArrayBuffer>;
    readonly wrapperSellPt: Buffer<ArrayBuffer>;
    readonly wrapperBuyYt: Buffer<ArrayBuffer>;
    readonly wrapperSellYt: Buffer<ArrayBuffer>;
    readonly wrapperCollectInterest: Buffer<ArrayBuffer>;
    readonly wrapperProvideLiquidity: Buffer<ArrayBuffer>;
    readonly wrapperProvideLiquidityClassic: Buffer<ArrayBuffer>;
    readonly wrapperProvideLiquidityBase: Buffer<ArrayBuffer>;
    readonly wrapperWithdrawLiquidity: Buffer<ArrayBuffer>;
    readonly wrapperWithdrawLiquidityClassic: Buffer<ArrayBuffer>;
};
/**
 * NOTE: these bytes are computed on first generation and may drift if
 * instruction names change in the router. Regenerate with:
 *
 *   node -e 'const c=require("crypto"); for (const n of
 *     ["wrapper_strip","wrapper_merge","wrapper_buy_pt","wrapper_sell_pt",
 *      "wrapper_buy_yt","wrapper_sell_yt","wrapper_collect_interest",
 *      "wrapper_provide_liquidity","wrapper_provide_liquidity_classic",
 *      "wrapper_provide_liquidity_base","wrapper_withdraw_liquidity",
 *      "wrapper_withdraw_liquidity_classic"])
 *     console.log(n, [...c.createHash("sha256")
 *       .update("global:"+n).digest().subarray(0,8)]
 *       .map(b=>"0x"+b.toString(16).padStart(2,"0")).join(","));'
 */
