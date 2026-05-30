/**
 * Unit tests for the high-level zap composers.
 *
 * Zaps are what the retail UI calls. `buildZapInToPt` composes
 * `[wrapper_strip]` or `[wrapper_strip, wrapper_sell_yt]` depending on
 * whether the user wants pure PT; `buildZapOutToBase` is a thin alias
 * around `wrapper_merge`.
 *
 * The composer does non-trivial account rewiring between strip and
 * sell_yt — strip's `ytDst` / `ptDst` / `sySrc` become sell_yt's
 * `ytSrc` / `ptSrc` / `sySrc`, and strip's `baseSrc` becomes sell_yt's
 * `baseDst`. Drift in that mapping silently breaks the retail "buy and
 * hold PT" flow, so pin it here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  buildZapInToPt,
  buildZapOutToBase,
} from "../src/fixed-yield/zap.js";
import { ROUTER_DISC } from "../src/fixed-yield/constants.js";
import { CLEARSTONE_ROUTER_PROGRAM_ID } from "../src/common/constants.js";

function dummy(i: number): PublicKey {
  const arr = new Uint8Array(32);
  arr[0] = i;
  arr[1] = (i >> 8) & 0xff;
  return new PublicKey(arr);
}

// ---------------------------------------------------------------------------
// Base strip fixture. The sellYt test layers an additional bundle on
// top — separating lets us prove the strip-only path first.
// ---------------------------------------------------------------------------

function stripBase() {
  return {
    user: dummy(0x01),
    syMarket: dummy(0x02),
    baseMint: dummy(0x03),
    syMint: dummy(0x04),
    baseVault: dummy(0x05),
    authority: dummy(0x06),
    vault: dummy(0x07),
    yieldPosition: dummy(0x08),
    addressLookupTable: dummy(0x09),
    coreEventAuthority: dummy(0x0a),
    baseSrc: dummy(0x20),
    sySrc: dummy(0x21),
    escrowSy: dummy(0x22),
    ytDst: dummy(0x23),
    ptDst: dummy(0x24),
    mintPt: dummy(0x25),
    mintYt: dummy(0x26),
    amountBase: 1_000_000,
  };
}

function sellYtExtras() {
  return {
    ytIn: 1_000_000,
    minSyOut: 990_000,
    market: dummy(0x70),
    marketEscrowSy: dummy(0x71),
    marketEscrowPt: dummy(0x72),
    marketAlt: dummy(0x73),
    tokenFeeTreasurySy: dummy(0x74),
  };
}

// ---------------------------------------------------------------------------
// buildZapInToPt — strip-only branch
// ---------------------------------------------------------------------------

test("buildZapInToPt: without sellYt → returns [wrapper_strip] only", () => {
  const ixs = buildZapInToPt(stripBase());
  assert.equal(ixs.length, 1);
  assert.deepEqual(
    [...ixs[0].data.subarray(0, 8)],
    [...ROUTER_DISC.wrapperStrip]
  );
  assert.equal(
    ixs[0].programId.toBase58(),
    CLEARSTONE_ROUTER_PROGRAM_ID.toBase58()
  );
});

// ---------------------------------------------------------------------------
// buildZapInToPt — strip + sell_yt cascade
// ---------------------------------------------------------------------------

test("buildZapInToPt: with sellYt → returns [strip, sell_yt] in order", () => {
  const ixs = buildZapInToPt({ ...stripBase(), sellYt: sellYtExtras() });
  assert.equal(ixs.length, 2);
  assert.deepEqual(
    [...ixs[0].data.subarray(0, 8)],
    [...ROUTER_DISC.wrapperStrip]
  );
  assert.deepEqual(
    [...ixs[1].data.subarray(0, 8)],
    [...ROUTER_DISC.wrapperSellYt]
  );
});

test("buildZapInToPt: strip's ytDst/ptDst/sySrc become sell_yt's ytSrc/ptSrc/sySrc", () => {
  // This is the non-obvious part of the composition: strip just minted
  // PT+YT into the user's dst ATAs, and sell_yt immediately consumes
  // those as its src. A swap here produces a tx that compiles but
  // fails on-chain with InsufficientFunds.
  const base = stripBase();
  const sell = sellYtExtras();
  const [, sellIx] = buildZapInToPt({ ...base, sellYt: sell });

  const sellKeys = sellIx.keys.map((k) => k.pubkey.toBase58());
  // sell_yt expects ytSrc, ptSrc, sySrc — all 3 must be present and
  // equal to the strip side's dst ATAs.
  assert.ok(sellKeys.includes(base.ytDst.toBase58()), "ytDst → ytSrc");
  assert.ok(sellKeys.includes(base.ptDst.toBase58()), "ptDst → ptSrc");
  assert.ok(sellKeys.includes(base.sySrc.toBase58()), "sySrc flows through");
});

test("buildZapInToPt: strip's baseSrc is reused as sell_yt's baseDst (redeem destination)", () => {
  // The final leg of sell_yt's adapter.redeem_sy writes base back to
  // the user — the natural destination is the same ATA strip originally
  // drew from. If this ever drifts to a separate ATA the user would
  // need to have two base ATAs initialised.
  const base = stripBase();
  const [, sellIx] = buildZapInToPt({ ...base, sellYt: sellYtExtras() });
  const keys = sellIx.keys.map((k) => k.pubkey.toBase58());
  assert.ok(
    keys.includes(base.baseSrc.toBase58()),
    "sell_yt's baseDst must equal strip's baseSrc"
  );
});

test("buildZapInToPt: sell_yt ix carries the market-side escrows supplied in sellYt", () => {
  const base = stripBase();
  const sell = sellYtExtras();
  const [, sellIx] = buildZapInToPt({ ...base, sellYt: sell });
  const keys = new Set(sellIx.keys.map((k) => k.pubkey.toBase58()));
  for (const pk of [
    sell.market,
    sell.marketEscrowSy,
    sell.marketEscrowPt,
    sell.marketAlt,
    sell.tokenFeeTreasurySy,
  ]) {
    assert.ok(keys.has(pk.toBase58()), `sell_yt must include ${pk.toBase58()}`);
  }
});

test("buildZapInToPt: sell_yt ix carries the vault-level merge-cascade accounts", () => {
  // sell_yt self-CPIs into merge, so the vault-level bundle (vault,
  // vaultAuthority mapped from `authority`, escrowSyVault mapped from
  // `escrowSy`, mintYt/mintPt, vaultAlt mapped from
  // `addressLookupTable`, yieldPosition) must survive the composer.
  const base = stripBase();
  const [, sellIx] = buildZapInToPt({ ...base, sellYt: sellYtExtras() });
  const keys = new Set(sellIx.keys.map((k) => k.pubkey.toBase58()));
  for (const pk of [
    base.vault,
    base.authority, // → vaultAuthority
    base.escrowSy, // → escrowSyVault
    base.mintYt,
    base.mintPt,
    base.addressLookupTable, // → vaultAlt
    base.yieldPosition,
  ]) {
    assert.ok(keys.has(pk.toBase58()), `sell_yt must include ${pk.toBase58()}`);
  }
});

test("buildZapInToPt: strip data carries amountBase, sell_yt data carries (ytIn, minSyOut)", () => {
  const base = stripBase();
  const sell = { ...sellYtExtras(), ytIn: 0x1111n, minSyOut: 0x2222n };
  const [stripIx, sellIx] = buildZapInToPt({
    ...base,
    amountBase: 0x3333n,
    sellYt: sell,
  });
  // strip: u64 amountBase @ 8..16
  assert.equal(stripIx.data[8], 0x33);
  assert.equal(stripIx.data[9], 0x33);
  // sell_yt: u64 ytIn @ 8..16, u64 minSyOut @ 16..24
  assert.equal(sellIx.data[8], 0x11);
  assert.equal(sellIx.data[9], 0x11);
  assert.equal(sellIx.data[16], 0x22);
  assert.equal(sellIx.data[17], 0x22);
});

// ---------------------------------------------------------------------------
// buildZapOutToBase — thin alias
// ---------------------------------------------------------------------------

test("buildZapOutToBase: returns a single wrapper_merge ix", () => {
  const ix = buildZapOutToBase({
    user: dummy(0x01),
    syMarket: dummy(0x02),
    baseMint: dummy(0x03),
    syMint: dummy(0x04),
    baseVault: dummy(0x05),
    authority: dummy(0x06),
    vault: dummy(0x07),
    yieldPosition: dummy(0x08),
    addressLookupTable: dummy(0x09),
    coreEventAuthority: dummy(0x0a),
    sySrc: dummy(0x30),
    baseDst: dummy(0x31),
    escrowSy: dummy(0x32),
    ytSrc: dummy(0x33),
    ptSrc: dummy(0x34),
    mintPt: dummy(0x35),
    mintYt: dummy(0x36),
    amountPy: 500_000,
  });
  assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperMerge]);
  assert.equal(
    ix.programId.toBase58(),
    CLEARSTONE_ROUTER_PROGRAM_ID.toBase58()
  );
});
