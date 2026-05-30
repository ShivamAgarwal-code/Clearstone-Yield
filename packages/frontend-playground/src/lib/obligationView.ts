/**
 * obligationView.ts — Decoder for klend's Obligation + Reserve accounts,
 * tailored for the lending position view. Pulls only the fields needed
 * for the balance-sheet UI; full borsh decode lives in klend-sdk if you
 * need anything richer.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { obligationPda, userMetadataPda } from "./klend";

// klend stores most values as Q64.60 fixed-point (`SF`/`Sf` suffix).
// To convert to a JS number: divide the u128 by 2^60.
const SF_SHIFT = 60n;

export function sfToNumber(sf: bigint): number {
  // Avoid Number truncation on large values: split high/low.
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

// Obligation deposit slot layout (136 bytes per slot):
//   depositReserve(32) + depositedAmount(u64=8) + marketValueSf(u128=16)
//   + borrowedAmountAgainstThisCollateralInElevationGroup(u64=8) + padding(u64×9=72)
const DEPOSIT_SLOT_SIZE = 136;
const DEPOSITS_OFFSET = 96; // post-disc(8) + tag(8) + lastUpdate(16) + market(32) + owner(32)

// Obligation borrow slot layout (200 bytes per slot):
//   borrowReserve(32) + cumulativeBorrowRateBsf(BigFractionBytes=48)
//   + firstBorrowedAtTimestamp(u64=8) + borrowedAmountSf(u128=16)
//   + marketValueSf(u128=16) + borrowFactorAdjustedMarketValueSf(u128=16)
//   + borrowedAmountOutsideElevationGroups(u64=8) + padding(u64×7=56)
const BORROW_SLOT_SIZE = 200;
// borrows[5] starts at: deposits-end + lowestReserveDepositLiquidationLtv(8) + depositedValueSf(16)
//                     = 96 + 8*136 + 8 + 16 = 1208
const BORROWS_OFFSET = 1208;

// After borrows[5]: borrowFactorAdjustedDebtValueSf, borrowedAssetsMarketValueSf,
//                   allowedBorrowValueSf, unhealthyBorrowValueSf
const POST_BORROWS_OFFSET = BORROWS_OFFSET + 5 * BORROW_SLOT_SIZE; // = 2208
const ELEVATION_GROUP_OFFSET = POST_BORROWS_OFFSET + 4 * 16 + 13;   // = 2285

export interface ObligationDeposit {
  reserve: PublicKey;
  depositedCtokens: bigint; // raw cToken amount in obligation
  marketValueSf: bigint;    // total market value of this deposit position (USD, Q64.60)
}

export interface ObligationBorrow {
  reserve: PublicKey;
  borrowedAmountSf: bigint;        // total debt in liquidity units, Q64.60
  marketValueSf: bigint;           // USD, Q64.60
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

export async function readObligation(conn: Connection, owner: PublicKey, market?: PublicKey): Promise<ObligationView> {
  const obligationAddr = market ? obligationPda(owner, 0, 0, market) : obligationPda(owner);
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
    // borrowedAmountSf at off + 32 + 48 + 8 = off + 88
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

  const depositedValueSf = readU128LE(d, DEPOSITS_OFFSET + 8 * DEPOSIT_SLOT_SIZE + 8); // skip lowestReserveDepositLiquidationLtv u64
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

// klend Reserve account layout (subset). We only need:
//   - liquidity.mint (for token program lookup)
//   - liquidity.market_price_sf (current price, Q64.60)
//   - liquidity.available_amount (free liquidity for borrow/flash-borrow)
//   - liquidity.borrowed_amount_sf (total borrowed)
//   - collateral.mint_total_supply (for cToken→liquidity exchange rate)
//   - liquidity.total_liquidity (= available + borrowed)
//
// The struct is large (8624 bytes) and the codegen layout is complex;
// for the playground we only decode the fields above directly.
// Verified offsets via klend-sdk@7.3.20's Reserve.layout in
// /home/axtar-1/clearstone-finance/node_modules/.../accounts/Reserve.ts.

// Reserve account layout (post-Anchor-disc):
//   version(u64=8) + lastUpdate(16) + lendingMarket(32) + farmCollateral(32) + farmDebt(32)
//   = 120 bytes header → liquidity sub-struct starts at byte 8 + 120 = 128.
const RESERVE_LIQUIDITY_OFFSET = 8 + 8 + 16 + 32 + 32 + 32;

// ReserveLiquidity sub-struct (verified against klend-sdk@7.3.20
// types/ReserveLiquidity.ts borsh layout):
//   mintPubkey(32) + supplyVault(32) + feeVault(32) + availableAmount(u64=8)
//   + borrowedAmountSf(u128=16) + marketPriceSf(u128=16)
//   + marketPriceLastUpdatedTs(u64=8) + mintDecimals(u64=8) + ...
const LIQ_MINT = 0;
const LIQ_AVAILABLE = 32 + 32 + 32;       // = 96
const LIQ_BORROWED_SF = LIQ_AVAILABLE + 8; // = 104
const LIQ_MARKET_PRICE_SF = LIQ_BORROWED_SF + 16; // = 120
const LIQ_MINT_DECIMALS = LIQ_MARKET_PRICE_SF + 16 + 8; // = 144

export interface ReserveView {
  liquidityMint: PublicKey;
  decimals: number;
  marketPriceSf: bigint;        // USD price, Q64.60
  availableAmount: bigint;      // raw liquidity units
  borrowedAmountSf: bigint;     // raw, Q64.60
  totalLiquiditySf: bigint;     // available + borrowed, in raw units (Q64.60)
  cTokenMintTotalSupply: bigint;
  ltvPct: number;               // standalone (outside-eMode) LTV cap, 0–100
  liqThresholdPct: number;      // standalone liquidation threshold, 0–100
}

// ReserveConfig.loan_to_value_pct + liquidation_threshold_pct sit inside
// the reserve account at fixed bytes once you skip header + liquidity +
// padding + collateral + padding. Verified empirically against the v1
// csSOL reserve (ltv=55 at offset 4872, liq=65 at offset 4873). Storing
// the pair here so we don't need to import the full klend SDK in the
// frontend just to surface two u8 fields.
const RESERVE_CONFIG_LTV_OFFSET = 4872;
const RESERVE_CONFIG_LIQ_THRESHOLD_OFFSET = 4873;

/**
 * PriceUpdateV2 layout (Pyth Solana Receiver / our accrual-oracle):
 *   discriminator(8) + write_authority(32) + verification_level(1)
 *   + price_message: feed_id(32) + price(i64=8) + conf(u64=8)
 *   + exponent(i32=4) + publish_time(i64=8) + prev_publish_time(i64=8)
 *   + ema_price(i64=8) + ema_conf(u64=8) + posted_slot(u64=8) = 133 bytes
 * price field at offset 73, exponent at offset 89.
 */
function readOraclePriceSf(data: Buffer): bigint | null {
  if (data.length < 93) return null;
  const price = data.readBigInt64LE(73);
  const expo = data.readInt32LE(89);
  if (price <= 0n) return null;
  // price * 10^expo is the USD price as a real number. Convert to
  // Q64.60: multiply by 2^60 / 10^|expo|. Use BigInt powers to avoid
  // floating-point precision loss at large prices.
  const absExpo = expo < 0 ? -expo : 0; // Pyth typically uses negative exponents (-8 etc.)
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

  // Prefer the live oracle price over klend's cached `market_price_sf`.
  // klend only updates that cache when `refresh_reserve` is called; for
  // a reserve nobody has touched recently the cached value can be 0.
  // The oracle account itself is updated continuously (Pyth Receiver
  // feeds every ~30s, our accrual oracle every keeper fire).
  let marketPriceSf = cachedPriceSf;
  if (oracleInfo) {
    const livePrice = readOraclePriceSf(oracleInfo.data);
    if (livePrice !== null && livePrice > 0n) marketPriceSf = livePrice;
  }

  // For v0 we approximate cToken ↔ liquidity at 1:1 — true for fresh
  // reserves, slowly diverges with accrued borrow interest. A precise
  // version reads collateral.mintTotalSupply (in the collateral
  // sub-struct after the liquidity + 150 u64 padding).
  const cTokenMintTotalSupply = availableAmount;
  const totalLiquiditySf = (BigInt(availableAmount) << SF_SHIFT) + borrowedAmountSf;

  const ltvPct = d[RESERVE_CONFIG_LTV_OFFSET];
  const liqThresholdPct = d[RESERVE_CONFIG_LIQ_THRESHOLD_OFFSET];

  return {
    liquidityMint, decimals, marketPriceSf, availableAmount, borrowedAmountSf,
    totalLiquiditySf, cTokenMintTotalSupply, ltvPct, liqThresholdPct,
  };
}

/**
 * Convert `cTokens` (obligation collateral amount) to underlying liquidity
 * using a reserve's exchange rate. For a fresh reserve this is 1:1; as
 * borrows accrue interest, the ratio drifts so cTokens become worth more
 * underlying.
 *
 * For v1 we do the simple 1:1 approximation. A precise version reads
 * reserve.collateral.mint_total_supply and reserve.liquidity.total_liquidity
 * and computes (cTokens × total_liquidity / cToken_supply).
 */
export function cTokensToUnderlying(cTokens: bigint): bigint {
  return cTokens; // 1:1 approximation
}

/**
 * Discover all reserves belonging to a klend market. Filters
 * `getProgramAccounts` by the lending_market field at byte offset 32
 * (post-disc 8 + version 8 + lastUpdate 16). Returns shallow metadata
 * for each — full state still requires `readReserve(reserve, oracle?)`.
 */
export async function discoverMarketReserves(
  conn: Connection,
  klendProgram: PublicKey,
  market: PublicKey,
): Promise<{ reserve: PublicKey; liquidityMint: PublicKey; decimals: number }[]> {
  const accounts = await conn.getProgramAccounts(klendProgram, {
    commitment: "confirmed",
    filters: [
      // Reserve account discriminator (sha256("account:Reserve")[..8])
      // is implicit via size; klend Reserve is 8624 bytes.
      { dataSize: 8624 },
      { memcmp: { offset: 32, bytes: market.toBase58() } },
    ],
  });
  const out: { reserve: PublicKey; liquidityMint: PublicKey; decimals: number }[] = [];
  for (const a of accounts) {
    const d = a.account.data;
    const base = RESERVE_LIQUIDITY_OFFSET;
    const liquidityMint = new PublicKey(d.subarray(base + LIQ_MINT, base + LIQ_MINT + 32));
    const decimals = Number(d.readBigUInt64LE(base + LIQ_MINT_DECIMALS));
    out.push({ reserve: a.pubkey, liquidityMint, decimals });
  }
  return out;
}
