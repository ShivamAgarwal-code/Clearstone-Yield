/**
 * setup-cssol-oracle.ts
 *
 * One-time setup of the csSOL price feed. Allocates the accrual-oracle output
 * (the stable address klend reserves point at) and initializes a FeedConfig
 * bound to:
 *
 *   source_program = Pyth Solana Receiver  (rec5EKMG…)
 *   feed_id        = SOL/USD                (ef0d8b6f…)
 *
 * Each keeper fire then posts a fresh Hermes VAA via the Pyth Receiver,
 * runs accrual-oracle::refresh on the resulting Pyth-owned price account, and
 * closes the price account in the same tx for rent refund. No long-lived
 * source account exists — the binding is by (program, feed_id).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/setup-cssol-oracle.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const ACCRUAL_ORACLE = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// Pyth SOL/USD feed id (network-agnostic price-feed identifier).
const SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const PRICE_UPDATE_V2_LEN = 133;

const INITIAL_INDEX_E9 = 1_000_000_000n; // 1.0
const RATE_BPS_PER_YEAR = 0; // passthrough until LST yield kicks in
const MIN_RATE_CHANGE_DELAY_SECS = 86_400; // 1 day on devnet; bump to ~172_800 (1 epoch) on mainnet
const MAX_RATE_DELTA_BPS_PER_CHANGE = 200; // ±2 % APY per cooldown

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function createOutputFeed(conn: Connection, payer: Keypair): Promise<Keypair> {
  const kp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(PRICE_UPDATE_V2_LEN);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: kp.publicKey,
        lamports: rent,
        space: PRICE_UPDATE_V2_LEN,
        programId: ACCRUAL_ORACLE,
      }),
    ),
    [payer, kp],
  );
  return kp;
}

async function initializeAccrual(
  conn: Connection,
  payer: Keypair,
  output: PublicKey,
  feedId: Buffer,
): Promise<PublicKey> {
  const [feedConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("accrual"), feedId, output.toBuffer()],
    ACCRUAL_ORACLE,
  );

  // Args: base_index_e9 (u64) | rate_bps_per_year (i32) | min_delay (u32) |
  //       max_delta (u32) | source_program (Pubkey 32) | feed_id ([u8; 32])
  const args = Buffer.alloc(8 + 4 + 4 + 4 + 32 + 32);
  let off = 0;
  args.writeBigUInt64LE(INITIAL_INDEX_E9, off); off += 8;
  args.writeInt32LE(RATE_BPS_PER_YEAR, off); off += 4;
  args.writeUInt32LE(MIN_RATE_CHANGE_DELAY_SECS, off); off += 4;
  args.writeUInt32LE(MAX_RATE_DELTA_BPS_PER_CHANGE, off); off += 4;
  PYTH_RECEIVER.toBuffer().copy(args, off); off += 32;
  feedId.copy(args, off);

  const ix = new TransactionInstruction({
    programId: ACCRUAL_ORACLE,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: feedConfig, isSigner: false, isWritable: true },
      { pubkey: output, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("initialize"), args]),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
  return feedConfig;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();

  const feedId = Buffer.from(SOL_USD_FEED_ID_HEX, "hex");
  if (feedId.length !== 32) throw new Error("feed id must be 32 bytes");

  console.log("=== csSOL accrual oracle setup (real Pyth source) ===");
  console.log("RPC:           ", RPC_URL);
  console.log("Payer:         ", payer.publicKey.toBase58());
  console.log("Source program:", PYTH_RECEIVER.toBase58());
  console.log("Feed (SOL/USD):", SOL_USD_FEED_ID_HEX);
  console.log();

  console.log("Allocating accrual output account...");
  const output = await createOutputFeed(conn, payer);
  console.log(`  output @ ${output.publicKey.toBase58()}`);

  console.log("Initializing accrual feed...");
  const feedConfig = await initializeAccrual(conn, payer, output.publicKey, feedId);
  console.log(`  config @ ${feedConfig.toBase58()}`);

  const out = {
    sourceProgram: PYTH_RECEIVER.toBase58(),
    feedIdHex: SOL_USD_FEED_ID_HEX,
    accrualOutput: output.publicKey.toBase58(),
    accrualConfig: feedConfig.toBase58(),
    initialIndexE9: INITIAL_INDEX_E9.toString(),
    rateBpsPerYear: RATE_BPS_PER_YEAR,
    minRateChangeDelaySecs: MIN_RATE_CHANGE_DELAY_SECS,
    maxRateDeltaBpsPerChange: MAX_RATE_DELTA_BPS_PER_CHANGE,
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-oracle.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nSaved → ${outPath}`);
  console.log("\nNext: paste accrualOutput into delta_csSOL_reserve.json::tokenInfo.pythConfiguration.price");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
