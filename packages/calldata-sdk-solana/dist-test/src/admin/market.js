import { PublicKey, TransactionInstruction, SystemProgram, } from "@solana/web3.js";
import { KLEND_PROGRAM_ID, KLEND_GLOBAL_CONFIG, TOKEN_PROGRAM_ID, DISC, } from "../common/constants.js";
import { marketAuthorityPda, reserveCollateralSupplyPda, reserveLiquiditySupplyPda, reserveFeeVaultPda, reserveCollateralMintPda, } from "../common/pda.js";
/**
 * Build the `init_lending_market` instruction.
 *
 * @param owner     Signer — becomes market owner
 * @param marketKp  Keypair for the new lending market account
 * @param quoteCurrency  32-byte identifier (e.g. sha256("USD"))
 */
export function createLendingMarket(owner, marketKp, quoteCurrency = Buffer.alloc(32)) {
    const data = Buffer.alloc(8 + 32);
    DISC.initLendingMarket.copy(data, 0);
    quoteCurrency.copy(data, 8, 0, 32);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: marketKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: marketAuthorityPda(marketKp.publicKey), isSigner: false, isWritable: false },
            { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
        ],
        data,
    });
}
/**
 * Build the `init_reserve` instruction.
 *
 * @param owner      Market owner (signer)
 * @param market     The lending market pubkey
 * @param reserveKp  Keypair for the new reserve
 * @param mint       The token mint for this reserve
 * @param tokenProgram  TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 */
export function initReserve(owner, market, reserveKp, mint, tokenProgram = TOKEN_PROGRAM_ID) {
    const reserve = reserveKp.publicKey;
    const mAuth = marketAuthorityPda(market);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: mAuth, isSigner: false, isWritable: false },
            { pubkey: reserve, isSigner: true, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: reserveLiquiditySupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: reserveFeeVaultPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: reserveCollateralMintPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: reserveCollateralSupplyPda(reserve, market), isSigner: false, isWritable: true },
            { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
            { pubkey: tokenProgram, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
        ],
        data: DISC.initReserve,
    });
}
/**
 * Build the `update_reserve_config` instruction.
 * Each call updates a single config field.
 *
 * @param owner    Market owner (signer)
 * @param market   The lending market
 * @param reserve  The reserve to configure
 * @param mode     CONFIG_MODE variant index (u32)
 * @param value    Borsh-encoded value bytes
 * @param skipValidation  Skip integrity validation (default: true for batching)
 */
export function updateReserveConfig(owner, market, reserve, mode, value, skipValidation = true) {
    // Borsh layout: disc(8) + mode(u32 LE) + vec_len(u32 LE) + value_bytes + bool
    const data = Buffer.alloc(8 + 4 + 4 + value.length + 1);
    let offset = 0;
    DISC.updateReserveConfig.copy(data, offset);
    offset += 8;
    data.writeUInt32LE(mode, offset);
    offset += 4;
    data.writeUInt32LE(value.length, offset);
    offset += 4;
    value.copy(data, offset);
    offset += value.length;
    data.writeUInt8(skipValidation ? 1 : 0, offset);
    return new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
            { pubkey: owner, isSigner: true, isWritable: true },
            { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: reserve, isSigner: false, isWritable: true },
        ],
        data,
    });
}
// ── Helpers for building config value buffers ──
/** Encode a u64 value for config updates (LTV, thresholds, limits). */
export function u64Value(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(n);
    return buf;
}
/** Encode a pubkey value for config updates (oracle addresses). */
export function pubkeyValue(pk) {
    return pk.toBuffer();
}
/**
 * Build a batch of config update transactions with compute budget.
 * Returns an array of TransactionInstructions (prepend ComputeBudget yourself).
 */
export function configBatch(owner, market, reserve, updates) {
    return updates.map(({ mode, value }) => updateReserveConfig(owner, market, reserve, mode, value));
}
