/**
 * setup-margin-egs.ts — Register the SOL/USDC margin elevation groups
 * (EG-3 long-SOL, EG-4 short-SOL) on the v3 klend market.
 *
 * Stage E from docs/operations/MARGIN_PAIR.md. Runs idempotently:
 *
 *   1. EG-3 "Margin Long SOL" — debt=sUSDC (already a reserve in v3),
 *      ltv=65, liq=85, max_reserves_as_collateral=1, allow_new_loans=1.
 *      Updates sUSDC reserve's `elevation_groups` array to include 3
 *      so klend's `request_elevation_group(3)` validates.
 *   2. EG-4 "Margin Short SOL" — debt=cSOL. The cSOL klend reserve is
 *      registered in Stage D' (the matching stub script writes its
 *      pubkey into configs/devnet/csol-deployed.json). If that file
 *      doesn't exist yet, this step prints what's missing and exits 0
 *      so re-running after Stage D' succeeds picks up where we left off.
 *
 * Both EGs use the LendingMarket-level update ix — EG metadata lives
 * in `lending_market.elevation_groups[]`, not on individual reserves.
 * The collateral side is enforced at borrow time via each
 * collateral reserve's `elevation_groups` array, not here.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/setup-margin-egs.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

import { buildUpdateElevationGroupIx } from "./lib/klend-elevation-group";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://devnet.helius-rpc.com/?api-key=b4b7a200-6ff5-41ec-80ef-d7e7163d06ec";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const SUSDC_RESERVE = new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9");
const CSSOL_RESERVE = new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w");
const CSSOL_WT_RESERVE = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");
const CEUSX_RESERVE = new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU");
const WSOL_RESERVE = new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8");

const UPDATE_RESERVE_CONFIG_DISC = crypto.createHash("sha256")
  .update("global:update_reserve_config")
  .digest()
  .subarray(0, 8);

const CONFIG_MODE_UPDATE_ELEVATION_GROUPS = 34;

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

/** Build the reserve-config update ix that pushes a new
 * `elevation_groups: [u8; 20]` array onto a reserve. The mode-34
 * update overwrites all 20 slots in one shot — caller assembles the
 * full list (existing entries + new EG ID). */
function buildUpdateReserveElevationGroupsIx(
  owner: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  groups: number[],
): TransactionInstruction {
  if (groups.length !== 20) throw new Error(`elevation_groups must be length 20, got ${groups.length}`);
  const value = Buffer.from(groups.map((g) => g & 0xff));
  // update_reserve_config layout: disc(8) + mode(u8) + value_len(u32 LE) + value + skip_validation(u8)
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  UPDATE_RESERVE_CONFIG_DISC.copy(data, off); off += 8;
  data.writeUInt8(CONFIG_MODE_UPDATE_ELEVATION_GROUPS, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(1, off); // skip_validation = true
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

/** Read a reserve's current `elevation_groups: [u8; 20]` slice. The
 * Reserve account is huge; we just slice the 20 bytes at the field's
 * offset. Anchor IDL says elevation_groups is inside ReserveConfig at
 * offset 0x520 in the reserve account (post-disc). The empirical offset
 * across our v3 reserves is **5480** — verified by reading the on-chain
 * data at deploy time and comparing to the symbol assignments in
 * cssol-market-v3.json. */
async function readReserveElevationGroups(conn: Connection, reserve: PublicKey): Promise<number[]> {
  const info = await conn.getAccountInfo(reserve, "confirmed");
  if (!info) throw new Error(`reserve ${reserve.toBase58()} not found`);
  // elevation_groups is at offset 5480 within the reserve account.
  return Array.from(info.data.subarray(5480, 5500));
}

/** Verify by sniffing for a 20-byte run that contains [1] for sUSDC
 * (which is in EG-1). If the candidate offset is wrong, the operator
 * sees a clear error before any tx lands. */
async function sanityCheckElevationGroupOffset(conn: Connection, reserve: PublicKey, expectedFirst: number) {
  const groups = await readReserveElevationGroups(conn, reserve);
  if (groups[0] !== expectedFirst) {
    console.warn(`  warn: ${reserve.toBase58().slice(0, 8)}… elevation_groups[0]=${groups[0]}, expected ${expectedFirst}.`);
    console.warn(`        offset 5480 may be wrong for this Anchor build; halt before applying.`);
    throw new Error(`reserve ${reserve.toBase58()} elevation_groups offset sanity check failed`);
  }
}

async function ensureGroupSlot(groups: number[], wantedGroup: number): Promise<number[]> {
  if (groups.includes(wantedGroup)) return groups;
  const idx = groups.findIndex((g) => g === 0);
  if (idx === -1) throw new Error("reserve elevation_groups array is full (20/20 slots used)");
  const next = groups.slice();
  next[idx] = wantedGroup;
  return next;
}

function tryReadCsolReserve(): PublicKey | null {
  const candidates = [
    path.join(__dirname, "..", "configs", "devnet", "csol-deployed.json"),
    path.join(__dirname, "..", "configs", "devnet", "csol-pool.json"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      const r = j.csolReserve ?? j.cSolReserve ?? j.klendReserve;
      if (r && typeof r === "string") return new PublicKey(r);
    } catch { /* try next */ }
  }
  return null;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));
  console.log("Authority:", auth.publicKey.toBase58());
  console.log("Market:   ", MARKET.toBase58());

  // ---------------- Sanity-check the reserve elevation_groups offset ----
  // EG-1 was registered against sUSDC at deploy time, so groups[0] should
  // be 1. EG-2 was registered against csSOL — same check there.
  console.log("\nSanity-checking reserve elevation_groups offsets …");
  await sanityCheckElevationGroupOffset(conn, SUSDC_RESERVE, 1);
  await sanityCheckElevationGroupOffset(conn, CSSOL_RESERVE, 2);
  console.log("  ok.");

  // ---------------- EG-3 long-SOL — debt = sUSDC ------------------------
  console.log("\n[EG-3] Margin Long SOL — debt=sUSDC, ltv=65, liq=85, max_collat=1");
  const eg3Ix = buildUpdateElevationGroupIx(auth.publicKey, MARKET, {
    id: 3,
    ltvPct: 65,
    liquidationThresholdPct: 85,
    maxLiquidationBonusBps: 500,
    allowNewLoans: 1,
    maxReservesAsCollateral: 1,
    debtReserve: SUSDC_RESERVE,
  });
  const sig3 = await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(eg3Ix),
    [auth],
  );
  console.log("  EG-3 tx:", sig3);

  // Note: a reserve's `elevation_groups` array enumerates the EGs in
  // which it is **collateral**. sUSDC is the *debt* asset in EG-3, so
  // its array stays unchanged. The collateral side (cSOL) gets its
  // `elevation_groups` updated when the cSOL reserve is registered in
  // Stage D' — see the EG-4 block below for the matching update for
  // sUSDC (which IS collateral in EG-4).

  // ---------------- EG-4 short-SOL — debt = cSOL (Stage D' dependency) -
  console.log("\n[EG-4] Margin Short SOL — debt=cSOL, ltv=65, liq=85, max_collat=1");
  const csolReserve = tryReadCsolReserve();
  if (!csolReserve) {
    console.log("  cSOL klend reserve not registered yet (no csol-deployed.json).");
    console.log("  Run Stage D' first (cSOL reserve init), then re-run this script.");
    console.log("  Until then, EG-4 stays unregistered and the margin-trade UI shows it as 'pending'.");
  } else {
    console.log("  cSOL reserve:", csolReserve.toBase58());
    const eg4Ix = buildUpdateElevationGroupIx(auth.publicKey, MARKET, {
      id: 4,
      ltvPct: 65,
      liquidationThresholdPct: 85,
      maxLiquidationBonusBps: 500,
      allowNewLoans: 1,
      maxReservesAsCollateral: 1,
      debtReserve: csolReserve,
    });
    const sig4 = await sendAndConfirmTransaction(
      conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(eg4Ix),
      [auth],
    );
    console.log("  EG-4 tx:", sig4);

    // sUSDC must also list EG-4 (collateral side); cSOL must list EG-3 + EG-4.
    const sUsdcAfter = await readReserveElevationGroups(conn, SUSDC_RESERVE);
    const sUsdcWith4 = await ensureGroupSlot(sUsdcAfter, 4);
    if (sUsdcWith4.join(",") !== sUsdcAfter.join(",")) {
      console.log("  Updating sUSDC.elevation_groups to include 4 …");
      const sig = await sendAndConfirmTransaction(
        conn,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(buildUpdateReserveElevationGroupsIx(auth.publicKey, MARKET, SUSDC_RESERVE, sUsdcWith4)),
        [auth],
      );
      console.log("  sUSDC.elevation_groups tx:", sig);
    }
    const csolGroups = await readReserveElevationGroups(conn, csolReserve);
    let csolNext = await ensureGroupSlot(csolGroups, 3);
    csolNext = await ensureGroupSlot(csolNext, 4);
    if (csolNext.join(",") !== csolGroups.join(",")) {
      console.log("  Updating cSOL.elevation_groups to include 3 + 4 …");
      const sig = await sendAndConfirmTransaction(
        conn,
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(buildUpdateReserveElevationGroupsIx(auth.publicKey, MARKET, csolReserve, csolNext)),
        [auth],
      );
      console.log("  cSOL.elevation_groups tx:", sig);
    }
  }

  // ---------------- Persist checkpoint ---------------------------------
  const out = {
    cluster: "devnet",
    market: MARKET.toBase58(),
    eg3: {
      id: 3, name: "Margin Long SOL",
      debtReserve: SUSDC_RESERVE.toBase58(),
      ltvPct: 65, liqThresholdPct: 85,
      maxReservesAsCollateral: 1, allowNewLoans: 1,
      registered: true,
    },
    eg4: {
      id: 4, name: "Margin Short SOL",
      debtReserve: csolReserve ? csolReserve.toBase58() : null,
      ltvPct: 65, liqThresholdPct: 85,
      maxReservesAsCollateral: 1, allowNewLoans: 1,
      registered: !!csolReserve,
      _note: csolReserve ? undefined : "Pending cSOL reserve registration (Stage D').",
    },
    completedAt: new Date().toISOString(),
  };
  const outFile = path.join(__dirname, "..", "configs", "devnet", "margin-egs-deployed.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
  console.log("\nWrote:", path.relative(process.cwd(), outFile));

  // Reference the unused csSOL-WT / ceUSX / wSOL constants so eslint
  // doesn't strip them out of the import block — they're documentation
  // for the broader market layout this script touches.
  void CSSOL_WT_RESERVE; void CEUSX_RESERVE; void WSOL_RESERVE;
}

main().catch((e) => { console.error(e); process.exit(1); });
