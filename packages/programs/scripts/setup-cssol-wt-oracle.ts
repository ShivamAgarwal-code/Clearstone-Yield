/**
 * setup-cssol-wt-oracle.ts — Dedicated accrual-oracle output for the
 * csSOL-WT klend reserve.
 *
 * Background
 * ----------
 * Today both csSOL and csSOL-WT klend reserves point at the SAME
 * accrual oracle output (`3Sx8WJC7…Pw3P`, see configs/devnet/
 * cssol-oracle.json). The WT reserve config's `_oracle_note` calls for
 * a separate price formula:
 *
 *   csSOL-WT price = min(
 *     csSOL_price * (1 - epoch_time_discount),
 *     pool.pending_wsol_total / cssol_wt_supply * SOL_USD
 *   )
 *
 * The accrual-oracle program already supports the second leg via
 * `refresh_with_vault` (programs/accrual-oracle/src/lib.rs:234) — it
 * computes `index_e9 = vault.tokens_deposited / vault.vrt_supply * 1e9`
 * directly from the bound Jito Vault. This script:
 *
 *   1. Allocates a new `PriceUpdateV2`-shaped output account owned by
 *      the accrual-oracle program (= the address WT will point at).
 *   2. Initializes a new `FeedConfig` PDA bound to the same Pyth
 *      SOL/USD source feed as csSOL.
 *   3. Calls `set_vault` to bind the csSOL Jito Vault, locking
 *      `refresh_with_vault` to that vault's state.
 *   4. Saves the addresses to configs/devnet/cssol-wt-oracle.json.
 *
 * What this script intentionally does NOT do
 * ------------------------------------------
 * - It does NOT update the WT klend reserve's `pyth_configuration.price`
 *   to point at the new output. That's a one-line follow-up via
 *   `update_reserve_config(mode=20, value=<new_output>)` once the keeper
 *   has been wired to crank the new oracle and the inline-crank in
 *   creditTrade.ts has been duplicated for the WT-specific oracle.
 *   Leaving the reserve pointing at the shared csSOL oracle keeps the
 *   convert/unwind flow working through the migration.
 *
 * - It does NOT update keeper-cloud or the inline crank. Those are
 *   separate edits — see comments in packages/keeper-cloud/src/index.ts
 *   and packages/frontend-institutional/src/lib/credit-trade/creditTrade.ts.
 *
 * Migration plan
 * --------------
 *   1. Run this script ONCE with the lending-market-owner keypair.
 *      Captures new accrualOutput / accrualConfig in the json file.
 *   2. Add a second `accrual_oracle::refresh_with_vault` call to
 *      keeper-cloud/src/index.ts so both oracles stay fresh.
 *   3. Duplicate `buildAccrualOracleRefreshIx` in creditTrade.ts as
 *      `buildAccrualOracleRefreshWithVaultIx`, wire it into the WT
 *      builders alongside the existing crank.
 *   4. Update the LUT to include the new output + vault accounts.
 *   5. Once the above is verified live, run
 *      `update_reserve_config(WT, mode=20, value=<new_output>)` to
 *      switch the reserve over.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/setup-cssol-wt-oracle.ts
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, SystemProgram, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const ACCRUAL_ORACLE = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");
const PYTH_RECEIVER  = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// Pyth SOL/USD feed id — same as csSOL since price denomination is the
// same; the divergence comes from the *index* (vault-backing ratio
// instead of time-based accrual).
const SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Jito vault to bind for `refresh_with_vault`. Pinned from
// configs/devnet/cssol-jito-vault.json (same address used by
// init-credit-trade-lut.ts).
const CSSOL_JITO_VAULT = new PublicKey("EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W");

// Pyth-sponsored SOL/USD push feed on devnet — the source PriceUpdateV2
// the accrual oracle reads. Same account both csSOL and the new WT
// oracle consume. Owner = Pyth Receiver; updated permissionlessly by
// Pyth's network every ~30s.
const PYTH_SOL_USD_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

const PRICE_UPDATE_V2_LEN = 133;

const INITIAL_INDEX_E9 = 1_000_000_000n; // 1.0 — refresh_with_vault overwrites this every fire
const RATE_BPS_PER_YEAR = 0;             // unused in vault mode but required at init
const MIN_RATE_CHANGE_DELAY_SECS = 86_400;
const MAX_RATE_DELTA_BPS_PER_CHANGE = 200;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    || path.join(process.env.HOME!, ".config/solana/id.json");
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
    new Transaction().add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: kp.publicKey,
      lamports: rent,
      space: PRICE_UPDATE_V2_LEN,
      programId: ACCRUAL_ORACLE,
    })),
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

  const args = Buffer.alloc(8 + 4 + 4 + 4 + 32 + 32);
  let off = 0;
  args.writeBigUInt64LE(INITIAL_INDEX_E9, off); off += 8;
  args.writeInt32LE(RATE_BPS_PER_YEAR, off); off += 4;
  args.writeUInt32LE(MIN_RATE_CHANGE_DELAY_SECS, off); off += 4;
  args.writeUInt32LE(MAX_RATE_DELTA_BPS_PER_CHANGE, off); off += 4;
  PYTH_RECEIVER.toBuffer().copy(args, off); off += 32;
  feedId.copy(args, off);

  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(new TransactionInstruction({
      programId: ACCRUAL_ORACLE,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: feedConfig, isSigner: false, isWritable: true },
        { pubkey: output, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("initialize"), args]),
    })),
    [payer],
  );
  return feedConfig;
}

async function refreshWithVault(
  conn: Connection,
  payer: Keypair,
  feedConfig: PublicKey,
  source: PublicKey,
  vault: PublicKey,
  output: PublicKey,
): Promise<void> {
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(new TransactionInstruction({
      programId: ACCRUAL_ORACLE,
      keys: [
        { pubkey: feedConfig, isSigner: false, isWritable: false },
        { pubkey: source, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: output, isSigner: false, isWritable: true  },
      ],
      data: disc("refresh_with_vault"),
    })),
    [payer],
  );
}

async function bindVault(
  conn: Connection,
  payer: Keypair,
  feedConfig: PublicKey,
  vault: PublicKey,
): Promise<void> {
  // set_vault(authority, feed_config, new_vault: Pubkey)
  const args = Buffer.alloc(32);
  vault.toBuffer().copy(args, 0);
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(new TransactionInstruction({
      programId: ACCRUAL_ORACLE,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: feedConfig, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc("set_vault"), args]),
    })),
    [payer],
  );
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKeypair();

  const feedId = Buffer.from(SOL_USD_FEED_ID_HEX, "hex");
  if (feedId.length !== 32) throw new Error("feed id must be 32 bytes");

  console.log("=== csSOL-WT accrual oracle setup (vault-backed) ===");
  console.log(`RPC:           ${RPC}`);
  console.log(`Payer:         ${payer.publicKey.toBase58()}`);
  console.log(`Source program (Pyth Receiver): ${PYTH_RECEIVER.toBase58()}`);
  console.log(`Feed (SOL/USD): ${SOL_USD_FEED_ID_HEX}`);
  console.log(`Vault to bind:  ${CSSOL_JITO_VAULT.toBase58()}`);

  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-wt-oracle.json");
  if (fs.existsSync(outPath)) {
    throw new Error(`${outPath} already exists — refusing to overwrite. Delete it first if you really want to re-init.`);
  }

  console.log("\nAllocating output account…");
  const output = await createOutputFeed(conn, payer);
  console.log(`  output @ ${output.publicKey.toBase58()}`);

  console.log("Initializing accrual feed…");
  const feedConfig = await initializeAccrual(conn, payer, output.publicKey, feedId);
  console.log(`  config @ ${feedConfig.toBase58()}`);

  console.log("Binding Jito vault for refresh_with_vault…");
  await bindVault(conn, payer, feedConfig, CSSOL_JITO_VAULT);
  console.log(`  bound vault: ${CSSOL_JITO_VAULT.toBase58()}`);

  // Seed the new output with one immediate refresh so subsequent
  // klend `refresh_reserve(WT)` can read a live posted_slot rather
  // than the all-zero placeholder left by `initialize`.
  console.log("Seeding output with one refresh_with_vault…");
  await refreshWithVault(conn, payer, feedConfig, PYTH_SOL_USD_FEED, CSSOL_JITO_VAULT, output.publicKey);
  console.log("  ✓ output seeded — posted_slot now current");

  const out = {
    sourceProgram: PYTH_RECEIVER.toBase58(),
    feedIdHex: SOL_USD_FEED_ID_HEX,
    accrualOutput: output.publicKey.toBase58(),
    accrualConfig: feedConfig.toBase58(),
    boundVault: CSSOL_JITO_VAULT.toBase58(),
    refreshMode: "refresh_with_vault",
    initialIndexE9: INITIAL_INDEX_E9.toString(),
    sourceFeed: PYTH_SOL_USD_FEED.toBase58(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nSaved → ${outPath}`);

  console.log(`
═══════════════════════════════════════════════════════════════════════
ON-CHAIN SETUP COMPLETE — three follow-up steps remaining
═══════════════════════════════════════════════════════════════════════

1. Add to packages/frontend-institutional/.env.local:

   VITE_WT_ACCRUAL_CONFIG=${feedConfig.toBase58()}
   VITE_WT_ACCRUAL_OUTPUT=${output.publicKey.toBase58()}
   VITE_WT_BOUND_VAULT=${CSSOL_JITO_VAULT.toBase58()}

2. Add to packages/keeper-cloud/wrangler.toml [vars] (or via
   \`pnpm wrangler secret put …\` for production):

   WT_ACCRUAL_CONFIG = "${feedConfig.toBase58()}"
   WT_ACCRUAL_OUTPUT = "${output.publicKey.toBase58()}"
   WT_BOUND_VAULT    = "${CSSOL_JITO_VAULT.toBase58()}"

   Then redeploy:  cd packages/keeper-cloud && pnpm deploy

3. Run the LUT extend + reserve flip:

   DEPLOY_KEYPAIR=~/.config/solana/id.json \\
     npx tsx packages/programs/scripts/migrate-wt-reserve-to-new-oracle.ts

   This script appends the new oracle accounts to the credit-trade LUT
   AND calls \`update_reserve_config(WT, mode=20, value=…)\` to flip
   the WT reserve's pyth_configuration.price to the new output.
   Validates the migration by sending a refresh_reserve(WT) and
   checking that last_update.slot bumps.
═══════════════════════════════════════════════════════════════════════
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
