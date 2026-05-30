/**
 * klend `UpdateLendingMarket(UpdateElevationGroup)` ix builder.
 *
 * The klend program exposes one ix `update_lending_market(mode: u64, value: [u8; 72])`
 * whose `mode` value selects a variant of `UpdateLendingMarketMode`. Mode 9 =
 * `UpdateElevationGroup` and the value bytes are a borsh-packed `ElevationGroup`:
 *
 *   max_liquidation_bonus_bps : u16   (2)
 *   id                        : u8    (1)
 *   ltv_pct                   : u8    (1)
 *   liquidation_threshold_pct : u8    (1)
 *   allow_new_loans           : u8    (1)
 *   max_reserves_as_collateral: u8    (1)
 *   padding0                  : u8    (1)
 *   debt_reserve              : Pubkey(32)
 *   padding1                  : [u64; 4](32)
 *   ─────────────────────────────────
 *   total                     : 72 bytes ✓
 *
 * id=0 is reserved by klend as "no group" and cannot be configured here. Use
 * id ∈ [1, 32]. Each group has exactly one debt reserve. Collateral reserves
 * are NOT specified at the market level — instead each reserve carries an
 * `elevation_groups: [u8; 20]` array via `update_reserve_config`, listing the
 * group ids in which it can be pledged.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import * as crypto from "crypto";

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

const UPDATE_LENDING_MARKET_DISC = crypto
  .createHash("sha256")
  .update("global:update_lending_market")
  .digest()
  .subarray(0, 8);

export const UPDATE_LENDING_MARKET_MODE_UPDATE_ELEVATION_GROUP = 9n;

export interface ElevationGroupParams {
  id: number;                          // 1..=32
  ltvPct: number;                      // 0..=100
  liquidationThresholdPct: number;     // ≥ ltvPct, ≤ 100
  maxLiquidationBonusBps: number;      // u16
  allowNewLoans: 0 | 1;
  maxReservesAsCollateral: number;     // u8 — typically 1
  debtReserve: PublicKey;
}

function packElevationGroup(p: ElevationGroupParams): Buffer {
  if (p.id < 1 || p.id > 32) throw new Error(`elevation group id must be 1..=32, got ${p.id}`);
  if (p.liquidationThresholdPct < p.ltvPct) {
    throw new Error("liquidationThresholdPct must be >= ltvPct");
  }
  const buf = Buffer.alloc(72);
  let off = 0;
  buf.writeUInt16LE(p.maxLiquidationBonusBps, off); off += 2;
  buf.writeUInt8(p.id, off); off += 1;
  buf.writeUInt8(p.ltvPct, off); off += 1;
  buf.writeUInt8(p.liquidationThresholdPct, off); off += 1;
  buf.writeUInt8(p.allowNewLoans, off); off += 1;
  buf.writeUInt8(p.maxReservesAsCollateral, off); off += 1;
  buf.writeUInt8(0, off); off += 1;            // padding0
  p.debtReserve.toBuffer().copy(buf, off); off += 32;
  // padding1: [u64; 4] = 32 zero bytes (already zero-initialized)
  return buf;
}

/**
 * Build the ix that registers / updates an elevation group on a market.
 * Caller must be the market's `lending_market_owner`.
 */
export function buildUpdateElevationGroupIx(
  marketOwner: PublicKey,
  lendingMarket: PublicKey,
  group: ElevationGroupParams,
): TransactionInstruction {
  // Layout: disc(8) + mode(u64) + value([u8; 72])  — value is fixed-size, no length prefix.
  const data = Buffer.alloc(8 + 8 + 72);
  let off = 0;
  UPDATE_LENDING_MARKET_DISC.copy(data, off); off += 8;
  data.writeBigUInt64LE(UPDATE_LENDING_MARKET_MODE_UPDATE_ELEVATION_GROUP, off); off += 8;
  packElevationGroup(group).copy(data, off);

  const keys: AccountMeta[] = [
    { pubkey: marketOwner, isSigner: true, isWritable: false },
    { pubkey: lendingMarket, isSigner: false, isWritable: true },
  ];
  return new TransactionInstruction({ programId: KLEND_PROGRAM_ID, keys, data });
}

/**
 * Convenience: load the on-disk groups JSON and produce an ix per group, given
 * a `symbolToReserve` mapping for resolving each group's debt reserve.
 *
 * Used by the deploy scripts:
 *   const ixs = buildElevationGroupIxsFromConfig(
 *     authority, market, groupsConfig,
 *     { USDC: usdcReserve, wSOL: wsolReserve }
 *   );
 *   await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [authority]);
 */
export interface GroupsConfig {
  groups: Array<{
    id: number;
    name: string;
    debtReserveSymbol: string;
    collateralReserveSymbols: string[];
    ltvPct: number;
    liquidationThresholdPct: number;
    maxLiquidationBonusBps: number;
    maxReservesAsCollateral: number;
    allowNewLoans: 0 | 1;
  }>;
}

export function buildElevationGroupIxsFromConfig(
  marketOwner: PublicKey,
  lendingMarket: PublicKey,
  cfg: GroupsConfig,
  symbolToReserve: Record<string, PublicKey>,
): TransactionInstruction[] {
  return cfg.groups.map((g) => {
    const debtReserve = symbolToReserve[g.debtReserveSymbol];
    if (!debtReserve) {
      throw new Error(
        `elevation group ${g.id} (${g.name}): missing reserve mapping for debt symbol ${g.debtReserveSymbol}`,
      );
    }
    return buildUpdateElevationGroupIx(marketOwner, lendingMarket, {
      id: g.id,
      ltvPct: g.ltvPct,
      liquidationThresholdPct: g.liquidationThresholdPct,
      maxLiquidationBonusBps: g.maxLiquidationBonusBps,
      allowNewLoans: g.allowNewLoans,
      maxReservesAsCollateral: g.maxReservesAsCollateral,
      debtReserve,
    });
  });
}
