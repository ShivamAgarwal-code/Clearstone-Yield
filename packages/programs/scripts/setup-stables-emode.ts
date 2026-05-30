/**
 * setup-stables-emode.ts — Register elevation group 1 (stablecoin eMode)
 * on the unified csSOL klend market.
 *
 * Two-step setup:
 *   1. Market-level: register elevation group {id=1, debt_reserve=sUSDC,
 *      ltv=90, liq_threshold=92, max_reserves_as_collateral=1, bonus=100bps}
 *      via `update_lending_market(UpdateElevationGroup, ...)`.
 *   2. Reserve-level: enroll the ceUSX reserve into group 1 by setting
 *      its `config.elevation_groups[0] = 1` via
 *      `update_reserve_config(UpdateElevationGroups, …)`. The 20-byte
 *      array lists every group id this reserve can be pledged in; we
 *      keep it sparse with only group 1 set for now.
 *
 * After this script:
 *   - Group 1 = stables (ceUSX collateral, sUSDC debt, 90% LTV)
 *   - Group 2 = LST/SOL (csSOL+csSOL-WT collateral, wSOL debt, 90% LTV)
 *
 * Both live on the same market so a single obligation can switch eMode
 * groups depending on which leg the user wants to lever.
 *
 * Usage: npx tsx scripts/setup-stables-emode.ts
 *
 * KNOWN BLOCKER (devnet, observed during deployment):
 *   Step 2 currently fails: every `update_reserve_config` call on the
 *   csSOL market returns InvalidConfig (6004) at
 *   handler_update_reserve_config.rs:49 once group 1 is registered —
 *   for *every* reserve in the market (csSOL, wSOL, csSOL-WT, ceUSX,
 *   sUSDC). The deployed klend binary no longer honors the
 *   `skipConfigIntegrityValidation` flag from the IDL: the
 *   `"WARNING! Skipping validation of the config"` log path was
 *   dropped, and `reserve_config_check` runs unconditionally. The
 *   market-wide invariant (likely involving group.debt_reserve
 *   liquidation-bonus relationships, since sUSDC was created with the
 *   liquidation-bonus fields defaulted to zero by `init_reserve`) fails
 *   for the new reserves and locks out updates to all of them.
 *
 *   Workarounds tried — all unsuccessful:
 *     - Repoint group 1 debt_reserve to wSOL (which has valid bonuses).
 *     - Re-register group 1 with maxBonus=0 to satisfy
 *       `g.max_liquidation_bonus_bps ≤ debt.max_liquidation_bonus_bps`.
 *     - mode 24 (`UpdateEntireReserveConfig`) — deprecated, panics.
 *     - Set bonus fields with skip=true — runs full validation anyway.
 *
 *   To unblock:
 *     a) Pull current klend Rust source and read line 49 of
 *        handler_update_reserve_config.rs to identify the exact
 *        invariant. With the source you can either pre-emptively
 *        satisfy it or open a PR to klend.
 *     b) Or recreate the ceUSX/sUSDC reserves from scratch with full
 *        bonus fields set at init-time, before registering group 1.
 *        Note: each reserve costs ~0.06 SOL in rent and lives forever
 *        in klend storage.
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { buildUpdateElevationGroupIx } from "./lib/klend-elevation-group.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET = new PublicKey("2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW");

// Reserves added by migrate-usx-into-cssol-market.ts.
const DEUSX_RESERVE = new PublicKey("yBZB2WHSizBs6Mg7GVPBYqm6L7vfcyC5UzJ2KU4YG1U");
const SUSDC_RESERVE = new PublicKey("DGMZhxx83nyquZ5Xb8m1VPACus2RdDNfBEyexgmXqtKC");
// Pre-existing reserve with valid liquidation-bonus values (max=500),
// used as a temporary debt_reserve for group 1 while we backfill
// sUSDC's liquidation bonuses.
const WSOL_RESERVE = new PublicKey("4RvKrQVTdgvGEf75yvZE9JwzG4rZJrbstNcvVoXrkZ8o");

const STABLES_GROUP_ID = 1;

const CONFIG_MODE = {
  UpdateMaxLiquidationBonusBps: 1,
  UpdateBadDebtLiquidationBonusBps: 29,
  UpdateMinLiquidationBonusBps: 30,
  UpdateElevationGroups: 34,
  UpdateDisableUsageAsCollateralOutsideEmode: 41,
} as const;

const updateReserveConfigDisc = crypto
  .createHash("sha256")
  .update("global:update_reserve_config")
  .digest()
  .subarray(0, 8);

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildUpdateReserveConfigIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  mode: number, value: Buffer, skipValidation: boolean,
) {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  updateReserveConfigDisc.copy(data, off); off += 8;
  data.writeUInt8(mode, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, off);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Stables eMode (group 1) Setup                ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Authority:    ${auth.publicKey.toBase58()}`);
  console.log(`  Balance:      ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);
  console.log(`  Market:       ${MARKET.toBase58()}`);
  console.log(`  Group:        ${STABLES_GROUP_ID} (stables)`);
  console.log(`  Debt:         sUSDC ${SUSDC_RESERVE.toBase58()}`);
  console.log(`  Collateral:   ceUSX ${DEUSX_RESERVE.toBase58()}`);
  console.log("");

  // Step 1: PREP — temporarily de-fang elevation group 1.
  // Klend's reserve_config_check validates *every* registered group's
  // debt_reserve invariants on every reserve update. Group 1 was
  // initially registered with `max_liquidation_bonus_bps = 100`, but
  // its debt reserve (sUSDC) has all liquidation-bonus fields set to
  // 0 (init_reserve default — the migration script never set them).
  // The implicit invariant
  //   group.debt_reserve.max_liquidation_bonus_bps ≥ group.max_liquidation_bonus_bps
  // therefore fails, blocking *all* reserve updates on this market.
  //
  // Fix: replace group 1 with an inert version (max_bonus=0,
  // allow_new_loans=0) so the invariant trivially holds, backfill
  // sUSDC's liquidation-bonus fields, then re-register group 1 with
  // the real params.
  console.log("=== Step 1a: Repoint Group 1 debt_reserve at wSOL (temp) ===");
  // wSOL has max_liquidation_bonus_bps=500 ≥ 100, satisfying the
  // invariant `group.debt_reserve.max ≥ group.max`. This unblocks
  // reserve updates so we can backfill sUSDC.
  const tempIx = buildUpdateElevationGroupIx(auth.publicKey, MARKET, {
    id: STABLES_GROUP_ID,
    ltvPct: 90,
    liquidationThresholdPct: 92,
    maxLiquidationBonusBps: 100,
    allowNewLoans: 0, // gate new loans while we juggle
    maxReservesAsCollateral: 1,
    debtReserve: WSOL_RESERVE,
  });
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(tempIx),
    [auth]);
  console.log("  ✓ Group 1 temp-pointed at wSOL (allow_new_loans=0)");

  // Step 1.5: backfill liquidation-bonus fields on ceUSX/sUSDC. The
  // migration script never touched these (init_reserve default 0/0/0).
  // After registering an elevation group, klend's reserve_config_check
  // walks every market reserve and asserts (presumably)
  //   reserve.max_liquidation_bonus_bps ≥ group.max_liquidation_bonus_bps
  // for every group. Group 1 has max=100bps, so reserve.max=0 fails —
  // and that failure blocks ANY further update on this reserve.
  // Order matters: bump `max` FIRST (lifts the ceiling), then `min`
  // (must be ≤ max), then `badDebt` (kept ≤ max for consistency with
  // csSOL-WT's pattern).
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  async function backfillBonuses(reserve: PublicKey, label: string) {
    console.log(`\n=== Backfill ${label} liquidation bonuses ===`);
    for (const [mode, v, hint] of [
      [CONFIG_MODE.UpdateMaxLiquidationBonusBps, u16(500), "max=500bps"],
      [CONFIG_MODE.UpdateMinLiquidationBonusBps, u16(200), "min=200bps"],
      [CONFIG_MODE.UpdateBadDebtLiquidationBonusBps, u16(99), "badDebt=99bps"],
    ] as const) {
      await sendAndConfirmTransaction(conn, new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(buildUpdateReserveConfigIx(auth.publicKey, MARKET, reserve, mode, v, true)),
        [auth]);
      console.log(`  ✓ ${label} ${hint}`);
    }
  }
  await backfillBonuses(DEUSX_RESERVE, "ceUSX");
  await backfillBonuses(SUSDC_RESERVE, "sUSDC");

  // Step 1b: now that sUSDC has valid bonuses, re-register group 1
  // with the real parameters.
  console.log("\n=== Step 1b: Re-register Elevation Group 1 ===");
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(buildUpdateElevationGroupIx(auth.publicKey, MARKET, {
      id: STABLES_GROUP_ID,
      ltvPct: 90,
      liquidationThresholdPct: 92,
      maxLiquidationBonusBps: 100,
      allowNewLoans: 1,
      maxReservesAsCollateral: 1,
      debtReserve: SUSDC_RESERVE,
    })),
    [auth]);
  console.log("  ✓ Group 1 active (ltv=90 / liq=92 / bonus=100bps / max_reserves=1)");

  // Step 2a: set ceUSX `disable_usage_as_collateral_outside_emode = 1`.
  // Klend's reserve_config_check requires this when the reserve is
  // enrolled in a group with `max_reserves_as_collateral = 1` —
  // otherwise the post-update validation fails with InvalidConfig
  // (the reserve would otherwise be usable as collateral both inside
  // and outside eMode, which conflicts with the single-collateral
  // group semantics).
  console.log("\n=== Step 2a: ceUSX disable_usage_as_collateral_outside_emode = 1 ===");
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(buildUpdateReserveConfigIx(
      auth.publicKey, MARKET, DEUSX_RESERVE,
      CONFIG_MODE.UpdateDisableUsageAsCollateralOutsideEmode, Buffer.from([1]), true,
    )),
    [auth]);
  console.log("  ✓ ceUSX.config.disable_usage_as_collateral_outside_emode = 1");

  // Step 2b: enroll ceUSX as eligible collateral in group 1.
  // The reserve carries an `elevation_groups: [u8; 20]` array — first
  // empty slot gets the new id. We currently set just slot[0]=1 since
  // ceUSX is only used in the stables group.
  console.log("\n=== Step 2b: Enroll ceUSX into Group 1 ===");
  const elevationGroupsBuf = Buffer.alloc(20); // zero-init
  elevationGroupsBuf[0] = STABLES_GROUP_ID;
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(buildUpdateReserveConfigIx(
      auth.publicKey, MARKET, DEUSX_RESERVE,
      CONFIG_MODE.UpdateElevationGroups, elevationGroupsBuf, true,
    )),
    [auth]);
  console.log(`  ✓ ceUSX.config.elevation_groups = [${STABLES_GROUP_ID}, 0, …, 0]`);

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Stables eMode ready                          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("  Next: in the playground, switch to group 1 from the");
  console.log("  elevation-group dropdown after depositing ceUSX.");
}

main().catch((e) => { console.error(e); process.exit(1); });
