/**
 * obligationView.ts — Decoder for klend Obligation + Reserve accounts.
 * Verbatim port from `frontend-playground/src/lib/obligationView.ts`,
 * with the local `klend` import re-pointed to `./klendIx`.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { obligationPda, userMetadataPda } from "./klendIx";

const SF_SHIFT = 60n;

export function sfToNumber(sf: bigint): number {
  const high = sf >> SF_SHIFT;
  const lowMask = (1n << SF_SHIFT) - 1n;
  const lowFrac = Number(sf & lowMask) / 2 ** Number(SF_SHIFT);
  return Number(high) + lowFrac;
}

function readU128LE(d: Buffer, off: number): bigint {
  const lo = d.readBigUInt64LE(off);
  const hi = d.readBigUInt64LE(off + 8);
  return lo + (hi << 64n);
}

const DEPOSIT_SLOT_SIZE = 136;
const DEPOSITS_OFFSET = 96;
const BORROW_SLOT_SIZE = 200;
const BORROWS_OFFSET = 1208;
const POST_BORROWS_OFFSET = BORROWS_OFFSET + 5 * BORROW_SLOT_SIZE;
const ELEVATION_GROUP_OFFSET = POST_BORROWS_OFFSET + 4 * 16 + 13;

export interface ObligationDeposit {
  reserve: PublicKey;
  depositedCtokens: bigint;
  marketValueSf: bigint;
}

export interface ObligationBorrow {
  reserve: PublicKey;
  borrowedAmountSf: bigint;
  marketValueSf: bigint;
  borrowFactorAdjustedMarketValueSf: bigint;
}

export interface ObligationView {
  exists: boolean;
  obligationAddr: PublicKey;
  userMetaAddr: PublicKey;
  deposits: ObligationDeposit[];
  borrows: ObligationBorrow[];
  depositedValueSf: bigint;
  borrowedAssetsMarketValueSf: bigint;
  borrowFactorAdjustedDebtValueSf: bigint;
  allowedBorrowValueSf: bigint;
  unhealthyBorrowValueSf: bigint;
  elevationGroup: number;
}

export async function readObligation(conn: Connection, owner: PublicKey, marketOrId?: PublicKey | number, id = 0): Promise<ObligationView> {
  // Backwards-compat: callers used to pass `(conn, owner)` (id=0) or
  // `(conn, owner, market)`. New callers can pass `(conn, owner, id)`
  // for a specific obligation seed-id, or `(conn, owner, market, id)`
  // when both are needed.
  const market = marketOrId instanceof PublicKey ? marketOrId : undefined;
  const seedId = typeof marketOrId === "number" ? marketOrId : id;
  const obligationAddr = market ? obligationPda(owner, 0, seedId, market) : obligationPda(owner, 0, seedId);
  const userMetaAddr = userMetadataPda(owner);
  const info = await conn.getAccountInfo(obligationAddr, "confirmed");
  if (!info) {
    return {
      exists: false, obligationAddr, userMetaAddr,
      deposits: [], borrows: [],
      depositedValueSf: 0n, borrowedAssetsMarketValueSf: 0n,
      borrowFactorAdjustedDebtValueSf: 0n,
      allowedBorrowValueSf: 0n, unhealthyBorrowValueSf: 0n,
      elevationGroup: 0,
    };
  }
  const d = info.data;

  const deposits: ObligationDeposit[] = [];
  for (let i = 0; i < 8; i++) {
    const off = DEPOSITS_OFFSET + i * DEPOSIT_SLOT_SIZE;
    const reserveBytes = d.subarray(off, off + 32);
    if (!reserveBytes.some((b) => b !== 0)) continue;
    deposits.push({
      reserve: new PublicKey(reserveBytes),
      depositedCtokens: d.readBigUInt64LE(off + 32),
      marketValueSf: readU128LE(d, off + 32 + 8),
    });
  }

  const borrows: ObligationBorrow[] = [];
  for (let i = 0; i < 5; i++) {
    const off = BORROWS_OFFSET + i * BORROW_SLOT_SIZE;
    const reserveBytes = d.subarray(off, off + 32);
    if (!reserveBytes.some((b) => b !== 0)) continue;
    const borrowedAmountSf = readU128LE(d, off + 88);
    const marketValueSf = readU128LE(d, off + 88 + 16);
    const borrowFactorAdjustedMarketValueSf = readU128LE(d, off + 88 + 32);
    borrows.push({
      reserve: new PublicKey(reserveBytes),
      borrowedAmountSf,
      marketValueSf,
      borrowFactorAdjustedMarketValueSf,
    });
  }

  const depositedValueSf = readU128LE(d, DEPOSITS_OFFSET + 8 * DEPOSIT_SLOT_SIZE + 8);
  const borrowFactorAdjustedDebtValueSf = readU128LE(d, POST_BORROWS_OFFSET);
  const borrowedAssetsMarketValueSf = readU128LE(d, POST_BORROWS_OFFSET + 16);
  const allowedBorrowValueSf = readU128LE(d, POST_BORROWS_OFFSET + 32);
  const unhealthyBorrowValueSf = readU128LE(d, POST_BORROWS_OFFSET + 48);
  const elevationGroup = d[ELEVATION_GROUP_OFFSET];

  return {
    exists: true, obligationAddr, userMetaAddr,
    deposits, borrows,
    depositedValueSf, borrowedAssetsMarketValueSf,
    borrowFactorAdjustedDebtValueSf,
    allowedBorrowValueSf, unhealthyBorrowValueSf,
    elevationGroup,
  };
}

const RESERVE_LIQUIDITY_OFFSET = 8 + 8 + 16 + 32 + 32 + 32;
const LIQ_MINT = 0;
const LIQ_AVAILABLE = 32 + 32 + 32;
const LIQ_BORROWED_SF = LIQ_AVAILABLE + 8;
const LIQ_MARKET_PRICE_SF = LIQ_BORROWED_SF + 16;
const LIQ_MINT_DECIMALS = LIQ_MARKET_PRICE_SF + 16 + 8;

export interface ReserveView {
  liquidityMint: PublicKey;
  decimals: number;
  marketPriceSf: bigint;
  availableAmount: bigint;
  borrowedAmountSf: bigint;
  totalLiquiditySf: bigint;
  cTokenMintTotalSupply: bigint;
  ltvPct: number;
  liqThresholdPct: number;
  /** Reserve utilization in [0,1] — borrowed / (borrowed + available). */
  utilization: number;
  /** Live borrow APR (fraction, e.g. 0.0175 = 1.75%) interpolated
   *  from the on-chain 11-point curve at the current utilization.
   *  Klend's curve is convex by design (validated by
   *  `validate_reserve_config_integrity`) so linear interpolation
   *  between adjacent points produces a faithful read. */
  borrowApr: number;
  /** Estimated supply APR — borrowApr × utilization × (1 − protocolTakeRatePct/100).
   *  Useful for displaying the supplier-side yield on retail pages
   *  that supply liquidity into the same reserve. */
  supplyApr: number;
  /** Protocol take rate as a percentage (0–100), read from the
   *  reserve config. Subtracted from the supplier's share of
   *  interest to compute `supplyApr`. */
  protocolTakeRatePct: number;
}

const RESERVE_CONFIG_LTV_OFFSET = 4872;
const RESERVE_CONFIG_LIQ_THRESHOLD_OFFSET = 4873;
// Reserve config layout — verified against the retail decoder
// (`packages/frontend-retail/src/lib/klend.ts`). The 11-point borrow
// curve sits at +4920 (each point = u32 utilization_bps + u32
// borrow_rate_bps), the protocol take rate at +4853.
const RESERVE_CONFIG_PROTOCOL_TAKE_RATE_OFFSET = 4853;
const RESERVE_CONFIG_BORROW_CURVE_OFFSET = 4920;
const SF_SHIFT_BIG = 60n;

function readBorrowCurveAprAt(data: Buffer, utilizationBps: number): number {
  // Read 11 (util_bps, rate_bps) pairs and linear-interpolate the
  // segment containing `utilizationBps`. Stops early once a point
  // reports >=10000 util (the curve's anchored 100% endpoint), so
  // we don't read garbage past the last meaningful point.
  const points: { u: number; r: number }[] = [];
  for (let i = 0; i < 11; i++) {
    const off = RESERVE_CONFIG_BORROW_CURVE_OFFSET + i * 8;
    const u = data.readUInt32LE(off);
    const r = data.readUInt32LE(off + 4);
    points.push({ u, r });
    if (u >= 10000) break;
  }
  if (points.length === 0) return 0;
  // Past the last point — clamp to the cap rate.
  if (utilizationBps >= points[points.length - 1].u) {
    return points[points.length - 1].r / 10000;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (utilizationBps >= a.u && utilizationBps <= b.u) {
      const span = b.u - a.u;
      const t = span === 0 ? 0 : (utilizationBps - a.u) / span;
      return (a.r + t * (b.r - a.r)) / 10000;
    }
  }
  return points[0].r / 10000;
}

function readOraclePriceSf(data: Buffer): bigint | null {
  if (data.length < 93) return null;
  const price = data.readBigInt64LE(73);
  const expo = data.readInt32LE(89);
  if (price <= 0n) return null;
  const absExpo = expo < 0 ? -expo : 0;
  if (absExpo === 0) return price << SF_SHIFT;
  const tenPow = 10n ** BigInt(absExpo);
  return (price << SF_SHIFT) / tenPow;
}

export async function readReserve(conn: Connection, reserve: PublicKey, oracle?: PublicKey): Promise<ReserveView | null> {
  const accounts = oracle
    ? await conn.getMultipleAccountsInfo([reserve, oracle], "confirmed")
    : [(await conn.getAccountInfo(reserve, "confirmed")), null];
  const reserveInfo = accounts[0];
  const oracleInfo = accounts[1];
  if (!reserveInfo) return null;
  const d = reserveInfo.data;
  const base = RESERVE_LIQUIDITY_OFFSET;

  const liquidityMint = new PublicKey(d.subarray(base + LIQ_MINT, base + LIQ_MINT + 32));
  const availableAmount = d.readBigUInt64LE(base + LIQ_AVAILABLE);
  const borrowedAmountSf = readU128LE(d, base + LIQ_BORROWED_SF);
  const cachedPriceSf = readU128LE(d, base + LIQ_MARKET_PRICE_SF);
  const decimals = Number(d.readBigUInt64LE(base + LIQ_MINT_DECIMALS));

  let marketPriceSf = cachedPriceSf;
  if (oracleInfo) {
    const livePrice = readOraclePriceSf(oracleInfo.data);
    if (livePrice !== null && livePrice > 0n) marketPriceSf = livePrice;
  }

  const cTokenMintTotalSupply = availableAmount;
  const totalLiquiditySf = (BigInt(availableAmount) << SF_SHIFT) + borrowedAmountSf;

  const ltvPct = d[RESERVE_CONFIG_LTV_OFFSET];
  const liqThresholdPct = d[RESERVE_CONFIG_LIQ_THRESHOLD_OFFSET];
  const protocolTakeRatePct = d[RESERVE_CONFIG_PROTOCOL_TAKE_RATE_OFFSET];

  // Utilization computed from the same SF-scaled borrowed value the
  // klend program uses internally, so the panel's displayed APR
  // matches the rate the borrow ix would charge at this exact slot.
  const borrowedScaled = Number(borrowedAmountSf >> SF_SHIFT_BIG);
  const availableScaled = Number(availableAmount);
  const totalLiquidity = availableScaled + borrowedScaled;
  const utilization = totalLiquidity > 0 ? borrowedScaled / totalLiquidity : 0;
  const utilizationBps = Math.round(utilization * 10000);

  const borrowApr = readBorrowCurveAprAt(d, utilizationBps);
  const supplyApr = borrowApr * utilization * (1 - protocolTakeRatePct / 100);

  return {
    liquidityMint, decimals, marketPriceSf, availableAmount, borrowedAmountSf,
    totalLiquiditySf, cTokenMintTotalSupply, ltvPct, liqThresholdPct,
    utilization, borrowApr, supplyApr, protocolTakeRatePct,
  };
}

export function cTokensToUnderlying(cTokens: bigint): bigint {
  return cTokens;
}
