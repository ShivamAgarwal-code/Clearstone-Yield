/**
 * setup-tradedesk.ts — Initialize the TradeDesk Oracle with feeds for USDY and USDC.
 *
 * Creates:
 *   1. A trade desk ("RWA Trading Desk")
 *   2. Two price feeds: USDY/USD ($1.08) and USDC/USD ($1.00)
 *   3. Adds the mnemonic wallet as an operator
 *
 * Usage:
 *   npx tsx scripts/setup-tradedesk.ts
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
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "mock_oracle.json"), "utf8"));
  const program = new Program(idl, provider);

  const DESK_NAME = "RWA Trading Desk";

  console.log("============================================");
  console.log("  TradeDesk Oracle Setup");
  console.log("============================================");
  console.log(`  RPC:       ${RPC_URL}`);
  console.log(`  Admin:     ${authority.publicKey.toBase58()}`);
  console.log(`  Desk:      ${DESK_NAME}`);
  console.log("============================================\n");

  // Derive desk PDA
  const [deskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("desk"), authority.publicKey.toBuffer(), Buffer.from(DESK_NAME)],
    ORACLE_PROGRAM
  );

  // Step 1: Create desk (if not exists)
  const deskInfo = await conn.getAccountInfo(deskPda);
  if (deskInfo) {
    console.log(`Desk already exists: ${deskPda.toBase58()}`);
  } else {
    console.log("Creating trade desk...");
    const sig = await (program.methods as any)
      .createDesk(DESK_NAME, "Manages RWA token price feeds for institutional lending")
      .accounts({
        admin: authority.publicKey,
        desk: deskPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Desk created: ${deskPda.toBase58()}`);
    console.log(`  Tx: ${sig.slice(0, 40)}...\n`);
  }

  // Step 2: Create feeds
  const feeds = [
    { label: "USDY/USD", base: "USDY", quote: "USD", price: 108000000, expo: -8 }, // $1.08
    { label: "USDC/USD", base: "USDC", quote: "USD", price: 100000000, expo: -8 }, // $1.00
    { label: "cUSDY/USD", base: "cUSDY", quote: "USD", price: 108000000, expo: -8 }, // $1.08
  ];

  const feedAddresses: Record<string, string> = {};

  for (const f of feeds) {
    const [feedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("feed"), deskPda.toBuffer(), Buffer.from(f.label)],
      ORACLE_PROGRAM
    );

    const feedInfo = await conn.getAccountInfo(feedPda);
    if (feedInfo) {
      console.log(`Feed ${f.label} already exists: ${feedPda.toBase58()}`);
      feedAddresses[f.label] = feedPda.toBase58();
      continue;
    }

    console.log(`Creating feed: ${f.label} @ $${(f.price * Math.pow(10, f.expo)).toFixed(2)}...`);
    try {
      const sig = await (program.methods as any)
        .createFeed(f.label, f.base, f.quote, f.expo, new BN(f.price))
        .accounts({
          authority: authority.publicKey,
          desk: deskPda,
          operatorEntry: null,
          priceFeed: feedPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  Created: ${feedPda.toBase58()}`);
      console.log(`  Tx: ${sig.slice(0, 40)}...\n`);
      feedAddresses[f.label] = feedPda.toBase58();
    } catch (e: any) {
      console.log(`  Failed: ${e.message?.slice(0, 80)}\n`);
    }
  }

  // Step 3: Add mnemonic wallet as operator (if env has it)
  try {
    const envFile = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const match = envFile.match(/DEPLOY_MNEMONIC="([^"]+)"/);
    if (match) {
      const bip39 = await import("bip39");
      const { derivePath } = await import("ed25519-hd-key");
      const seed = bip39.mnemonicToSeedSync(match[1], "");
      const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
      const phantomWallet = Keypair.fromSeed(derived.key).publicKey;

      const [operatorPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("operator"), deskPda.toBuffer(), phantomWallet.toBuffer()],
        ORACLE_PROGRAM
      );

      const opInfo = await conn.getAccountInfo(operatorPda);
      if (opInfo) {
        console.log(`Operator already exists: ${phantomWallet.toBase58()}`);
      } else {
        console.log(`Adding operator: ${phantomWallet.toBase58()}`);
        const sig = await (program.methods as any)
          .addOperator()
          .accounts({
            admin: authority.publicKey,
            desk: deskPda,
            operator: phantomWallet,
            operatorEntry: operatorPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        console.log(`  Added! Tx: ${sig.slice(0, 40)}...\n`);
      }
    }
  } catch (e: any) {
    console.log(`  Operator setup skipped: ${e.message?.slice(0, 60)}\n`);
  }

  // Save config
  const config = {
    program: ORACLE_PROGRAM.toBase58(),
    desk: deskPda.toBase58(),
    admin: authority.publicKey.toBase58(),
    feeds: feedAddresses,
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "tradedesk.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));

  console.log("============================================");
  console.log("  TradeDesk Oracle Ready");
  console.log("============================================");
  console.log(`  Desk:      ${deskPda.toBase58()}`);
  for (const [label, addr] of Object.entries(feedAddresses)) {
    console.log(`  ${label.padEnd(12)} ${addr}`);
  }
  console.log(`\n  Config:    ${outPath}`);
  console.log("============================================");
}

main().catch(console.error);
