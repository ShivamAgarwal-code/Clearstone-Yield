/**
 * init-cssol-wt-oracle.ts — Allocates a separate accrual-oracle output
 * for the csSOL-WT reserve. The keeper-cloud Worker (extended) will call
 * accrual_oracle::refresh_with_vault on this output every 5 minutes,
 * pricing csSOL-WT identically to csSOL.
 *
 * Why a *separate* oracle output and not just point csSOL-WT at csSOL's
 * accrual output: the design memo describes an eventual `min(csSOL_price,
 * pool.pending_wsol / cssol_wt_supply * SOL_USD)` formula that needs to
 * read the WithdrawQueue PDA. That requires either:
 *   (a) a new accrual-oracle ix that takes the queue + cssol_wt_supply
 *       (simpler — but requires a program upgrade);
 *   (b) keeping the price 1:1 with csSOL via refresh_with_vault for v1
 *       and adding the backing-floor variant later (this script).
 *
 * v1 approach: same source-program, same feed_id, same vault binding
 * as csSOL → identical price stream. The `min(...)` floor is layered
 * in via a follow-up oracle upgrade once redemption stress shows up.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-cssol-wt-oracle.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const ACCRUAL_ORACLE = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const JITO_VAULT_PROGRAM = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

const SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PRICE_UPDATE_V2_LEN = 133;

const INITIAL_INDEX_E9 = 1_000_000_000n;
const RATE_BPS_PER_YEAR = 0;
const MIN_RATE_CHANGE_DELAY_SECS = 86_400;
const MAX_RATE_DELTA_BPS_PER_CHANGE = 200;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();

  const poolCfg = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), "utf8",
  ));
  const cssolJitoVault = new PublicKey(poolCfg.vault); // CSSOL_VAULT (the Jito vault account)

  const feedId = Buffer.from(SOL_USD_FEED_ID_HEX, "hex");

  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-wt-oracle.json");
  if (fs.existsSync(outPath)) {
    console.log(`already exists at ${outPath} — re-running would create a duplicate. Delete the file first if you want a fresh oracle.`);
    return;
  }

  console.log("=== csSOL-WT accrual oracle setup ===");
  console.log("RPC:        ", RPC_URL);
  console.log("Payer:      ", payer.publicKey.toBase58());
  console.log("Vault bind: ", cssolJitoVault.toBase58(), "(same vault as csSOL)");

  // 1. Allocate output PriceUpdateV2.
  console.log("\n1. allocating accrual output…");
  const output = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(PRICE_UPDATE_V2_LEN);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: output.publicKey,
        lamports: rent,
        space: PRICE_UPDATE_V2_LEN,
        programId: ACCRUAL_ORACLE,
      }),
    ),
    [payer, output],
  );
  console.log(`   output: ${output.publicKey.toBase58()}`);

  // 2. Initialize FeedConfig.
  console.log("2. initialize FeedConfig…");
  const [feedConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("accrual"), feedId, output.publicKey.toBuffer()],
    ACCRUAL_ORACLE,
  );
  // Args: base_index_e9 (u64) | rate_bps_per_year (i32) | min_delay (u32)
  //     | max_delta (u32) | source_program (Pubkey) | feed_id ([u8; 32])
  const args = Buffer.alloc(8 + 4 + 4 + 4 + 32 + 32);
  let off = 0;
  args.writeBigUInt64LE(INITIAL_INDEX_E9, off); off += 8;
  args.writeInt32LE(RATE_BPS_PER_YEAR, off); off += 4;
  args.writeUInt32LE(MIN_RATE_CHANGE_DELAY_SECS, off); off += 4;
  args.writeUInt32LE(MAX_RATE_DELTA_BPS_PER_CHANGE, off); off += 4;
  PYTH_RECEIVER.toBuffer().copy(args, off); off += 32;
  feedId.copy(args, off);

  const initIx = new TransactionInstruction({
    programId: ACCRUAL_ORACLE,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: feedConfig, isSigner: false, isWritable: true },
      { pubkey: output.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("initialize"), args]),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(initIx), [payer]);
  console.log(`   feedConfig: ${feedConfig.toBase58()}`);

  // 3. Bind to the same Jito vault as csSOL — refresh_with_vault path.
  console.log("3. bind to csSOL Jito vault (set_vault)…");
  const setVaultIx = new TransactionInstruction({
    programId: ACCRUAL_ORACLE,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: feedConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("set_vault"), cssolJitoVault.toBuffer()]),
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(setVaultIx), [payer]);
  console.log("   bound.");

  const out = {
    sourceProgram: PYTH_RECEIVER.toBase58(),
    feedIdHex: SOL_USD_FEED_ID_HEX,
    accrualOutput: output.publicKey.toBase58(),
    accrualConfig: feedConfig.toBase58(),
    vault: cssolJitoVault.toBase58(),
    initialIndexE9: INITIAL_INDEX_E9.toString(),
    rateBpsPerYear: RATE_BPS_PER_YEAR,
    minRateChangeDelaySecs: MIN_RATE_CHANGE_DELAY_SECS,
    maxRateDeltaBpsPerChange: MAX_RATE_DELTA_BPS_PER_CHANGE,
    completedAt: new Date().toISOString(),
    _note: "v1 binding: same vault as csSOL → identical price. v2 will add a backing-floor formula via an oracle upgrade.",
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== done ===");
  console.log(`Output:        ${output.publicKey.toBase58()}  (paste into delta_csSOL_WT_reserve.json::tokenInfo.pythConfiguration.price)`);
  console.log(`Saved → ${path.relative(process.cwd(), outPath)}`);
  console.log("\nNext: scripts/init-pool-pending-wsol.ts");
  // unused (kept for type safety, JITO_VAULT_PROGRAM verifies the vault belongs to Jito at call sites elsewhere)
  void JITO_VAULT_PROGRAM;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
