/**
 * update-wsol-irm.ts — Replace the wSOL reserve's borrow rate curve with the
 * production 11-point shape from `configs/wsol_borrow_reserve.json`.
 *
 * Why this exists: the v3 wSOL reserve (`CaPUL8sij…6VF8`) was init'd with
 * a stub 3-point kink (0%/0, 80%/5, 100%/50). The 11-point production
 * curve in the JSON file (kinks at 50/80/90/93/96/100% with target 10%
 * APR at 90% util) was never applied. Retail / institutional UIs read
 * the curve correctly, so flipping the on-chain shape via this script
 * propagates to both surfaces on the next 30s poll without any UI work.
 *
 * Mechanics: klend's `update_reserve_config` accepts mode 23
 * (`UpdateBorrowRateCurve`) with skip-validation=true post-init. Same
 * path applyReserveConfigPhase1 uses in setup-cssol-market.ts — verified
 * working there for the cSOL margin reserve, which does carry the rich
 * 11-point shape on-chain.
 *
 * Out of scope: protocolTakeRatePct (mode 4 = UpdateProtocolTakeRate)
 * is in klend's GLOBAL_ADMIN_ONLY_MODES set — only Kamino can change it.
 * The on-chain `0%` is the init default and we can't bump it to the 10%
 * the JSON specifies without their cooperation.
 *
 * Usage:
 *   npx tsx scripts/update-wsol-irm.ts                  # simulate then prompt
 *   npx tsx scripts/update-wsol-irm.ts --send           # send without prompt
 *   DEPLOY_KEYPAIR=/path/to/key.json npx tsx ...        # override signer
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const WSOL_RESERVE = new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8");

const CONFIG_MODE_UpdateBorrowRateCurve = 23;
const CURVE_OFFSET_IN_RESERVE = 4920;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    ?? path.join(process.env.HOME!, ".config/solana/clearstone-devnet.json");
  if (!fs.existsSync(p)) {
    throw new Error(`Keypair not found at ${p}. Set DEPLOY_KEYPAIR env var.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

interface CurvePoint { utilizationRateBps: number; borrowRateBps: number }

function loadCurve(): CurvePoint[] {
  const cfg = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "configs", "wsol_borrow_reserve.json"), "utf8"));
  const points: CurvePoint[] = cfg.borrowRateCurve.points;
  if (!Array.isArray(points) || points.length !== 11) {
    throw new Error(`Expected 11-point curve, got ${points?.length}`);
  }
  return points;
}

function curveBuf(points: CurvePoint[]): Buffer {
  const buf = Buffer.alloc(88);
  points.forEach((p, i) => {
    buf.writeUInt32LE(p.utilizationRateBps, i * 8);
    buf.writeUInt32LE(p.borrowRateBps, i * 8 + 4);
  });
  return buf;
}

function readOnChainCurve(reserveData: Buffer): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (let i = 0; i < 11; i++) {
    const off = CURVE_OFFSET_IN_RESERVE + i * 8;
    out.push({
      utilizationRateBps: reserveData.readUInt32LE(off),
      borrowRateBps:      reserveData.readUInt32LE(off + 4),
    });
  }
  return out;
}

function fmtCurve(pts: CurvePoint[]): string {
  return pts.map(p => `${(p.utilizationRateBps / 100).toFixed(2)}%/${(p.borrowRateBps / 100).toFixed(2)}%`).join("  ");
}

function buildUpdateBorrowRateCurveIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey, value: Buffer,
): TransactionInstruction {
  const cfgDisc = disc("update_reserve_config");
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  cfgDisc.copy(data, off); off += 8;
  data.writeUInt8(CONFIG_MODE_UpdateBorrowRateCurve, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(1, off); // skipValidation = true (matches phase-1 path)

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner,                isSigner: true,  isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG,  isSigner: false, isWritable: false },
      { pubkey: market,               isSigner: false, isWritable: false },
      { pubkey: reserve,              isSigner: false, isWritable: true  },
    ],
    data,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const probe = args.find(a => a.startsWith("--probe="))?.slice("--probe=".length);

  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  console.log("Network:        ", RPC);
  console.log("Authority:      ", auth.publicKey.toBase58());
  console.log("Market:         ", MARKET.toBase58());
  console.log("wSOL reserve:   ", WSOL_RESERVE.toBase58());
  console.log("");

  // ── Probe modes for diagnosing klend's curve validate() rules ──
  // --probe=current: re-submit the on-chain curve verbatim (pure no-op
  //   semantics; sanity-checks whether ANY update to the in-use reserve
  //   passes validate()).
  // --probe=linear: a strictly-increasing 11-point linear ramp (0→1000
  //   bps over 0→10000 util). Fully convex, no duplicates.
  // --probe=tweak: re-submit the on-chain curve with the very first
  //   point's rate bumped 0→1 bps (minimal content change).
  let desired: CurvePoint[];
  if (probe) {
    const before = await conn.getAccountInfo(WSOL_RESERVE);
    if (!before) throw new Error("wSOL reserve not found");
    const curr = readOnChainCurve(before.data);
    if (probe === "current") {
      desired = curr;
    } else if (probe === "tweak") {
      desired = curr.map((p, i) => i === 0 ? { ...p, borrowRateBps: 1 } : p);
    } else if (probe === "linear") {
      desired = Array.from({ length: 11 }, (_, i) => ({
        utilizationRateBps: i * 1000,
        borrowRateBps:      i * 100,
      }));
    } else {
      throw new Error(`Unknown probe: ${probe}`);
    }
    console.log(`Probe curve (--probe=${probe}):`);
  } else {
    desired = loadCurve();
    console.log("Desired curve (from configs/wsol_borrow_reserve.json):");
  }
  console.log("  ", fmtCurve(desired));
  console.log("");

  const before = await conn.getAccountInfo(WSOL_RESERVE);
  if (!before) throw new Error("wSOL reserve account not found on-chain");
  const beforeCurve = readOnChainCurve(before.data);
  console.log("Current on-chain curve:");
  console.log("  ", fmtCurve(beforeCurve));
  console.log("");

  // Skip the work entirely if it already matches.
  const matches = beforeCurve.every((p, i) =>
    p.utilizationRateBps === desired[i].utilizationRateBps
    && p.borrowRateBps === desired[i].borrowRateBps);
  if (matches) {
    console.log("On-chain curve already matches the JSON. Nothing to do.");
    return;
  }

  const ix = buildUpdateBorrowRateCurveIx(auth.publicKey, MARKET, WSOL_RESERVE, curveBuf(desired));
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ix);

  // Always simulate first — surfaces InvalidSigner / curve-validation errors
  // before we burn a slot's tx budget.
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = auth.publicKey;
  const sim = await conn.simulateTransaction(tx, [auth]);
  if (sim.value.err) {
    console.error("Simulation failed:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.error("Logs:\n  " + sim.value.logs.join("\n  "));
    process.exit(1);
  }
  console.log("Simulation OK. Logs (last 8):");
  for (const l of (sim.value.logs ?? []).slice(-8)) console.log("  " + l);
  console.log("");

  if (!send) {
    console.log("Dry-run only. Re-run with --send to broadcast.");
    return;
  }

  console.log("Sending...");
  const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
  console.log("Confirmed:", sig);
  console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
  console.log("");

  const after = await conn.getAccountInfo(WSOL_RESERVE);
  if (after) {
    const afterCurve = readOnChainCurve(after.data);
    console.log("New on-chain curve:");
    console.log("  ", fmtCurve(afterCurve));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
