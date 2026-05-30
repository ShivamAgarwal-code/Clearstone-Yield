/**
 * init-withdraw-queue.ts — Calls governor::init_withdraw_queue on the
 * upgraded governor program. One-shot per pool; creates the per-pool
 * `WithdrawQueue` PDA at seeds = [b"withdraw_queue", pool_pda].
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-withdraw-queue.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const GOVERNOR_PROGRAM_ID = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  const governor = new Program(loadIdl("governor"), provider);

  const poolCfgPath = path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  const poolCfg = JSON.parse(fs.readFileSync(poolCfgPath, "utf8"));
  const poolPda = new PublicKey(poolCfg.pool.poolConfig);

  const [withdrawQueue] = PublicKey.findProgramAddressSync(
    [Buffer.from("withdraw_queue"), poolPda.toBuffer()],
    GOVERNOR_PROGRAM_ID,
  );

  console.log("=== withdraw queue init ===");
  console.log("Pool PDA:        ", poolPda.toBase58());
  console.log("WithdrawQueue:   ", withdrawQueue.toBase58());

  if (await conn.getAccountInfo(withdrawQueue)) {
    console.log("Already initialized — nothing to do.");
  } else {
    const sig = await (governor.methods as any)
      .initWithdrawQueue()
      .accounts({
        authority: authority.publicKey,
        poolConfig: poolPda,
        withdrawQueue,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`Created — Tx: ${sig}`);
  }

  // Persist
  poolCfg.withdrawQueue = withdrawQueue.toBase58();
  fs.writeFileSync(poolCfgPath, JSON.stringify(poolCfg, null, 2) + "\n");
  console.log(`Saved withdrawQueue address → cssol-pool.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
