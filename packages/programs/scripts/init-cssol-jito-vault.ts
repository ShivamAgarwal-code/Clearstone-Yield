/**
 * init-cssol-jito-vault.ts — Step 1 of JITO_INTEGRATION_PLAN.md (post-pivot).
 *
 * Initializes our own Jito Vault on devnet with `supportedMint = wSOL`.
 * The vault's `mintBurnAdmin` is set to the governor pool PDA so future
 * `MintTo` calls require governor co-signing — that's where the KYC gate
 * lives. Initial admin is the deployer; secondary admin (mint/burn) is set
 * to the governor PDA in a follow-up ix.
 *
 * The @jito-foundation/vault-sdk is @solana/kit-native; rather than bridge,
 * we hand-build the InitializeVault and SetSecondaryAdmin instructions in
 * @solana/web3.js using the discriminators and account ordering documented
 * in the SDK type defs. PDA seeds verified against the live devnet vault
 * `CSLdXAxizcHzEGDTfGWrfYoUQ8wpr4uN4nCLX1qjiNr5`:
 *   vault       PDA seed = ["vault", base]
 *   burn_vault  PDA seed = ["burn_vault", base]
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-cssol-jito-vault.ts
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
const GOVERNOR_PROGRAM = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");

// Per @jito-foundation/vault-sdk INITIALIZE_VAULT_DISCRIMINATOR.
const INIT_VAULT_DISC = 1;
// Per @jito-foundation/vault-sdk SET_SECONDARY_ADMIN_DISCRIMINATOR.
const SET_SECONDARY_ADMIN_DISC = 22;

// VaultAdminRole enum (kinobi). MintBurnAdmin is the role we want to gate
// MintTo with. Per the SDK's `VaultAdminRole` codec, MintBurnAdmin = 9
// (counted from DelegationAdmin=0, OperatorAdmin, NcnAdmin, SlasherAdmin,
//  CapacityAdmin, FeeWallet, MintBurnAdmin, DelegateAssetAdmin, FeeAdmin,
//  MetadataAdmin). Verify before sending — getting the role wrong silently
//  binds the wrong slot.
const ROLE_MINT_BURN_ADMIN = 6;

// Vault params for the devnet POC.
const DEPOSIT_FEE_BPS = 0;
const WITHDRAWAL_FEE_BPS = 0;
const REWARD_FEE_BPS = 100; // 1% of NCN rewards (mainnet only — zero impact on devnet)
const DECIMALS = 9; // matches wSOL
const INITIALIZE_TOKEN_AMOUNT = 1_000_000n; // 0.001 wSOL bootstrap

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, JITO_VAULT_PROGRAM)[0];
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payerPath = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = loadKp(payerPath);

  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json");
  if (fs.existsSync(outPath)) {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    const vault = new PublicKey(existing.vault);
    const info = await conn.getAccountInfo(vault);
    if (info && info.owner.equals(JITO_VAULT_PROGRAM)) {
      console.log("Vault already initialized at", vault.toBase58());
      console.log("Skipping init (idempotent).");
      return;
    }
    console.log("Existing config refers to a non-vault account; reinitializing.");
  }

  // Resolve governor pool PDA (becomes the mintBurnAdmin after step 1b).
  const [governorPoolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), NATIVE_MINT.toBuffer()],
    GOVERNOR_PROGRAM,
  );

  // Generate the mandatory fresh keypairs.
  const baseKp = Keypair.generate();
  const vrtMintKp = Keypair.generate();

  const config = pda([Buffer.from("config")]);
  const vault = pda([Buffer.from("vault"), baseKp.publicKey.toBuffer()]);
  const burnVault = pda([Buffer.from("burn_vault"), baseKp.publicKey.toBuffer()]);
  const vaultStTokenAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const burnVaultVrtTokenAccount = getAssociatedTokenAddressSync(
    vrtMintKp.publicKey, burnVault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const adminStTokenAccount = getAssociatedTokenAddressSync(
    NATIVE_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("=== Init csSOL Jito Vault ===");
  console.log("RPC:                    ", RPC);
  console.log("admin (deployer):       ", payer.publicKey.toBase58());
  console.log("governor pool PDA:      ", governorPoolPda.toBase58(), "(future mintBurnAdmin)");
  console.log("base keypair:           ", baseKp.publicKey.toBase58());
  console.log("vault PDA:              ", vault.toBase58());
  console.log("vrtMint:                ", vrtMintKp.publicKey.toBase58());
  console.log("burnVault PDA:          ", burnVault.toBase58());
  console.log("vault wSOL ATA:         ", vaultStTokenAccount.toBase58());
  console.log("burnVault VRT ATA:      ", burnVaultVrtTokenAccount.toBase58());
  console.log("admin wSOL ATA:         ", adminStTokenAccount.toBase58());
  console.log("config PDA:             ", config.toBase58());

  // Pre-flight 1: ensure admin's wSOL ATA exists with bootstrap balance.
  console.log("\nPre-flight 1: wrap bootstrap SOL → wSOL");
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, adminStTokenAccount, payer.publicKey, NATIVE_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ))
      .add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: adminStTokenAccount,
        lamports: Number(INITIALIZE_TOKEN_AMOUNT),
      }))
      .add(createSyncNativeInstruction(adminStTokenAccount)),
    [payer],
  );
  const wsolBal = (await conn.getTokenAccountBalance(adminStTokenAccount)).value.amount;
  console.log("  admin wSOL balance:   ", wsolBal);

  // Pre-flight 2: create the vault's wSOL ATA. Vault PDA doesn't exist as
  // a Solana account yet, but the ATA derivation only needs the owner
  // pubkey — so we can create the ATA before the vault itself. Without
  // this, InitializeVault errors with "Account is not owned by the token
  // program" because it expects a pre-created token account.
  console.log("\nPre-flight 2: create vault's wSOL ATA");
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, vaultStTokenAccount, vault, NATIVE_MINT,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    )),
    [payer],
  );
  console.log("  vault wSOL ATA created");

  // Build InitializeVault ix.
  // Args layout: u8 disc | u16 depFee | u16 wdFee | u16 rewardFee | u8 decimals | u64 initAmount
  const data = Buffer.alloc(1 + 2 + 2 + 2 + 1 + 8);
  let off = 0;
  data.writeUInt8(INIT_VAULT_DISC, off); off += 1;
  data.writeUInt16LE(DEPOSIT_FEE_BPS, off); off += 2;
  data.writeUInt16LE(WITHDRAWAL_FEE_BPS, off); off += 2;
  data.writeUInt16LE(REWARD_FEE_BPS, off); off += 2;
  data.writeUInt8(DECIMALS, off); off += 1;
  data.writeBigUInt64LE(INITIALIZE_TOKEN_AMOUNT, off);

  // Account ordering per InitializeVaultInput in @jito-foundation/vault-sdk:
  //   config, vault, vrtMint, stMint, adminStTokenAccount, vaultStTokenAccount,
  //   burnVault, burnVaultVrtTokenAccount, admin, base,
  //   systemProgram, tokenProgram, associatedTokenProgram.
  const initIx = new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },                       // bumps numVaults counter
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vrtMintKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },                  // stMint = wSOL
      { pubkey: adminStTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultStTokenAccount, isSigner: false, isWritable: true },
      { pubkey: burnVault, isSigner: false, isWritable: true },
      { pubkey: burnVaultVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },                // admin (signer)
      { pubkey: baseKp.publicKey, isSigner: true, isWritable: false },              // base (signer)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  console.log("\nStep 1a: InitializeVault");
  const initTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(initIx);
  let initSig: string;
  try {
    initSig = await sendAndConfirmTransaction(conn, initTx, [payer, vrtMintKp, baseKp]);
  } catch (e: any) {
    console.error("InitializeVault failed:");
    if (e?.transactionLogs) for (const l of e.transactionLogs.slice(-12)) console.error(" ", l);
    throw e;
  }
  console.log("  tx:", initSig);

  // Step 1b: SetSecondaryAdmin(MintBurnAdmin = governor pool PDA)
  // Args: u8 disc | u8 role
  // Accounts per SetSecondaryAdminInput:
  //   config, vault, admin (signer), newAdmin
  console.log("\nStep 1b: SetSecondaryAdmin(MintBurnAdmin = governor PDA)");
  const ssaData = Buffer.alloc(1 + 1);
  ssaData.writeUInt8(SET_SECONDARY_ADMIN_DISC, 0);
  ssaData.writeUInt8(ROLE_MINT_BURN_ADMIN, 1);
  const ssaIx = new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: governorPoolPda, isSigner: false, isWritable: false },
    ],
    data: ssaData,
  });
  let ssaSig: string;
  try {
    ssaSig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })).add(ssaIx),
      [payer],
    );
  } catch (e: any) {
    console.error("SetSecondaryAdmin failed:");
    if (e?.transactionLogs) for (const l of e.transactionLogs.slice(-12)) console.error(" ", l);
    throw e;
  }
  console.log("  tx:", ssaSig);

  // Persist
  const out = {
    cluster: "devnet",
    rpc: RPC,
    program: JITO_VAULT_PROGRAM.toBase58(),
    config: config.toBase58(),
    vault: vault.toBase58(),
    base: baseKp.publicKey.toBase58(),
    baseSecret: Array.from(baseKp.secretKey), // dev only — needed for record but rotate before mainnet
    vrtMint: vrtMintKp.publicKey.toBase58(),
    burnVault: burnVault.toBase58(),
    burnVaultVrtTokenAccount: burnVaultVrtTokenAccount.toBase58(),
    vaultStTokenAccount: vaultStTokenAccount.toBase58(),
    adminStTokenAccount: adminStTokenAccount.toBase58(),
    admin: payer.publicKey.toBase58(),
    mintBurnAdmin: governorPoolPda.toBase58(),
    supportedMint: NATIVE_MINT.toBase58(),
    feesBps: { deposit: DEPOSIT_FEE_BPS, withdrawal: WITHDRAWAL_FEE_BPS, reward: REWARD_FEE_BPS },
    decimals: DECIMALS,
    initializeTokenAmount: INITIALIZE_TOKEN_AMOUNT.toString(),
    initSig,
    setSecondaryAdminSig: ssaSig,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== done ===");
  console.log("vault:           ", vault.toBase58());
  console.log("vrtMint:         ", vrtMintKp.publicKey.toBase58());
  console.log("supportedMint:   ", NATIVE_MINT.toBase58(), "(wSOL)");
  console.log("mintBurnAdmin:   ", governorPoolPda.toBase58(), "(governor pool PDA)");
  console.log("Saved → ", outPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
