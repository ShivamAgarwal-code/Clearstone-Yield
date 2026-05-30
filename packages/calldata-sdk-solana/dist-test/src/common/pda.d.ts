import { PublicKey } from "@solana/web3.js";
/** Derive the whitelist PDA for a given mint. */
export declare function whitelistPda(mint: PublicKey): PublicKey;
/** Derive the klend lending market authority PDA. */
export declare function marketAuthorityPda(market: PublicKey): PublicKey;
/** Derive the obligation PDA for a given market + owner. */
export declare function obligationPda(market: PublicKey, owner: PublicKey, seed?: number): PublicKey;
/** Derive the user metadata PDA for a given owner. */
export declare function userMetadataPda(owner: PublicKey): PublicKey;
/** Derive the reserve collateral supply vault PDA. */
export declare function reserveCollateralSupplyPda(reserve: PublicKey, market: PublicKey): PublicKey;
/** Derive the reserve liquidity supply vault PDA. */
export declare function reserveLiquiditySupplyPda(reserve: PublicKey, market: PublicKey): PublicKey;
/** Derive the reserve fee vault PDA. */
export declare function reserveFeeVaultPda(reserve: PublicKey, market: PublicKey): PublicKey;
/** Derive the reserve collateral (cToken) mint PDA. */
export declare function reserveCollateralMintPda(reserve: PublicKey, market: PublicKey): PublicKey;
/** Derive the associated token address. */
export declare function ata(mint: PublicKey, owner: PublicKey, tokenProgram?: PublicKey): PublicKey;
