/**
 * setup-civic-csol.ts — Wire Civic self-registration on the v3 cSOL
 * native-wrap pool. Counterpart to `setup-civic.ts` (which targets the
 * v1 dtUSDY pool) — same two steps, different programs:
 *
 *   1. Set the cSOL pool PDA as v3 delta-mint's co_authority on the
 *      cSOL `MintConfig` (so the pool can sign whitelist-add CPIs).
 *   2. Set the Civic gatekeeper network on the v3 governor's cSOL
 *      `PoolConfig` (so `self_register_native` accepts gateway tokens
 *      from that network).
 *
 * Run once per devnet deploy. After this, retail wallets that pass
 * Civic on the same gatekeeper network as dtUSDY can self-onboard
 * onto cSOL via `governor.self_register_native()` — no operator
 * intervention required.
 *
 * Prerequisite: the v3 governor binary must include the
 * `self_register_native` handler (added 2026-05-06). Redeploy first
 * if you're running this against the older binary.
 *
 * Authority: Step 2 (set_gatekeeper_network on the cSOL pool) must
 * be signed by the cSOL pool's `authority` field —
 * `DiDbnkw2tYL8K1M5ndLdSHWaeXr53kcKyDyS7SiuDcFn` on devnet, stored at
 * `~/.config/solana/clearstone-devnet.json`. The default
 * `id.json` deploy keypair is *not* the pool authority and will get
 * `Unauthorized (governor 6002)`.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/setup-civic-csol.ts [gatekeeper-network-pubkey]
 *
 * Defaults to the same Civic Uniqueness network as `setup-civic.ts`
 * so retail flows present a single Civic ceremony.
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Civic Uniqueness gatekeeper — matches the dtUSDY pool's network so a
// single Civic pass satisfies both onboarding ixs.
const DEFAULT_NETWORK = "ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6";

// v3 cSOL pool — pulled from `configs/devnet/cssol-market-v3.json` and
// pinned here to avoid taking on a config import for a one-shot
// admin script.
const V3_GOVERNOR        = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const V3_DELTA_MINT      = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
const CSOL_POOL_CONFIG   = new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ");
const CSOL_DM_MINT_CONFIG = new PublicKey("GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B");

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

  // Load IDLs from the workspace target dir. Anchor 0.30+ reads the
  // program id from `idl.address`; we override per-instance so the
  // single governor IDL backs both v1 and v3 instances.
  const govIdlRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "governor.json"), "utf8"));
  const dmIdlRaw  = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "delta_mint.json"),  "utf8"));
  const governor  = new Program({ ...govIdlRaw, address: V3_GOVERNOR.toBase58() } as any, provider);
  const deltaMint = new Program({ ...dmIdlRaw,  address: V3_DELTA_MINT.toBase58() } as any, provider);

  console.log("============================================");
  console.log("  Civic Setup — cSOL pool (v3)");
  console.log("============================================");
  console.log(`  Authority:        ${authority.publicKey.toBase58()}`);
  console.log(`  v3 governor:      ${V3_GOVERNOR.toBase58()}`);
  console.log(`  v3 delta-mint:    ${V3_DELTA_MINT.toBase58()}`);
  console.log(`  cSOL pool:        ${CSOL_POOL_CONFIG.toBase58()}`);
  console.log(`  cSOL dm config:   ${CSOL_DM_MINT_CONFIG.toBase58()}`);
  console.log(`  Gatekeeper net:   ${gatekeeperNetwork.toBase58()}`);
  console.log("============================================\n");

  // Step 1: cSOL pool PDA → v3 delta-mint co_authority.
  // Idempotent: when the cSOL pool was bootstrapped, its MintConfig's
  // `authority` was already set to the pool PDA (so subsequent
  // SetCoAuthority signed by the deploy keypair fails with delta-mint's
  // `NotWhitelisted` (6000) — the error code is reused as
  // "signer != stored authority"). We treat that as success.
  console.log("Step 1: Setting co_authority on v3 delta-mint (cSOL MintConfig)...");
  try {
    const sig = await (deltaMint.methods as any)
      .setCoAuthority(CSOL_POOL_CONFIG)
      .accounts({
        authority: authority.publicKey,
        mintConfig: CSOL_DM_MINT_CONFIG,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Done: ${sig.slice(0, 30)}...`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const benign =
      msg.includes("already in use") ||
      msg.includes("custom program error") ||
      msg.includes("NotWhitelisted") ||  // delta-mint reuses this for "signer != stored authority"
      msg.includes("Error Number: 6000");
    if (benign) {
      console.log(`  Already configured (signer is not the stored authority — pool PDA already owns it).`);
    } else {
      throw e;
    }
  }

  // Step 2: Set gatekeeper network on the cSOL pool.
  console.log("\nStep 2: Setting gatekeeper_network on cSOL pool (v3 governor)...");
  try {
    const sig = await (governor.methods as any)
      .setGatekeeperNetwork(gatekeeperNetwork)
      .accounts({
        authority: authority.publicKey,
        poolConfig: CSOL_POOL_CONFIG,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Done: ${sig.slice(0, 30)}...`);
  } catch (e: any) {
    console.error(`  Failed: ${e.message}`);
    throw e;
  }

  console.log("\n============================================");
  console.log("  cSOL pool ready for Civic-gated self-register.");
  console.log("  Retail flow: a Civic-verified wallet can now call");
  console.log("  governor.self_register_native against this pool.");
  console.log("============================================");
}

main().catch((e) => { console.error(e); process.exit(1); });
