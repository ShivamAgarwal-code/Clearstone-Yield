import { PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
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
export declare function initializeMint(authority: PublicKey, mintKp: Keypair): TransactionInstruction;
/**
 * Build the `add_to_whitelist` instruction.
 * Adds an address to the KYC whitelist for a given mint.
 *
 * @param authority  Signer — must be mint authority
 * @param mint       The dUSDY mint
 * @param wallet     The wallet to whitelist
 */
export declare function addToWhitelist(authority: PublicKey, mint: PublicKey, wallet: PublicKey): TransactionInstruction;
/**
 * Build the `mint_tokens` instruction.
 * Mints dUSDY to a whitelisted wallet's ATA.
 *
 * @param authority  Signer — must be mint authority
 * @param mint       The dUSDY mint
 * @param recipient  Whitelisted wallet receiving tokens
 * @param amount     Amount in base units (6 decimals)
 */
export declare function mintTokens(authority: PublicKey, mint: PublicKey, recipient: PublicKey, amount: bigint): TransactionInstruction;
