/**
 * add-admin.ts — Add a wallet as a governor admin
 *
 * Usage:
 *   npx tsx scripts/add-admin.ts <WALLET_ADDRESS>
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8"))));
  }
  const p = path.join(process.env.HOME || "~", ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const addr = process.argv[2];
  if (!addr) {
    console.error("Usage: npx tsx scripts/add-admin.ts <WALLET_ADDRESS>");
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "governor.json"), "utf8"));
  const program = new Program(idl, provider);

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "deployment.json"), "utf8")
  );
  const poolConfig = new PublicKey(deployment.pool.poolConfig);
  const newAdmin = new PublicKey(addr);

  const [adminEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("admin"), poolConfig.toBuffer(), newAdmin.toBuffer()],
    GOVERNOR
  );

  const exists = await conn.getAccountInfo(adminEntry);
  if (exists) {
    console.log(`Already admin: ${addr}`);
    console.log(`  PDA: ${adminEntry.toBase58()}`);
    return;
  }

  console.log(`Adding admin: ${newAdmin.toBase58()}`);
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log(`  Pool:      ${poolConfig.toBase58()}`);

  try {
    const sig = await (program.methods as any)
      .addAdmin()
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        newAdmin,
        adminEntry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`\nAdmin added!`);
    console.log(`  Tx: ${sig}`);
    console.log(`  PDA: ${adminEntry.toBase58()}`);
  } catch (e: any) {
    console.error(`Failed: ${e.message}`);
    if (e.logs) console.error("Logs:", e.logs.slice(-3).join("\n  "));
  }
}

main().catch(console.error);
