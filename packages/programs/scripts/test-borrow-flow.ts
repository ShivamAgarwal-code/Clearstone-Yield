/**
 * test-borrow-flow.ts — Full borrow flow on devnet:
 *   1. RefreshReserve (cUSDY + USDC)
 *   2. InitObligation
 *   3. DepositReserveLiquidityAndObligationCollateral (cUSDY)
 *   4. RefreshObligation
 *   5. BorrowObligationLiquidity (USDC)
 */

import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const auth = loadKeypair();

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs/devnet/working-reserves.json"), "utf8"));
  const dUsdyReserve = new PublicKey(config.dUsdyReserve);
  const usdcReserve = new PublicKey(config.usdcReserve);
  const dUsdyOracle = new PublicKey(config.dUsdyOracle);
  const usdcOracle = new PublicKey(config.usdcOracle);
  const usdcMint = new PublicKey(config.usdcMint);

  // Read cUSDY mint from deployment config
  const deployConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs/devnet/deployment.json"), "utf8"));
  const dUsdyMint = new PublicKey(deployConfig.pool.wrappedMint);

  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);

  console.log("============================================");
  console.log("  Borrow Flow Test");
  console.log("============================================");
  console.log(`  Authority:    ${auth.publicKey.toBase58()}`);
  console.log(`  cUSDY mint:   ${dUsdyMint.toBase58()}`);
  console.log(`  USDC mint:    ${usdcMint.toBase58()}`);
  console.log(`  cUSDY reserve: ${dUsdyReserve.toBase58()}`);
  console.log(`  USDC reserve:  ${usdcReserve.toBase58()}`);
  console.log("============================================\n");

  // Step 1: Refresh both reserves
  console.log("--- Step 1: RefreshReserve ---");
  for (const [name, reserve, oracle] of [
    ["cUSDY", dUsdyReserve, dUsdyOracle],
    ["USDC", usdcReserve, usdcOracle],
  ] as const) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    tx.add({
      programId: KLEND, data: disc("refresh_reserve"),
      keys: [
        { pubkey: reserve, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
      ],
    });
    await sendAndConfirmTransaction(conn, tx, [auth]);
    console.log(`  ${name}: OK`);
  }

  // Step 2: InitObligation
  console.log("\n--- Step 2: InitObligation ---");
  // Obligation PDA: seeds depend on klend version. Let's use a keypair instead.
  // klend uses [tag, id, lending_market, owner, seed1, seed2] for the obligation seed
  // For simplicity, create obligation with a Keypair
  const obligationKp = Keypair.generate();
  const obligationSize = 3344; // Obligation account size from klend

  // seed1 and seed2: klend expects specific accounts. Use default (KLEND program as placeholder)
  // From the SDK: seed1Account and seed2Account are just used for PDA derivation
  // For the basic initObligation, they can be the lending market itself
  const tag = 0; // default obligation tag
  const id = 0;  // default obligation id

  // Derive obligation PDA
  const tagBuf = Buffer.alloc(1); tagBuf.writeUInt8(tag);
  const idBuf = Buffer.alloc(1); idBuf.writeUInt8(id);
  // Seeds: [tag(1), id(1), owner, market, seed1, seed2]
  // For tag=0: seed1 and seed2 must be PublicKey.default
  const seed1 = PublicKey.default;
  const seed2 = PublicKey.default;
  const [obligationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from([tag]), Buffer.from([id]), auth.publicKey.toBuffer(), MARKET.toBuffer(), seed1.toBuffer(), seed2.toBuffer()],
    KLEND
  );

  // userMetadata PDA: ["user_meta", owner]
  const [userMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), auth.publicKey.toBuffer()],
    KLEND
  );

  // Step 2a: InitUserMetadata (required before InitObligation)
  const userMetaInfo = await conn.getAccountInfo(userMetadata);
  if (!userMetaInfo) {
    console.log("  Creating UserMetadata...");
    // args: userLookupTable (pubkey) — use default
    const metaArgs = PublicKey.default.toBuffer();
    const metaTx = new Transaction();
    metaTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    metaTx.add({
      programId: KLEND,
      data: Buffer.concat([disc("init_user_metadata"), metaArgs]),
      keys: [
        { pubkey: auth.publicKey, isSigner: true, isWritable: false },
        { pubkey: auth.publicKey, isSigner: true, isWritable: true },
        { pubkey: userMetadata, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false }, // referrerUserMetadata (None)
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    try {
      await sendAndConfirmTransaction(conn, metaTx, [auth]);
      console.log(`  UserMetadata created: ${userMetadata.toBase58()}`);
    } catch (e: any) {
      console.log(`  UserMetadata failed: ${e.logs?.filter((l: string) => l.includes("log:"))?.pop()?.replace("Program log: ", "")?.slice(0, 100)}`);
    }
  } else {
    console.log(`  UserMetadata exists: ${userMetadata.toBase58()}`);
  }

  const obligationInfo = await conn.getAccountInfo(obligationPda);
  if (obligationInfo) {
    console.log(`  Obligation already exists: ${obligationPda.toBase58()}`);
  } else {
    // initObligation args: tag(u8), id(u8)
    const args = Buffer.alloc(2);
    args.writeUInt8(tag, 0);
    args.writeUInt8(id, 1);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    tx.add({
      programId: KLEND,
      data: Buffer.concat([disc("init_obligation"), args]),
      keys: [
        { pubkey: auth.publicKey, isSigner: true, isWritable: false }, // obligationOwner
        { pubkey: auth.publicKey, isSigner: true, isWritable: true },  // feePayer
        { pubkey: obligationPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false },
        { pubkey: seed1, isSigner: false, isWritable: false },           // seed1Account (default for tag=0)
        { pubkey: seed2, isSigner: false, isWritable: false },           // seed2Account (default for tag=0)
        { pubkey: userMetadata, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    });
    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
      console.log(`  Created: ${obligationPda.toBase58()}`);
      console.log(`  Tx: ${sig.slice(0, 40)}...`);
    } catch (e: any) {
      const logs = e.logs?.filter((l: string) => l.includes("log:"))?.slice(-3) || [];
      for (const l of logs) console.log(`  ${l.replace("Program log: ", "").slice(0, 120)}`);
      return;
    }
  }

  // Step 3: Deposit cUSDY as collateral
  console.log("\n--- Step 3: Deposit cUSDY collateral ---");

  // Check cUSDY balance
  const dUsdyAta = getAssociatedTokenAddressSync(dUsdyMint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dUsdyBalance = await conn.getTokenAccountBalance(dUsdyAta).catch(() => null);
  console.log(`  cUSDY balance: ${dUsdyBalance?.value?.uiAmountString || "0"}`);

  if (!dUsdyBalance || Number(dUsdyBalance.value.amount) === 0) {
    console.log("  No cUSDY balance. Mint some first via: pnpm deploy:all:devnet");
    console.log("  Skipping deposit + borrow.");
    return;
  }

  // Reserve PDAs for cUSDY
  const [dUsdyLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), dUsdyReserve.toBuffer()], KLEND);
  const [dUsdyCollMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), dUsdyReserve.toBuffer()], KLEND);
  const [dUsdyCollSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), dUsdyReserve.toBuffer()], KLEND);

  const depositAmount = Math.min(Number(dUsdyBalance.value.amount), 100_000000); // 100 cUSDY max

  // depositReserveLiquidityAndObligationCollateral args: liquidity_amount(u64)
  const depositArgs = Buffer.alloc(8);
  depositArgs.writeBigUInt64LE(BigInt(depositAmount), 0);

  const depositTx = new Transaction();
  // klend check_refresh: deposit at ix[N] expects RefreshObligation at ix[N-2], RefreshReserve at ix[N-1]
  // ix0: RefreshObligation
  depositTx.add({
    programId: KLEND, data: disc("refresh_obligation"),
    keys: [
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: obligationPda, isSigner: false, isWritable: true },
    ],
  });
  depositTx.add({
    programId: KLEND, data: disc("refresh_reserve"),
    keys: [
      { pubkey: dUsdyReserve, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: dUsdyOracle, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
    ],
  });
  depositTx.add({
    programId: KLEND,
    data: Buffer.concat([disc("deposit_reserve_liquidity_and_obligation_collateral"), depositArgs]),
    keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },    // owner
      { pubkey: obligationPda, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: dUsdyReserve, isSigner: false, isWritable: true },
      { pubkey: dUsdyMint, isSigner: false, isWritable: false },       // reserveLiquidityMint
      { pubkey: dUsdyLiqSupply, isSigner: false, isWritable: true },
      { pubkey: dUsdyCollMint, isSigner: false, isWritable: true },
      { pubkey: dUsdyCollSupply, isSigner: false, isWritable: true },   // reserveDestinationDepositCollateral
      { pubkey: dUsdyAta, isSigner: false, isWritable: true },          // userSourceLiquidity
      { pubkey: KLEND, isSigner: false, isWritable: false },            // placeholderUserDestinationCollateral (None)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },       // collateralTokenProgram (cToken is SPL Token)
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // liquidityTokenProgram (cUSDY is Token-2022)
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
  });

  try {
    const sig = await sendAndConfirmTransaction(conn, depositTx, [auth]);
    console.log(`  Deposited ${depositAmount / 1e6} cUSDY as collateral`);
    console.log(`  Tx: ${sig.slice(0, 40)}...`);
  } catch (e: any) {
    console.log(`  Deposit failed:`);
    const logs = e.logs?.filter((l: string) => l.includes("log:"))?.slice(-3) || [];
    for (const l of logs) console.log(`    ${l.replace("Program log: ", "")}`);
    return;
  }

  // Step 4: Refresh obligation
  console.log("\n--- Step 4: RefreshObligation ---");
  const refreshObTx = new Transaction();
  refreshObTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  refreshObTx.add({
    programId: KLEND,
    data: disc("refresh_obligation"),
    keys: [
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: obligationPda, isSigner: false, isWritable: true },
      // remaining accounts: pairs of (reserve, oracle) for each deposit/borrow in the obligation
      { pubkey: dUsdyReserve, isSigner: false, isWritable: false },
      { pubkey: dUsdyOracle, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard placeholder
      { pubkey: KLEND, isSigner: false, isWritable: false }, // scope placeholder
    ],
  });
  try {
    await sendAndConfirmTransaction(conn, refreshObTx, [auth]);
    console.log("  OK");
  } catch (e: any) {
    console.log(`  Failed: ${e.logs?.filter((l: string) => l.includes("log:"))?.pop()?.replace("Program log: ", "")?.slice(0, 100)}`);
  }

  // Step 5: Borrow USDC
  console.log("\n--- Step 5: Borrow USDC ---");
  const borrowAmount = 50_000000; // 50 USDC

  // USDC reserve PDAs
  const [usdcLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), usdcReserve.toBuffer()], KLEND);
  const [usdcFeeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), usdcReserve.toBuffer()], KLEND);

  // User USDC ATA
  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, auth.publicKey);
  const usdcAtaInfo = await conn.getAccountInfo(userUsdcAta);

  const borrowTx = new Transaction();
  borrowTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));

  if (!usdcAtaInfo) {
    borrowTx.add(createAssociatedTokenAccountInstruction(auth.publicKey, userUsdcAta, auth.publicKey, usdcMint));
  }

  const borrowArgs = Buffer.alloc(8);
  borrowArgs.writeBigUInt64LE(BigInt(borrowAmount), 0);

  borrowTx.add({
    programId: KLEND,
    data: Buffer.concat([disc("borrow_obligation_liquidity"), borrowArgs]),
    keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: false },     // owner
      { pubkey: obligationPda, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: usdcReserve, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },          // borrowReserveLiquidityMint
      { pubkey: usdcLiqSupply, isSigner: false, isWritable: true },
      { pubkey: usdcFeeRecv, isSigner: false, isWritable: true },
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      { pubkey: KLEND, isSigner: false, isWritable: false },             // referrerTokenState (None)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
  });

  try {
    const sig = await sendAndConfirmTransaction(conn, borrowTx, [auth]);
    console.log(`  Borrowed ${borrowAmount / 1e6} USDC!`);
    console.log(`  Tx: ${sig.slice(0, 40)}...`);

    const usdcBal = await conn.getTokenAccountBalance(userUsdcAta);
    console.log(`  USDC balance: ${usdcBal.value.uiAmountString}`);
  } catch (e: any) {
    console.log("  Borrow failed:");
    const logs = e.logs?.filter((l: string) => l.includes("log:"))?.slice(-3) || [];
    for (const l of logs) console.log(`    ${l.replace("Program log: ", "")}`);
  }

  console.log("\n============================================");
  console.log("  Borrow Flow Complete");
  console.log("============================================");
}

main().catch(console.error);
