/**
 * deploy-csol-pool-devnet.ts
 *
 * Deploys the cSOL native-wrap pool — the KYC-gated 1:1 wrapper of
 * wSOL used as the loan asset on the credit-trade flow.
 *
 * Steps:
 *   1. governor.initialize_native_pool — atomically creates the
 *      cSOL Token-2022 mint via delta-mint CPI and the pool config
 *      PDA at seeds=[b"native_pool", cSOL_mint].
 *   2. delta_mint.add_to_whitelist — whitelists the deployer (Holder
 *      role) so the seed deposit can be minted.
 *   3. delta_mint.mint_to — mints a small cSOL seed to the deployer's
 *      ATA so the v4 klend reserve has a non-zero initial deposit.
 *   4. governor.activate_wrapping_native — transfers delta-mint
 *      authority to the pool PDA so subsequent wraps mint via CPI.
 *   5. Save configs/devnet/csol-pool.json.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/deploy-csol-pool-devnet.ts
 *
 * Note: pool authority must be the same keypair as the existing csSOL
 * pool authority (`DiDbnkw2…uDcFn`) so the playground/whitelist scripts
 * can reuse the same admin context. Override via DEPLOY_KEYPAIR.
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
  NATIVE_MINT,
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

// Real Pyth-pushed SOL/USD feed — used as cSOL's underlying oracle
// (1:1 with wSOL, no accrual layer).
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// Seed amount minted to the deployer's cSOL ATA for klend's
// init_reserve initial-deposit requirement (token program rejects 0).
// 1_000_000 lamport-units = 0.001 cSOL @ 9 decimals.
const CSOL_SEED_AMOUNT = 1_000_000n;
const CSOL_DECIMALS = 9;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  // Anchor 0.30+ embeds the program ID in the IDL but it can be stale —
  // the live governor binary may have been re-deployed at a new addr.
  // Override so `new Program(idl, provider)` talks to the right program.
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
  console.log("║  cSOL pool deploy (KYC wrapper of wSOL)       ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  RPC:           ${RPC_URL}`);
  console.log(`  Authority:     ${authority.publicKey.toBase58()}`);
  console.log(`  Underlying:    ${NATIVE_MINT.toBase58()} (wSOL)`);
  console.log(`  Underlying oracle: ${PYTH_SOL_USD.toBase58()}`);
  const balance = await conn.getBalance(authority.publicKey);
  console.log(`  Balance:       ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.05e9) console.warn("⚠ Low SOL — top up before continuing.");

  // Idempotent checkpoint so partial failures resume cleanly.
  const checkpointPath = path.join(__dirname, "..", "configs/devnet/csol-pool.checkpoint.json");
  let cp: { mint?: string } = {};
  if (fs.existsSync(checkpointPath)) {
    cp = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    console.log(`  Resuming checkpoint: mint=${cp.mint ?? "(none)"}`);
  }
  const persist = () => fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));

  // --- Step 1: initialize_native_pool ---
  let cSolMint: PublicKey;
  let cSolMintKp: Keypair | null = null;
  if (cp.mint) {
    cSolMint = new PublicKey(cp.mint);
    console.log(`\nStep 1: pool already initialized — reusing cSOL mint ${cSolMint.toBase58()}`);
  } else {
    cSolMintKp = Keypair.generate();
    cSolMint = cSolMintKp.publicKey;
  }
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("native_pool"), cSolMint.toBuffer()],
    GOVERNOR_PROGRAM_ID,
  );
  const [dmMintConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), cSolMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
  );
  const [dmMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), cSolMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
  );

  const existingPool = await conn.getAccountInfo(poolConfig);
  if (!existingPool) {
    if (!cSolMintKp) throw new Error("checkpoint says mint exists but pool doesn't — delete csol-pool.checkpoint.json and retry");
    console.log(`\nStep 1: governor.initialize_native_pool`);
    const sig = await (governor.methods as any)
      .initializeNativePool({
        underlyingOracle: PYTH_SOL_USD,
        decimals: CSOL_DECIMALS,
      })
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        underlyingMint: NATIVE_MINT,
        wrappedMint: cSolMint,
        dmMintConfig,
        dmMintAuthority,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([cSolMintKp])
      .rpc();
    cp.mint = cSolMint.toBase58();
    persist();
    console.log(`  cSOL mint: ${cSolMint.toBase58()}`);
    console.log(`  Pool PDA:  ${poolConfig.toBase58()}`);
    console.log(`  Tx:        ${sig}`);
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

  // --- Step 3: mint cSOL seed to deployer ATA ---
  const cSolAta = getAssociatedTokenAddressSync(
    cSolMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(cSolAta))) {
    console.log(`\nStep 3a: create cSOL ATA`);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, cSolAta, authority.publicKey, cSolMint,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(conn, tx, [authority]);
  }
  const ataBal = await conn.getTokenAccountBalance(cSolAta).catch(() => null);
  const currentBal = ataBal ? BigInt(ataBal.value.amount) : 0n;
  if (currentBal >= CSOL_SEED_AMOUNT) {
    console.log(`\nStep 3b: cSOL ATA already has ${currentBal} units — skipping mint`);
  } else {
    console.log(`\nStep 3b: delta_mint.mint_to ${CSOL_SEED_AMOUNT} cSOL units`);
    const sig = await (deltaMint.methods as any)
      .mintTo(new BN(CSOL_SEED_AMOUNT.toString()))
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
        mint: cSolMint,
        mintAuthority: dmMintAuthority,
        whitelistEntry,
        destination: cSolAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  // --- Step 4: activate_wrapping_native (move authority → pool PDA) ---
  // Detect activation by re-reading MintConfig.authority and comparing
  // to the pool PDA. delta-mint's MintConfig has authority at offset
  // 8 + mint(32) = 40 (post-disc).
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

  // --- Pool's wSOL vault ATA — created here so the first wrap doesn't
  //     have to provision it. ATA owned by pool PDA, holding wSOL. ---
  const poolWsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT, poolConfig, true, // allowOwnerOffCurve = true (PDA owner)
  );
  if (!(await conn.getAccountInfo(poolWsolAta))) {
    console.log(`\nStep 5: create pool wSOL vault ATA`);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, poolWsolAta, poolConfig, NATIVE_MINT,
      ),
    );
    await sendAndConfirmTransaction(conn, tx, [authority]);
    console.log(`  ${poolWsolAta.toBase58()}`);
  } else {
    console.log(`\nStep 5: pool wSOL vault already exists at ${poolWsolAta.toBase58()}`);
  }

  // --- Output ---
  const out = {
    cluster: "devnet",
    rpc: RPC_URL,
    authority: authority.publicKey.toBase58(),
    pool: {
      poolConfig: poolConfig.toBase58(),
      underlyingMint: NATIVE_MINT.toBase58(),
      underlyingOracle: PYTH_SOL_USD.toBase58(),
      decimals: CSOL_DECIMALS,
    },
    csolMint: cSolMint.toBase58(),
    csolAta: cSolAta.toBase58(),
    poolWsolVault: poolWsolAta.toBase58(),
    dmMintConfig: dmMintConfig.toBase58(),
    dmMintAuthority: dmMintAuthority.toBase58(),
    seedAmountUnits: CSOL_SEED_AMOUNT.toString(),
    completedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "csol-pool.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  cSOL pool deployed                            ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  cSOL mint:     ${cSolMint.toBase58()}`);
  console.log(`  Pool PDA:      ${poolConfig.toBase58()}`);
  console.log(`  Pool wSOL vault: ${poolWsolAta.toBase58()}`);
  console.log(`  Saved → ${outPath}`);
  console.log("\nNext: bootstrap v4 market with cSOL as the loan reserve");
  console.log(`  MARKET_VERSION=v4 npx tsx scripts/bootstrap-cssol-market-v2.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
