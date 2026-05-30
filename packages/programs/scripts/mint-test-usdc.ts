/**
 * mint-test-usdc.ts — Mint test USDC to a wallet on devnet
 *
 * Usage:
 *   npx tsx scripts/mint-test-usdc.ts <WALLET_ADDRESS> [amount_usdc]
 *   npx tsx scripts/mint-test-usdc.ts J4vmo...  1000
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME || "~", ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const wallet = process.argv[2];
  const amountUsdc = parseFloat(process.argv[3] || "1000");

  if (!wallet) {
    console.error("Usage: npx tsx scripts/mint-test-usdc.ts <WALLET_ADDRESS> [amount_usdc]");
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const dest = new PublicKey(wallet);

  // Load test USDC mint from deployment config
  const marketConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "market-deployed.json"), "utf8")
  );
  const usdcMint = new PublicKey(
    marketConfig.testUsdcMint || marketConfig.reserves?.USDC?.mint || "2tboZ672zptawbXLUrcqfF7YkkS1kzDS4ewwxtjuog1G"
  );

  console.log(`Minting ${amountUsdc} test USDC to ${wallet}`);
  console.log(`  Mint: ${usdcMint.toBase58()}`);
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);

  const ata = await getOrCreateAssociatedTokenAccount(
    conn, authority, usdcMint, dest, false, undefined, undefined, TOKEN_PROGRAM_ID
  );
  console.log(`  ATA: ${ata.address.toBase58()}`);

  const amount = BigInt(Math.round(amountUsdc * 1e6));
  const sig = await mintTo(conn, authority, usdcMint, ata.address, authority, amount);
  console.log(`  Minted! Tx: ${sig}`);
}

main().catch(console.error);
