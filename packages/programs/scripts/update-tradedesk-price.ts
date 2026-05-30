/**
 * update-tradedesk-price.ts — Update a TradeDesk Oracle feed price.
 *
 * Usage:
 *   npx tsx scripts/update-tradedesk-price.ts <FEED_LABEL> <PRICE_USD>
 *
 * Examples:
 *   npx tsx scripts/update-tradedesk-price.ts "USDY/USD" 1.08
 *   npx tsx scripts/update-tradedesk-price.ts "USDC/USD" 1.00
 *   npx tsx scripts/update-tradedesk-price.ts "cUSDY/USD" 1.08
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ORACLE_PROGRAM = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const label = process.argv[2];
  const priceUsd = parseFloat(process.argv[3]);

  if (!label || isNaN(priceUsd)) {
    console.error('Usage: npx tsx scripts/update-tradedesk-price.ts <FEED_LABEL> <PRICE_USD>');
    console.error('  e.g.: npx tsx scripts/update-tradedesk-price.ts "USDY/USD" 1.08');
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "mock_oracle.json"), "utf8"));
  const program = new Program(idl, provider);

  // Load desk config
  const configPath = path.join(__dirname, "..", "configs", "devnet", "tradedesk.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const deskPda = new PublicKey(config.desk);

  // Derive feed PDA
  const [feedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("feed"), deskPda.toBuffer(), Buffer.from(label)],
    ORACLE_PROGRAM
  );

  // Check if this is an operator or admin
  const [operatorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("operator"), deskPda.toBuffer(), authority.publicKey.toBuffer()],
    ORACLE_PROGRAM
  );
  const opInfo = await conn.getAccountInfo(operatorPda);
  const isOperator = !!opInfo;

  // Convert price: $1.08 with expo=-8 → 108000000
  const expo = -8;
  const priceScaled = Math.round(priceUsd * Math.pow(10, Math.abs(expo)));
  const confidence = Math.round(priceScaled * 0.001); // 0.1% confidence band

  console.log(`Updating ${label}: $${priceUsd} → ${priceScaled} (expo=${expo})`);
  console.log(`  Feed:       ${feedPda.toBase58()}`);
  console.log(`  Signer:     ${authority.publicKey.toBase58()} (${isOperator ? 'operator' : 'admin'})`);
  console.log(`  Confidence: ${confidence}`);

  try {
    const sig = await (program.methods as any)
      .setPrice(new BN(priceScaled), new BN(confidence))
      .accounts({
        authority: authority.publicKey,
        desk: deskPda,
        operatorEntry: isOperator ? operatorPda : null,
        priceFeed: feedPda,
      })
      .rpc();
    console.log(`\n  Updated! Tx: ${sig}`);
  } catch (e: any) {
    console.error(`  Failed: ${e.message}`);
    if (e.logs) {
      for (const log of e.logs.slice(-3)) console.error("  " + log);
    }
  }
}

main().catch(console.error);
