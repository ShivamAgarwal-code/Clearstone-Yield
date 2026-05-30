/**
 * Unit tests for the curator-admin instruction builders.
 *
 * These are the keeper hot-path: reallocate_to_market, reallocate_from_market,
 * mark_to_market. A wire-format drift here silently breaks every rebalance
 * the keeper tries to land, so pin discriminator bytes, account slots, and
 * argument encoding to the spec.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import {
  buildReallocateToMarket,
  buildReallocateFromMarket,
  buildMarkToMarket,
} from "../src/fixed-yield/curator-admin.js";
import { CURATOR_ADMIN_DISC } from "../src/fixed-yield/constants.js";
import {
  CLEARSTONE_CURATOR_PROGRAM_ID,
  CLEARSTONE_CORE_PROGRAM_ID,
  GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "../src/common/constants.js";

// ---------------------------------------------------------------------------
// Deterministic filler keys. Each slot gets a unique byte so a swap in the
// builder shows up as a specific index mismatch rather than a blurred diff.
// ---------------------------------------------------------------------------
function dummy(i: number): PublicKey {
  const arr = new Uint8Array(32);
  arr[0] = i;
  return new PublicKey(arr);
}

function reallocateCommon() {
  return {
    curator: dummy(0x01),
    vault: dummy(0x02),
    baseMint: dummy(0x03),
    baseEscrow: dummy(0x04),
    syMarket: dummy(0x05),
    syMint: dummy(0x06),
    adapterBaseVault: dummy(0x07),
    vaultSyAta: dummy(0x08),
    market: dummy(0x09),
    marketEscrowPt: dummy(0x0a),
    marketEscrowSy: dummy(0x0b),
    tokenFeeTreasurySy: dummy(0x0c),
    marketAlt: dummy(0x0d),
    mintPt: dummy(0x0e),
    mintLp: dummy(0x0f),
    vaultPtAta: dummy(0x10),
    vaultLpAta: dummy(0x11),
    coreEventAuthority: dummy(0x12),
  };
}

// ---------------------------------------------------------------------------
// reallocate_to_market
// ---------------------------------------------------------------------------

test("buildReallocateToMarket: programId defaults to CLEARSTONE_CURATOR_PROGRAM_ID", () => {
  const ix = buildReallocateToMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    baseIn: 1,
    ptBuyAmount: 1,
    maxSyIn: 1,
    ptIntent: 1,
    syIntent: 1,
    minLpOut: 1,
  });
  assert.equal(
    ix.programId.toBase58(),
    CLEARSTONE_CURATOR_PROGRAM_ID.toBase58()
  );
});

test("buildReallocateToMarket: data prefix matches discriminator", () => {
  const ix = buildReallocateToMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    baseIn: 0,
    ptBuyAmount: 0,
    maxSyIn: 0,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
  });
  assert.deepEqual(
    [...ix.data.subarray(0, 8)],
    [...CURATOR_ADMIN_DISC.reallocateToMarket]
  );
});

test("buildReallocateToMarket: args = u16 idx | u64 baseIn | u64 ptBuy | i64 maxSy | u64 ptIntent | u64 syIntent | u64 minLp", () => {
  const ix = buildReallocateToMarket({
    ...reallocateCommon(),
    allocationIndex: 0x1234,
    baseIn: 1,
    ptBuyAmount: 2,
    maxSyIn: 3,
    ptIntent: 4,
    syIntent: 5,
    minLpOut: 6,
  });
  // Total = 8 (disc) + 2 (u16) + 8*6 (u64/i64) = 58 bytes.
  assert.equal(ix.data.length, 58);
  // allocationIndex u16 LE at 8..10
  assert.equal(ix.data[8], 0x34);
  assert.equal(ix.data[9], 0x12);
  // baseIn u64 LE at 10..18
  assert.equal(ix.data[10], 1);
  for (let i = 11; i < 18; i++) assert.equal(ix.data[i], 0);
  // ptBuyAmount u64 LE at 18..26
  assert.equal(ix.data[18], 2);
  // maxSyIn i64 LE at 26..34
  assert.equal(ix.data[26], 3);
  // ptIntent u64 LE at 34..42
  assert.equal(ix.data[34], 4);
  // syIntent u64 LE at 42..50
  assert.equal(ix.data[42], 5);
  // minLpOut u64 LE at 50..58
  assert.equal(ix.data[50], 6);
});

test("buildReallocateToMarket: maxSyIn encodes negative as two's complement i64", () => {
  // i64le(-1) → 0xff * 8
  const ix = buildReallocateToMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    baseIn: 0,
    ptBuyAmount: 0,
    maxSyIn: -1,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
  });
  for (let i = 26; i < 34; i++) {
    assert.equal(ix.data[i], 0xff, `byte ${i} of i64 two's-complement -1`);
  }
});

test("buildReallocateToMarket: accepts BN and bigint inputs equivalently", () => {
  const common = reallocateCommon();
  const bigVal = 0x0102030405060708n;
  const fromBigint = buildReallocateToMarket({
    ...common,
    allocationIndex: 0,
    baseIn: bigVal,
    ptBuyAmount: 0,
    maxSyIn: 0,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
  });
  const fromBn = buildReallocateToMarket({
    ...common,
    allocationIndex: 0,
    baseIn: new BN("0102030405060708", 16),
    ptBuyAmount: 0,
    maxSyIn: 0,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
  });
  assert.deepEqual([...fromBigint.data], [...fromBn.data]);
});

test("buildReallocateToMarket: 23-key layout — curator is sole signer, ATA+System trailing", () => {
  const common = reallocateCommon();
  const ix = buildReallocateToMarket({
    ...common,
    allocationIndex: 0,
    baseIn: 0,
    ptBuyAmount: 0,
    maxSyIn: 0,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
  });
  assert.equal(ix.keys.length, 23, "reallocate_to_market has init_if_needed → includes ATA+System");

  // Signers: only curator.
  const signers = ix.keys.filter((k) => k.isSigner);
  assert.equal(signers.length, 1);
  assert.equal(signers[0].pubkey.toBase58(), common.curator.toBase58());
  assert.equal(signers[0].isWritable, true, "curator funds rent → must be mut");

  // Readonly account slots from reallocateKeys (baseMint, syMarket, marketAlt,
  // mintPt, tokenProgram, syProgram, coreProgram, coreEventAuthority,
  // associatedTokenProgram, systemProgram).
  const readonlyIndices = [2, 4, 12, 13, 17, 18, 19, 20, 21, 22];
  for (const i of readonlyIndices) {
    assert.equal(ix.keys[i].isWritable, false, `index ${i} must be readonly`);
  }

  // Writable account slots (vault, baseEscrow, syMint, adapterBaseVault,
  // vaultSyAta, market, marketEscrowPt, marketEscrowSy, tokenFeeTreasurySy,
  // mintLp, vaultPtAta, vaultLpAta).
  const writableIndices = [1, 3, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16];
  for (const i of writableIndices) {
    assert.equal(ix.keys[i].isWritable, true, `index ${i} must be writable`);
  }
});

test("buildReallocateToMarket: trailing programs are the expected defaults", () => {
  const ix = buildReallocateToMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    baseIn: 0,
    ptBuyAmount: 0,
    maxSyIn: 0,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
  });
  assert.equal(ix.keys[17].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(
    ix.keys[18].pubkey.toBase58(),
    GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID.toBase58()
  );
  assert.equal(
    ix.keys[19].pubkey.toBase58(),
    CLEARSTONE_CORE_PROGRAM_ID.toBase58()
  );
  assert.equal(
    ix.keys[21].pubkey.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
  );
  assert.equal(
    ix.keys[22].pubkey.toBase58(),
    SystemProgram.programId.toBase58()
  );
});

test("buildReallocateToMarket: program overrides are honoured", () => {
  const override = dummy(0xfe);
  const ix = buildReallocateToMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    baseIn: 0,
    ptBuyAmount: 0,
    maxSyIn: 0,
    ptIntent: 0,
    syIntent: 0,
    minLpOut: 0,
    tokenProgram: override,
    programId: override,
  });
  assert.equal(ix.programId.toBase58(), override.toBase58());
  assert.equal(ix.keys[17].pubkey.toBase58(), override.toBase58());
});

// ---------------------------------------------------------------------------
// reallocate_from_market
// ---------------------------------------------------------------------------

test("buildReallocateFromMarket: data prefix matches discriminator", () => {
  const ix = buildReallocateFromMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    lpIn: 0,
    minPtOut: 0,
    minSyOut: 0,
    ptSellAmount: 0,
    minSyForPt: 0,
    syRedeemAmount: 0,
    baseOutExpected: 0,
  });
  assert.deepEqual(
    [...ix.data.subarray(0, 8)],
    [...CURATOR_ADMIN_DISC.reallocateFromMarket]
  );
});

test("buildReallocateFromMarket: args = u16 idx | u64 lpIn | u64 minPtOut | u64 minSyOut | u64 ptSell | i64 minSyForPt | u64 syRedeem | u64 baseOut", () => {
  const ix = buildReallocateFromMarket({
    ...reallocateCommon(),
    allocationIndex: 0x0042,
    lpIn: 1,
    minPtOut: 2,
    minSyOut: 3,
    ptSellAmount: 4,
    minSyForPt: 5,
    syRedeemAmount: 6,
    baseOutExpected: 7,
  });
  // 8 disc + 2 u16 + 8*7 = 66 bytes.
  assert.equal(ix.data.length, 66);
  assert.equal(ix.data[8], 0x42);
  assert.equal(ix.data[9], 0x00);
  // lpIn at 10, minPtOut at 18, minSyOut at 26, ptSellAmount at 34,
  // minSyForPt at 42, syRedeemAmount at 50, baseOutExpected at 58.
  assert.equal(ix.data[10], 1);
  assert.equal(ix.data[18], 2);
  assert.equal(ix.data[26], 3);
  assert.equal(ix.data[34], 4);
  assert.equal(ix.data[42], 5);
  assert.equal(ix.data[50], 6);
  assert.equal(ix.data[58], 7);
});

test("buildReallocateFromMarket: minSyForPt encodes negative as two's complement i64", () => {
  const ix = buildReallocateFromMarket({
    ...reallocateCommon(),
    allocationIndex: 0,
    lpIn: 0,
    minPtOut: 0,
    minSyOut: 0,
    ptSellAmount: 0,
    minSyForPt: -1,
    syRedeemAmount: 0,
    baseOutExpected: 0,
  });
  // minSyForPt starts at 8+2+8*4 = 42.
  for (let i = 42; i < 50; i++) {
    assert.equal(ix.data[i], 0xff, `byte ${i} of i64 two's-complement -1`);
  }
});

test("buildReallocateFromMarket: 21-key layout — no ATA+System (no init_if_needed)", () => {
  const common = reallocateCommon();
  const ix = buildReallocateFromMarket({
    ...common,
    allocationIndex: 0,
    lpIn: 0,
    minPtOut: 0,
    minSyOut: 0,
    ptSellAmount: 0,
    minSyForPt: 0,
    syRedeemAmount: 0,
    baseOutExpected: 0,
  });
  assert.equal(
    ix.keys.length,
    21,
    "reallocate_from_market has no init_if_needed → no ATA / System at tail"
  );

  // Curator is still the only signer.
  const signers = ix.keys.filter((k) => k.isSigner);
  assert.equal(signers.length, 1);
  assert.equal(signers[0].pubkey.toBase58(), common.curator.toBase58());

  // Last key must be core_event_authority (not System).
  assert.equal(
    ix.keys[20].pubkey.toBase58(),
    common.coreEventAuthority.toBase58()
  );
});

// ---------------------------------------------------------------------------
// mark_to_market — permissionless (no signer)
// ---------------------------------------------------------------------------

test("buildMarkToMarket: data = disc + u16 allocationIndex", () => {
  const ix = buildMarkToMarket({
    vault: dummy(0x01),
    coreVault: dummy(0x02),
    market: dummy(0x03),
    allocationIndex: 0x0102,
  });
  assert.equal(ix.data.length, 10); // 8 disc + 2 u16
  assert.deepEqual(
    [...ix.data.subarray(0, 8)],
    [...CURATOR_ADMIN_DISC.markToMarket]
  );
  assert.equal(ix.data[8], 0x02);
  assert.equal(ix.data[9], 0x01);
});

test("buildMarkToMarket: permissionless — no signer, only vault is writable", () => {
  const ix = buildMarkToMarket({
    vault: dummy(0x01),
    coreVault: dummy(0x02),
    market: dummy(0x03),
    allocationIndex: 0,
  });
  assert.equal(ix.keys.length, 3);
  const signers = ix.keys.filter((k) => k.isSigner);
  assert.equal(signers.length, 0, "mark_to_market is permissionless");
  assert.equal(ix.keys[0].isWritable, true, "vault must be writable");
  assert.equal(ix.keys[1].isWritable, false);
  assert.equal(ix.keys[2].isWritable, false);
});

test("buildMarkToMarket: programId defaults to CLEARSTONE_CURATOR_PROGRAM_ID and can be overridden", () => {
  const defaulted = buildMarkToMarket({
    vault: dummy(0x01),
    coreVault: dummy(0x02),
    market: dummy(0x03),
    allocationIndex: 0,
  });
  assert.equal(
    defaulted.programId.toBase58(),
    CLEARSTONE_CURATOR_PROGRAM_ID.toBase58()
  );

  const override = dummy(0xfe);
  const custom = buildMarkToMarket({
    vault: dummy(0x01),
    coreVault: dummy(0x02),
    market: dummy(0x03),
    allocationIndex: 0,
    programId: override,
  });
  assert.equal(custom.programId.toBase58(), override.toBase58());
});
