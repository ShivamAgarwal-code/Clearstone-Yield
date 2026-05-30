/**
 * PDA derivations for clearstone_core accounts.
 *
 * Seeds taken directly from `programs/clearstone_core/src/seeds.rs` and
 * the market/escrow account macros. Keep in sync if upstream changes.
 */

import { PublicKey } from "@solana/web3.js";
import { CLEARSTONE_CORE_PROGRAM_ID } from "../common/constants.js";

const SEED = {
  authority: Buffer.from("authority"),
  mintPt: Buffer.from("mint_pt"),
  mintYt: Buffer.from("mint_yt"),
  escrowYt: Buffer.from("escrow_yt"),
  yieldPosition: Buffer.from("yield_position"),
  market: Buffer.from("market"),
  mintLp: Buffer.from("mint_lp"),
  escrowPt: Buffer.from("escrow_pt"),
  escrowSy: Buffer.from("escrow_sy"),
  lpPosition: Buffer.from("lp_position"),
  eventAuthority: Buffer.from("__event_authority"),
} as const;

function findPda(seeds: Buffer[], programId = CLEARSTONE_CORE_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** Vault authority PDA — signer for SY movements on behalf of the vault. */
export function vaultAuthorityPda(vault: PublicKey): PublicKey {
  return findPda([SEED.authority, vault.toBuffer()]);
}

/** PT mint — one per vault. */
export function mintPtPda(vault: PublicKey): PublicKey {
  return findPda([SEED.mintPt, vault.toBuffer()]);
}

/** YT mint — one per vault. */
export function mintYtPda(vault: PublicKey): PublicKey {
  return findPda([SEED.mintYt, vault.toBuffer()]);
}

/** Vault-owned YT escrow. */
export function escrowYtPda(vault: PublicKey): PublicKey {
  return findPda([SEED.escrowYt, vault.toBuffer()]);
}

/**
 * Yield position PDA — per (vault, holder). The vault itself holds its own
 * yield position under `vault_authority`, which is what the wrappers pass.
 */
export function yieldPositionPda(
  vault: PublicKey,
  holder: PublicKey
): PublicKey {
  return findPda([SEED.yieldPosition, vault.toBuffer(), holder.toBuffer()]);
}

/** Market PDA — one per (vault, seed_id). seed_id 1..=255 lets curators run multiple maturities per vault. */
export function marketPda(vault: PublicKey, seedId: number): PublicKey {
  return findPda([
    SEED.market,
    vault.toBuffer(),
    Buffer.from([seedId & 0xff]),
  ]);
}

/** LP mint for a market. */
export function mintLpPda(market: PublicKey): PublicKey {
  return findPda([SEED.mintLp, market.toBuffer()]);
}

/** Market PT escrow (AMM reserve). */
export function marketEscrowPtPda(market: PublicKey): PublicKey {
  return findPda([SEED.escrowPt, market.toBuffer()]);
}

/** Market SY escrow (AMM reserve). */
export function marketEscrowSyPda(market: PublicKey): PublicKey {
  return findPda([SEED.escrowSy, market.toBuffer()]);
}

/** Core-program event-authority PDA (Anchor emits events via it). */
export function coreEventAuthorityPda(): PublicKey {
  return findPda([SEED.eventAuthority]);
}

/**
 * Convenience: everything a strip/merge call needs for a given vault.
 * The caller still provides sy_program + sy_market + base mint/vault.
 */
export function deriveVaultPdas(vault: PublicKey) {
  return {
    authority: vaultAuthorityPda(vault),
    mintPt: mintPtPda(vault),
    mintYt: mintYtPda(vault),
    escrowYt: escrowYtPda(vault),
    yieldPosition: yieldPositionPda(vault, vaultAuthorityPda(vault)),
    coreEventAuthority: coreEventAuthorityPda(),
  };
}
