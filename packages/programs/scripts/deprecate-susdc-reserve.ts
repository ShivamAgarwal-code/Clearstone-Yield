/**
 * deprecate-susdc-reserve.ts — Final phase of the sUSDC → cUSDC switch.
 *
 * After migrate-eg-debt-to-cusdc.ts has flipped EG-1 and EG-3 to point
 * at the cUSDC reserve, the legacy unrestricted sUSDC reserve
 * (`78kkPN…BFy9`) has no traffic. This script locks it down:
 *
 *   * UpdateReserveStatus → Hidden (1) — klend rejects new
 *     deposit / borrow flows with `ReserveDeprecated`-flavored errors
 *     while leaving repay / withdraw paths open for any stragglers.
 *   * UpdateDepositLimit → 0 — defense-in-depth.
 *   * UpdateBorrowLimit → 0 — defense-in-depth.
 *   * UpdateBorrowLimitOutsideElevationGroup → 0.
 *   * UpdateElevationGroups → [0; 20] — drop sUSDC from any reserve's
 *     EG-collateral-eligibility list (its old EG-4 entry).
 *
 * All ops use update_reserve_config (skipValidation chosen per the
 * `klend skip-validation flag inverted` memory: false for cap edits on
 * a live reserve so the integrity-validator branch accepts them, true
 * for status / EG flag edits which the validator rejects).
 *
 * Always simulates; pass --send to broadcast.
 *
 * Pre-conditions (verify before --send):
 *   - migrate-eg-debt-to-cusdc.ts has completed (no EG points at sUSDC).
 *   - sUSDC supply vault is essentially empty (project memory: 0.10
 *     sUSDC dust at deprecation time).
 *   - 0 obligations have non-zero sUSDC deposits or borrows.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/deprecate-susdc-reserve.ts          # dry-run
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/deprecate-susdc-reserve.ts --send   # broadcast
 *
 * Authority: lending-market owner.
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

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const SUSDC_RESERVE = new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9");

// klend reserve_config update modes (from setup-csol-reserve.ts).
const MODE = {
  UpdateDepositLimit: 8,
  UpdateBorrowLimit: 9,
  UpdateElevationGroups: 34,
  UpdateBorrowLimitOutsideElevationGroup: 44,
  // ReserveStatus is mode 33 in klend's IDL — single u8 enum:
  //   0 = Active, 1 = Obsolete, 2 = Hidden.
  // Hidden is the right pick: blocks new deposit/borrow but leaves
  // repay/withdraw paths open for any stragglers.
  UpdateReserveStatus: 33,
} as const;
const RESERVE_STATUS_HIDDEN = 2;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
const UPDATE_DISC = disc("update_reserve_config");

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildUpdateReserveConfigIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  mode: number, value: Buffer, skipValidation: boolean,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  UPDATE_DISC.copy(data, off); off += 8;
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
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp();

  console.log("Network:    ", RPC);
  console.log("Authority:  ", auth.publicKey.toBase58());
  console.log("Market:     ", MARKET.toBase58());
  console.log("Reserve:    ", SUSDC_RESERVE.toBase58(), "(sUSDC — DEPRECATING)");
  console.log("");

  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

  // skipValidation choice per the memory note. For limit cuts on a live
  // reserve, false routes through the integrity validator which accepts
  // limit-decreasing edits. For status / EG-array edits, true bypasses
  // the validator (which rejects them outright).
  const ops: { name: string; mode: number; value: Buffer; skipValidation: boolean }[] = [
    { name: "Status → Hidden",                            mode: MODE.UpdateReserveStatus,                  value: Buffer.from([RESERVE_STATUS_HIDDEN]), skipValidation: true  },
    { name: "DepositLimit → 0",                           mode: MODE.UpdateDepositLimit,                   value: u64(0n),                              skipValidation: false },
    { name: "BorrowLimit → 0",                            mode: MODE.UpdateBorrowLimit,                    value: u64(0n),                              skipValidation: false },
    { name: "BorrowLimitOutsideElevationGroup → 0",       mode: MODE.UpdateBorrowLimitOutsideElevationGroup, value: u64(0n),                            skipValidation: true  },
    { name: "ElevationGroups → [0; 20]",                  mode: MODE.UpdateElevationGroups,                value: Buffer.alloc(20),                     skipValidation: true  },
  ];

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }),
    ...ops.map((o) => buildUpdateReserveConfigIx(auth.publicKey, MARKET, SUSDC_RESERVE, o.mode, o.value, o.skipValidation)),
  ];
  console.log("Operations:");
  for (const o of ops) console.log(`  - ${o.name}  (mode=${o.mode}, skipValidation=${o.skipValidation})`);
  console.log("");

  // Split into individual txs — update_reserve_config must run alone
  // for klend's integrity validator to read fresh state between edits.
  // (Same pattern setup-csol-reserve.ts uses.)
  for (const op of ops) {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(auth.publicKey, MARKET, SUSDC_RESERVE, op.mode, op.value, op.skipValidation));
    const { blockhash } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = auth.publicKey;

    const sim = await conn.simulateTransaction(tx, [auth]);
    if (sim.value.err) {
      console.error(`✗ ${op.name} — simulation REJECTED:`, JSON.stringify(sim.value.err));
      if (sim.value.logs) console.error("  " + sim.value.logs.slice(-6).join("\n  "));
      process.exit(1);
    }
    console.log(`✓ ${op.name} — sim OK`);

    if (send) {
      const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
      console.log(`  → ${sig}`);
    }
  }

  if (!send) {
    console.log("\nDry-run complete. All sims passed. Re-run with --send to broadcast.");
  } else {
    console.log("\nsUSDC reserve deprecated. Frontend should now show it as a legacy/repay-only entry.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
