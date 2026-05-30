import { TransactionInstruction, SystemProgram, } from "@solana/web3.js";
import { DELTA_MINT_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, DISC, } from "../common/constants.js";
import { whitelistPda, ata } from "../common/pda.js";
/**
 * Build the `initialize_mint` instruction for delta-mint.
 * Creates a new Token-2022 mint with:
 *   - Transfer hook (KYC gating)
 *   - Confidential transfers (auto_approve = false)
 *   - Permanent delegate (for compliance freezes)
 *
 * @param authority  Signer — becomes mint authority
 * @param mintKp     Keypair for the new mint account
 * @returns          TransactionInstruction
 */
export function initializeMint(authority, mintKp) {
    return new TransactionInstruction({
        programId: DELTA_MINT_PROGRAM_ID,
        keys: [
            { pubkey: authority, isSigner: true, isWritable: true },
            { pubkey: mintKp.publicKey, isSigner: true, isWritable: true },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: DISC.initializeMint,
    });
}
/**
 * Build the `add_to_whitelist` instruction.
 * Adds an address to the KYC whitelist for a given mint.
 *
 * @param authority  Signer — must be mint authority
 * @param mint       The dUSDY mint
 * @param wallet     The wallet to whitelist
 */
export function addToWhitelist(authority, mint, wallet) {
    const wlPda = whitelistPda(mint);
    return new TransactionInstruction({
        programId: DELTA_MINT_PROGRAM_ID,
        keys: [
            { pubkey: authority, isSigner: true, isWritable: true },
            { pubkey: wlPda, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: wallet, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
            DISC.addToWhitelist,
            wallet.toBuffer(),
        ]),
    });
}
/**
 * Build the `mint_tokens` instruction.
 * Mints dUSDY to a whitelisted wallet's ATA.
 *
 * @param authority  Signer — must be mint authority
 * @param mint       The dUSDY mint
 * @param recipient  Whitelisted wallet receiving tokens
 * @param amount     Amount in base units (6 decimals)
 */
export function mintTokens(authority, mint, recipient, amount) {
    const recipientAta = ata(mint, recipient, TOKEN_2022_PROGRAM_ID);
    const wlPda = whitelistPda(mint);
    const data = Buffer.alloc(16);
    DISC.mintTokens.copy(data, 0);
    data.writeBigUInt64LE(amount, 8);
    return new TransactionInstruction({
        programId: DELTA_MINT_PROGRAM_ID,
        keys: [
            { pubkey: authority, isSigner: true, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: true },
            { pubkey: recipientAta, isSigner: false, isWritable: true },
            { pubkey: wlPda, isSigner: false, isWritable: false },
            { pubkey: recipient, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
    });
}
