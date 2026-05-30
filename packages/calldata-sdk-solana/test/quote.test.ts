/**
 * Tests for the off-chain quoting helpers (quote.ts).
 *
 * These are pure-math functions the retail UI drives for "deposit X →
 * receive Y at APY Z%" displays. A float-precision slip here would
 * produce nonsensical APYs in the UI without breaking any builder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import {
  quoteFixedApy,
  quoteTermDeposit,
  quoteRequiredDeposit,
} from "../src/fixed-yield/quote.js";

const YEAR = 365 * 24 * 60 * 60;

test("quoteFixedApy: 30-day PT at 0.99 → roughly 13% APY", () => {
  const q = quoteFixedApy({
    ptPrice: 0.99,
    maturityTs: 1_700_000_000 + 30 * 86_400,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  });
  // (1/0.99)^(365/30) - 1 ≈ 0.1296
  assert.ok(q.apy > 0.12 && q.apy < 0.14, `apy=${q.apy}`);
  assert.equal(q.timeToMaturity, 30 * 86_400);
  assert.ok(Math.abs(q.payoffRatio - 1 / 0.99) < 1e-9);
});

test("quoteFixedApy: past-maturity returns apy=0, ttm=0, but still reports payoffRatio", () => {
  const q = quoteFixedApy({
    ptPrice: 0.95,
    maturityTs: 1_700_000_000,
    nowTs: 1_700_000_100, // 100s after maturity
    syExchangeRate: 1.0,
  });
  assert.equal(q.apy, 0);
  assert.equal(q.timeToMaturity, 0);
  assert.ok(Math.abs(q.payoffRatio - 1 / 0.95) < 1e-9);
});

test("quoteFixedApy: at-maturity edge case (ttm exactly 0) returns apy=0", () => {
  const q = quoteFixedApy({
    ptPrice: 0.95,
    maturityTs: 1_700_000_000,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  });
  assert.equal(q.apy, 0);
  assert.equal(q.timeToMaturity, 0);
});

test("quoteFixedApy: ptPrice at parity with syExchangeRate → 0% apy", () => {
  const q = quoteFixedApy({
    ptPrice: 1.0,
    maturityTs: 1_700_000_000 + YEAR,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  });
  assert.ok(Math.abs(q.apy) < 1e-12);
});

test("quoteFixedApy: 1-year PT at 0.9 → 0.1111... APY (11.11%)", () => {
  const q = quoteFixedApy({
    ptPrice: 0.9,
    maturityTs: 1_700_000_000 + YEAR,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  });
  // (1/0.9)^1 - 1 ≈ 0.1111
  assert.ok(Math.abs(q.apy - (1 / 0.9 - 1)) < 1e-9);
});

test("quoteTermDeposit: base-in → base-out matches payoffRatio, APY unchanged", () => {
  const s = {
    ptPrice: 0.98,
    maturityTs: 1_700_000_000 + 90 * 86_400,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  };
  const res = quoteTermDeposit(s, 1_000_000);
  // payoffRatio ≈ 1.0204 → out ≈ 1_020_408
  const apy = quoteFixedApy(s).apy;
  assert.equal(res.apy, apy);
  const outNum = res.amountBaseOutAtMaturity.toNumber();
  assert.ok(outNum >= 1_020_000 && outNum <= 1_020_500, `out=${outNum}`);
});

test("quoteTermDeposit: accepts BN and bigint equivalently", () => {
  const s = {
    ptPrice: 0.99,
    maturityTs: 1_700_000_000 + 30 * 86_400,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  };
  const fromNum = quoteTermDeposit(s, 1_000_000);
  const fromBig = quoteTermDeposit(s, 1_000_000n);
  const fromBn = quoteTermDeposit(s, new BN(1_000_000));
  assert.equal(
    fromNum.amountBaseOutAtMaturity.toString(),
    fromBig.amountBaseOutAtMaturity.toString()
  );
  assert.equal(
    fromNum.amountBaseOutAtMaturity.toString(),
    fromBn.amountBaseOutAtMaturity.toString()
  );
});

test("quoteRequiredDeposit: round-trips with quoteTermDeposit within rounding", () => {
  const s = {
    ptPrice: 0.97,
    maturityTs: 1_700_000_000 + 60 * 86_400,
    nowTs: 1_700_000_000,
    syExchangeRate: 1.0,
  };
  const target = 1_000_000;
  const need = quoteRequiredDeposit(s, target);
  const roundTrip = quoteTermDeposit(s, need.amountBaseIn);
  const delta = Math.abs(roundTrip.amountBaseOutAtMaturity.toNumber() - target);
  // 1e6 scaling loses precision at ~1 unit — 2-unit tolerance is safe.
  assert.ok(delta <= 2, `round-trip delta=${delta}`);
});
