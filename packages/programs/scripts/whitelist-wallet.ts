/**
 * whitelist-wallet.ts
 *
 * Whitelists a wallet as a Holder/Liquidator across **every MintConfig**
 * managed by the csSOL pool — atomically and idempotently. Reads the
 * unified bundle config so retail, institutional, and playground users
 * end up with identical on-chain whitelist coverage with one invocation.
 *
 * Both KYC-gated retail and KYB-gated institutional approvals end up as
 * a `WhitelistRole::Holder` PDA on each MintConfig — the only smart-
 * contract role that can mint csSOL / csSOL-WT. This script is what
 * realises that "Holder on all of them" outcome on-chain.
 *
 * Default mode (bundle): hits every entry in
 * `configs/devnet/whitelist-bundle.json` for the csSOL pool, skipping
 * any whose whitelist PDA already exists.
 *
 * Single-MintConfig mode: pass `MINT_CONFIG_LABEL=<label>` to whitelist
 * on just one entry from the bundle (e.g. for re-running a partial
 * failure). Or set `DM_MINT_CONFIG=<address>` to target an arbitrary
 * MintConfig outside the bundle (legacy override path).
 *
 * Usage:
 *   npx tsx scripts/whitelist-wallet.ts <WALLET_ADDRESS> [holder|liquidator]
 *
 *   # Just one entry from the bundle:
 *   MINT_CONFIG_LABEL=csSOL-WT npx tsx scripts/whitelist-wallet.ts <WALLET>
 *
 *   # Off-bundle MintConfig (legacy):
 *   DM_MINT_CONFIG=<addr> npx tsx scripts/whitelist-wallet.ts <WALLET>
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const GOVERNOR_PROGRAM_ID = new PublicKey(
  process.env.GOVERNOR_PROGRAM_ID ?? "6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi",
);
const DELTA_MINT_PROGRAM_ID = new PublicKey(
  process.env.DELTA_MINT_PROGRAM_ID ?? "BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy",
);

interface BundleEntry {
  label: string;
  address: string;
  ix:
    | "addParticipantViaPool"        // standard csSOL-style pool (seed: ["pool", underlying_mint])
    | "addWtParticipantViaPool"      // withdraw-ticket sibling (different seed shape)
    | "addParticipantNativeViaPool"; // native-wrap pool — cSOL (seed: ["native_pool", wrapped_mint])
  comment?: string;
}
interface BundlePool {
  poolConfig: string;
  poolConfigJson: string;
  mintConfigs: BundleEntry[];
  _status?: string;
}

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const defaultPath = path.join(process.env.HOME || "~", ".config/solana/id.json");
  const raw = fs.readFileSync(defaultPath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function loadIdl(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", `${name}.json`), "utf8"));
}

function loadBundle(): Record<string, BundlePool> {
  const file = process.env.BUNDLE_JSON
    ?? path.join(__dirname, "..", "configs", "devnet", "whitelist-bundle.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  // Schema v2: { pools: { <poolLabel>: BundlePool } }. Earlier scripts
  // wrote the legacy `csSOLPool` top-level field; honour both for now.
  if (raw.pools) return raw.pools as Record<string, BundlePool>;
  if (raw.csSOLPool) return { csSOL: raw.csSOLPool as BundlePool };
  throw new Error(`whitelist-bundle.json: no pools field, found keys ${Object.keys(raw).join(", ")}`);
}

async function whitelistOne(
  conn: Connection,
  governorProgram: any,
  authority: Keypair,
  poolConfig: PublicKey,
  entry: BundleEntry,
  targetWallet: PublicKey,
  roleArg: any,
  roleLabel: string,
): Promise<{ status: "skipped" | "added" | "failed"; sig?: string; pda: PublicKey; reason?: string }> {
  const dmMintConfig = new PublicKey(entry.address);
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), targetWallet.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  );
  const existing = await conn.getAccountInfo(whitelistEntry);
  if (existing) return { status: "skipped", pda: whitelistEntry };

  try {
    const sig = await (governorProgram.methods as any)
      [entry.ix](roleArg)
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        adminEntry: null,
        dmMintConfig,
        wallet: targetWallet,
        whitelistEntry,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    void roleLabel;
    return { status: "added", sig, pda: whitelistEntry };
  } catch (e: any) {
    const tail = (e.logs ?? []).slice(-3).join(" | ");
    return { status: "failed", pda: whitelistEntry, reason: `${e.message}${tail ? ` (${tail})` : ""}` };
  }
}

async function main() {
  const walletAddr = process.argv[2];
  const role = (process.argv[3] || "holder").toLowerCase();

  if (!walletAddr) {
    console.error("Usage: npx tsx scripts/whitelist-wallet.ts <WALLET_ADDRESS> [holder|liquidator]");
    process.exit(1);
  }
  if (role !== "holder" && role !== "liquidator") {
    console.error("Role must be 'holder' or 'liquidator'");
    process.exit(1);
  }

  const targetWallet = new PublicKey(walletAddr);
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  const idl = loadIdl("governor");
  idl.address = GOVERNOR_PROGRAM_ID.toBase58();
  if (idl.metadata) idl.metadata.address = GOVERNOR_PROGRAM_ID.toBase58();
  const governorProgram = new Program(idl, provider);

  const roleArg = role === "holder" ? { holder: {} } : { liquidator: {} };

  // Build the work plan. Three modes:
  //  1. DM_MINT_CONFIG override → off-bundle single MintConfig (legacy path).
  //     POOL_CONFIG_JSON env or first pool in bundle supplies the pool PDA.
  //  2. MINT_CONFIG_LABEL → one entry, searched across every pool.
  //  3. default → every entry in every pool, skipping pending-deploy pools.
  type PlanEntry = { pool: string; poolConfig: PublicKey; entry: BundleEntry };
  let plan: PlanEntry[] = [];

  if (process.env.DM_MINT_CONFIG && !process.env.MINT_CONFIG_LABEL) {
    const bundle = loadBundle();
    // Pick the first ready pool as the signing pool for the override
    // (the override path is meant for single-shot legacy use).
    const firstPool = Object.values(bundle).find((p) => !p._status && p.poolConfig !== "TBD");
    if (!firstPool) throw new Error("no ready pool in bundle for DM_MINT_CONFIG override");
    plan = [{
      pool: "override",
      poolConfig: new PublicKey(firstPool.poolConfig),
      entry: {
        label: "override",
        address: process.env.DM_MINT_CONFIG,
        ix: "addWtParticipantViaPool",
      },
    }];
    console.log(`(legacy override) Using MintConfig ${process.env.DM_MINT_CONFIG} via addWtParticipantViaPool against pool ${firstPool.poolConfig}.`);
  } else {
    const bundle = loadBundle();
    for (const [poolLabel, pool] of Object.entries(bundle)) {
      if (pool._status) {
        console.log(`  [⏸ pending] pool=${poolLabel} → ${pool._status}`);
        continue;
      }
      if (!pool.poolConfig || pool.poolConfig === "TBD") continue;
      const poolPubkey = new PublicKey(pool.poolConfig);
      for (const e of pool.mintConfigs) {
        if (process.env.MINT_CONFIG_LABEL && e.label !== process.env.MINT_CONFIG_LABEL) continue;
        plan.push({ pool: poolLabel, poolConfig: poolPubkey, entry: e });
      }
    }
    if (plan.length === 0) {
      const known = Object.values(bundle).flatMap((p) => p.mintConfigs.map((e) => e.label)).join(", ");
      console.error(
        process.env.MINT_CONFIG_LABEL
          ? `MINT_CONFIG_LABEL=${process.env.MINT_CONFIG_LABEL} not found in bundle. Known: ${known}`
          : `No ready entries in bundle.`,
      );
      process.exit(1);
    }
  }

  console.log(`\nWhitelisting ${targetWallet.toBase58()} as ${role} across ${plan.length} MintConfig(s):`);
  console.log(`  Authority: ${authority.publicKey.toBase58()}\n`);

  let added = 0, skipped = 0, failed = 0;
  for (const { pool, poolConfig, entry } of plan) {
    const r = await whitelistOne(conn, governorProgram, authority, poolConfig, entry, targetWallet, roleArg, role);
    const tag = r.status === "added" ? "✓ added " : r.status === "skipped" ? "• exists" : "✗ failed";
    const detail = r.status === "added" ? r.sig : r.status === "failed" ? r.reason : r.pda.toBase58();
    console.log(`  [${tag}] [${pool}] ${entry.label.padEnd(10)} (${entry.ix}) → ${detail}`);
    if (r.status === "added") added++;
    else if (r.status === "skipped") skipped++;
    else failed++;
  }

  console.log(`\nDone: ${added} added, ${skipped} already-present, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch(console.error);
