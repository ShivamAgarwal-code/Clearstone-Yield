/**
 * Curator-admin instruction builders — for the **keeper service**.
 *
 * All ixs here require the curator wallet as signer (see
 * KEEPER_PERMISSIONS.md). The retail SDK surfaces are in `curator.ts`;
 * keep these separate so a compromised frontend can't accidentally
 * expose them.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
interface ReallocateCommon {
    /** Curator wallet — signer. Also `mut` because init_if_needed ATAs pay rent. */
    curator: PublicKey;
    vault: PublicKey;
    baseMint: PublicKey;
    /** Vault's base escrow. */
    baseEscrow: PublicKey;
    syMarket: PublicKey;
    syMint: PublicKey;
    /** Adapter-owned base pool. */
    adapterBaseVault: PublicKey;
    /** Vault-PDA-owned SY ATA. */
    vaultSyAta: PublicKey;
    market: PublicKey;
    marketEscrowPt: PublicKey;
    marketEscrowSy: PublicKey;
    tokenFeeTreasurySy: PublicKey;
    marketAlt: PublicKey;
    mintPt: PublicKey;
    mintLp: PublicKey;
    vaultPtAta: PublicKey;
    vaultLpAta: PublicKey;
    coreEventAuthority: PublicKey;
    tokenProgram?: PublicKey;
    syProgram?: PublicKey;
    coreProgram?: PublicKey;
    associatedTokenProgram?: PublicKey;
    programId?: PublicKey;
}
export interface ReallocateToMarketParams extends ReallocateCommon {
    allocationIndex: number;
    baseIn: BN | bigint | number;
    ptBuyAmount: BN | bigint | number;
    maxSyIn: BN | bigint | number;
    ptIntent: BN | bigint | number;
    syIntent: BN | bigint | number;
    minLpOut: BN | bigint | number;
}
export declare function buildReallocateToMarket(p: ReallocateToMarketParams): TransactionInstruction;
export interface ReallocateFromMarketParams extends ReallocateCommon {
    allocationIndex: number;
    lpIn: BN | bigint | number;
    minPtOut: BN | bigint | number;
    minSyOut: BN | bigint | number;
    ptSellAmount: BN | bigint | number;
    minSyForPt: BN | bigint | number;
    syRedeemAmount: BN | bigint | number;
    baseOutExpected: BN | bigint | number;
}
export declare function buildReallocateFromMarket(p: ReallocateFromMarketParams): TransactionInstruction;
export interface MarkToMarketParams {
    vault: PublicKey;
    /** Core-program Vault account for the target market. */
    coreVault: PublicKey;
    market: PublicKey;
    allocationIndex: number;
    programId?: PublicKey;
}
export declare function buildMarkToMarket(p: MarkToMarketParams): TransactionInstruction;
export {};
