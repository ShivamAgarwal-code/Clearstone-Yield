/**
 * Unit tests for the hand-rolled account-offset decoders in
 * src/fixed-yield.ts.
 *
 * These are the mission-critical bits — if the offsets drift vs. the
 * clearstone_core state layout, the indexer will silently return garbage
 * maturity dates and PT prices and the retail UI will quote nonsense APYs.
 *
 * Run:  pnpm --filter backend-edge run test
 *
 * Test strategy: hand-build a byte buffer matching the documented
 * layout, write known sentinel values at the target offsets (and
 * adversarial patterns everywhere else so we catch off-by-one),
 * and assert the decoders return exactly the sentinels.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeVaultMaturity,
  decodeMarketPtPrice,
  decodeTokenAccountAmount,
  decodeCuratorVaultHeader,
  decodeCuratorVaultAllocations,
  decodeCuratorUserPositionShares,
  deriveAta,
  VAULT_START_TS_OFFSET,
  VAULT_DURATION_OFFSET,
  MARKET_PT_BALANCE_OFFSET,
  MARKET_SY_BALANCE_OFFSET,
  TOKEN_ACCOUNT_AMOUNT_OFFSET,
  TOKEN_ACCOUNT_BASE_SIZE,
  CURATOR_VAULT_TOTAL_ASSETS_OFFSET,
  CURATOR_VAULT_TOTAL_SHARES_OFFSET,
  CURATOR_VAULT_FEE_BPS_OFFSET,
  CURATOR_VAULT_ALLOCATIONS_OFFSET,
  CURATOR_ALLOCATION_SIZE,
  CURATOR_USER_POSITION_SHARES_OFFSET,
} from "../src/fixed-yield.js";
import { PublicKey } from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Helpers — build adversarially-patterned buffers so any off-by-one in
// the decoder reads obviously-wrong values instead of accidentally
// valid ones.
// ---------------------------------------------------------------------------

function patternedBuf(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

function writeU32LE(buf: Uint8Array, off: number, n: number): void {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setUint32(off, n, true);
}

function writeU64LE(buf: Uint8Array, off: number, n: bigint): void {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setBigUint64(off, n, true);
}

// ---------------------------------------------------------------------------
// decodeVaultMaturity
// ---------------------------------------------------------------------------

test("decodeVaultMaturity: reads start_ts + duration from documented offsets", () => {
  // Vault layout prefix is 331 + 4 + 4 = 339 bytes up through duration.
  const buf = patternedBuf(512);
  const startTs = 1_700_000_000; // 2023-11-14
  const duration = 90 * 24 * 60 * 60; // 90 days
  writeU32LE(buf, VAULT_START_TS_OFFSET, startTs);
  writeU32LE(buf, VAULT_DURATION_OFFSET, duration);

  const maturity = decodeVaultMaturity(buf);
  assert.equal(maturity, startTs + duration);
});

test("decodeVaultMaturity: pattern bytes elsewhere don't bleed in", () => {
  // If VAULT_START_TS_OFFSET were off by one, we'd pick up the pattern
  // byte next door instead of our sentinel. This test catches that.
  const buf = patternedBuf(512);
  const startTs = 1_600_000_000;
  const duration = 365 * 24 * 60 * 60;
  writeU32LE(buf, VAULT_START_TS_OFFSET, startTs);
  writeU32LE(buf, VAULT_DURATION_OFFSET, duration);

  // Poison the bytes adjacent to the fields with a distinctive value.
  buf[VAULT_START_TS_OFFSET - 1] = 0xcc;
  buf[VAULT_DURATION_OFFSET + 4] = 0xdd;

  assert.equal(decodeVaultMaturity(buf), startTs + duration);
});

test("decodeVaultMaturity: zero fields yield zero maturity", () => {
  const buf = patternedBuf(512);
  writeU32LE(buf, VAULT_START_TS_OFFSET, 0);
  writeU32LE(buf, VAULT_DURATION_OFFSET, 0);
  assert.equal(decodeVaultMaturity(buf), 0);
});

test("decodeVaultMaturity: max u32 values don't overflow (number-safe range)", () => {
  const buf = patternedBuf(512);
  const startTs = 0xffff_ffff;
  const duration = 0xffff_ffff;
  writeU32LE(buf, VAULT_START_TS_OFFSET, startTs);
  writeU32LE(buf, VAULT_DURATION_OFFSET, duration);
  // JS numbers are safe up to 2^53 — two u32s summed is ~8.6e9, well under.
  assert.equal(decodeVaultMaturity(buf), startTs + duration);
});

test("decodeVaultMaturity: throws on undersized buffer", () => {
  const tooSmall = new Uint8Array(VAULT_DURATION_OFFSET + 3); // one byte short
  assert.throws(() => decodeVaultMaturity(tooSmall), /too small/);
});

test("decodeVaultMaturity: accepts buffer exactly large enough", () => {
  const minSize = VAULT_DURATION_OFFSET + 4;
  const buf = new Uint8Array(minSize);
  writeU32LE(buf, VAULT_START_TS_OFFSET, 42);
  writeU32LE(buf, VAULT_DURATION_OFFSET, 100);
  assert.equal(decodeVaultMaturity(buf), 142);
});

// ---------------------------------------------------------------------------
// decodeMarketPtPrice
// ---------------------------------------------------------------------------

test("decodeMarketPtPrice: reads pt_balance + sy_balance from documented offsets", () => {
  const buf = patternedBuf(600);
  const pt = 1_000_000_000n; // 1000 PT at 6 decimals
  const sy = 976_500_000n; // 976.5 SY → PT discounted
  writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, pt);
  writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);

  const price = decodeMarketPtPrice(buf);
  // SY / PT = 0.9765 within float precision.
  assert.ok(Math.abs(price - 0.9765) < 1e-9, `price=${price}`);
});

test("decodeMarketPtPrice: zero PT reserve → 0 (no divide-by-zero)", () => {
  const buf = patternedBuf(600);
  writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, 0n);
  writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, 1_000_000n);
  assert.equal(decodeMarketPtPrice(buf), 0);
});

test("decodeMarketPtPrice: adjacent bytes don't bleed", () => {
  const buf = patternedBuf(600);
  const pt = 500_000_000n;
  const sy = 487_000_000n;
  writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, pt);
  writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);

  // Poison the bytes around the two fields.
  buf[MARKET_PT_BALANCE_OFFSET - 1] = 0xaa;
  buf[MARKET_PT_BALANCE_OFFSET + 8] = 0xbb; // between pt & sy is 0 bytes, so this is SY_BALANCE[0]
  buf[MARKET_SY_BALANCE_OFFSET + 8] = 0xcc;

  // The poison between pt & sy IS the first byte of sy_balance — the
  // fields are adjacent. So overwrite poison with the real SY after.
  writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);

  assert.ok(Math.abs(decodeMarketPtPrice(buf) - 487 / 500) < 1e-9);
});

test("decodeMarketPtPrice: typical near-maturity price (close to 1.0)", () => {
  const buf = patternedBuf(600);
  const pt = 1_000_000_000_000n;
  const sy = 998_200_000_000n; // 5d pre-maturity, ~0.9982
  writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, pt);
  writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);

  const price = decodeMarketPtPrice(buf);
  assert.ok(price > 0.99 && price < 1.0, `expected ~0.998, got ${price}`);
});

test("decodeMarketPtPrice: throws on undersized buffer", () => {
  const tooSmall = new Uint8Array(MARKET_SY_BALANCE_OFFSET + 7);
  assert.throws(() => decodeMarketPtPrice(tooSmall), /too small/);
});

test("decodeMarketPtPrice: accepts buffer exactly large enough", () => {
  const minSize = MARKET_SY_BALANCE_OFFSET + 8;
  const buf = new Uint8Array(minSize);
  writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, 100n);
  writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, 97n);
  assert.equal(decodeMarketPtPrice(buf), 0.97);
});

// ---------------------------------------------------------------------------
// decodeTokenAccountAmount
// ---------------------------------------------------------------------------

test("decodeTokenAccountAmount: reads u64 at offset 64 (classic SPL layout)", () => {
  const buf = patternedBuf(TOKEN_ACCOUNT_BASE_SIZE);
  const amount = 12_345_678_901_234n;
  writeU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET, amount);
  assert.equal(decodeTokenAccountAmount(buf), amount);
});

test("decodeTokenAccountAmount: zero balance returns 0n", () => {
  const buf = patternedBuf(TOKEN_ACCOUNT_BASE_SIZE);
  writeU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET, 0n);
  assert.equal(decodeTokenAccountAmount(buf), 0n);
});

test("decodeTokenAccountAmount: max u64 preserved as bigint", () => {
  const buf = patternedBuf(TOKEN_ACCOUNT_BASE_SIZE);
  const max = 0xffff_ffff_ffff_ffffn;
  writeU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET, max);
  assert.equal(decodeTokenAccountAmount(buf), max);
});

test("decodeTokenAccountAmount: accepts Token-2022 accounts (larger than base size)", () => {
  // Token-2022 extensions extend the account past 165 bytes — the
  // `amount` field is still at offset 64.
  const extendedSize = TOKEN_ACCOUNT_BASE_SIZE + 128;
  const buf = patternedBuf(extendedSize);
  const amount = 999_999n;
  writeU64LE(buf, TOKEN_ACCOUNT_AMOUNT_OFFSET, amount);
  assert.equal(decodeTokenAccountAmount(buf), amount);
});

test("decodeTokenAccountAmount: throws on undersized buffer", () => {
  const tooSmall = new Uint8Array(TOKEN_ACCOUNT_AMOUNT_OFFSET + 7);
  assert.throws(() => decodeTokenAccountAmount(tooSmall), /too small/);
});

test("decodeTokenAccountAmount: offset-drift guard", () => {
  assert.equal(TOKEN_ACCOUNT_AMOUNT_OFFSET, 64);
  assert.equal(TOKEN_ACCOUNT_BASE_SIZE, 165);
});

// ---------------------------------------------------------------------------
// deriveAta — regression-test against a known SPL vector
// ---------------------------------------------------------------------------

test("deriveAta: matches @solana/spl-token's getAssociatedTokenAddressSync for USDC", () => {
  // Pre-computed with @solana/spl-token@0.4.x via:
  //   getAssociatedTokenAddressSync(USDC_MINT, SYSTEM_PROGRAM_ID)
  //   → HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M
  // Regenerating if the seeds or program IDs ever change:
  //   node -e 'const s=require("@solana/spl-token"),w=require("@solana/web3.js");
  //     console.log(s.getAssociatedTokenAddressSync(
  //       new w.PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  //       new w.PublicKey("11111111111111111111111111111111")
  //     ).toBase58());'
  const owner = new PublicKey("11111111111111111111111111111111");
  const mint = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  const expected = "HJt8Tjdsc9ms9i4WCZEzhzr4oyf3ANcdzXrNdLPFqm3M";
  assert.equal(deriveAta(owner, mint).toBase58(), expected);
});

test("deriveAta: distinct mints produce distinct ATAs for same owner", () => {
  const owner = new PublicKey(
    "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA"
  );
  const a = deriveAta(
    owner,
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  );
  const b = deriveAta(
    owner,
    new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")
  );
  assert.notEqual(a.toBase58(), b.toBase58());
});

// ---------------------------------------------------------------------------
// Curator-vault decoders
// ---------------------------------------------------------------------------

function writePubkey(buf: Uint8Array, off: number, b58: string): void {
  const bytes = new PublicKey(b58).toBuffer();
  buf.set(bytes, off);
}

function writeU16LE(buf: Uint8Array, off: number, n: number): void {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setUint16(off, n, true);
}

function writeU32LEAt(buf: Uint8Array, off: number, n: number): void {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setUint32(off, n, true);
}

test("decodeCuratorVaultHeader: pulls 3 pubkeys + totals + feeBps", () => {
  const size = CURATOR_VAULT_ALLOCATIONS_OFFSET + 8;
  const buf = patternedBuf(size);
  const curator = "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA";
  const baseMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const baseEscrow = "7HUgyqN5f1dQeebEgpKtC2Hue8oHCxVphGFsbaBJ3wAL";
  writePubkey(buf, 8, curator);
  writePubkey(buf, 40, baseMint);
  writePubkey(buf, 72, baseEscrow);
  writeU64LE(buf, CURATOR_VAULT_TOTAL_ASSETS_OFFSET, 1_000_000_000n);
  writeU64LE(buf, CURATOR_VAULT_TOTAL_SHARES_OFFSET, 900_000_000n);
  writeU16LE(buf, CURATOR_VAULT_FEE_BPS_OFFSET, 2000);

  const h = decodeCuratorVaultHeader(buf);
  assert.equal(h.curator, curator);
  assert.equal(h.baseMint, baseMint);
  assert.equal(h.baseEscrow, baseEscrow);
  assert.equal(h.totalAssets, 1_000_000_000n);
  assert.equal(h.totalShares, 900_000_000n);
  assert.equal(h.feeBps, 2000);
});

test("decodeCuratorVaultHeader: throws on undersized buffer", () => {
  const tooSmall = new Uint8Array(CURATOR_VAULT_FEE_BPS_OFFSET + 1);
  assert.throws(() => decodeCuratorVaultHeader(tooSmall), /too small/);
});

test("decodeCuratorVaultAllocations: decodes a 2-entry allocations vec", () => {
  const allocStart = CURATOR_VAULT_ALLOCATIONS_OFFSET + 4;
  const size = allocStart + 2 * CURATOR_ALLOCATION_SIZE + 1;
  const buf = patternedBuf(size);
  writeU32LEAt(buf, CURATOR_VAULT_ALLOCATIONS_OFFSET, 2);

  // Entry 0
  const m0 = "11111111111111111111111111111111";
  writePubkey(buf, allocStart, m0);
  writeU16LE(buf, allocStart + 32, 6000); // 60% weight
  writeU64LE(buf, allocStart + 34, 1_000_000n);
  writeU64LE(buf, allocStart + 42, 500_000n);

  // Entry 1
  const m1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const off1 = allocStart + CURATOR_ALLOCATION_SIZE;
  writePubkey(buf, off1, m1);
  writeU16LE(buf, off1 + 32, 4000); // 40%
  writeU64LE(buf, off1 + 34, 2_000_000n);
  writeU64LE(buf, off1 + 42, 1_500_000n);

  const allocs = decodeCuratorVaultAllocations(buf);
  assert.equal(allocs.length, 2);
  assert.equal(allocs[0].market, m0);
  assert.equal(allocs[0].weightBps, 6000);
  assert.equal(allocs[0].capBase, 1_000_000n);
  assert.equal(allocs[0].deployedBase, 500_000n);
  assert.equal(allocs[1].market, m1);
  assert.equal(allocs[1].weightBps, 4000);
});

test("decodeCuratorVaultAllocations: empty vec returns []", () => {
  const size = CURATOR_VAULT_ALLOCATIONS_OFFSET + 4 + 1;
  const buf = patternedBuf(size);
  writeU32LEAt(buf, CURATOR_VAULT_ALLOCATIONS_OFFSET, 0);
  assert.deepEqual(decodeCuratorVaultAllocations(buf), []);
});

test("decodeCuratorVaultAllocations: truncated buffer returns what fits", () => {
  // Claim 3 allocations but only supply bytes for 1.
  const allocStart = CURATOR_VAULT_ALLOCATIONS_OFFSET + 4;
  const size = allocStart + CURATOR_ALLOCATION_SIZE;
  const buf = patternedBuf(size);
  writeU32LEAt(buf, CURATOR_VAULT_ALLOCATIONS_OFFSET, 3);
  writePubkey(buf, allocStart, "11111111111111111111111111111111");
  writeU16LE(buf, allocStart + 32, 10_000);

  const allocs = decodeCuratorVaultAllocations(buf);
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].weightBps, 10_000);
});

test("decodeCuratorUserPositionShares: reads u64 at offset 72", () => {
  const buf = patternedBuf(CURATOR_USER_POSITION_SHARES_OFFSET + 8);
  writeU64LE(buf, CURATOR_USER_POSITION_SHARES_OFFSET, 777_777n);
  assert.equal(decodeCuratorUserPositionShares(buf), 777_777n);
});

test("decodeCuratorUserPositionShares: zero balance returns 0n", () => {
  const buf = patternedBuf(CURATOR_USER_POSITION_SHARES_OFFSET + 8);
  writeU64LE(buf, CURATOR_USER_POSITION_SHARES_OFFSET, 0n);
  assert.equal(decodeCuratorUserPositionShares(buf), 0n);
});

test("decodeCuratorUserPositionShares: throws on undersized buffer", () => {
  const tooSmall = new Uint8Array(CURATOR_USER_POSITION_SHARES_OFFSET + 7);
  assert.throws(() => decodeCuratorUserPositionShares(tooSmall), /too small/);
});

// ---------------------------------------------------------------------------
// Offset-drift guard — if someone edits the layout and forgets to bump
// the offsets, this test gives a single spot to re-assert.
// ---------------------------------------------------------------------------

test("offset constants match source-documented layout", () => {
  // Vault: 8 disc + 32 curator + 2 fee_bps + 1 reentrancy + 8 pubkeys
  // (sy_program, mint_sy, mint_yt, mint_pt, escrow_yt, escrow_sy,
  // yield_position, address_lookup_table) × 32 = 8+32+2+1+8*32 = 299,
  // then u32 start_ts u32 duration. Earlier 331/335 were off by one
  // pubkey — bug surfaced when wiring live cssol+kUSDC stacks to
  // MARKET_REGISTRY (kUSDC vault decoded as 2011 with the old offsets).
  assert.equal(VAULT_START_TS_OFFSET, 299);
  assert.equal(VAULT_DURATION_OFFSET, 303);

  // MarketTwo: 8 + 32 + 2 + 1 + 32 + 32*7 + 2 + 32 + 1 + 1 + 32 = 365
  // financials.expiration_ts (u64) @ 365, pt_balance @ 373, sy_balance @ 381.
  assert.equal(MARKET_PT_BALANCE_OFFSET, 373);
  assert.equal(MARKET_SY_BALANCE_OFFSET, 381);

  // Token-2022 / SPL token-account amount @ 64, base size 165.
  assert.equal(TOKEN_ACCOUNT_AMOUNT_OFFSET, 64);
  assert.equal(TOKEN_ACCOUNT_BASE_SIZE, 165);

  // CuratorVault: 8 + 32*3 = 104 → total_assets, total_shares @ 112,
  // fee_bps @ 120, last_harvest_total_assets (u64) @ 122, vec-len @ 130.
  assert.equal(CURATOR_VAULT_TOTAL_ASSETS_OFFSET, 104);
  assert.equal(CURATOR_VAULT_TOTAL_SHARES_OFFSET, 112);
  assert.equal(CURATOR_VAULT_FEE_BPS_OFFSET, 120);
  assert.equal(CURATOR_VAULT_ALLOCATIONS_OFFSET, 130);
  assert.equal(CURATOR_ALLOCATION_SIZE, 50);

  // UserPosition: 8 + 32 + 32 = 72 → shares @ 72.
  assert.equal(CURATOR_USER_POSITION_SHARES_OFFSET, 72);
});
