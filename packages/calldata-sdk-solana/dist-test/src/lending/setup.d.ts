import { PublicKey, TransactionInstruction } from "@solana/web3.js";
/**
 * Build `init_user_metadata` instruction.
 * Creates the user metadata PDA (required before creating obligations).
 *
 * @param owner  User wallet (signer + fee payer)
 */
export declare function initUserMetadata(owner: PublicKey): TransactionInstruction;
/**
 * Build `init_obligation` instruction.
 * Creates a lending obligation for the user on a given market.
 *
 * @param owner   User wallet (signer + fee payer)
 * @param market  The lending market pubkey
 * @param seed    Obligation seed index (default 0, allows multiple obligations)
 */
export declare function initObligation(owner: PublicKey, market: PublicKey, seed?: number): TransactionInstruction;
