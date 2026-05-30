/**
 * Tests for the fixed-yield PDA derivations (pda.ts).
 *
 * These seeds are part of the core program's ABI. A swap in seed order,
 * a change from `Buffer.from("market")` to "market_v2", or a stray
 * trailing byte would produce deterministic-but-wrong PDAs — every
 * deposit/withdraw/trade would land ConstraintSeeds.
 *
 * Strategy: pin determinism + (vault)/(market)-scoping so a drift
 * shows up here, and verify `deriveVaultPdas` composes the per-leg
 * derivations correctly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  vaultAuthorityPda,
  mintPtPda,
  mintYtPda,
  escrowYtPda,
  yieldPositionPda,
  marketPda,
  mintLpPda,
  marketEscrowPtPda,
  marketEscrowSyPda,
  coreEventAuthorityPda,
  deriveVaultPdas,
} from "../src/fixed-yield/pda.js";

const VAULT_A = new PublicKey("DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA");
const VAULT_B = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
const HOLDER = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

test("vaultAuthorityPda: deterministic per vault, distinct across vaults", () => {
  assert.equal(
    vaultAuthorityPda(VAULT_A).toBase58(),
    vaultAuthorityPda(VAULT_A).toBase58()
  );
  assert.notEqual(
    vaultAuthorityPda(VAULT_A).toBase58(),
    vaultAuthorityPda(VAULT_B).toBase58()
  );
});

test("mintPt/mintYt/escrowYt: all vault-scoped and distinct from each other", () => {
  const pt = mintPtPda(VAULT_A).toBase58();
  const yt = mintYtPda(VAULT_A).toBase58();
  const esc = escrowYtPda(VAULT_A).toBase58();
  // Distinct seeds → must produce distinct PDAs.
  assert.notEqual(pt, yt);
  assert.notEqual(pt, esc);
  assert.notEqual(yt, esc);
  // Vault-scoping: same-role PDA differs across vaults.
  assert.notEqual(pt, mintPtPda(VAULT_B).toBase58());
  assert.notEqual(yt, mintYtPda(VAULT_B).toBase58());
  assert.notEqual(esc, escrowYtPda(VAULT_B).toBase58());
});

test("yieldPositionPda: distinct per (vault, holder) pair", () => {
  const a = yieldPositionPda(VAULT_A, HOLDER).toBase58();
  assert.equal(a, yieldPositionPda(VAULT_A, HOLDER).toBase58());
  assert.notEqual(a, yieldPositionPda(VAULT_B, HOLDER).toBase58());
  const otherHolder = new PublicKey(
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  );
  assert.notEqual(a, yieldPositionPda(VAULT_A, otherHolder).toBase58());
});

test("marketPda: distinct per (vault, seedId) — enables multiple maturities per vault", () => {
  const m1 = marketPda(VAULT_A, 1).toBase58();
  const m2 = marketPda(VAULT_A, 2).toBase58();
  const m1b = marketPda(VAULT_B, 1).toBase58();
  assert.notEqual(m1, m2, "different seedIds must yield distinct PDAs");
  assert.notEqual(m1, m1b, "different vaults must yield distinct PDAs");
});

test("marketPda: seedId is masked to one byte (u8 semantics)", () => {
  // 256 & 0xff = 0, so marketPda(vault, 256) === marketPda(vault, 0).
  assert.equal(
    marketPda(VAULT_A, 0).toBase58(),
    marketPda(VAULT_A, 256).toBase58()
  );
});

test("mintLp / marketEscrowPt / marketEscrowSy: market-scoped and distinct", () => {
  const market = marketPda(VAULT_A, 1);
  const lp = mintLpPda(market).toBase58();
  const ept = marketEscrowPtPda(market).toBase58();
  const esy = marketEscrowSyPda(market).toBase58();
  assert.notEqual(lp, ept);
  assert.notEqual(lp, esy);
  assert.notEqual(ept, esy);
  // Different market → different PDAs.
  const market2 = marketPda(VAULT_B, 1);
  assert.notEqual(lp, mintLpPda(market2).toBase58());
});

test("coreEventAuthorityPda: deterministic (no args)", () => {
  assert.equal(
    coreEventAuthorityPda().toBase58(),
    coreEventAuthorityPda().toBase58()
  );
});

test("deriveVaultPdas: bundles per-vault derivations consistently", () => {
  const bundle = deriveVaultPdas(VAULT_A);
  assert.equal(
    bundle.authority.toBase58(),
    vaultAuthorityPda(VAULT_A).toBase58()
  );
  assert.equal(bundle.mintPt.toBase58(), mintPtPda(VAULT_A).toBase58());
  assert.equal(bundle.mintYt.toBase58(), mintYtPda(VAULT_A).toBase58());
  assert.equal(bundle.escrowYt.toBase58(), escrowYtPda(VAULT_A).toBase58());
  assert.equal(
    bundle.coreEventAuthority.toBase58(),
    coreEventAuthorityPda().toBase58()
  );
  // yieldPosition is specifically keyed by (vault, authority) — not (vault, user).
  assert.equal(
    bundle.yieldPosition.toBase58(),
    yieldPositionPda(VAULT_A, bundle.authority).toBase58()
  );
});
