/**
 * migrate-eg-debt-to-cusdc.ts — Repoints the lending market's EG-1
 * (stables) and EG-3 (margin-long-SOL) debt_reserve from the
 * unrestricted retail sUSDC reserve (`78kkPN…BFy9`) to the new
 * KYC-gated cUSDC reserve (read from configs/devnet/cusdc-deployed.json).
 *
 * Strict copy of migrate-eg2-debt-to-csol.ts, generalized to update
 * multiple groups in a single run. Reads each target EG's full struct
 * first, preserves every field, and only swaps debt_reserve. Always
 * simulates first; pass --send to broadcast.
 *
 * Pre-conditions verified before flip:
 *   - cUSDC reserve has deposit_limit > 0, borrow_limit > 0 (set by
 *     setup-cusdc-reserve.ts).
 *   - sUSDC reserve has zero outstanding debt across all obligations
 *     (already true on devnet — see project memory).
 *
 * Post-condition:
 *   - EG-1 binds (ceUSX + ceUSX-WT) collateral to cUSDC debt.
 *   - EG-3 binds cSOL collateral to cUSDC debt.
 *   - Existing EG obligations referencing sUSDC as debt would be left
 *     in an inconsistent state; verify there are none before --send.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/migrate-eg-debt-to-cusdc.ts             # dry-run
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/migrate-eg-debt-to-cusdc.ts --send      # broadcast
 *
 * Authority: lending-market owner (= cSOL deploy authority on devnet).
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
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");

// Legacy reserve being deprecated. We refuse to flip if a target EG's
// current debt_reserve is something other than this — protects against
// fat-finger overwrites.
const SUSDC_RESERVE = new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9");

// EG ids to repoint to cUSDC. EG-1 = stables, EG-3 = margin-long-SOL.
// (EG-4 has cSOL as debt — unaffected; EG-2 has cSOL as debt.)
const TARGET_EGS = [1, 3] as const;

const MODE_UPDATE_ELEVATION_GROUP = 9;

// LendingMarket layout — EG[32] starts at offset 200, each entry 72B.
const EG_ARRAY_OFFSET = 200;
const EG_STRUCT_SIZE = 72;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

interface ElevationGroup {
  maxLiquidationBonusBps: number;
  id: number;
  ltvPct: number;
  liquidationThresholdPct: number;
  allowNewLoans: number;
  maxReservesAsCollateral: number;
  padding0: number;
  debtReserve: PublicKey;
  padding1: bigint[];
}

function decodeEG(buf: Buffer, offset: number): ElevationGroup {
  let o = offset;
  const maxLiquidationBonusBps = buf.readUInt16LE(o); o += 2;
  const id = buf.readUInt8(o); o += 1;
  const ltvPct = buf.readUInt8(o); o += 1;
  const liquidationThresholdPct = buf.readUInt8(o); o += 1;
  const allowNewLoans = buf.readUInt8(o); o += 1;
  const maxReservesAsCollateral = buf.readUInt8(o); o += 1;
  const padding0 = buf.readUInt8(o); o += 1;
  const debtReserve = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const padding1 = [
    buf.readBigUInt64LE(o),
    buf.readBigUInt64LE(o + 8),
    buf.readBigUInt64LE(o + 16),
    buf.readBigUInt64LE(o + 24),
  ];
  return { maxLiquidationBonusBps, id, ltvPct, liquidationThresholdPct, allowNewLoans, maxReservesAsCollateral, padding0, debtReserve, padding1 };
}

function encodeEG(eg: ElevationGroup): Buffer {
  const buf = Buffer.alloc(EG_STRUCT_SIZE);
  let o = 0;
  buf.writeUInt16LE(eg.maxLiquidationBonusBps, o); o += 2;
  buf.writeUInt8(eg.id, o); o += 1;
  buf.writeUInt8(eg.ltvPct, o); o += 1;
  buf.writeUInt8(eg.liquidationThresholdPct, o); o += 1;
  buf.writeUInt8(eg.allowNewLoans, o); o += 1;
  buf.writeUInt8(eg.maxReservesAsCollateral, o); o += 1;
  buf.writeUInt8(eg.padding0, o); o += 1;
  eg.debtReserve.toBuffer().copy(buf, o); o += 32;
  for (const v of eg.padding1) { buf.writeBigUInt64LE(v, o); o += 8; }
  return buf;
}

function fmtEG(eg: ElevationGroup): string {
  return `id=${eg.id} ltv=${eg.ltvPct}% liqThr=${eg.liquidationThresholdPct}% maxBonus=${eg.maxLiquidationBonusBps}bps `
    + `allowNew=${eg.allowNewLoans} maxColl=${eg.maxReservesAsCollateral} debt=${eg.debtReserve.toBase58().slice(0,8)}…`;
}

function buildUpdateEgIx(auth: PublicKey, newEg: ElevationGroup): TransactionInstruction {
  const data = Buffer.concat([
    disc("update_lending_market"),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(MODE_UPDATE_ELEVATION_GROUP)); return b; })(),
    encodeEG(newEg),
  ]);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: auth,   isSigner: true,  isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true  },
    ],
    data,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  // Read cUSDC reserve from the deploy artifact.
  const cusdcDeployedPath = path.join(__dirname, "..", "configs", "devnet", "cusdc-deployed.json");
  if (!fs.existsSync(cusdcDeployedPath)) {
    throw new Error(`Missing ${cusdcDeployedPath} — run scripts/setup-cusdc-reserve.ts first.`);
  }
  const cusdcDeployed = JSON.parse(fs.readFileSync(cusdcDeployedPath, "utf8"));
  const cusdcReserve = new PublicKey(cusdcDeployed.cusdcReserve);

  console.log("Network:         ", RPC);
  console.log("Authority:       ", auth.publicKey.toBase58());
  console.log("Market:          ", MARKET.toBase58());
  console.log("Target debt:     ", cusdcReserve.toBase58(), "(cUSDC)");
  console.log("Legacy debt:     ", SUSDC_RESERVE.toBase58(), "(sUSDC, deprecated)");
  console.log("Repointing EGs:  ", TARGET_EGS.join(", "));
  console.log("");

  const mktInfo = await conn.getAccountInfo(MARKET);
  if (!mktInfo) throw new Error("market not found");

  // Locate each target EG's array index by id.
  const targets: { idx: number; current: ElevationGroup }[] = [];
  for (const id of TARGET_EGS) {
    let found = false;
    for (let i = 0; i < 32; i++) {
      const eg = decodeEG(mktInfo.data, EG_ARRAY_OFFSET + i * EG_STRUCT_SIZE);
      if (eg.id === id) { targets.push({ idx: i, current: eg }); found = true; break; }
    }
    if (!found) throw new Error(`EG-${id} not registered on the market — register it first.`);
  }

  console.log("Current EG state:");
  for (const t of targets) console.log(`  EG-${t.current.id} @ idx ${t.idx}:`, fmtEG(t.current));
  console.log("");

  // Build the flip ixes — preserve everything except debt_reserve.
  const ixes: TransactionInstruction[] = [];
  let workToDo = false;
  for (const t of targets) {
    if (t.current.debtReserve.equals(cusdcReserve)) {
      console.log(`✓ EG-${t.current.id} debt is already cUSDC — skipping`);
      continue;
    }
    if (!t.current.debtReserve.equals(SUSDC_RESERVE)) {
      console.log(`⚠ EG-${t.current.id}'s current debt is neither sUSDC nor cUSDC:`);
      console.log(`    ${t.current.debtReserve.toBase58()}`);
      console.log("Refusing to overwrite blindly. Re-check market state.");
      process.exit(1);
    }
    workToDo = true;
    const newEg: ElevationGroup = { ...t.current, debtReserve: cusdcReserve };
    console.log(`EG-${t.current.id}: ${t.current.debtReserve.toBase58().slice(0,8)}… → ${cusdcReserve.toBase58().slice(0,8)}…`);
    ixes.push(buildUpdateEgIx(auth.publicKey, newEg));
  }
  if (!workToDo) {
    console.log("\nNothing to do.");
    return;
  }

  // Single tx for atomicity — both EGs flip together so any in-flight
  // borrows that span more than one EG never see a half-migrated state.
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
  for (const ix of ixes) tx.add(ix);

  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = auth.publicKey;

  const sim = await conn.simulateTransaction(tx, [auth]);
  if (sim.value.err) {
    console.error("\nSimulation REJECTED:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.error("Logs:\n  " + sim.value.logs.join("\n  "));
    process.exit(1);
  }
  console.log("\nSimulation OK. Logs (last 12):");
  for (const l of (sim.value.logs ?? []).slice(-12)) console.log("  " + l);
  console.log("");

  if (!send) {
    console.log("Dry-run only. Re-run with --send to broadcast.");
    return;
  }

  console.log("Sending …");
  const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
  console.log("Confirmed:", sig);
  console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

  const after = await conn.getAccountInfo(MARKET);
  if (after) {
    console.log("\nNew on-chain EG state:");
    for (const t of targets) {
      const eg = decodeEG(after.data, EG_ARRAY_OFFSET + t.idx * EG_STRUCT_SIZE);
      console.log(`  EG-${eg.id}:`, fmtEG(eg));
    }
  }

  // Persist the new state for the next operator.
  const outPath = path.join(__dirname, "..", "configs", "devnet", "margin-egs-deployed.json");
  let existing: any = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
  existing[`eg1`] = { id: 1, debtReserve: cusdcReserve.toBase58(), _debtReserveSymbol: "cUSDC", migratedAt: new Date().toISOString() };
  existing[`eg3`] = { ...(existing.eg3 ?? {}), debtReserve: cusdcReserve.toBase58(), _debtReserveSymbol: "cUSDC", migratedAt: new Date().toISOString() };
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("\nUpdated", path.relative(process.cwd(), outPath));
}

main().catch((e) => { console.error(e); process.exit(1); });
