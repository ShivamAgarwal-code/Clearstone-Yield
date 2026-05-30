/**
 * poc-wrap-with-jito-vault.ts — Phase A step 3 verification.
 *
 * Calls governor::wrap_with_jito_vault, which atomically:
 *   1. Pulls native SOL → wSOL (caller-side ATA setup before the ix).
 *   2. Jito Vault MintTo: pool PDA signs as mintBurnAdmin, VRT → pool VRT vault.
 *   3. delta-mint::mint_to: csSOL minted to user (KYC checked).
 *
 * One signature for the user. csSOL is now backed 1:1 nominally by the
 * pool's VRT (which itself appreciates against SOL via Jito Vault state).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
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
const JITO_VAULT = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

const AMOUNT = BigInt(process.env.AMOUNT || "5000000"); // 0.005 SOL

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const user = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const poolCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json"), "utf8"));
  const vaultCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8"));

  const poolPda = new PublicKey(poolCfg.pool.poolConfig);
  const cssolMint = new PublicKey(poolCfg.cssolMint);
  const dmMintConfig = new PublicKey(poolCfg.dmMintConfig);
  const dmMintAuth = new PublicKey(poolCfg.dmMintAuthority);
  const poolVrtAta = new PublicKey(poolCfg.poolVrtAta);

  const jitoVault = new PublicKey(vaultCfg.vault);
  const vrtMint = new PublicKey(vaultCfg.vrtMint);
  const vaultStTokenAccount = new PublicKey(vaultCfg.vaultStTokenAccount);

  const [jitoConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], JITO_VAULT);

  // Vault fee wallet sits at offset 696 in the Vault account. We learned
  // this in an earlier session by binary-searching on-chain bytes; for
  // our vault, fee_wallet = deployer.
  const vaultInfo = await conn.getAccountInfo(jitoVault);
  if (!vaultInfo) throw new Error("vault not found");
  const feeWallet = new PublicKey(vaultInfo.data.subarray(696, 728));
  const vaultFeeAta = getAssociatedTokenAddressSync(vrtMint, feeWallet, false, TOKEN_PROGRAM_ID);

  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userVrt = getAssociatedTokenAddressSync(vrtMint, user.publicKey, false, TOKEN_PROGRAM_ID);
  const userCssolAta = getAssociatedTokenAddressSync(cssolMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), user.publicKey.toBuffer()],
    DELTA_MINT,
  );

  const disc = crypto.createHash("sha256").update("global:wrap_with_jito_vault").digest().subarray(0, 8);
  const data = Buffer.concat([disc, Buffer.alloc(8)]);
  data.writeBigUInt64LE(AMOUNT, 8);

  const ix = new TransactionInstruction({
    programId: GOVERNOR,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },           // user
      { pubkey: poolPda, isSigner: false, isWritable: true },                 // pool_config (writable for delta-mint CPI)
      { pubkey: userWsol, isSigner: false, isWritable: true },                // user_underlying_ata
      { pubkey: JITO_VAULT, isSigner: false, isWritable: false },             // jito_vault_program
      { pubkey: jitoConfig, isSigner: false, isWritable: false },             // jito_vault_config (vault program checks writable internally — keep R here)
      { pubkey: jitoVault, isSigner: false, isWritable: true },               // jito_vault
      { pubkey: vrtMint, isSigner: false, isWritable: true },                 // vrt_mint
      { pubkey: vaultStTokenAccount, isSigner: false, isWritable: true },    // vault_st_token_account
      { pubkey: userVrt, isSigner: false, isWritable: true },                // user_vrt_token_account
      { pubkey: poolVrtAta, isSigner: false, isWritable: true },             // pool_vrt_token_account
      { pubkey: vaultFeeAta, isSigner: false, isWritable: true },            // vault_fee_token_account
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },       // spl_token_program
      { pubkey: dmMintConfig, isSigner: false, isWritable: false },          // dm_mint_config
      { pubkey: cssolMint, isSigner: false, isWritable: true },              // wrapped_mint
      { pubkey: dmMintAuth, isSigner: false, isWritable: false },            // dm_mint_authority
      { pubkey: whitelistEntry, isSigner: false, isWritable: false },        // whitelist_entry
      { pubkey: userCssolAta, isSigner: false, isWritable: true },           // user_wrapped_ata
      { pubkey: DELTA_MINT, isSigner: false, isWritable: false },            // delta_mint_program
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // wrapped_token_program
    ],
    data,
  });

  console.log("=== wrap_with_jito_vault POC ===");
  console.log("user:        ", user.publicKey.toBase58());
  console.log("amount:      ", AMOUNT.toString(), "lamports");
  console.log("pool VRT ATA:", poolVrtAta.toBase58());

  const cssolBefore = (await conn.getTokenAccountBalance(userCssolAta).catch(() => null))?.value.amount ?? "0";
  const poolVrtBefore = (await conn.getTokenAccountBalance(poolVrtAta).catch(() => null))?.value.amount ?? "0";
  const vaultBefore = (await conn.getAccountInfo(jitoVault))!.data;
  const vaultTdBefore = vaultBefore.readBigUInt64LE(112);
  const vaultVsBefore = vaultBefore.readBigUInt64LE(104);

  // Compose: ensure user wSOL ATA + ATA for VRT in fee wallet, fund wSOL with
  // AMOUNT lamports, sync_native, then call our new ix.
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userWsol, user.publicKey, NATIVE_MINT,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userCssolAta, user.publicKey, cssolMint,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, vaultFeeAta, feeWallet, vrtMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userVrt, user.publicKey, vrtMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: userWsol, lamports: Number(AMOUNT) }))
    .add(createSyncNativeInstruction(userWsol))
    .add(ix);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [user]);
    console.log("\nwrap_with_jito_vault sig:", sig);
  } catch (e: any) {
    if (e?.transactionLogs) for (const l of e.transactionLogs.slice(-12)) console.error(" ", l);
    throw e;
  }

  const cssolAfter = (await conn.getTokenAccountBalance(userCssolAta).catch(() => null))?.value.amount ?? "0";
  const poolVrtAfter = (await conn.getTokenAccountBalance(poolVrtAta).catch(() => null))?.value.amount ?? "0";
  const vaultAfter = (await conn.getAccountInfo(jitoVault))!.data;
  const vaultTdAfter = vaultAfter.readBigUInt64LE(112);
  const vaultVsAfter = vaultAfter.readBigUInt64LE(104);

  console.log("\n=== state delta ===");
  console.log(`user csSOL:     ${cssolBefore} → ${cssolAfter}  Δ=${BigInt(cssolAfter) - BigInt(cssolBefore)}`);
  console.log(`pool VRT:       ${poolVrtBefore} → ${poolVrtAfter}  Δ=${BigInt(poolVrtAfter) - BigInt(poolVrtBefore)}`);
  console.log(`vault tokensDeposited:  ${vaultTdBefore} → ${vaultTdAfter}  Δ=${vaultTdAfter - vaultTdBefore}`);
  console.log(`vault vrtSupply:        ${vaultVsBefore} → ${vaultVsAfter}  Δ=${vaultVsAfter - vaultVsBefore}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
