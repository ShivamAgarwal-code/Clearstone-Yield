/**
 * deploy-cssol-governor-devnet.ts
 *
 * Step 2 of the csSOL devnet stack (after deploying the program binaries):
 *   1. Initializes the csSOL governor pool — CPI to delta-mint creates the
 *      Token-2022 csSOL mint with PDA mint authority owned by delta-mint and
 *      first-tier authority on the deployer.
 *   2. Whitelists the deployer (delta-mint::add_to_whitelist).
 *   3. Mints a small csSOL seed to the deployer's ATA (delta-mint::mint_to)
 *      — needed by setup-cssol-market.ts for klend's init_reserve seed.
 *
 * Pool params:
 *   underlying     = wSOL (native mint)
 *   underlying_oracle = accrual-oracle output  (csSOL price source, from cssol-oracle.json)
 *   borrow_mint    = wSOL
 *   borrow_oracle  = 7UVi…  (real Pyth-Receiver-owned SOL/USD push feed)
 *   decimals       = 9       (SOL native decimals)
 *   ltv_pct        = 55      (no-group baseline; group 2 overrides to 90)
 *   liq_threshold  = 65      (no-group baseline; group 2 overrides to 92)
 *   elevation_group = 2      (LST/SOL — registered on the market by setup-cssol-market.ts)
 *
 * Why mint_to before market registration: setup-cssol-market.ts uses the
 * deployer's csSOL ATA as the `initialLiquiditySource` for klend's init_reserve.
 * The pool is in `Initializing` state until register_lending_market completes,
 * but delta-mint::mint_to runs against delta-mint directly (it does not check
 * pool status), and the deployer is still the mint authority pre-activation.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/deploy-cssol-governor-devnet.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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

// Real Pyth-pushed SOL/USD feed on devnet (also valid mainnet — same feed_id PDA).
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// Seed amount minted to the deployer's csSOL ATA. Just enough to satisfy
// klend's init_reserve initial-deposit requirement (token program rejects 0).
// 1_000_000 lamport-units = 0.001 csSOL @ 9 decimals.
const CSSOL_SEED_AMOUNT = 1_000_000n;

const ELEVATION_GROUP = 2;
const BASELINE_LTV_PCT = 55;
const BASELINE_LIQUIDATION_THRESHOLD_PCT = 65;
const CSSOL_DECIMALS = 9;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

function loadOracleConfig(): { accrualOutput: string } {
  const p = path.join(__dirname, "..", "configs", "devnet", "cssol-oracle.json");
  if (!fs.existsSync(p)) {
    throw new Error(`run setup-cssol-oracle.ts first — ${p} missing`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  const governorIdl = loadIdl("governor");
  const deltaMintIdl = loadIdl("delta_mint");
  const governor = new Program(governorIdl, provider);
  const deltaMint = new Program(deltaMintIdl, provider);

  const oracleCfg = loadOracleConfig();
  const accrualOutput = new PublicKey(oracleCfg.accrualOutput);

  console.log("=== csSOL governor pool deploy ===");
  console.log("RPC:           ", RPC_URL);
  console.log("Authority:     ", authority.publicKey.toBase58());
  console.log("Underlying:    ", NATIVE_MINT.toBase58(), "(wSOL)");
  console.log("Underlying oracle (accrual):", accrualOutput.toBase58());
  console.log("Borrow oracle (Pyth SOL/USD):", PYTH_SOL_USD.toBase58());

  const balance = await conn.getBalance(authority.publicKey);
  console.log("Balance:       ", (balance / 1e9).toFixed(4), "SOL");
  if (balance < 0.5e9) {
    console.warn("⚠ Low SOL balance. Top up before continuing — this script needs ~0.05 SOL.");
  }

  // --- Pool config PDA — keyed by underlying (wSOL) -----------------------
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), NATIVE_MINT.toBuffer()],
    GOVERNOR_PROGRAM_ID,
  );
  console.log("Pool PDA:      ", poolConfig.toBase58());

  const existingPool = await conn.getAccountInfo(poolConfig);
  let cssolMint: PublicKey;
  let dmMintConfig: PublicKey;
  let dmMintAuthority: PublicKey;

  if (existingPool) {
    // Layout: disc(8) + authority(32) + underlying_mint(32) + underlying_oracle(32)
    //   + borrow_mint(32) + borrow_oracle(32) + wrapped_mint(32) at offset 168
    const wrappedMintOffset = 8 + 32 * 5;
    cssolMint = new PublicKey(existingPool.data.subarray(wrappedMintOffset, wrappedMintOffset + 32));
    [dmMintConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), cssolMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    [dmMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), cssolMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    console.log("Pool exists — reusing csSOL mint:", cssolMint.toBase58());
  } else {
    const cssolMintKp = Keypair.generate();
    cssolMint = cssolMintKp.publicKey;
    [dmMintConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), cssolMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    [dmMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), cssolMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );

    console.log("\nStep 1: governor.initialize_pool");
    const sig = await (governor.methods as any)
      .initializePool({
        underlyingOracle: accrualOutput,
        borrowMint: NATIVE_MINT,
        borrowOracle: PYTH_SOL_USD,
        decimals: CSSOL_DECIMALS,
        ltvPct: BASELINE_LTV_PCT,
        liquidationThresholdPct: BASELINE_LIQUIDATION_THRESHOLD_PCT,
        elevationGroup: ELEVATION_GROUP,
      })
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        underlyingMint: NATIVE_MINT,
        wrappedMint: cssolMint,
        dmMintConfig,
        dmMintAuthority,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([cssolMintKp])
      .rpc();
    console.log(`  csSOL mint: ${cssolMint.toBase58()}`);
    console.log(`  Tx: ${sig}`);
  }

  // --- Step 2: whitelist deployer (delta-mint direct) ----------------------
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), authority.publicKey.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  );
  const whitelistInfo = await conn.getAccountInfo(whitelistEntry);
  if (whitelistInfo) {
    console.log("\nStep 2: deployer already whitelisted — skipping.");
  } else {
    console.log("\nStep 2: delta_mint.add_to_whitelist (deployer as Holder)");
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
  }

  // --- Step 3: mint csSOL seed to deployer ATA -----------------------------
  const cssolAta = getAssociatedTokenAddressSync(
    cssolMint, authority.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ataInfo = await conn.getAccountInfo(cssolAta);
  if (!ataInfo) {
    console.log("\nStep 3a: create csSOL ATA");
    const ix = createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, cssolAta, authority.publicKey, cssolMint,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const tx = new (await import("@solana/web3.js")).Transaction().add(ix);
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    await sendAndConfirmTransaction(conn, tx, [authority]);
  }

  const ataBalance = await conn.getTokenAccountBalance(cssolAta).catch(() => null);
  const currentBal = ataBalance ? BigInt(ataBalance.value.amount) : 0n;
  if (currentBal >= CSSOL_SEED_AMOUNT) {
    console.log(`\nStep 3b: csSOL ATA already has ${currentBal} units (>= ${CSSOL_SEED_AMOUNT} seed). Skipping mint.`);
  } else {
    console.log(`\nStep 3b: delta_mint.mint_to ${CSSOL_SEED_AMOUNT} csSOL units → deployer ATA`);
    const sig = await (deltaMint.methods as any)
      .mintTo(new BN(CSSOL_SEED_AMOUNT.toString()))
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
        mint: cssolMint,
        mintAuthority: dmMintAuthority,
        whitelistEntry,
        destination: cssolAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  // --- Output ---------------------------------------------------------------
  const out = {
    cluster: "devnet",
    rpc: RPC_URL,
    authority: authority.publicKey.toBase58(),
    pool: {
      poolConfig: poolConfig.toBase58(),
      underlyingMint: NATIVE_MINT.toBase58(),
      underlyingOracle: accrualOutput.toBase58(),
      borrowMint: NATIVE_MINT.toBase58(),
      borrowOracle: PYTH_SOL_USD.toBase58(),
      decimals: CSSOL_DECIMALS,
      ltvPct: BASELINE_LTV_PCT,
      liquidationThresholdPct: BASELINE_LIQUIDATION_THRESHOLD_PCT,
      elevationGroup: ELEVATION_GROUP,
    },
    cssolMint: cssolMint.toBase58(),
    cssolAta: cssolAta.toBase58(),
    dmMintConfig: dmMintConfig.toBase58(),
    dmMintAuthority: dmMintAuthority.toBase58(),
    seedAmountUnits: CSSOL_SEED_AMOUNT.toString(),
    completedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== done ===");
  console.log(`csSOL mint:    ${cssolMint.toBase58()}`);
  console.log(`csSOL ATA:     ${cssolAta.toBase58()}`);
  console.log(`Pool PDA:      ${poolConfig.toBase58()}`);
  console.log(`Saved → ${outPath}`);
  console.log("\nNext: run scripts/setup-cssol-market.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
