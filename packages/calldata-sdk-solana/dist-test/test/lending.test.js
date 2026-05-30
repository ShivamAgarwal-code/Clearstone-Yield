/**
 * Tests for the lending module (setup.ts + operations.ts).
 *
 * These are the SDK surfaces the borrow/lend UI drives. Scope is
 * narrower than the fixed-yield surface — just enough to pin
 * discriminator + arg layout + PDA resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { initUserMetadata, initObligation, } from "../src/lending/setup.js";
import { refreshReserve, deposit, withdraw, borrow, repay, } from "../src/lending/operations.js";
import { KLEND_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, DISC, } from "../src/common/constants.js";
import { marketAuthorityPda, obligationPda, userMetadataPda, reserveLiquiditySupplyPda, reserveCollateralMintPda, reserveFeeVaultPda, ata, } from "../src/common/pda.js";
const OWNER = new PublicKey("DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA");
const MARKET = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
const RESERVE = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// ---------------------------------------------------------------------------
// setup.ts
// ---------------------------------------------------------------------------
test("initUserMetadata: program + data = initUserMetadata disc, owner is signer", () => {
    const ix = initUserMetadata(OWNER);
    assert.equal(ix.programId.toBase58(), KLEND_PROGRAM_ID.toBase58());
    assert.deepEqual([...ix.data], [...DISC.initUserMetadata]);
    assert.equal(ix.keys[0].pubkey.toBase58(), OWNER.toBase58());
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[1].pubkey.toBase58(), userMetadataPda(OWNER).toBase58());
});
test("initObligation: data = disc + u64 tag(0) + u8 seed", () => {
    const ix = initObligation(OWNER, MARKET, 3);
    assert.equal(ix.data.length, 8 + 8 + 1);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.initObligation]);
    assert.equal(ix.data.readBigUInt64LE(8), 0n);
    assert.equal(ix.data[16], 3);
    // Obligation PDA uses seed=3.
    assert.equal(ix.keys[1].pubkey.toBase58(), obligationPda(MARKET, OWNER, 3).toBase58());
});
test("initObligation: defaults seed=0 when omitted", () => {
    const ix = initObligation(OWNER, MARKET);
    assert.equal(ix.data[16], 0);
    assert.equal(ix.keys[1].pubkey.toBase58(), obligationPda(MARKET, OWNER, 0).toBase58());
});
// ---------------------------------------------------------------------------
// operations.ts — refreshReserve
// ---------------------------------------------------------------------------
test("refreshReserve: exactly 6 accounts, reserve is writable, oracles are readonly", () => {
    const pyth = new PublicKey("BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb");
    const ix = refreshReserve(RESERVE, MARKET, pyth);
    assert.equal(ix.keys.length, 6);
    assert.equal(ix.keys[0].pubkey.toBase58(), RESERVE.toBase58());
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[2].pubkey.toBase58(), pyth.toBase58());
    // Unused oracle slots fall back to PublicKey.default (system program).
    for (const i of [3, 4, 5]) {
        assert.equal(ix.keys[i].pubkey.toBase58(), PublicKey.default.toBase58());
        assert.equal(ix.keys[i].isWritable, false);
    }
    assert.deepEqual([...ix.data], [...DISC.refreshReserve]);
});
// ---------------------------------------------------------------------------
// operations.ts — deposit / withdraw / borrow / repay
// ---------------------------------------------------------------------------
test("deposit: data = depositReserveLiquidity disc + u64 amount", () => {
    const ix = deposit(OWNER, MARKET, RESERVE, MINT, TOKEN_PROGRAM_ID, 1000000n);
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.depositReserveLiquidity]);
    assert.equal(ix.data.readBigUInt64LE(8), 1000000n);
});
test("deposit: key layout pins obligation, market authority, supply PDAs", () => {
    const ix = deposit(OWNER, MARKET, RESERVE, MINT, TOKEN_PROGRAM_ID, 1n);
    // Index 0=owner (signer), 1=obligation, 2=market, 3=marketAuthority, 4=reserve.
    assert.equal(ix.keys[1].pubkey.toBase58(), obligationPda(MARKET, OWNER, 0).toBase58());
    assert.equal(ix.keys[2].pubkey.toBase58(), MARKET.toBase58());
    assert.equal(ix.keys[3].pubkey.toBase58(), marketAuthorityPda(MARKET).toBase58());
    assert.equal(ix.keys[4].pubkey.toBase58(), RESERVE.toBase58());
    // Liquidity supply @ 6, cMint @ 7.
    assert.equal(ix.keys[6].pubkey.toBase58(), reserveLiquiditySupplyPda(RESERVE, MARKET).toBase58());
    assert.equal(ix.keys[7].pubkey.toBase58(), reserveCollateralMintPda(RESERVE, MARKET).toBase58());
    // user ATA uses the caller-supplied token program.
    assert.equal(ix.keys[9].pubkey.toBase58(), ata(MINT, OWNER, TOKEN_PROGRAM_ID).toBase58());
});
test("deposit: honours TOKEN_2022 token program for dUSDY-style mints", () => {
    const ix = deposit(OWNER, MARKET, RESERVE, MINT, TOKEN_2022_PROGRAM_ID, 1n);
    // user ATA at index 9 must be the TOKEN_2022 ATA.
    assert.equal(ix.keys[9].pubkey.toBase58(), ata(MINT, OWNER, TOKEN_2022_PROGRAM_ID).toBase58());
});
test("withdraw: data = disc + u64, 13 accounts (one fewer than deposit — no ATA program)", () => {
    const ix = withdraw(OWNER, MARKET, RESERVE, MINT, TOKEN_PROGRAM_ID, 1n);
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.withdrawObligationCollateral]);
    assert.equal(ix.keys.length, 13);
});
test("borrow: data = borrowObligationLiquidity disc + u64 amount; 10-key layout", () => {
    const ix = borrow(OWNER, MARKET, RESERVE, MINT, 500000n);
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.borrowObligationLiquidity]);
    assert.equal(ix.data.readBigUInt64LE(8), 500000n);
    assert.equal(ix.keys.length, 10);
    assert.equal(ix.keys[7].pubkey.toBase58(), reserveFeeVaultPda(RESERVE, MARKET).toBase58());
});
test("repay: data = repayObligationLiquidity disc + u64, 8-key layout (no cMint)", () => {
    const ix = repay(OWNER, MARKET, RESERVE, MINT, 250000n);
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.repayObligationLiquidity]);
    assert.equal(ix.keys.length, 8);
});
test("obligation PDA uses seed consistently across setup + operations", () => {
    // initObligation(seed=5) → PDA@seed=5; deposit(seed=5) must hit the
    // same PDA. A drift here silently sends deposits to the wrong obligation.
    const initIx = initObligation(OWNER, MARKET, 5);
    const depositIx = deposit(OWNER, MARKET, RESERVE, MINT, TOKEN_PROGRAM_ID, 1n, 5);
    // initObligation places obligation at keys[1]; deposit places it at keys[1] too.
    assert.equal(initIx.keys[1].pubkey.toBase58(), depositIx.keys[1].pubkey.toBase58());
});
