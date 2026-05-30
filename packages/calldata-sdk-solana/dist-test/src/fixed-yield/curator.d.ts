/**
 * Low-level instruction builders for `clearstone_curator`.
 *
 * The curator vault is the "savings account / auto-roll" surface: users
 * deposit base tokens and hold shares; the curator rebalances shares
 * across PT markets so rollovers happen at each market's maturity
 * without user involvement.
 *
 * Shipping in v1:
 *   - buildCuratorDeposit   — user deposits base → mints shares
 *   - buildCuratorWithdraw  — user burns shares → receives base (idle portion)
 *
 * Out of scope here (curator/keeper operations):
 *   - initialize_vault, set_allocations, reallocate_to/from_market,
 *     mark_to_market, harvest_fees. These have distinct auth (curator
 *     signer, not user) and are exposed separately via the curator
 *     frontend, not the retail SDK.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
/** `curator_vault` PDA keyed by (curator, base_mint). */
export declare function curatorVaultPda(curator: PublicKey, baseMint: PublicKey, programId?: PublicKey): PublicKey;
/** Vault-owned base token escrow. */
export declare function curatorBaseEscrowPda(vault: PublicKey, programId?: PublicKey): PublicKey;
/** Per-user position PDA keyed by (vault, owner). */
export declare function curatorUserPositionPda(vault: PublicKey, owner: PublicKey, programId?: PublicKey): PublicKey;
export interface CuratorDepositParams {
    owner: PublicKey;
    vault: PublicKey;
    baseMint: PublicKey;
    baseEscrow: PublicKey;
    baseSrc: PublicKey;
    position: PublicKey;
    amountBase: BN | bigint | number;
    tokenProgram?: PublicKey;
    programId?: PublicKey;
}
export declare function buildCuratorDeposit(p: CuratorDepositParams): TransactionInstruction;
export interface CuratorWithdrawParams {
    owner: PublicKey;
    vault: PublicKey;
    baseMint: PublicKey;
    baseDst: PublicKey;
    baseEscrow: PublicKey;
    position: PublicKey;
    /** Shares to burn. */
    shares: BN | bigint | number;
    tokenProgram?: PublicKey;
    programId?: PublicKey;
}
export declare function buildCuratorWithdraw(p: CuratorWithdrawParams): TransactionInstruction;
