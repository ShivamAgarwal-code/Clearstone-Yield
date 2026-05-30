import { PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
/**
 * Build the `init_lending_market` instruction.
 *
 * @param owner     Signer — becomes market owner
 * @param marketKp  Keypair for the new lending market account
 * @param quoteCurrency  32-byte identifier (e.g. sha256("USD"))
 */
export declare function createLendingMarket(owner: PublicKey, marketKp: Keypair, quoteCurrency?: Buffer): TransactionInstruction;
/**
 * Build the `init_reserve` instruction.
 *
 * @param owner      Market owner (signer)
 * @param market     The lending market pubkey
 * @param reserveKp  Keypair for the new reserve
 * @param mint       The token mint for this reserve
 * @param tokenProgram  TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 */
export declare function initReserve(owner: PublicKey, market: PublicKey, reserveKp: Keypair, mint: PublicKey, tokenProgram?: PublicKey): TransactionInstruction;
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
export declare function updateReserveConfig(owner: PublicKey, market: PublicKey, reserve: PublicKey, mode: number, value: Buffer, skipValidation?: boolean): TransactionInstruction;
/** Encode a u64 value for config updates (LTV, thresholds, limits). */
export declare function u64Value(n: bigint): Buffer;
/** Encode a pubkey value for config updates (oracle addresses). */
export declare function pubkeyValue(pk: PublicKey): Buffer;
/**
 * Build a batch of config update transactions with compute budget.
 * Returns an array of TransactionInstructions (prepend ComputeBudget yourself).
 */
export declare function configBatch(owner: PublicKey, market: PublicKey, reserve: PublicKey, updates: Array<{
    mode: number;
    value: Buffer;
}>): TransactionInstruction[];
