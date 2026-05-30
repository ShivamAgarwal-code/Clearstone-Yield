/**
 * poc-cssol-vault-mint.ts — Step 3 of JITO_INTEGRATION_PLAN.md.
 *
 * Demonstrates the full deposit flow against OUR gated Jito Vault on devnet:
 *
 *   1. Temporarily rotate `mintBurnAdmin` back to the deployer so MintTo can
 *      be signed from this client script. (Production path is governor CPI.)
 *   2. Wrap a small amount of native SOL into the deployer's wSOL ATA.
 *   3. Call MintTo — wSOL → VRT — proving the end-to-end Jito Vault integration.
 *   4. Restore `mintBurnAdmin` to the governor pool PDA so the gate is back
 *      in place for any subsequent (KYC-only) deposits via governor CPI.
 *
 * Result: the deployer holds VRT against our vault's wSOL deposit. The
 * accrual oracle (next step) will read the vault's state to derive csSOL's
 * exchange rate.
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
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const JITO_VAULT_PROGRAM = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

// SDK constants we previously confirmed:
const MINT_TO_DISC = 11;                      // MINT_TO_DISCRIMINATOR
const SET_SECONDARY_ADMIN_DISC = 22;          // SET_SECONDARY_ADMIN_DISCRIMINATOR
const ROLE_MINT_BURN_ADMIN = 6;               // VaultAdminRole::MintBurnAdmin

const AMOUNT = BigInt(process.env.AMOUNT || "5000000"); // 0.005 SOL default

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildSetSecondaryAdminIx(
  config: PublicKey,
  vault: PublicKey,
  admin: PublicKey,
  newAdmin: PublicKey,
  role: number,
): TransactionInstruction {
  const data = Buffer.alloc(2);
  data.writeUInt8(SET_SECONDARY_ADMIN_DISC, 0);
  data.writeUInt8(role, 1);
  return new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: newAdmin, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildMintToIx(
  config: PublicKey,
  vault: PublicKey,
  vrtMint: PublicKey,
  depositor: PublicKey,
  depositorTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  depositorVrtTokenAccount: PublicKey,
  vaultFeeTokenAccount: PublicKey,
  mintSigner: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint,
): TransactionInstruction {
  // u8 disc | u64 amountIn | u64 minAmountOut
  const data = Buffer.alloc(1 + 8 + 8);
  data.writeUInt8(MINT_TO_DISC, 0);
  data.writeBigUInt64LE(amountIn, 1);
  data.writeBigUInt64LE(minAmountOut, 9);
  // Account ordering per MintToInput:
  //   config, vault, vrtMint, depositor (signer, writable),
  //   depositorTokenAccount (W), vaultTokenAccount (W),
  //   depositorVrtTokenAccount (W), vaultFeeTokenAccount (W),
  //   tokenProgram, mintSigner (signer)
  return new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vrtMint, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: depositorVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mintSigner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payerPath = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = loadKp(payerPath);

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8"));
  const config = new PublicKey(cfg.config);
  const vault = new PublicKey(cfg.vault);
  const vrtMint = new PublicKey(cfg.vrtMint);
  const vaultStTokenAccount = new PublicKey(cfg.vaultStTokenAccount);
  const adminStTokenAccount = new PublicKey(cfg.adminStTokenAccount);
  const governorPda = new PublicKey(cfg.mintBurnAdmin);

  // The vault's fee_wallet field; for a vault we initialized, the fee_wallet
  // defaults to the admin (deployer). Vault fee token account = ATA(vrtMint, fee_wallet).
  const feeWallet = payer.publicKey; // confirmed at init: admin = fee_wallet for our vault
  const vaultFeeTokenAccount = getAssociatedTokenAddressSync(
    vrtMint, feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const depositorVrtAta = getAssociatedTokenAddressSync(
    vrtMint, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("=== csSOL Jito Vault deposit POC ===");
  console.log("RPC:                   ", RPC);
  console.log("vault:                 ", vault.toBase58());
  console.log("vrtMint:               ", vrtMint.toBase58());
  console.log("admin / deployer:      ", payer.publicKey.toBase58());
  console.log("current mintBurnAdmin: ", governorPda.toBase58(), "(governor PDA)");
  console.log("fee VRT ATA:           ", vaultFeeTokenAccount.toBase58());
  console.log("user VRT ATA:          ", depositorVrtAta.toBase58());

  // --- Step 1: rotate mintBurnAdmin temporarily to deployer ---
  console.log("\nStep 1: SetSecondaryAdmin(MintBurnAdmin = deployer) — temporary");
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(buildSetSecondaryAdminIx(config, vault, payer.publicKey, payer.publicKey, ROLE_MINT_BURN_ADMIN)),
    [payer],
  );

  try {
    // --- Step 2: ensure user's wSOL ATA has AMOUNT, plus VRT ATA + fee ATA exist ---
    console.log("Step 2: prepare wSOL + VRT ATAs");
    await sendAndConfirmTransaction(
      conn,
      new Transaction()
        .add(createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, adminStTokenAccount, payer.publicKey, NATIVE_MINT,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(SystemProgram.transfer({
          fromPubkey: payer.publicKey, toPubkey: adminStTokenAccount, lamports: Number(AMOUNT),
        }))
        .add(createSyncNativeInstruction(adminStTokenAccount))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, depositorVrtAta, payer.publicKey, vrtMint,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey, vaultFeeTokenAccount, feeWallet, vrtMint,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        )),
      [payer],
    );
    console.log("  wSOL balance:", (await conn.getTokenAccountBalance(adminStTokenAccount)).value.amount);

    // --- Step 3: MintTo (the actual deposit) ---
    console.log("\nStep 3: MintTo  (depositor + mintSigner = deployer; gate temporarily relaxed)");
    const vrtBefore = (await conn.getTokenAccountBalance(depositorVrtAta).catch(() => null))?.value.amount ?? "0";
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
        .add(buildMintToIx(
          config, vault, vrtMint,
          payer.publicKey,                     // depositor
          adminStTokenAccount,                  // depositorTokenAccount (deployer wSOL)
          vaultStTokenAccount,                  // vaultTokenAccount (vault wSOL)
          depositorVrtAta,                      // depositorVrtTokenAccount
          vaultFeeTokenAccount,                 // vaultFeeTokenAccount
          payer.publicKey,                      // mintSigner = deployer (mintBurnAdmin temp)
          AMOUNT,
          0n,
        )),
      [payer],
    );
    console.log("  MintTo sig:", sig);
    const vrtAfter = (await conn.getTokenAccountBalance(depositorVrtAta).catch(() => null))?.value.amount ?? "0";
    console.log(`  VRT balance: ${vrtBefore} → ${vrtAfter} (Δ ${BigInt(vrtAfter) - BigInt(vrtBefore)})`);

    // Read updated vault state
    const vaultInfo = await conn.getAccountInfo(vault);
    if (vaultInfo) {
      const data = vaultInfo.data;
      const tokensDeposited = data.readBigUInt64LE(112);
      const vrtSupply = data.readBigUInt64LE(104);
      console.log(`  vault.tokensDeposited: ${tokensDeposited}`);
      console.log(`  vault.vrtSupply:       ${vrtSupply}`);
      console.log(`  exchange rate:         ${Number(tokensDeposited) / Number(vrtSupply)}`);
    }
  } finally {
    // --- Step 4: restore the gate ---
    console.log("\nStep 4: SetSecondaryAdmin(MintBurnAdmin = governor PDA) — restore gate");
    try {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(buildSetSecondaryAdminIx(config, vault, payer.publicKey, governorPda, ROLE_MINT_BURN_ADMIN)),
        [payer],
      );
      console.log("  gate restored.");
    } catch (e: any) {
      console.error("  WARN: gate restoration failed — vault is currently in DEPLOYER-ADMIN mode!");
      console.error("  Run: SetSecondaryAdmin(MintBurnAdmin =", governorPda.toBase58(), ") manually.");
      throw e;
    }
  }
}

main().catch((e) => {
  if (e?.transactionLogs) {
    console.error("logs:");
    for (const l of e.transactionLogs.slice(-12)) console.error(" ", l);
  }
  console.error(e);
  process.exit(1);
});
