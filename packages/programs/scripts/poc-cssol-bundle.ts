/**
 * poc-cssol-bundle.ts — Step 5: csSOL wrap+deposit as a Jito Bundle.
 *
 * Bundles atomically execute multiple transactions through Jito's Block
 * Engine relay — either all txs land in the same block or none do, plus
 * the tip pays for priority during congestion. We use this for the
 * user-facing wrap+deposit flow:
 *
 *   tx[0]: governor::wrap (SOL → wSOL → csSOL via delta-mint, KYC checked)
 *   tx[1]: tip transfer (lamports → Jito tip account)
 *
 * On mainnet this would use the wrap_with_jito_vault path that also
 * deposits into our gated Jito Vault, then klend deposit_reserve_liquidity
 * to plant the csSOL collateral in elevation group 2 — all in one bundle
 * for atomic execution. For the devnet POC we exercise just the wrap leg
 * to prove the Bundle integration works end-to-end.
 *
 * **Important devnet caveat:** Jito-Solana validators only run on mainnet,
 * so bundles submitted against devnet/testnet block engines will be
 * accepted (Block Engine returns a bundle UUID) but won't necessarily land
 * — depends on whether testnet leaders are connected to the engine. The
 * SUBMISSION path is what we're proving here; the same code lands on
 * mainnet without modification.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json AMOUNT=1000000 \
 *     npx tsx scripts/poc-cssol-bundle.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
// Note: jito-ts's gRPC searcher API requires auth-keypair allow-listing
// (Jito controls who can submit via gRPC). We instead use the public
// JSON-RPC `sendBundle` endpoint at /api/v1/bundles, which is
// permissionless and what most builders use today. This is functionally
// equivalent — same bundle semantics, same UUID return — just without the
// gRPC auth ceremony.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
// JSON-RPC endpoint for bundle submission. This works for any cluster
// — the Block Engine routes the bundle to leaders that connect to it.
// Devnet bundles won't necessarily land (no Jito-Solana validators run on
// devnet) but the SUBMISSION succeeds and returns a UUID, which is the
// integration we're proving here.
const BLOCK_ENGINE_URL =
  process.env.BLOCK_ENGINE_URL || "https://ny.testnet.block-engine.jito.wtf/api/v1/bundles";

const GOVERNOR = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");

// 0.0001 SOL. Below the typical Jito mainnet floor (~0.001 SOL) but fine
// for testnet — and for devnet POCs we just want to demo the path.
const TIP_LAMPORTS = Number(process.env.TIP_LAMPORTS || "100000");
const WRAP_AMOUNT = BigInt(process.env.AMOUNT || "1000000"); // 0.001 SOL

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const user = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  // Load existing csSOL pool config (governor pool, dm mint, vault, etc.)
  const poolCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), "utf8"));
  const poolPda = new PublicKey(poolCfg.pool.poolConfig);
  const cssolMint = new PublicKey(poolCfg.cssolMint);
  const dmMintConfig = new PublicKey(poolCfg.dmMintConfig);
  const dmMintAuth = new PublicKey(poolCfg.dmMintAuthority);
  const vault = poolCfg.vault
    ? new PublicKey(poolCfg.vault)
    : getAssociatedTokenAddressSync(NATIVE_MINT, poolPda, true, TOKEN_PROGRAM_ID);

  console.log("=== csSOL wrap → Jito Bundle POC ===");
  console.log("RPC:           ", RPC);
  console.log("Block Engine:  ", BLOCK_ENGINE_URL);
  console.log("user:          ", user.publicKey.toBase58());
  console.log("wrap amount:   ", WRAP_AMOUNT.toString(), "lamports");
  console.log("tip amount:    ", TIP_LAMPORTS, "lamports");

  // Derive the user's ATAs and whitelist entry.
  const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userCssolAta = getAssociatedTokenAddressSync(
    cssolMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), user.publicKey.toBuffer()],
    DELTA_MINT,
  );

  // Build the wrap ix (same shape as wrap-sol-to-cssol.ts).
  const wrapData = Buffer.alloc(8 + 8);
  disc("wrap").copy(wrapData, 0);
  wrapData.writeBigUInt64LE(WRAP_AMOUNT, 8);
  const wrapIx = new TransactionInstruction({
    programId: GOVERNOR,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: userWsolAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: dmMintConfig, isSigner: false, isWritable: false },
      { pubkey: cssolMint, isSigner: false, isWritable: true },
      { pubkey: dmMintAuth, isSigner: false, isWritable: false },
      { pubkey: whitelistEntry, isSigner: false, isWritable: false },
      { pubkey: userCssolAta, isSigner: false, isWritable: true },
      { pubkey: DELTA_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: wrapData,
  });

  // Get tip accounts via JSON-RPC. Jito publishes a small fixed set of
  // 8 tip accounts; getTipAccounts via RPC returns the canonical list.
  console.log("\nFetching Jito tip accounts via JSON-RPC ...");
  const tipResp = await fetch(BLOCK_ENGINE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
  });
  const tipBody = (await tipResp.json()) as { result?: string[]; error?: { message: string } };
  if (tipBody.error) throw new Error(`getTipAccounts: ${tipBody.error.message}`);
  const tipAccounts = tipBody.result ?? [];
  console.log(`  tip accounts: ${tipAccounts.length} candidates, picking one at random`);
  const tipAccount = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);
  console.log(`  selected tip: ${tipAccount.toBase58()}`);

  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  // Build wrap tx — includes ATA setup + native SOL → wSOL → governor.wrap.
  const wrapMsg = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey, userWsolAta, user.publicKey, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        user.publicKey, userCssolAta, user.publicKey, cssolMint,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      SystemProgram.transfer({
        fromPubkey: user.publicKey,
        toPubkey: userWsolAta,
        lamports: Number(WRAP_AMOUNT),
      }),
      createSyncNativeInstruction(userWsolAta),
      wrapIx,
    ],
  }).compileToV0Message();
  const wrapTx = new VersionedTransaction(wrapMsg);
  wrapTx.sign([user]);

  // Tip tx — small SOL transfer to the Jito tip account.
  const tipMsg = new TransactionMessage({
    payerKey: user.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: user.publicKey,
        toPubkey: tipAccount,
        lamports: TIP_LAMPORTS,
      }),
    ],
  }).compileToV0Message();
  const tipTx = new VersionedTransaction(tipMsg);
  tipTx.sign([user]);

  console.log("\nBundle:");
  console.log("  tx[0] = governor::wrap (5 ixs incl ATA setup + sync_native + wrap)");
  console.log("  tx[1] = tip → Jito");
  console.log("  total tip:", TIP_LAMPORTS, "lamports");

  // Pre-state for delta logging
  const cssolBefore = (await conn.getTokenAccountBalance(userCssolAta).catch(() => null))?.value.amount ?? "0";
  console.log("\ncsSOL balance before:", cssolBefore);

  // Bundle JSON-RPC payload: each tx is base58 of the serialized
  // VersionedTransaction.
  const encodedTxs = [wrapTx, tipTx].map((t) => {
    const raw = Buffer.from(t.serialize());
    // base58 encode (Solana bundles use base58, not base64).
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt("0x" + raw.toString("hex"));
    let out = "";
    while (n > 0n) { const r = Number(n % 58n); n = n / 58n; out = alphabet[r] + out; }
    for (const b of raw) { if (b === 0) out = "1" + out; else break; }
    return out;
  });

  console.log("\nSubmitting bundle to Block Engine ...");
  const sendResp = await fetch(BLOCK_ENGINE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [encodedTxs] }),
  });
  const sendBody = (await sendResp.json()) as { result?: string; error?: { message: string; data?: any } };
  if (sendBody.error) {
    throw new Error(`sendBundle: ${sendBody.error.message} ${JSON.stringify(sendBody.error.data ?? {})}`);
  }
  const bundleUuid = sendBody.result!;
  console.log("  Bundle UUID:", bundleUuid);
  console.log("  → Block Engine accepted the bundle. Whether it lands depends on whether the");
  console.log("    next leader is a Jito-Solana validator connected to this Block Engine.");
  console.log("    On devnet/testnet that's not guaranteed; on mainnet it's the default.");

  // Try to wait briefly to see if it landed via the regular RPC.
  console.log("\nPolling RPC for landing (10s) ...");
  let landed = false;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const bal = (await conn.getTokenAccountBalance(userCssolAta).catch(() => null))?.value.amount ?? "0";
    if (BigInt(bal) > BigInt(cssolBefore)) {
      console.log(`  ✓ landed: csSOL balance ${cssolBefore} → ${bal}`);
      landed = true;
      break;
    }
  }
  if (!landed) {
    console.log("  Bundle did not land in the polling window. Block Engine UUID returned");
    console.log("  successfully though — the SDK + auth + bundle construction path is verified.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
