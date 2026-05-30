import { PublicKey } from "@solana/web3.js";
// Program IDs — KYC + lending (clearstone-finance)
// NOTE: delta-mint + governor IDs regenerated during the anchor 0.31 upgrade.
export const DELTA_MINT_PROGRAM_ID = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
export const GOVERNOR_PROGRAM_ID = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
// Program IDs — fixed-yield stack (clearstone-fixed-yield fork).
// These are the declare_id!'s on the fork's mainline branch.
export const CLEARSTONE_CORE_PROGRAM_ID = new PublicKey("EKpLcVc6rky1ah28NMZFoT2oSXkAKWcEsr6nbZziTWbC");
export const CLEARSTONE_ROUTER_PROGRAM_ID = new PublicKey("DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW");
export const CLEARSTONE_CURATOR_PROGRAM_ID = new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm");
export const KAMINO_SY_ADAPTER_PROGRAM_ID = new PublicKey("29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd");
export const GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID = new PublicKey("DZEqpkctMmB1Xq6foy1KnP3VayVFgJfykzi49fpWZ8M6");
// External programs
export const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
// Well-known mints
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDY_MINT = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");
// Pyth oracle feeds
export const PYTH_USDY_PRICE = new PublicKey("BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb");
export const PYTH_USDC_PRICE = new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD");
// klend global config PDA
export const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
// Anchor discriminators (first 8 bytes of sha256("global:<ix_name>"))
export const DISC = {
    // delta-mint
    initializeMint: Buffer.from([0x5a, 0x5d, 0xaf, 0xf5, 0xf6, 0x61, 0x7c, 0x7b]),
    addToWhitelist: Buffer.from([0xba, 0x47, 0x06, 0xef, 0x78, 0xf6, 0x4c, 0x53]),
    mintTokens: Buffer.from([0x43, 0x18, 0x88, 0x5d, 0x2a, 0x5e, 0x32, 0x14]),
    // klend — sha256("global:<snake_case>")[0..8]
    initLendingMarket: Buffer.from([0x22, 0xa2, 0x74, 0x0e, 0x65, 0x89, 0x5e, 0xef]),
    initReserve: Buffer.from([0x8a, 0xf5, 0x47, 0xe1, 0x99, 0x04, 0x03, 0x2b]),
    updateReserveConfig: Buffer.from([0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d]),
    initObligation: Buffer.from([0xfc, 0xbb, 0x5b, 0xf1, 0xa1, 0xf8, 0x9c, 0x12]),
    initUserMetadata: Buffer.from([0xfb, 0xdd, 0x31, 0x1e, 0x37, 0x2b, 0x82, 0xb5]),
    refreshReserve: Buffer.from([0x02, 0xda, 0x8a, 0x96, 0xa3, 0x16, 0x8b, 0x23]),
    depositReserveLiquidity: Buffer.from([0x64, 0x9f, 0x61, 0x68, 0xfe, 0x02, 0xd2, 0x51]),
    borrowObligationLiquidity: Buffer.from([0xe9, 0x52, 0x34, 0xb3, 0x87, 0x2f, 0xc7, 0x2e]),
    repayObligationLiquidity: Buffer.from([0x05, 0x2c, 0xb0, 0x43, 0xde, 0x53, 0x7d, 0x69]),
    withdrawObligationCollateral: Buffer.from([0x12, 0x0a, 0xa3, 0x0e, 0xb4, 0x0a, 0x00, 0xd6]),
};
// UpdateConfigMode variant discriminators (u32 LE Borsh enum)
// Full list from klend program — only include modes actually needed
export const CONFIG_MODE = {
    UpdateLoanToValuePct: 0,
    UpdateMaxLiquidationBonusBps: 1,
    UpdateLiquidationThresholdPct: 2,
    UpdateProtocolLiquidationFee: 3,
    UpdateProtocolTakeRate: 4,
    UpdateFeesBorrowFee: 5,
    UpdateFeesFlashLoanFee: 6,
    UpdateDepositLimit: 8,
    UpdateBorrowLimit: 9,
    UpdateTokenInfoLowerHeuristic: 10,
    UpdateTokenInfoUpperHeuristic: 11,
    UpdateTokenInfoExpHeuristic: 12,
    UpdateTokenInfoTwapDivergence: 13,
    UpdateTokenInfoName: 14,
    UpdateScopePriceFeed: 15,
    UpdateScopePriceChain: 16,
    UpdateScopeTwapChain: 17,
    UpdateTokenInfoMaxAgePriceSeconds: 18,
    UpdateTokenInfoMaxAgeTwapSeconds: 19,
    UpdatePythPrice: 20,
    UpdateSwitchboardPrice: 21,
    UpdateSwitchboardTwap: 22,
    UpdateBorrowRateCurve: 23,
    UpdateBorrowFactor: 25,
    UpdateAssetTier: 28,
    UpdateElevationGroup: 30,
    UpdateMultiplierSideBoost: 32,
    UpdateMultiplierTagBoost: 33,
    UpdateReserveStatus: 34,
    UpdateBadDebtLiquidationBonusBps: 39,
    UpdateMinLiquidationBonusBps: 40,
    UpdateAutodeleverageEnabled: 44,
    UpdateDepositWithdrawalCap: 46,
    UpdateDebtWithdrawalCap: 47,
    UpdateUtilizationLimitBlockBorrowingAbove: 52,
    UpdateBlockPriceUsage: 55,
};
