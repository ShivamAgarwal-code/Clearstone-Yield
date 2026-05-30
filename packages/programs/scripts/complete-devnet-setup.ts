/**
 * complete-devnet-setup.ts
 *
 * Completes the devnet deployment by:
 *   1. Configuring the USDC reserve (updateReserveConfig via updateEntireReserveConfig)
 *   2. Whitelisting the authority wallet via governor add_participant
 *   3. Minting cUSDY tokens via governor mint_wrapped
 *   4. Initializing the cUSDY reserve with a seed deposit
 *
 * Prerequisites:
 *   - pnpm devnet:full has been run (governor pool, market, USDC reserve created)
 *
 * Usage:
 *   npx tsx scripts/complete-devnet-setup.ts
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
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GOVERNOR_PROGRAM_ID = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT_PROGRAM_ID = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

const RESERVE_SIZE = 8624;

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

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

function loadConfig(name: string) {
  const configPath = path.join(__dirname, "..", "configs", "devnet", name);
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// PDA helpers (matching klend SDK seeds.js)
function reserveLiquiditySupplyPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_liq_supply"), reserve.toBuffer()], KLEND_PROGRAM_ID
  );
  return pda;
}
function reserveFeeVaultPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_receiver"), reserve.toBuffer()], KLEND_PROGRAM_ID
  );
  return pda;
}
function reserveCollateralMintPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_coll_mint"), reserve.toBuffer()], KLEND_PROGRAM_ID
  );
  return pda;
}
function reserveCollateralSupplyPda(reserve: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_coll_supply"), reserve.toBuffer()], KLEND_PROGRAM_ID
  );
  return pda;
}
function marketAuthorityPda(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()], KLEND_PROGRAM_ID
  );
  return pda;
}

// klend initReserve instruction builder
function buildInitReserve(
  signer: PublicKey, market: PublicKey, reserve: PublicKey,
  mint: PublicKey, initialLiquiditySource: PublicKey,
  liquidityTokenProgram: PublicKey
): TransactionInstruction {
  // sha256("global:init_reserve")[0..8]
  const disc = Buffer.from([0x8a, 0xf5, 0x47, 0xe1, 0x99, 0x04, 0x03, 0x2b]);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: marketAuthorityPda(market), isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: reserveLiquiditySupplyPda(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveFeeVaultPda(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralMintPda(reserve), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralSupplyPda(reserve), isSigner: false, isWritable: true },
      { pubkey: initialLiquiditySource, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

  // Load IDLs
  const governorIdl = loadIdl("governor");
  const governorProgram = new Program(governorIdl, provider);

  // Load configs from previous steps
  const deployment = loadConfig("deployment.json");
  const marketConfig = loadConfig("market-deployed.json");

  const poolConfig = new PublicKey(deployment.pool.poolConfig);
  const wrappedMint = new PublicKey(deployment.pool.wrappedMint);
  const dmMintConfig = new PublicKey(deployment.pool.dmMintConfig);
  const dmMintAuthority = new PublicKey(deployment.pool.dmMintAuthority);
  const usdyOracle = new PublicKey(deployment.oracles.usdyPythV2);
  const usdcOracle = new PublicKey(deployment.oracles.usdcPythV2);
  const marketAddress = new PublicKey(marketConfig.market);
  const usdcReserveAddress = new PublicKey(marketConfig.reserves.USDC.address);
  const usdcMint = new PublicKey(marketConfig.reserves.USDC.mint);

  const balance = await conn.getBalance(authority.publicKey);
  console.log("============================================");
  console.log("  Complete Devnet Setup");
  console.log("============================================");
  console.log(`  Authority:    ${authority.publicKey.toBase58()}`);
  console.log(`  Balance:      ${(balance / 1e9).toFixed(4)} SOL`);
  console.log(`  Pool:         ${poolConfig.toBase58()}`);
  console.log(`  cUSDY mint:   ${wrappedMint.toBase58()}`);
  console.log(`  Market:       ${marketAddress.toBase58()}`);
  console.log(`  USDC reserve: ${usdcReserveAddress.toBase58()}`);
  console.log("============================================\n");

  // =========================================================================
  // Step 1: Configure USDC reserve
  // =========================================================================
  console.log("--- Step 1: Configure USDC reserve ---");

  const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
  // sha256("global:update_reserve_config")[0..8]
  const UPDATE_DISC = Buffer.from([0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d]);

  const configUpdates = [
    { name: "UpdatePythPrice", mode: 20, value: usdcOracle.toBuffer() },
    { name: "UpdateLoanToValuePct", mode: 0, value: Buffer.from([0]) },
    { name: "UpdateLiquidationThresholdPct", mode: 2, value: Buffer.from([0]) },
    // UpdateBorrowRateCurve (mode 23) — set a basic linear curve before limits
    { name: "UpdateBorrowRateCurve", mode: 23, value: (() => {
      // BorrowRateCurve: { points: [CurvePoint; 11] }
      // CurvePoint: { utilization_rate_bps: u32, borrow_rate_bps: u32 }
      // 11 points * 8 bytes = 88 bytes
      const buf = Buffer.alloc(88);
      const points = [
        [0, 0], [1000, 400], [2000, 800], [4000, 1200], [6000, 2000],
        [7000, 3000], [7500, 4000], [8000, 6000], [8500, 10000], [9000, 20000],
        [10000, 50000],
      ];
      points.forEach(([util, rate], i) => {
        buf.writeUInt32LE(util, i * 8);
        buf.writeUInt32LE(rate, i * 8 + 4);
      });
      return buf;
    })() },
    { name: "UpdateDepositLimit", mode: 8, value: (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100_000_000_000n); return b; })() },
    { name: "UpdateBorrowLimit", mode: 9, value: (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(75_000_000_000n); return b; })() },
  ];

  // Check if reserve exists first
  const reserveInfo = await conn.getAccountInfo(usdcReserveAddress);
  if (!reserveInfo) {
    console.log("  USDC reserve not found! Run pnpm devnet:market first.");
  } else {
    console.log(`  USDC reserve found (${reserveInfo.data.length} bytes)`);
    for (const { name, mode, value } of configUpdates) {
      // Borsh: disc(8) + mode(u8 enum) + value_len(u32) + value_data + skip(bool/u8)
      const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
      let offset = 0;
      UPDATE_DISC.copy(data, offset); offset += 8;
      data.writeUInt8(mode, offset); offset += 1;      // mode as u8 (Borsh enum)
      data.writeUInt32LE(value.length, offset); offset += 4;
      value.copy(data, offset); offset += value.length;
      data.writeUInt8(1, offset); // skipConfigIntegrityValidation = true

      const ix = new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
          { pubkey: marketAddress, isSigner: false, isWritable: false },
          { pubkey: usdcReserveAddress, isSigner: false, isWritable: true },
        ],
        data,
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ix
      );

      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [authority]);
        console.log(`  ${name}: OK (${sig.slice(0, 20)}...)`);
      } catch (e: any) {
        const logs = e.logs || [];
        console.error(`  ${name}: FAILED — ${logs.find((l: string) => l.includes("Error:")) || e.message}`);
      }
    }
  }

  // =========================================================================
  // Step 2: Whitelist authority via governor add_participant
  // =========================================================================
  console.log("\n--- Step 2: Whitelist authority wallet ---");

  // WhitelistEntry PDA: ["whitelist", mint_config, wallet]
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), authority.publicKey.toBuffer()],
    DELTA_MINT_PROGRAM_ID
  );

  const whitelistExists = await conn.getAccountInfo(whitelistEntry);
  if (whitelistExists) {
    console.log(`  Already whitelisted: ${whitelistEntry.toBase58()}`);
  } else {
    try {
      const sig = await (governorProgram.methods as any)
        .addParticipant({ holder: {} }) // ParticipantRole::Holder
        .accounts({
          authority: authority.publicKey,
          poolConfig,
          dmMintConfig,
          wallet: authority.publicKey,
          whitelistEntry,
          deltaMintProgram: DELTA_MINT_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  Whitelisted: ${sig}`);
    } catch (e: any) {
      console.error(`  Whitelist failed: ${e.message}`);
      if (e.logs) console.error("  Logs:", e.logs.slice(-3).join("\n    "));
    }
  }

  // =========================================================================
  // Step 3: Mint cUSDY tokens via governor mint_wrapped
  // =========================================================================
  console.log("\n--- Step 3: Mint cUSDY tokens ---");

  // Create ATA for cUSDY (Token-2022)
  let dUsdyAta: PublicKey;
  try {
    const ata = await getOrCreateAssociatedTokenAccount(
      conn, authority, wrappedMint, authority.publicKey, false, "confirmed",
      undefined, TOKEN_2022_PROGRAM_ID
    );
    dUsdyAta = ata.address;
    console.log(`  cUSDY ATA: ${dUsdyAta.toBase58()}`);
  } catch (e: any) {
    console.error(`  Failed to create cUSDY ATA: ${e.message}`);
    return;
  }

  // Mint 1000 cUSDY (1_000_000_000 with 6 decimals)
  const mintAmount = 1_000_000_000; // 1000 tokens
  try {
    const sig = await (governorProgram.methods as any)
      .mintWrapped(new (await import("@coral-xyz/anchor")).BN(mintAmount))
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        dmMintConfig,
        wrappedMint,
        dmMintAuthority,
        whitelistEntry,
        destination: dUsdyAta,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Minted 1000 cUSDY: ${sig}`);
  } catch (e: any) {
    console.error(`  Mint failed: ${e.message}`);
    if (e.logs) console.error("  Logs:", e.logs.slice(-3).join("\n    "));
  }

  // =========================================================================
  // Step 4: Initialize cUSDY reserve (or reuse existing)
  // =========================================================================
  console.log("\n--- Step 4: Initialize cUSDY reserve ---");

  let dUsdyReserveAddress: PublicKey;
  const existingDusdyReserve = marketConfig.reserves?.cUSDY?.address;

  if (existingDusdyReserve && existingDusdyReserve !== "pending") {
    dUsdyReserveAddress = new PublicKey(existingDusdyReserve);
    const info = await conn.getAccountInfo(dUsdyReserveAddress);
    if (info) {
      console.log(`  cUSDY reserve already exists: ${dUsdyReserveAddress.toBase58()}`);
    } else {
      console.log(`  Config references ${dUsdyReserveAddress.toBase58()} but not found on-chain. Creating new.`);
      dUsdyReserveAddress = null as any;
    }
  }

  if (!dUsdyReserveAddress || !(await conn.getAccountInfo(dUsdyReserveAddress))) {
    const dUsdyReserveKp = Keypair.generate();
    const reserveRent = await conn.getMinimumBalanceForRentExemption(RESERVE_SIZE);

    const tx4 = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: dUsdyReserveKp.publicKey,
        lamports: reserveRent,
        space: RESERVE_SIZE,
        programId: KLEND_PROGRAM_ID,
      }),
      buildInitReserve(
        authority.publicKey,
        marketAddress,
        dUsdyReserveKp.publicKey,
        wrappedMint,
        dUsdyAta,
        TOKEN_2022_PROGRAM_ID
      )
    );

    try {
      const sig = await sendAndConfirmTransaction(conn, tx4, [authority, dUsdyReserveKp]);
      dUsdyReserveAddress = dUsdyReserveKp.publicKey;
      console.log(`  cUSDY reserve created: ${dUsdyReserveAddress.toBase58()}`);
      console.log(`  Tx: ${sig}`);
    } catch (e: any) {
      console.error(`  cUSDY reserve failed: ${e.message}`);
      if (e.logs) {
        const relevant = e.logs.filter((l: string) => l.includes("Error") || l.includes("log:"));
        console.error("  Logs:", relevant.slice(-5).join("\n    "));
      }
      dUsdyReserveAddress = dUsdyReserveKp.publicKey; // still save for config
    }
  }

  // Configure cUSDY reserve
  if (dUsdyReserveAddress && await conn.getAccountInfo(dUsdyReserveAddress)) {
    console.log("\n  Configuring cUSDY reserve...");
    const dUsdyConfigs = [
      { name: "UpdatePythPrice", mode: 20, value: usdyOracle.toBuffer() },
      { name: "UpdateLoanToValuePct", mode: 0, value: Buffer.from([75]) },
      { name: "UpdateLiquidationThresholdPct", mode: 2, value: Buffer.from([82]) },
      { name: "UpdateBorrowRateCurve", mode: 23, value: (() => {
        const buf = Buffer.alloc(88);
        const points = [
          [0, 0], [1000, 200], [2000, 400], [4000, 600], [6000, 1000],
          [7000, 1500], [7500, 2000], [8000, 3000], [8500, 5000], [9000, 10000],
          [10000, 25000],
        ];
        points.forEach(([util, rate], i) => {
          buf.writeUInt32LE(util, i * 8);
          buf.writeUInt32LE(rate, i * 8 + 4);
        });
        return buf;
      })() },
      { name: "UpdateDepositLimit", mode: 8, value: (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100_000_000_000n); return b; })() },
      { name: "UpdateBorrowLimit", mode: 9, value: (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(0n); return b; })() },
    ];

    for (const { name, mode, value } of dUsdyConfigs) {
      const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
      let offset = 0;
      UPDATE_DISC.copy(data, offset); offset += 8;
      data.writeUInt8(mode, offset); offset += 1;
      data.writeUInt32LE(value.length, offset); offset += 4;
      value.copy(data, offset); offset += value.length;
      data.writeUInt8(1, offset);

      const ix = new TransactionInstruction({
        programId: KLEND_PROGRAM_ID,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
          { pubkey: marketAddress, isSigner: false, isWritable: false },
          { pubkey: dUsdyReserveAddress, isSigner: false, isWritable: true },
        ],
        data,
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
        ix
      );

      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [authority]);
        console.log(`  ${name}: OK`);
      } catch (e: any) {
        const logs = e.logs || [];
        console.error(`  ${name}: FAILED — ${logs.find((l: string) => l.includes("Error:")) || e.message}`);
      }
    }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  const output = {
    ...marketConfig,
    reserves: {
      ...marketConfig.reserves,
      cUSDY: {
        status: "created",
        address: dUsdyReserveAddress.toBase58(),
        mint: wrappedMint.toBase58(),
        oracle: usdyOracle.toBase58(),
        tokenProgram: "Token-2022",
        role: "collateral",
        ltv: "75%",
      },
    },
    whitelistedWallets: [authority.publicKey.toBase58()],
    completedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "..", "configs", "devnet", "market-deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("\n============================================");
  console.log("  Setup Complete!");
  console.log("============================================");
  console.log(`  Market:         ${marketAddress.toBase58()}`);
  console.log(`  USDC reserve:   ${usdcReserveAddress.toBase58()}`);
  console.log(`  cUSDY reserve:  ${dUsdyReserveAddress.toBase58()}`);
  console.log(`  cUSDY mint:     ${wrappedMint.toBase58()}`);
  console.log(`  Whitelisted:    ${authority.publicKey.toBase58()}`);
  console.log("============================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
