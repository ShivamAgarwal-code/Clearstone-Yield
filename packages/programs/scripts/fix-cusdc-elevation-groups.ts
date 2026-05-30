/**
 * fix-cusdc-elevation-groups.ts — write cUSDC reserve's elevation_groups
 * array to [1, 3, 4, 0×17] so klend's `check_same_elevation_group`
 * accepts borrows from EG-1 (stables) and EG-3 (margin-long-SOL)
 * obligations.
 *
 * Background: when the cUSDC reserve was first set up, its
 * elevation_groups array was written as [4, 0, …] — meant for the
 * EG-4 collateral side. But klend's borrow check requires the *borrow*
 * reserve's elevation_groups to ALSO contain the obligation's EG id,
 * not just the collateral reserve's. cSOL follows the same convention
 * (its array is [2, 3, 4] — debt in 2 + 4, collateral in 3).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/fix-cusdc-elevation-groups.ts
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

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const CUSDC_RESERVE = new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe");

const MODE_UPDATE_ELEVATION_GROUPS = 34;
const TARGET = [1, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const ELEVATION_GROUPS_OFFSET = 5480; // empirically located across all reserves

const UPDATE_DISC = crypto
  .createHash("sha256")
  .update("global:update_reserve_config")
  .digest()
  .subarray(0, 8);

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildIx(owner: PublicKey, value: Buffer, skipValidation: boolean): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  UPDATE_DISC.copy(data, off); off += 8;
  data.writeUInt8(MODE_UPDATE_ELEVATION_GROUPS, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, off);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: CUSDC_RESERVE, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp();
  console.log("Network:", RPC);
  console.log("Signer: ", auth.publicKey.toBase58());

  const before = await conn.getAccountInfo(CUSDC_RESERVE);
  console.log("BEFORE elevation_groups:", Array.from(before!.data.subarray(ELEVATION_GROUPS_OFFSET, ELEVATION_GROUPS_OFFSET + 20)).join(","));

  const value = Buffer.from(TARGET);

  // Try skipValidation=false first (live reserve = is_used=true post-
  // deposit; integrity-validator branch is the only one that should
  // accept). Fall back to true if rejected.
  let lastErr: any = null;
  for (const skipValidation of [false, true] as const) {
    try {
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(buildIx(auth.publicKey, value, skipValidation));
      const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
      console.log(`✓ elevation_groups update sent (skipValidation=${skipValidation}) tx=${sig}`);
      lastErr = null;
      break;
    } catch (e: any) {
      lastErr = e;
      const logs: string[] = e?.transactionLogs ?? e?.logs ?? [];
      console.log(`× skipValidation=${skipValidation} rejected:`);
      for (const l of logs.slice(-6)) console.log("  " + l);
    }
  }
  if (lastErr) throw lastErr;

  const after = await conn.getAccountInfo(CUSDC_RESERVE);
  console.log("AFTER  elevation_groups:", Array.from(after!.data.subarray(ELEVATION_GROUPS_OFFSET, ELEVATION_GROUPS_OFFSET + 20)).join(","));
}

main().catch((e) => { console.error(e); process.exit(1); });
