/**
 * init-cssol-vault.ts — One-time bring-up of the csSOL pool's wSOL vault.
 *
 * `governor.wrap` deposits underlying tokens into a `vault` token account
 * owned by the pool PDA. For csSOL, the underlying is wSOL — so we need a
 * wSOL ATA with the pool PDA as owner. This script creates it (idempotent).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-cssol-vault.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";

function loadKp(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const poolCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), "utf8"));
  const poolPda = new PublicKey(poolCfg.pool.poolConfig);

  // Vault = wSOL ATA whose owner is the pool PDA. allowOwnerOffCurve=true since
  // the pool PDA is off-curve (it's a program-derived address).
  const vault = getAssociatedTokenAddressSync(NATIVE_MINT, poolPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  console.log("Pool PDA:        ", poolPda.toBase58());
  console.log("wSOL vault ATA:  ", vault.toBase58());

  if (await conn.getAccountInfo(vault)) {
    console.log("Vault already exists — nothing to do.");
    return;
  }

  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, vault, poolPda, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ),
    [payer],
  );
  console.log("Created:", sig);

  // Persist
  poolCfg.vault = vault.toBase58();
  fs.writeFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), JSON.stringify(poolCfg, null, 2) + "\n");
  console.log("Saved vault address into cssol-pool.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
