/**
 * PDA derivations for clearstone_core accounts.
 *
 * Seeds taken directly from `programs/clearstone_core/src/seeds.rs` and
 * the market/escrow account macros. Keep in sync if upstream changes.
 */
import { PublicKey } from "@solana/web3.js";
/** Vault authority PDA — signer for SY movements on behalf of the vault. */
export declare function vaultAuthorityPda(vault: PublicKey): PublicKey;
/** PT mint — one per vault. */
export declare function mintPtPda(vault: PublicKey): PublicKey;
/** YT mint — one per vault. */
export declare function mintYtPda(vault: PublicKey): PublicKey;
/** Vault-owned YT escrow. */
export declare function escrowYtPda(vault: PublicKey): PublicKey;
/**
 * Yield position PDA — per (vault, holder). The vault itself holds its own
 * yield position under `vault_authority`, which is what the wrappers pass.
 */
export declare function yieldPositionPda(vault: PublicKey, holder: PublicKey): PublicKey;
/** Market PDA — one per (vault, seed_id). seed_id 1..=255 lets curators run multiple maturities per vault. */
export declare function marketPda(vault: PublicKey, seedId: number): PublicKey;
/** LP mint for a market. */
export declare function mintLpPda(market: PublicKey): PublicKey;
/** Market PT escrow (AMM reserve). */
export declare function marketEscrowPtPda(market: PublicKey): PublicKey;
/** Market SY escrow (AMM reserve). */
export declare function marketEscrowSyPda(market: PublicKey): PublicKey;
/** Core-program event-authority PDA (Anchor emits events via it). */
export declare function coreEventAuthorityPda(): PublicKey;
/**
 * Convenience: everything a strip/merge call needs for a given vault.
 * The caller still provides sy_program + sy_market + base mint/vault.
 */
export declare function deriveVaultPdas(vault: PublicKey): {
    authority: PublicKey;
    mintPt: PublicKey;
    mintYt: PublicKey;
    escrowYt: PublicKey;
    yieldPosition: PublicKey;
    coreEventAuthority: PublicKey;
};
