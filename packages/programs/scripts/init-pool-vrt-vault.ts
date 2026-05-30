/**
 * init-pool-vrt-vault.ts — Phase A step 2: create the pool's VRT vault.
 *
 * `governor::wrap_with_jito_vault` mints VRT into a pool-PDA-owned ATA
 * (canonical pool backing). That ATA must exist before the first call.
 * One-shot: creates ATA(vrt_mint, pool_pda, allowOwnerOffCurve=true).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-pool-vrt-vault.ts
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
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const poolCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), "utf8"));
  const vaultCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8"));
  const poolPda = new PublicKey(poolCfg.pool.poolConfig);
  const vrtMint = new PublicKey(vaultCfg.vrtMint);

  const poolVrtAta = getAssociatedTokenAddressSync(
    vrtMint, poolPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("Pool PDA:    ", poolPda.toBase58());
  console.log("VRT mint:    ", vrtMint.toBase58());
  console.log("Pool VRT ATA:", poolVrtAta.toBase58());

  if (await conn.getAccountInfo(poolVrtAta)) {
    console.log("already exists, nothing to do.");
  } else {
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, poolVrtAta, poolPda, vrtMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      )),
      [payer],
    );
    console.log("created:", sig);
  }

  // Persist
  poolCfg.poolVrtAta = poolVrtAta.toBase58();
  fs.writeFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), JSON.stringify(poolCfg, null, 2) + "\n");
  console.log("saved pool VRT ATA into cssol-pool.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
