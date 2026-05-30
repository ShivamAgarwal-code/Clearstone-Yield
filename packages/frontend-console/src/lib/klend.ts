/**
 * klend.ts — Kamino Lend instruction builders for the retail frontend.
 *
 * Builds raw instructions using web3.js v1 types.
 * PDA seeds follow the klend on-chain program pattern.
 */

import {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

// ---------------------------------------------------------------------------
// Discriminators — precomputed sha256("global:<name>")[0..8]
// ---------------------------------------------------------------------------

const REFRESH_RESERVE_DISC = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);
const DEPOSIT_RESERVE_LIQUIDITY_DISC = Buffer.from([169, 201, 30, 126, 6, 205, 102, 68]);
const REDEEM_RESERVE_COLLATERAL_DISC = Buffer.from([234, 117, 181, 125, 185, 142, 220, 29]);

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

export function lendingMarketAuthority(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()],
    KLEND_PROGRAM
  );
  return pda;
}

/** Reserve-derived PDA. Seeds: [seed, reserve] */
function reservePda(seed: string, reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(seed), reserve.toBuffer()],
    KLEND_PROGRAM
  );
  return pda;
}

export function reserveLiquiditySupply(reserve: PublicKey): PublicKey {
  return reservePda("reserve_liq_supply", reserve);
}

export function reserveCollateralMint(reserve: PublicKey): PublicKey {
  return reservePda("reserve_coll_mint", reserve);
}

export function reserveCollateralSupply(reserve: PublicKey): PublicKey {
  return reservePda("reserve_coll_supply", reserve);
}

export function feeReceiver(reserve: PublicKey): PublicKey {
  return reservePda("fee_receiver", reserve);
}

// ---------------------------------------------------------------------------
// Instruction: refreshReserve
// ---------------------------------------------------------------------------

export function buildRefreshReserveIx(
  reserve: PublicKey,
  market: PublicKey,
  oracle: PublicKey
): TransactionInstruction {
  // klend requires unused oracle slots to be the klend program ID itself, not PublicKey.default
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },        // pyth oracle
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false }, // switchboard price (unused)
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false }, // switchboard twap (unused)
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false }, // scope prices (unused)
    ],
    data: REFRESH_RESERVE_DISC,
  });
}

// ---------------------------------------------------------------------------
// Instruction: depositReserveLiquidity
// ---------------------------------------------------------------------------

export function buildDepositReserveLiquidityIx(
  owner: PublicKey,
  reserve: PublicKey,
  market: PublicKey,
  liquidityMint: PublicKey,
  amount: bigint,
  liquidityTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  collateralTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  userSourceLiquidity: PublicKey,
  userDestinationCollateral: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  DEPOSIT_RESERVE_LIQUIDITY_DISC.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);

  // Account order from klend source: owner, market, lma, reserve, mint, liqSupply, collMint, userCollDest, userLiqSource, collTokenProg, liqTokenProg, sysvarIx
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority(market), isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: liquidityMint, isSigner: false, isWritable: false },
      { pubkey: reserveLiquiditySupply(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralMint(reserve), isSigner: false, isWritable: true },
      { pubkey: userDestinationCollateral, isSigner: false, isWritable: true },
      { pubkey: userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: collateralTokenProgram, isSigner: false, isWritable: false },
      { pubkey: liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Instruction: redeemReserveCollateral
// ---------------------------------------------------------------------------

export function buildRedeemReserveCollateralIx(
  owner: PublicKey,
  reserve: PublicKey,
  market: PublicKey,
  liquidityMint: PublicKey,
  collateralAmount: bigint,
  liquidityTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  collateralTokenProgram: PublicKey = TOKEN_PROGRAM_ID,
  userSourceCollateral: PublicKey,
  userDestinationLiquidity: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  REDEEM_RESERVE_COLLATERAL_DISC.copy(data, 0);
  data.writeBigUInt64LE(collateralAmount, 8);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: lendingMarketAuthority(market), isSigner: false, isWritable: false },
      { pubkey: liquidityMint, isSigner: false, isWritable: false },
      { pubkey: reserveCollateralMint(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveLiquiditySupply(reserve), isSigner: false, isWritable: true },
      { pubkey: userSourceCollateral, isSigner: false, isWritable: true },
      { pubkey: userDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: collateralTokenProgram, isSigner: false, isWritable: false },
      { pubkey: liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Reserve account decoding (minimal — just the fields we need)
// ---------------------------------------------------------------------------

// Reserve account layout offsets (Anchor discriminator + fields):
// See klend IDL Reserve type. We read specific offsets from the raw data.
//
// disc: 8 bytes
// version: u64 (8)             offset 8
// last_update: LastUpdate (24)  offset 16
//   slot: u64, stale: u8, placeholder: [u8;7], price_status: u8, padding: [u8;7]
// lending_market: Pubkey (32)   offset 40
// ... many fields ...
//
// The key liquidity fields are at known offsets within ReserveLiquidity:
// ReserveLiquidity starts at offset 72 (after disc + version + last_update + lending_market):
//   mint_pubkey: Pubkey (32)     offset 72
//   supply_vault: Pubkey (32)    offset 104
//   ... (fee_vault, available_amount, etc.)

const SF_SHIFT = 60n; // scale factor for *Sf fields: value / 2^60

export interface ReserveInfo {
  /** Available liquidity in native units */
  availableAmount: bigint;
  /** Borrowed amount (scaled fraction, divide by 2^60) */
  borrowedAmountSf: bigint;
  /** Collateral mint total supply */
  cTokenMintSupply: bigint;
  /** Protocol take rate (0-100) */
  protocolTakeRatePct: number;
  /** Supply APY (estimated) */
  supplyAPY: number;
  /** Exchange rate: liquidity per cToken */
  exchangeRate: number;
}

export function decodeReserveInfo(data: Buffer): ReserveInfo | null {
  if (data.length < 5008) return null;

  // Offsets verified against klend devnet reserve D4qXufDqBjU5iTbVMHfdxDrpYnz31sed1oQCJbWoVGmH
  // Reserve account is 8624 bytes (klend v2).
  const AVAILABLE_AMOUNT_OFFSET = 224;
  const BORROWED_SF_OFFSET = 232;       // u128 (16 bytes)
  const CTOKEN_SUPPLY_OFFSET = 2592;
  const PROTOCOL_TAKE_RATE_OFFSET = 4853; // config start (4840) + 13
  const BORROW_CURVE_OFFSET = 4920;      // 11 points × 8 bytes each

  try {
    const availableAmount = data.readBigUInt64LE(AVAILABLE_AMOUNT_OFFSET);
    const borrowedAmountSf =
      data.readBigUInt64LE(BORROWED_SF_OFFSET) |
      (data.readBigUInt64LE(BORROWED_SF_OFFSET + 8) << 64n);
    const cTokenMintSupply = data.readBigUInt64LE(CTOKEN_SUPPLY_OFFSET);
    const protocolTakeRatePct = data[PROTOCOL_TAKE_RATE_OFFSET];

    const borrowedAmount = Number(borrowedAmountSf >> SF_SHIFT);
    const available = Number(availableAmount);
    const totalLiquidity = available + borrowedAmount;
    const utilization = totalLiquidity > 0 ? borrowedAmount / totalLiquidity : 0;

    // Decode borrow rate curve (11 points: {utilization_bps: u32, borrow_rate_bps: u32})
    const curvePoints: { utilBps: number; rateBps: number }[] = [];
    for (let i = 0; i < 11; i++) {
      const off = BORROW_CURVE_OFFSET + i * 8;
      const utilBps = data.readUInt32LE(off);
      const rateBps = data.readUInt32LE(off + 4);
      curvePoints.push({ utilBps, rateBps });
      if (utilBps >= 10000) break; // 100% utilization = last point
    }

    // Interpolate borrow rate from curve
    const utilBps = Math.round(utilization * 10000);
    let borrowRateBps = 0;
    for (let i = 0; i < curvePoints.length - 1; i++) {
      const a = curvePoints[i];
      const b = curvePoints[i + 1];
      if (utilBps >= a.utilBps && utilBps <= b.utilBps) {
        const t = b.utilBps === a.utilBps ? 0 : (utilBps - a.utilBps) / (b.utilBps - a.utilBps);
        borrowRateBps = a.rateBps + t * (b.rateBps - a.rateBps);
        break;
      }
    }
    if (utilBps >= (curvePoints[curvePoints.length - 1]?.utilBps ?? 10000)) {
      borrowRateBps = curvePoints[curvePoints.length - 1]?.rateBps ?? 0;
    }

    const borrowRate = borrowRateBps / 10000; // bps → fraction
    const supplyAPR = borrowRate * utilization * (1 - protocolTakeRatePct / 100);
    // Compound per slot (~400ms), ~78.9M slots/year
    const SLOTS_PER_YEAR = 78_892_314;
    const supplyAPY = supplyAPR > 0
      ? Math.pow(1 + supplyAPR / SLOTS_PER_YEAR, SLOTS_PER_YEAR) - 1
      : 0;

    return {
      availableAmount,
      borrowedAmountSf,
      cTokenMintSupply,
      protocolTakeRatePct,
      supplyAPY,
      exchangeRate: totalLiquidity > 0 && Number(cTokenMintSupply) > 0
        ? totalLiquidity / (Number(cTokenMintSupply) / 1e6)
        : 1,
    };
  } catch {
    return null;
  }
}
