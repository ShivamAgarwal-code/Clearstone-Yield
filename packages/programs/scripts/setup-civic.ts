/**
 * setup-civic.ts — Configure Civic self-registration for the governor pool.
 *
 * Steps:
 *   1. Set the governor pool PDA as delta-mint's co_authority
 *   2. Set the Civic gatekeeper network on the pool
 *
 * Usage:
 *   npx tsx scripts/setup-civic.ts [gatekeeper-network-pubkey]
 *
 * Gatekeeper networks:
 *   ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6  — Uniqueness (liveness only)
 *   tibePmPaoTgrs929rWpu755EXaxC7M3SthVCf6GK3yL  — ID Verification (gov ID + liveness)
 *   bni1ewus6aMxTxBi5SAfzEmmXLf8KcVFRmTfproJuKw  — ID + OFAC screening
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Default: Civic uniqueness (liveness only — good for devnet testing)
const DEFAULT_NETWORK = "ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6";

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME || "~", ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const networkArg = process.argv[2] || DEFAULT_NETWORK;
  const gatekeeperNetwork = new PublicKey(networkArg);

  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  // Load deployment config
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "deployment.json"), "utf8")
  );
  const poolConfig = new PublicKey(deployment.pool.poolConfig);
  const dmMintConfig = new PublicKey(deployment.pool.dmMintConfig);

  // Load IDLs
  const govIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "governor.json"), "utf8"));
  const dmIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "delta_mint.json"), "utf8"));
  const governor = new Program(govIdl, provider);
  const deltaMint = new Program(dmIdl, provider);

  console.log("============================================");
  console.log("  Civic Self-Registration Setup");
  console.log("============================================");
  console.log(`  Authority:         ${authority.publicKey.toBase58()}`);
  console.log(`  Pool:              ${poolConfig.toBase58()}`);
  console.log(`  DM MintConfig:     ${dmMintConfig.toBase58()}`);
  console.log(`  Gatekeeper Net:    ${gatekeeperNetwork.toBase58()}`);
  console.log("============================================\n");

  // Step 1: Set co_authority on delta-mint to the pool PDA
  console.log("Step 1: Setting co_authority on delta-mint...");
  try {
    const sig = await (deltaMint.methods as any)
      .setCoAuthority(poolConfig)
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Done: ${sig.slice(0, 30)}...`);
  } catch (e: any) {
    if (e.message?.includes("already in use") || e.message?.includes("custom program error")) {
      console.log(`  May already be set. Error: ${e.message.slice(0, 80)}`);
    } else {
      throw e;
    }
  }

  // Step 2: Set gatekeeper network on governor pool
  console.log("\nStep 2: Setting gatekeeper network on governor pool...");
  try {
    const sig = await (governor.methods as any)
      .setGatekeeperNetwork(gatekeeperNetwork)
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Done: ${sig.slice(0, 30)}...`);
  } catch (e: any) {
    console.error(`  Failed: ${e.message}`);
    throw e;
  }

  console.log("\n============================================");
  console.log("  Self-registration enabled!");
  console.log("============================================");
  console.log("  Users with a valid Civic pass can now call");
  console.log("  governor.self_register() to whitelist");
  console.log("  themselves without admin intervention.");
  console.log("============================================");
}

main().catch(console.error);
