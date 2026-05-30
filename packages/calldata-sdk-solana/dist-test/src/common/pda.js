import { PublicKey } from "@solana/web3.js";
import { DELTA_MINT_PROGRAM_ID, KLEND_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, } from "./constants.js";
/** Derive the whitelist PDA for a given mint. */
export function whitelistPda(mint) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("whitelist"), mint.toBuffer()], DELTA_MINT_PROGRAM_ID);
    return pda;
}
/** Derive the klend lending market authority PDA. */
export function marketAuthorityPda(market) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the obligation PDA for a given market + owner. */
export function obligationPda(market, owner, seed = 0) {
    const seedBuf = Buffer.alloc(1);
    seedBuf.writeUInt8(seed);
    const [pda] = PublicKey.findProgramAddressSync([seedBuf, Buffer.from("obligation"), market.toBuffer(), owner.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the user metadata PDA for a given owner. */
export function userMetadataPda(owner) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), owner.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the reserve collateral supply vault PDA. */
export function reserveCollateralSupplyPda(reserve, market) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), market.toBuffer(), reserve.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the reserve liquidity supply vault PDA. */
export function reserveLiquiditySupplyPda(reserve, market) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), market.toBuffer(), reserve.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the reserve fee vault PDA. */
export function reserveFeeVaultPda(reserve, market) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), market.toBuffer(), reserve.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the reserve collateral (cToken) mint PDA. */
export function reserveCollateralMintPda(reserve, market) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), market.toBuffer(), reserve.toBuffer()], KLEND_PROGRAM_ID);
    return pda;
}
/** Derive the associated token address. */
export function ata(mint, owner, tokenProgram = TOKEN_PROGRAM_ID) {
    const [pda] = PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
    return pda;
}
