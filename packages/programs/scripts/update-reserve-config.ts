/**
 * update-reserve-config.ts — Maintainable single-shot tool for editing
 * any klend reserve's config on the v3 market.
 *
 * Wraps `update_reserve_config` (klend's mode-keyed config setter) with
 * a small set of high-level subcommands so we don't hand-roll the same
 * disc + value-buffer layout every time. Always simulates first, then
 * broadcasts only with `--send`.
 *
 * klend's `skip_config_integrity_validation` flag is the OPPOSITE of
 * "bypass everything": setting it true REQUIRES the reserve to be in
 * `is_predeposit` state (no deposits below the market minimum). For
 * live reserves we send skipValidation=false so klend runs its full
 * `validate_reserve_config_integrity` — that's the path which accepts
 * well-formed curve / limit / EG / name / oracle edits on in-use
 * reserves. Set `skipValidation: true` per-subcommand only when the
 * reserve is genuinely predeposit (init-time tweaks).
 *
 * Subcommands:
 *   set-curve              <reserve> <jsonPath|"production-sol-debt">
 *   set-deposit-limit      <reserve> <rawU64>
 *   set-borrow-limit       <reserve> <rawU64>
 *   set-elevation-groups   <reserve> <"a,b,c,…">     # padded to 20×u8
 *   set-status             <reserve> <0|1|2>          # Active/Obsolete/Hidden
 *   set-name               <reserve> <string>         # ≤32 ascii bytes
 *   set-pyth               <reserve> <pubkey>
 *   set-ltv                <reserve> <pct>
 *   set-liq-threshold      <reserve> <pct>
 *   set-borrow-factor      <reserve> <pct≥100>
 *   set-borrow-limit-out-eg <reserve> <rawU64>
 *
 * Modes 4 (protocolTakeRate) / 5 (originationFee) / 6 (flashLoanFee) /
 * 47 (hostFixedInterestRate) are GLOBAL_ADMIN_ONLY and not exposed —
 * Kamino controls those.
 *
 * Usage:
 *   npx tsx scripts/update-reserve-config.ts \
 *     <reserve> <subcommand> <args>
 *   npx tsx scripts/update-reserve-config.ts \
 *     <reserve> <subcommand> <args> --send                # broadcast
 *   DEPLOY_KEYPAIR=/path npx tsx ... <args>               # override signer
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

// klend's UpdateConfigMode enum — only the modes we expose here.
// Cross-checked against node_modules/@kamino-finance/klend-sdk/src/idl/klend.json.
const MODE = {
  LTV:                       0,
  LiqThreshold:              2,
  DepositLimit:              8,
  BorrowLimit:               9,
  Name:                     16,
  PriceMaxAge:              17,
  TwapMaxAge:               18,
  PythPrice:                20,
  BorrowRateCurve:          23,
  BorrowFactor:             32,
  ElevationGroups:          34,
  Status:                   38,
  BorrowLimitOutsideEG:     44,
} as const;

const RESERVE_CURVE_OFFSET = 4920;     // 11 × 8-byte CurvePoint slots
const RESERVE_NAME_OFFSET = 5032;
const RESERVE_LTV_OFFSET = 4872;
const RESERVE_LIQ_THRESHOLD_OFFSET = 4873;
const RESERVE_DEPOSIT_LIMIT_OFFSET = 5016;
const RESERVE_BORROW_LIMIT_OFFSET = 5024;
const RESERVE_STATUS_OFFSET = 4861;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    ?? path.join(process.env.HOME!, ".config/solana/id.json");
  if (!fs.existsSync(p)) {
    throw new Error(`Authority keypair not found at ${p}. Set DEPLOY_KEYPAIR env var.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

interface CurvePoint { utilizationRateBps: number; borrowRateBps: number }

const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  // Production curve for a SOL-class debt asset. Convex (slope
  // monotonically non-decreasing), 11 strictly-increasing util points,
  // target 10% APR at 90% util kink, 45% cap at 100%. Matches the
  // shape used by cSOL today.
  "production-sol-debt": [
    { utilizationRateBps: 0,     borrowRateBps: 1 },
    { utilizationRateBps: 5000,  borrowRateBps: 200 },
    { utilizationRateBps: 8000,  borrowRateBps: 500 },
    { utilizationRateBps: 9000,  borrowRateBps: 1000 },
    { utilizationRateBps: 9500,  borrowRateBps: 1500 },
    { utilizationRateBps: 9700,  borrowRateBps: 2000 },
    { utilizationRateBps: 9800,  borrowRateBps: 2500 },
    { utilizationRateBps: 9900,  borrowRateBps: 3000 },
    { utilizationRateBps: 9950,  borrowRateBps: 3500 },
    { utilizationRateBps: 9980,  borrowRateBps: 4000 },
    { utilizationRateBps: 10000, borrowRateBps: 4500 },
  ],
};

function curveBuf(points: CurvePoint[]): Buffer {
  if (points.length !== 11) throw new Error(`borrowRateCurve must have 11 points, got ${points.length}`);
  const buf = Buffer.alloc(88);
  points.forEach((p, i) => {
    buf.writeUInt32LE(p.utilizationRateBps, i * 8);
    buf.writeUInt32LE(p.borrowRateBps, i * 8 + 4);
  });
  return buf;
}

function elevationGroupsBuf(groups: number[]): Buffer {
  // klend stores 20 × u8. Caller passes a list (possibly shorter); we
  // pad with zeros and reject anything > 255 or > 20 distinct entries.
  if (groups.length > 20) throw new Error(`elevationGroups must have ≤20 entries, got ${groups.length}`);
  const buf = Buffer.alloc(20);
  groups.forEach((g, i) => {
    if (g < 0 || g > 255) throw new Error(`elevation group ${g} out of u8 range`);
    buf.writeUInt8(g, i);
  });
  return buf;
}

function buildIx(
  authority: PublicKey, reserve: PublicKey, mode: number, value: Buffer, skipValidation = false,
): TransactionInstruction {
  const cfgDisc = disc("update_reserve_config");
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  cfgDisc.copy(data, off); off += 8;
  data.writeUInt8(mode, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, off);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: authority,           isSigner: true,  isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: MARKET,              isSigner: false, isWritable: false },
      { pubkey: reserve,             isSigner: false, isWritable: true  },
    ],
    data,
  });
}

interface Subcommand {
  mode: number;
  value: Buffer;
  describe: (data: Buffer) => string;   // pretty current vs new
  readCurrent: (data: Buffer) => string;
  /** True only when the reserve is `is_predeposit` (no live deposits)
   *  — that's the single state in which klend honors the skip flag.
   *  Default false: route through `validate_reserve_config_integrity`. */
  skipValidation?: boolean;
}

function parseSubcommand(cmd: string, rawArgs: string[]): Subcommand {
  switch (cmd) {
    case "set-curve": {
      const arg = rawArgs[0];
      if (!arg) throw new Error("set-curve <jsonPath|presetName>");
      let pts: CurvePoint[];
      if (CURVE_PRESETS[arg]) pts = CURVE_PRESETS[arg];
      else pts = JSON.parse(fs.readFileSync(arg, "utf8")).borrowRateCurve?.points ?? JSON.parse(fs.readFileSync(arg, "utf8"));
      return {
        mode: MODE.BorrowRateCurve,
        value: curveBuf(pts),
        describe: () => `→ ${pts.length}-point curve, ${pts.map(p=>`${p.utilizationRateBps/100}/${p.borrowRateBps/100}`).join(" ")}`,
        readCurrent: (data) => {
          const out: string[] = [];
          for (let i = 0; i < 11; i++) {
            const o = RESERVE_CURVE_OFFSET + i * 8;
            out.push(`${data.readUInt32LE(o)/100}/${data.readUInt32LE(o+4)/100}`);
          }
          return out.join(" ");
        },
      };
    }
    case "set-deposit-limit": case "set-borrow-limit":
    case "set-borrow-limit-out-eg": {
      const v = rawArgs[0];
      if (!v) throw new Error(`${cmd} <rawU64>`);
      const val = BigInt(v);
      const buf = Buffer.alloc(8); buf.writeBigUInt64LE(val);
      const offset = cmd === "set-deposit-limit" ? RESERVE_DEPOSIT_LIMIT_OFFSET : RESERVE_BORROW_LIMIT_OFFSET;
      const mode = cmd === "set-deposit-limit" ? MODE.DepositLimit
        : cmd === "set-borrow-limit" ? MODE.BorrowLimit
        : MODE.BorrowLimitOutsideEG;
      return {
        mode, value: buf,
        skipValidation: false,
        describe: () => `→ ${val.toString()}`,
        readCurrent: (data) => cmd === "set-borrow-limit-out-eg"
          ? "(read-only — no fixed offset exposed)"
          : data.readBigUInt64LE(offset).toString(),
      };
    }
    case "set-elevation-groups": {
      const list = rawArgs[0];
      if (!list) throw new Error("set-elevation-groups <a,b,c,...>");
      const groups = list.split(",").map((s) => parseInt(s.trim()));
      return {
        mode: MODE.ElevationGroups,
        value: elevationGroupsBuf(groups),
        skipValidation: false,
        describe: () => `→ groups [${groups.join(", ")}] padded to 20`,
        readCurrent: () => "(read via SDK — raw bytes too noisy to dump here)",
      };
    }
    case "set-status": {
      const v = rawArgs[0];
      if (v == null) throw new Error("set-status <0|1|2>");
      const s = parseInt(v);
      return {
        mode: MODE.Status, value: Buffer.from([s]),
        describe: () => `→ ${["Active","Obsolete","Hidden"][s] ?? s}`,
        readCurrent: (data) => ["Active","Obsolete","Hidden"][data[RESERVE_STATUS_OFFSET]] ?? String(data[RESERVE_STATUS_OFFSET]),
      };
    }
    case "set-name": {
      const v = rawArgs[0];
      if (!v) throw new Error("set-name <string>");
      const buf = Buffer.alloc(32); Buffer.from(v).copy(buf);
      return {
        mode: MODE.Name, value: buf,
        describe: () => `→ "${v}"`,
        readCurrent: (data) => Buffer.from(data.subarray(RESERVE_NAME_OFFSET, RESERVE_NAME_OFFSET + 32)).toString().replace(/\0/g, ""),
      };
    }
    case "set-pyth": {
      const v = rawArgs[0];
      if (!v) throw new Error("set-pyth <pubkey>");
      return {
        mode: MODE.PythPrice, value: new PublicKey(v).toBuffer(),
        describe: () => `→ ${v}`,
        readCurrent: () => "(pyth oracle pubkey — not displayed)",
      };
    }
    case "set-ltv": case "set-liq-threshold": {
      const v = rawArgs[0];
      if (v == null) throw new Error(`${cmd} <pct>`);
      const pct = parseInt(v);
      return {
        mode: cmd === "set-ltv" ? MODE.LTV : MODE.LiqThreshold,
        value: Buffer.from([pct]),
        describe: () => `→ ${pct}%`,
        readCurrent: (data) => `${data[cmd === "set-ltv" ? RESERVE_LTV_OFFSET : RESERVE_LIQ_THRESHOLD_OFFSET]}%`,
      };
    }
    case "set-borrow-factor": {
      const v = rawArgs[0];
      if (!v) throw new Error("set-borrow-factor <pct≥100>");
      const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(v));
      return {
        mode: MODE.BorrowFactor, value: buf,
        skipValidation: false,
        describe: () => `→ ${v}%`,
        readCurrent: () => "(borrow factor — not displayed)",
      };
    }
    default:
      throw new Error(`unknown subcommand: ${cmd}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const send = argv.includes("--send");
  const args = argv.filter((a) => a !== "--send");
  if (args.length < 2) {
    console.error("Usage: update-reserve-config.ts <reserve> <subcommand> <args> [--send]");
    process.exit(2);
  }
  const reserveArg = args[0];
  const cmd = args[1];
  const rest = args.slice(2);

  const reserve = new PublicKey(reserveArg);
  const sub = parseSubcommand(cmd, rest);

  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  const before = await conn.getAccountInfo(reserve);
  if (!before) throw new Error(`reserve ${reserve.toBase58()} not found on-chain`);

  console.log("Network:        ", RPC);
  console.log("Authority:      ", auth.publicKey.toBase58());
  console.log("Reserve:        ", reserve.toBase58());
  console.log("Subcommand:     ", cmd);
  console.log("Mode:           ", sub.mode);
  console.log("Skip validation:", sub.skipValidation === true ? "true (predeposit-only path)" : "false (klend integrity check)");
  console.log("Current:        ", sub.readCurrent(before.data));
  console.log("Target:         ", sub.describe(before.data));
  console.log("");

  const ix = buildIx(auth.publicKey, reserve, sub.mode, sub.value, sub.skipValidation === true);
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = auth.publicKey;

  const sim = await conn.simulateTransaction(tx, [auth]);
  if (sim.value.err) {
    console.error("Simulation REJECTED:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.error("Logs:\n  " + sim.value.logs.join("\n  "));
    process.exit(1);
  }
  console.log("Simulation OK. Logs (last 6):");
  for (const l of (sim.value.logs ?? []).slice(-6)) console.log("  " + l);
  console.log("");

  if (!send) {
    console.log("Dry-run only. Re-run with --send to broadcast.");
    return;
  }

  console.log("Sending...");
  const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
  console.log("Confirmed:", sig);
  console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

  const after = await conn.getAccountInfo(reserve);
  if (after) {
    console.log("");
    console.log("New on-chain value:", sub.readCurrent(after.data));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
