/**
 * init-pool-pending-wsol.ts — Creates the pool's `pending_wsol` token
 * account where matured Jito withdrawals land before being redeemed.
 *
 * **Why not ATA**: `getAssociatedTokenAddress(NATIVE_MINT, pool_pda)` is
 * a single canonical address. The pool already has a wSOL ATA (the
 * legacy `vault` for `governor::wrap`). Co-locating matured wSOL with
 * the deposit vault would commingle two accounting buckets — confusing
 * even if currently the wrap path is unused for csSOL. We use a plain
 * non-ATA token account at a fresh keypair-derived address instead, so
 * the address differs from the legacy vault by construction.
 *
 * Owner = pool PDA. Mint = NATIVE_MINT (wSOL).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-pool-pending-wsol.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();

  const poolCfgPath = path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  const poolCfg = JSON.parse(fs.readFileSync(poolCfgPath, "utf8"));
  const poolPda = new PublicKey(poolCfg.pool.poolConfig);

  if (poolCfg.poolPendingWsolAccount) {
    const existing = new PublicKey(poolCfg.poolPendingWsolAccount);
    if (await conn.getAccountInfo(existing)) {
      console.log(`Already exists at ${existing.toBase58()} — skipping.`);
      return;
    }
    console.warn(`Config has poolPendingWsolAccount=${existing.toBase58()} but on-chain account is missing. Recreating.`);
  }

  const acctKp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

  console.log("Pool PDA:               ", poolPda.toBase58());
  console.log("New pending_wsol acct:  ", acctKp.publicKey.toBase58());

  const tx = new Transaction()
    .add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: acctKp.publicKey,
      lamports: rent,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }))
    .add(createInitializeAccountInstruction(
      acctKp.publicKey,
      NATIVE_MINT,
      poolPda,            // owner = pool PDA
      TOKEN_PROGRAM_ID,
    ));

  const sig = await sendAndConfirmTransaction(conn, tx, [payer, acctKp]);
  console.log(`Tx: ${sig}`);

  poolCfg.poolPendingWsolAccount = acctKp.publicKey.toBase58();
  fs.writeFileSync(poolCfgPath, JSON.stringify(poolCfg, null, 2) + "\n");
  console.log(`Saved → cssol-pool.json::poolPendingWsolAccount`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
