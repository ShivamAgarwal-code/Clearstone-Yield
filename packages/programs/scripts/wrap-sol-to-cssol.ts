/**
 * wrap-sol-to-cssol.ts — End-to-end: native SOL → wSOL → csSOL.
 *
 * Builds one transaction that:
 *   1. Ensures the user has a wSOL ATA (Token program).
 *   2. Transfers `amount` lamports from the user's native SOL balance into
 *      that ATA and calls sync_native, materializing wSOL.
 *   3. Ensures the user has a csSOL ATA (Token-2022).
 *   4. Calls `governor::wrap(amount)` — pulls wSOL from user's ATA into the
 *      pool vault and CPI's into delta-mint to mint `amount` csSOL.
 *
 * Prereqs:
 *   - `init-cssol-vault.ts` must have been run (creates the pool's wSOL vault).
 *   - The signer must be whitelisted in delta-mint as a Holder.
 *   - The signer needs ≥ amount + ~0.003 SOL for ATA rent and tx fees.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json AMOUNT=10000000 \
 *     npx tsx scripts/wrap-sol-to-cssol.ts
 *   (AMOUNT is in lamports of csSOL = lamports of SOL since both are 9 decimals.
 *    Default = 10_000_000 = 0.01 SOL.)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
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
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";

const GOVERNOR = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");

function loadKp(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const user = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));
  const amount = BigInt(process.env.AMOUNT || "10000000"); // 0.01 SOL default

  const poolCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), "utf8"));
  const poolPda      = new PublicKey(poolCfg.pool.poolConfig);
  const cssolMint    = new PublicKey(poolCfg.cssolMint);
  const dmMintConfig = new PublicKey(poolCfg.dmMintConfig);
  const dmMintAuth   = new PublicKey(poolCfg.dmMintAuthority);
  const vault        = poolCfg.vault
    ? new PublicKey(poolCfg.vault)
    : getAssociatedTokenAddressSync(NATIVE_MINT, poolPda, true, TOKEN_PROGRAM_ID);

  console.log("User:        ", user.publicKey.toBase58());
  console.log("Amount:      ", amount.toString(), "lamports");
  console.log("Pool PDA:    ", poolPda.toBase58());
  console.log("Vault:       ", vault.toBase58());
  console.log("csSOL mint:  ", cssolMint.toBase58());

  // Whitelist PDA — must exist for delta-mint to allow mint_to via wrap CPI.
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), user.publicKey.toBuffer()],
    DELTA_MINT,
  );
  if (!(await conn.getAccountInfo(whitelistEntry))) {
    throw new Error(`User ${user.publicKey.toBase58()} is not whitelisted (no PDA at ${whitelistEntry.toBase58()}). Whitelist via delta-mint::add_to_whitelist first.`);
  }

  const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userCssolAta = getAssociatedTokenAddressSync(cssolMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  // Pre-balance for diff
  const cssolBefore = (await conn.getTokenAccountBalance(userCssolAta).catch(() => null))?.value.amount ?? "0";

  // Build wrap ix payload: discriminator + u64 amount
  const wrapData = Buffer.concat([disc("wrap"), Buffer.alloc(8)]);
  wrapData.writeBigUInt64LE(amount, 8);

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
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // underlying_token_program (wSOL = SPL)
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },    // wrapped_token_program (csSOL = Token-2022)
    ],
    data: wrapData,
  });

  const tx = new Transaction()
    // Ensure both ATAs (idempotent)
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userWsolAta, user.publicKey, NATIVE_MINT,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userCssolAta, user.publicKey, cssolMint,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    // Top up wSOL ATA with native SOL of the wrap amount, then sync_native
    .add(SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: userWsolAta,
      lamports: Number(amount),
    }))
    .add(createSyncNativeInstruction(userWsolAta))
    // Wrap into csSOL
    .add(wrapIx);

  const sig = await sendAndConfirmTransaction(conn, tx, [user]);
  console.log("\nwrap sig:", sig);

  const cssolAfter = (await conn.getTokenAccountBalance(userCssolAta).catch(() => null))?.value.amount ?? "0";
  console.log(`csSOL ATA: ${cssolBefore} → ${cssolAfter} (Δ ${BigInt(cssolAfter) - BigInt(cssolBefore)})`);
}

main().catch((e) => {
  if (e?.transactionLogs) console.error("logs:\n  " + e.transactionLogs.slice(-8).join("\n  "));
  console.error(e);
  process.exit(1);
});
