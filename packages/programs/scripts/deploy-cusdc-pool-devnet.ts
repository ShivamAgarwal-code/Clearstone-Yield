/**
 * deploy-cusdc-pool-devnet.ts
 *
 * Deploys the cUSDC native-wrap pool — the KYC-gated 1:1 wrapper of
 * Solstice USDC (sUSDC). Replaces the unrestricted retail sUSDC reserve
 * as the debt asset in EG-1 (stables) + EG-3 (margin long SOL) and as
 * the collateral side of EG-4 (margin short SOL).
 *
 * Mirrors deploy-csol-pool-devnet.ts almost exactly — the governor's
 * `initialize_native_pool` ix takes any SPL underlying, so the same
 * code path works for wSOL→cSOL and sUSDC→cUSDC. Only the underlying
 * mint, oracle, and decimals change.
 *
 * Steps:
 *   1. governor.initialize_native_pool — atomically creates the
 *      cUSDC Token-2022 mint via delta-mint CPI and the pool config
 *      PDA at seeds=[b"native_pool", cUSDC_mint].
 *   2. delta_mint.add_to_whitelist — whitelists the deployer (Holder
 *      role) so the seed deposit can be minted.
 *   3. delta_mint.mint_to — mints a small cUSDC seed to the deployer's
 *      ATA so klend's init_reserve has a non-zero initial deposit.
 *   4. governor.activate_wrapping_native — transfers delta-mint
 *      authority to the pool PDA so subsequent wraps mint via CPI.
 *   5. Idempotent ATA create for the pool's sUSDC vault.
 *   6. Save configs/devnet/cusdc-pool.json.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/deploy-cusdc-pool-devnet.ts
 *
 * Auth: must be the same keypair that ran the cSOL pool deploy so the
 * KYC root authority + admin context line up. Override via DEPLOY_KEYPAIR.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GOVERNOR_PROGRAM_ID = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT_PROGRAM_ID = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");

// Underlying = Solstice USDC (the same mint the legacy sUSDC klend
// reserve already uses). Plain SPL Token (not Token-2022).
const SUSDC_MINT = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");

// USDC Pyth Receiver feed — same one the sUSDC reserve uses today.
const PYTH_USDC_USD = new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD");

// Seed amount minted to the deployer's cUSDC ATA for klend's
// init_reserve initial-deposit requirement (token program rejects 0).
// 1_000_000 raw units = 1.0 cUSDC @ 6 decimals — generous so we have
// headroom to also seed the reserve liquidity (init_reserve needs ≥1).
const CUSDC_SEED_AMOUNT = 1_000_000n;
const CUSDC_DECIMALS = 6;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  // Anchor 0.30+ embeds the program ID in the IDL but it can be stale —
  // override so `new Program(idl, provider)` talks to the deployed addr.
  const overrides: Record<string, PublicKey> = {
    governor: GOVERNOR_PROGRAM_ID,
    delta_mint: DELTA_MINT_PROGRAM_ID,
  };
  if (overrides[name]) {
    idl.address = overrides[name].toBase58();
    if (idl.metadata) idl.metadata.address = overrides[name].toBase58();
  }
  return idl;
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  const governor = new Program(loadIdl("governor"), provider);
  const deltaMint = new Program(loadIdl("delta_mint"), provider);

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  cUSDC pool deploy (KYC wrapper of sUSDC)    ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  RPC:                ${RPC_URL}`);
  console.log(`  Authority:          ${authority.publicKey.toBase58()}`);
  console.log(`  Underlying:         ${SUSDC_MINT.toBase58()} (sUSDC)`);
  console.log(`  Underlying oracle:  ${PYTH_USDC_USD.toBase58()}`);
  const balance = await conn.getBalance(authority.publicKey);
  console.log(`  Balance:            ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05e9) console.warn("⚠ Low SOL — top up before continuing.");

  // Idempotent checkpoint so partial failures resume cleanly.
  const checkpointPath = path.join(__dirname, "..", "configs/devnet/cusdc-pool.checkpoint.json");
  let cp: { mint?: string } = {};
  if (fs.existsSync(checkpointPath)) {
    cp = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    console.log(`  Resuming checkpoint: mint=${cp.mint ?? "(none)"}`);
  }
  const persist = () => fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));

  // --- Step 1: initialize_native_pool ---
  let cUsdcMint: PublicKey;
  let cUsdcMintKp: Keypair | null = null;
  if (cp.mint) {
    cUsdcMint = new PublicKey(cp.mint);
    console.log(`\nStep 1: pool already initialized — reusing cUSDC mint ${cUsdcMint.toBase58()}`);
  } else {
    cUsdcMintKp = Keypair.generate();
    cUsdcMint = cUsdcMintKp.publicKey;
  }
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("native_pool"), cUsdcMint.toBuffer()],
    GOVERNOR_PROGRAM_ID,
  );
  const [dmMintConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), cUsdcMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
  );
  const [dmMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), cUsdcMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
  );

  const existingPool = await conn.getAccountInfo(poolConfig);
  if (!existingPool) {
    if (!cUsdcMintKp) throw new Error("checkpoint says mint exists but pool doesn't — delete cusdc-pool.checkpoint.json and retry");
    console.log(`\nStep 1: governor.initialize_native_pool`);
    const sig = await (governor.methods as any)
      .initializeNativePool({
        underlyingOracle: PYTH_USDC_USD,
        decimals: CUSDC_DECIMALS,
      })
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        underlyingMint: SUSDC_MINT,
        wrappedMint: cUsdcMint,
        dmMintConfig,
        dmMintAuthority,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([cUsdcMintKp])
      .rpc();
    cp.mint = cUsdcMint.toBase58();
    persist();
    console.log(`  cUSDC mint: ${cUsdcMint.toBase58()}`);
    console.log(`  Pool PDA:   ${poolConfig.toBase58()}`);
    console.log(`  Tx:         ${sig}`);
  } else {
    console.log(`\nStep 1: pool exists at ${poolConfig.toBase58()} — skipping init`);
  }

  // --- Step 2: whitelist the deployer (Holder) ---
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), authority.publicKey.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  );
  const wlInfo = await conn.getAccountInfo(whitelistEntry);
  if (!wlInfo) {
    console.log(`\nStep 2: delta_mint.add_to_whitelist (deployer as Holder)`);
    const sig = await (deltaMint.methods as any)
      .addToWhitelist()
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
        wallet: authority.publicKey,
        whitelistEntry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  } else {
    console.log(`\nStep 2: deployer already whitelisted — skipping`);
  }

  // --- Step 3: mint cUSDC seed to deployer ATA ---
  const cUsdcAta = getAssociatedTokenAddressSync(
    cUsdcMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(cUsdcAta))) {
    console.log(`\nStep 3a: create cUSDC ATA`);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, cUsdcAta, authority.publicKey, cUsdcMint,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(conn, tx, [authority]);
  }
  const ataBal = await conn.getTokenAccountBalance(cUsdcAta).catch(() => null);
  const currentBal = ataBal ? BigInt(ataBal.value.amount) : 0n;
  if (currentBal >= CUSDC_SEED_AMOUNT) {
    console.log(`\nStep 3b: cUSDC ATA already has ${currentBal} units — skipping mint`);
  } else {
    console.log(`\nStep 3b: delta_mint.mint_to ${CUSDC_SEED_AMOUNT} cUSDC units`);
    const sig = await (deltaMint.methods as any)
      .mintTo(new BN(CUSDC_SEED_AMOUNT.toString()))
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
        mint: cUsdcMint,
        mintAuthority: dmMintAuthority,
        whitelistEntry,
        destination: cUsdcAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  // --- Step 4: activate_wrapping_native (move authority → pool PDA) ---
  // Detect activation by re-reading MintConfig.authority (offset 8+32=40
  // post-disc) and comparing to the pool PDA.
  const mcInfo = await conn.getAccountInfo(dmMintConfig);
  const mcAuth = mcInfo ? new PublicKey(mcInfo.data.subarray(40, 72)) : null;
  if (mcAuth?.equals(poolConfig)) {
    console.log(`\nStep 4: wrapping already activated (authority = pool PDA)`);
  } else {
    console.log(`\nStep 4: governor.activate_wrapping_native`);
    const sig = await (governor.methods as any)
      .activateWrappingNative()
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        dmMintConfig,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  // --- Step 5: pool's sUSDC vault ATA — created here so the first wrap
  //     doesn't have to provision it. ATA is owned by pool PDA, holds
  //     sUSDC. sUSDC is plain SPL Token (not Token-2022), so use the
  //     legacy program for the vault. ---
  const poolSusdcVault = getAssociatedTokenAddressSync(
    SUSDC_MINT, poolConfig, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(poolSusdcVault))) {
    console.log(`\nStep 5: create pool sUSDC vault ATA`);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, poolSusdcVault, poolConfig, SUSDC_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(conn, tx, [authority]);
    console.log(`  ${poolSusdcVault.toBase58()}`);
  } else {
    console.log(`\nStep 5: pool sUSDC vault already exists at ${poolSusdcVault.toBase58()}`);
  }

  // --- Output ---
  const out = {
    cluster: "devnet",
    rpc: RPC_URL,
    authority: authority.publicKey.toBase58(),
    pool: {
      poolConfig: poolConfig.toBase58(),
      underlyingMint: SUSDC_MINT.toBase58(),
      underlyingOracle: PYTH_USDC_USD.toBase58(),
      decimals: CUSDC_DECIMALS,
    },
    cusdcMint: cUsdcMint.toBase58(),
    cusdcAta: cUsdcAta.toBase58(),
    poolSusdcVault: poolSusdcVault.toBase58(),
    dmMintConfig: dmMintConfig.toBase58(),
    dmMintAuthority: dmMintAuthority.toBase58(),
    seedAmountUnits: CUSDC_SEED_AMOUNT.toString(),
    completedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "cusdc-pool.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  cUSDC pool deployed                          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  cUSDC mint:        ${cUsdcMint.toBase58()}`);
  console.log(`  Pool PDA:          ${poolConfig.toBase58()}`);
  console.log(`  Pool sUSDC vault:  ${poolSusdcVault.toBase58()}`);
  console.log(`  dmMintConfig:      ${dmMintConfig.toBase58()}`);
  console.log(`  Saved → ${outPath}`);
  console.log("\nNext: scripts/setup-cusdc-reserve.ts (klend init_reserve + config + EG remap)");
}

main().catch((e) => { console.error(e); process.exit(1); });
