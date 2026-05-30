/**
 * Off-chain quoting helpers.
 *
 * These are pure-math functions that do not touch RPC. The frontend
 * feeds them market state it has already fetched (via backend-edge's
 * `/markets` endpoint) and gets back user-displayable numbers.
 *
 * Math is deliberately simplified for v1 — the exact on-chain AMM curve
 * (scaled-log w/ virtualised reserves) is replicated in a separate
 * quoting library. For now these are "good enough to display an APY in
 * the UI" estimates that round-trip correctly with `min_out` slippage
 * bounds.
 */

import BN from "bn.js";

const YEAR_SECONDS = 365 * 24 * 60 * 60;

export interface MarketSnapshot {
  /** On-chain PT price in SY base units per PT base unit, as a decimal. */
  ptPrice: number;
  /** Market maturity timestamp (unix seconds). */
  maturityTs: number;
  /** Current unix seconds (caller-provided for determinism). */
  nowTs: number;
  /** SY exchange rate to base — e.g. kUSDC → USDC growth factor. */
  syExchangeRate: number;
}

export interface FixedApyQuote {
  /** Effective annualised fixed yield if held to maturity. */
  apy: number;
  /** Time to maturity in seconds. Clamped at 0. */
  timeToMaturity: number;
  /** Payoff ratio at maturity: base-out / base-in. */
  payoffRatio: number;
}

/**
 * Fixed APY for buying 1 PT at the current market price and holding to
 * maturity. apy = (payoff)^(year / ttm) − 1.
 */
export function quoteFixedApy(s: MarketSnapshot): FixedApyQuote {
  const ttm = Math.max(0, s.maturityTs - s.nowTs);
  const payoffRatio = s.syExchangeRate / s.ptPrice;

  if (ttm <= 0) {
    return { apy: 0, timeToMaturity: 0, payoffRatio };
  }

  const apy = Math.pow(payoffRatio, YEAR_SECONDS / ttm) - 1;
  return { apy, timeToMaturity: ttm, payoffRatio };
}

/**
 * Expected base-out at maturity for a given base-in today.
 * Useful for the "deposit X → receive Y on <date>" hero line.
 */
export function quoteTermDeposit(
  s: MarketSnapshot,
  amountBaseIn: BN | bigint | number
): {
  amountBaseOutAtMaturity: BN;
  apy: number;
} {
  const q = quoteFixedApy(s);
  const inBn = new BN(amountBaseIn.toString());
  // payoffRatio may be slightly > or < 1 depending on PT price vs SY
  // appreciation. Multiply as u64 * ratio, truncate.
  const out = inBn.muln(Math.round(q.payoffRatio * 1e6)).divn(1e6);
  return { amountBaseOutAtMaturity: out, apy: q.apy };
}

/** Inverse: "I want Y base at maturity, how much do I deposit now?" */
export function quoteRequiredDeposit(
  s: MarketSnapshot,
  amountBaseOutAtMaturity: BN | bigint | number
): {
  amountBaseIn: BN;
  apy: number;
} {
  const q = quoteFixedApy(s);
  const outBn = new BN(amountBaseOutAtMaturity.toString());
  const inBn = outBn.muln(1e6).divn(Math.round(q.payoffRatio * 1e6));
  return { amountBaseIn: inBn, apy: q.apy };
}
