/**
 * setup-devnet-market.ts
 *
 * Creates a Kamino lending market with cUSDY collateral and USDC borrow
 * reserves on Solana devnet. Then registers the market with the governor.
 *
 * Prerequisites:
 *   1. Programs deployed: delta-mint, governor (pnpm deploy:mnemonic)
 *   2. Governor pool initialized (deploy-governor-devnet.ts)
 *   3. Oracle accounts ready (setup-devnet-oracles.ts)
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/setup-devnet-market.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const GOVERNOR_PROGRAM_ID = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

// Devnet token mints (verified on-chain)
const DEVNET_USDC_MINT = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const DEVNET_USDT_MINT = new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft");
const DEVNET_USX_MINT = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const DEVNET_EUSX_MINT = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");

// Devnet programs
const DEVNET_USX_PROGRAM = new PublicKey("usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD");
const DEVNET_YIELD_VAULT_PROGRAM = new PublicKey("euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr");

// Pyth V2 devnet USDY oracle
const PYTH_USDY_DEVNET = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

// klend account sizes — devnet program expects slightly larger than mainnet
const LENDING_MARKET_SIZE = 4664;
const RESERVE_SIZE = 8624;

// Discriminators — computed as sha256("global:<snake_case_name>")[0..8]
const DISC = {
  initLendingMarket: Buffer.from([0x22, 0xa2, 0x74, 0x0e, 0x65, 0x89, 0x5e, 0xef]),
  initReserve: Buffer.from([0x8a, 0xf5, 0x47, 0xe1, 0x99, 0x04, 0x03, 0x2b]),
  updateReserveConfig: Buffer.from([0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d]),
  refreshReserve: Buffer.from([0x02, 0xda, 0x8a, 0xeb, 0x4f, 0xc9, 0x19, 0x66]),
};

const CONFIG_MODE = {
  UpdateLoanToValuePct: 0,
  UpdateLiquidationThresholdPct: 2,
  UpdateDepositLimit: 8,
  UpdateBorrowLimit: 9,
  UpdatePythPrice: 20,
  UpdateBorrowRateCurve: 23,
  UpdateReserveStatus: 34,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const defaultPath = path.join(process.env.HOME || "~", ".config/solana/id.json");
  const raw = fs.readFileSync(defaultPath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function marketAuthorityPda(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

// PDA seeds: [seed_string, reserve_address] — per klend SDK seeds.js
function reserveLiquiditySupplyPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_liq_supply"), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveFeeVaultPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_receiver"), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveCollateralMintPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_coll_mint"), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveCollateralSupplyPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_coll_supply"), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function poolConfigPda(underlyingMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), underlyingMint.toBuffer()],
    GOVERNOR_PROGRAM_ID
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function buildInitLendingMarket(owner: PublicKey, market: PublicKey): TransactionInstruction {
  const quoteCurrency = Buffer.alloc(32); // "USD" — left as zeros for simplicity
  const data = Buffer.alloc(8 + 32);
  DISC.initLendingMarket.copy(data, 0);
  quoteCurrency.copy(data, 8);

  // Per klend IDL: lendingMarketOwner, lendingMarket, lendingMarketAuthority, systemProgram, rent
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: marketAuthorityPda(market), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitReserve(
  signer: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  mint: PublicKey,
  initialLiquiditySource: PublicKey,
  liquidityTokenProgram: PublicKey
): TransactionInstruction {
  const mAuth = marketAuthorityPda(market);
  // Per klend IDL: signer, lendingMarket, lendingMarketAuthority, reserve,
  //   reserveLiquidityMint, reserveLiquiditySupply, feeReceiver,
  //   reserveCollateralMint, reserveCollateralSupply, initialLiquiditySource,
  //   rent, liquidityTokenProgram, collateralTokenProgram, systemProgram
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: mAuth, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: reserveLiquiditySupplyPda(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveFeeVaultPda(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralMintPda(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralSupplyPda(reserve), isSigner: false, isWritable: true },
      { pubkey: initialLiquiditySource, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // collateralTokenProgram (always SPL Token)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.initReserve,
  });
}

function buildUpdateReserveConfig(
  owner: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  mode: number,
  value: Buffer,
  skipValidation = true
): TransactionInstruction {
  // Borsh: disc(8) + mode(u8 enum) + value_len(u32) + value_data + skip(u8 bool)
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let offset = 0;
  DISC.updateReserveConfig.copy(data, offset); offset += 8;
  data.writeUInt8(mode, offset); offset += 1;
  data.writeUInt32LE(value.length, offset); offset += 4;
  value.copy(data, offset); offset += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, offset);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function u64Buf(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

function u8Buf(n: number): Buffer {
  return Buffer.from([n]);
}

function pubkeyBuf(pk: PublicKey): Buffer {
  return pk.toBuffer();
}

function buildRegisterLendingMarketIx(
  authority: PublicKey,
  poolConfig: PublicKey,
  lendingMarket: PublicKey,
  collateralReserve: PublicKey,
  borrowReserve: PublicKey
): TransactionInstruction {
  const disc = Buffer.from([0x37, 0x45, 0x3f, 0xcc, 0xe0, 0x53, 0x04, 0x40]);
  const data = Buffer.alloc(8 + 32 + 32 + 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  lendingMarket.toBuffer().copy(data, offset); offset += 32;
  collateralReserve.toBuffer().copy(data, offset); offset += 32;
  borrowReserve.toBuffer().copy(data, offset);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolConfig, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();

  console.log("============================================");
  console.log("  Devnet Kamino Market Setup");
  console.log("============================================");
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log("============================================\n");

  // Load oracle config
  const oracleConfigPath = path.join(__dirname, "..", "configs", "devnet", "oracles-deployed.json");
  let usdcOracleAddr: PublicKey;
  if (fs.existsSync(oracleConfigPath)) {
    const oracleConfig = JSON.parse(fs.readFileSync(oracleConfigPath, "utf8"));
    usdcOracleAddr = new PublicKey(oracleConfig.devnetOracles["USDC/USD"].address);
    console.log(`  USDC oracle (from config): ${usdcOracleAddr.toBase58()}`);
  } else {
    console.log("  WARNING: No oracle config found. Run setup-devnet-oracles.ts first.");
    console.log("  Using USDY oracle as placeholder for both reserves.\n");
    usdcOracleAddr = PYTH_USDY_DEVNET;
  }

  // Load deployment config if available
  const deployConfigPath = path.join(__dirname, "..", "configs", "devnet", "deployment.json");
  let wrappedMint: PublicKey;
  let underlyingMint = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");
  if (fs.existsSync(deployConfigPath)) {
    const deployConfig = JSON.parse(fs.readFileSync(deployConfigPath, "utf8"));
    wrappedMint = new PublicKey(deployConfig.pool.wrappedMint);
    console.log(`  Wrapped mint (from config): ${wrappedMint.toBase58()}`);
  } else {
    console.log("  WARNING: No deployment config. Using dummy wrapped mint.");
    wrappedMint = Keypair.generate().publicKey;
  }

  // Generate new keypairs for market and reserves
  const marketKp = Keypair.generate();
  const dUsdyReserveKp = Keypair.generate();
  const usdcReserveKp = Keypair.generate();

  console.log(`\n  Market:         ${marketKp.publicKey.toBase58()}`);
  console.log(`  cUSDY reserve:  ${dUsdyReserveKp.publicKey.toBase58()}`);
  console.log(`  USDC reserve:   ${usdcReserveKp.publicKey.toBase58()}`);
  console.log(`  USDC mint:      ${DEVNET_USDC_MINT.toBase58()} (verified devnet)`);

  // ---------------------------------------------------------------------------
  // Step 1: Create lending market
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 1: Create lending market ---");

  const marketRent = await conn.getMinimumBalanceForRentExemption(LENDING_MARKET_SIZE);
  const tx1 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: marketKp.publicKey,
      lamports: marketRent,
      space: LENDING_MARKET_SIZE,
      programId: KLEND_PROGRAM_ID,
    }),
    buildInitLendingMarket(authority.publicKey, marketKp.publicKey)
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx1, [authority, marketKp]);
    console.log(`  Market created: ${sig}`);
  } catch (e: any) {
    console.error(`  Failed: ${e.message}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Initialize reserves
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 2: Initialize reserves ---");

  const reserveRent = await conn.getMinimumBalanceForRentExemption(RESERVE_SIZE);

  // klend initReserve requires a seed deposit from initialLiquiditySource.
  // We don't control the devnet USDC mint authority, so create our own test USDC.
  console.log("\n  Creating test USDC mint (we need mint authority for seed deposit)...");
  let testUsdcMint: PublicKey;
  try {
    testUsdcMint = await createMint(
      conn, authority, authority.publicKey, null, 6, undefined, { commitment: "confirmed" }
    );
    console.log(`  Test USDC mint: ${testUsdcMint.toBase58()}`);
  } catch (e: any) {
    console.error(`  Failed to create test USDC mint: ${e.message}`);
    return;
  }

  // Create ATA and mint seed tokens for USDC
  const usdcAta = await getOrCreateAssociatedTokenAccount(
    conn, authority, testUsdcMint, authority.publicKey, false, "confirmed"
  );
  console.log(`  USDC ATA: ${usdcAta.address.toBase58()}`);

  // Mint 1000 USDC (1_000_000_000 with 6 decimals) for seed deposit
  await mintTo(conn, authority, testUsdcMint, usdcAta.address, authority, 1_000_000_000);
  console.log("  Minted 1000 test USDC to ATA");

  // USDC reserve (Token Program) — using our test mint
  const tx2b = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: usdcReserveKp.publicKey,
      lamports: reserveRent,
      space: RESERVE_SIZE,
      programId: KLEND_PROGRAM_ID,
    }),
    buildInitReserve(
      authority.publicKey,
      marketKp.publicKey,
      usdcReserveKp.publicKey,
      testUsdcMint,
      usdcAta.address,
      TOKEN_PROGRAM_ID
    )
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx2b, [authority, usdcReserveKp]);
    console.log(`  USDC reserve created: ${sig}`);
  } catch (e: any) {
    console.error(`  USDC reserve failed: ${e.message}`);
  }

  // cUSDY reserve (Token-2022)
  // Note: cUSDY mint exists but we haven't minted any tokens yet (requires whitelist flow).
  // We skip cUSDY reserve init for now — it will be added after governor whitelisting.
  console.log("\n  NOTE: Skipping cUSDY reserve — requires minting cUSDY via governor whitelist flow.");
  console.log("  Run add_participant + mint_wrapped first, then init cUSDY reserve separately.");

  // ---------------------------------------------------------------------------
  // Step 3: Configure reserves
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 3: Configure reserves ---");

  const market = marketKp.publicKey;

  // USDC config batch
  const usdcConfigs = [
    { mode: CONFIG_MODE.UpdatePythPrice, value: pubkeyBuf(usdcOracleAddr) },
    { mode: CONFIG_MODE.UpdateLoanToValuePct, value: u8Buf(0) },
    { mode: CONFIG_MODE.UpdateLiquidationThresholdPct, value: u8Buf(0) },
    { mode: CONFIG_MODE.UpdateDepositLimit, value: u64Buf(100_000_000_000n) },
    { mode: CONFIG_MODE.UpdateBorrowLimit, value: u64Buf(75_000_000_000n) },
  ];

  for (const { mode, value } of usdcConfigs) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      buildUpdateReserveConfig(authority.publicKey, market, usdcReserveKp.publicKey, mode, value)
    );
    try {
      await sendAndConfirmTransaction(conn, tx, [authority]);
      console.log(`  USDC config mode ${mode}: OK`);
    } catch (e: any) {
      console.error(`  USDC config mode ${mode}: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: Register with governor
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 4: Register lending market with governor ---");

  const poolConfig = poolConfigPda(underlyingMint);

  const poolInfo = await conn.getAccountInfo(poolConfig);
  if (poolInfo) {
    const tx4 = new Transaction().add(
      buildRegisterLendingMarketIx(
        authority.publicKey,
        poolConfig,
        market,
        dUsdyReserveKp.publicKey,
        usdcReserveKp.publicKey
      )
    );
    try {
      const sig = await sendAndConfirmTransaction(conn, tx4, [authority]);
      console.log(`  Registered: ${sig}`);
    } catch (e: any) {
      console.error(`  Registration failed: ${e.message}`);
    }
  } else {
    console.log("  Governor pool not found. Run deploy-governor-devnet.ts first.");
    console.log("  Skipping registration.\n");
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const output = {
    cluster: "devnet",
    market: marketKp.publicKey.toBase58(),
    reserves: {
      cUSDY: {
        status: "pending — needs mint_wrapped via governor first",
        reserveKeypair: dUsdyReserveKp.publicKey.toBase58(),
        mint: wrappedMint.toBase58(),
        oracle: PYTH_USDY_DEVNET.toBase58(),
        tokenProgram: "Token-2022",
        role: "collateral",
        ltv: "75%",
      },
      USDC: {
        address: usdcReserveKp.publicKey.toBase58(),
        mint: testUsdcMint.toBase58(),
        oracle: usdcOracleAddr.toBase58(),
        tokenProgram: "Token Program",
        role: "borrow",
        borrowLimit: "75,000 USDC",
        note: "Uses test USDC mint (we control mint authority)",
      },
    },
    governor: {
      poolConfig: poolConfig.toBase58(),
    },
    _keypairBackups: {
      _warning: "Store these securely — needed for market administration",
      market: Array.from(marketKp.secretKey),
      dUsdyReserve: Array.from(dUsdyReserveKp.secretKey),
      usdcReserve: Array.from(usdcReserveKp.secretKey),
    },
  };

  const outPath = path.join(__dirname, "..", "configs", "devnet", "market-deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("\n============================================");
  console.log("  Market config saved to:");
  console.log(`  ${outPath}`);
  console.log("============================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
