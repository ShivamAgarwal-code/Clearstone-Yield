/**
 * setup-eusx-market.ts — Create klend reserves for the eUSX collateral market
 *
 * Creates:
 *   - ceUSX reserve (collateral, yield-bearing, $1.08)
 *   - Solstice USDC reserve (borrow asset, $1.00)
 *   - Oracles for both (PriceUpdateV2 format)
 *   - Full reserve configuration (LTV, limits, borrow curve)
 *
 * Usage: npx tsx scripts/setup-eusx-market.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");

// Solstice tokens
const SOLSTICE_USDC = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const SOLSTICE_USDT = new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft");
const USX = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const EUSX = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const DEUSX = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");

function disc(name: string) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildPriceUpdateV2(authority: PublicKey, price: number, slot: number): Buffer {
  const buf = Buffer.alloc(133);
  let off = 0;
  PRICE_UPDATE_V2_DISC.copy(buf, off); off += 8;
  authority.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(1, off); off += 1; // Full verification
  off += 32; // feed_id (zeros)
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeInt32LE(-8, off); off += 4;
  const ts = BigInt(Math.floor(Date.now() / 1000));
  buf.writeBigInt64LE(ts, off); off += 8;
  buf.writeBigInt64LE(ts - 1n, off); off += 8;
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeBigUInt64LE(BigInt(slot), off);
  return buf;
}

async function createOracle(conn: Connection, auth: Keypair, price: number, label: string): Promise<PublicKey> {
  const oracleKp = Keypair.generate();
  const slot = await conn.getSlot();
  const rent = await conn.getMinimumBalanceForRentExemption(133);
  const data = buildPriceUpdateV2(auth.publicKey, price, slot);

  // Create account owned by mock-oracle
  const tx1 = new Transaction().add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey,
    newAccountPubkey: oracleKp.publicKey,
    lamports: rent,
    space: 133,
    programId: MOCK_ORACLE,
  }));
  await sendAndConfirmTransaction(conn, tx1, [auth, oracleKp]);

  // Write data
  const writeDisc = disc("write_raw");
  const writeArgs = Buffer.alloc(4 + 4 + data.length);
  writeArgs.writeUInt32LE(0, 0);
  writeArgs.writeUInt32LE(data.length, 4);
  data.copy(writeArgs, 8);
  const tx2 = new Transaction().add({
    programId: MOCK_ORACLE,
    keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },
      { pubkey: oracleKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([writeDisc, writeArgs]),
  });
  await sendAndConfirmTransaction(conn, tx2, [auth]);
  console.log(`  Oracle ${label}: ${oracleKp.publicKey.toBase58()} ($${price})`);
  return oracleKp.publicKey;
}

async function createReserve(
  conn: Connection, auth: Keypair, mint: PublicKey, tokenProgram: PublicKey
): Promise<PublicKey> {
  const reserveKp = Keypair.generate();
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);

  // Need seed deposit — create a test token if we don't have one
  let seedAta: PublicKey;
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    // Token-2022 (ceUSX)
    const ata = await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey, false, undefined, undefined, tokenProgram);
    seedAta = ata.address;
  } else {
    // Regular Token (Solstice USDC etc.)
    const ata = await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey);
    seedAta = ata.address;
    // Check balance
    const info = await conn.getAccountInfo(seedAta);
    if (info) {
      const bal = info.data.readBigUInt64LE(64);
      if (bal < 100000n) {
        console.log(`  Warning: Low balance for ${mint.toBase58().slice(0, 8)}... (${bal}). Need seed deposit.`);
      }
    }
  }

  const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), reserveKp.publicKey.toBuffer()], KLEND);
  const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), reserveKp.publicKey.toBuffer()], KLEND);
  const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), reserveKp.publicKey.toBuffer()], KLEND);
  const [feeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), reserveKp.publicKey.toBuffer()], KLEND);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
  tx.add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey,
    newAccountPubkey: reserveKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(8624),
    space: 8624,
    programId: KLEND,
  }));
  tx.add({
    programId: KLEND,
    data: Buffer.from(disc("init_reserve")),
    keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: feeRecv, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collSupply, isSigner: false, isWritable: true },
      { pubkey: seedAta, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  await sendAndConfirmTransaction(conn, tx, [auth, reserveKp]);
  return reserveKp.publicKey;
}

async function configureReserve(
  conn: Connection, auth: Keypair, reserve: PublicKey, oracle: PublicKey, name: string
) {
  const cfgDisc = disc("update_reserve_config");

  async function update(mode: number, value: Buffer, skip: boolean = false) {
    const ixData = Buffer.alloc(1 + 4 + value.length + 1);
    ixData.writeUInt8(mode, 0);
    ixData.writeUInt32LE(value.length, 1);
    value.copy(ixData, 5);
    ixData.writeUInt8(skip ? 1 : 0, 5 + value.length);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
    tx.add({ programId: KLEND, data: Buffer.concat([Buffer.from(cfgDisc), ixData]), keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: false },
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
    ]});
    await sendAndConfirmTransaction(conn, tx, [auth]);
  }

  const nameBuf = Buffer.alloc(32); Buffer.from(name).copy(nameBuf);
  const maxAge = Buffer.alloc(8); maxAge.writeBigUInt64LE(BigInt("18446744073709551615"), 0);
  const bigLimit = Buffer.alloc(8); bigLimit.writeBigUInt64LE(BigInt("1000000000000000"), 0);

  // Configure in order that passes validation
  await update(16, nameBuf, true);           console.log(`    Name: ${name}`);
  await update(17, maxAge, true);            console.log(`    PriceMaxAge: u64::MAX`);
  await update(18, maxAge, true);            console.log(`    TwapMaxAge: u64::MAX`);
  await update(20, oracle.toBuffer(), true); console.log(`    Oracle: ${oracle.toBase58().slice(0, 12)}...`);
  await update(0, Buffer.from([75]));        console.log(`    LTV: 75%`);
  await update(2, Buffer.from([85]));        console.log(`    LiqThreshold: 85%`);

  // Borrow factor
  const bf = Buffer.alloc(8); bf.writeBigUInt64LE(BigInt(100), 0);
  await update(32, bf);                      console.log(`    BorrowFactor: 100%`);

  // Borrow rate curve
  const curve = Buffer.alloc(88);
  curve.writeUInt32LE(0, 0); curve.writeUInt32LE(0, 4);
  curve.writeUInt32LE(8000, 8); curve.writeUInt32LE(500, 12);
  for (let i = 2; i < 11; i++) { curve.writeUInt32LE(10000, i * 8); curve.writeUInt32LE(5000, i * 8 + 4); }
  await update(23, curve);                   console.log(`    BorrowRateCurve: 0-5-50%`);

  // Limits (skip=false to pass full validation)
  await update(8, bigLimit, false);          console.log(`    DepositLimit: 1T`);
  await update(9, bigLimit, false);          console.log(`    BorrowLimit: 1T`);

  // Borrow limit outside elevation group
  const maxLimit = Buffer.alloc(8); maxLimit.writeBigUInt64LE(BigInt("18446744073709551615"), 0);
  await update(44, maxLimit, false);         console.log(`    BorrowLimitOutsideEG: u64::MAX`);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    eUSX Collateral Market Setup               ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Authority: ${auth.publicKey.toBase58()}`);
  console.log(`  Balance:   ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);
  console.log(`  Market:    ${MARKET.toBase58()}`);
  console.log("");

  // Step 1: Create oracles
  console.log("=== Step 1: Create Oracles ===");
  const deusxOracle = await createOracle(conn, auth, 1.08, "ceUSX");
  const solUsdcOracle = await createOracle(conn, auth, 1.00, "Solstice USDC");

  // Step 2: Create ceUSX reserve (Token-2022)
  console.log("\n=== Step 2: Create ceUSX Reserve (Collateral) ===");
  let deusxReserve: PublicKey;
  try {
    deusxReserve = await createReserve(conn, auth, DEUSX, TOKEN_2022_PROGRAM_ID);
    console.log(`  Reserve: ${deusxReserve.toBase58()}`);
  } catch (e: any) {
    console.log(`  Failed: ${e.message?.slice(0, 100)}`);
    console.log(`  (ceUSX reserve may need a seed deposit of ceUSX tokens first)`);
    return;
  }

  // Step 3: Create Solstice USDC reserve (regular Token)
  console.log("\n=== Step 3: Create Solstice USDC Reserve (Borrow) ===");
  let solUsdcReserve: PublicKey;
  try {
    solUsdcReserve = await createReserve(conn, auth, SOLSTICE_USDC, TOKEN_PROGRAM_ID);
    console.log(`  Reserve: ${solUsdcReserve.toBase58()}`);
  } catch (e: any) {
    console.log(`  Failed: ${e.message?.slice(0, 100)}`);
    console.log(`  (Need Solstice USDC in wallet for seed deposit)`);
    return;
  }

  // Step 4: Configure reserves
  console.log("\n=== Step 4: Configure ceUSX Reserve ===");
  await configureReserve(conn, auth, deusxReserve, deusxOracle, "ceUSX");

  console.log("\n=== Step 5: Configure Solstice USDC Reserve ===");
  await configureReserve(conn, auth, solUsdcReserve, solUsdcOracle, "sUSDC");

  // Step 6: Test RefreshReserve
  console.log("\n=== Step 6: Verify RefreshReserve ===");
  for (const [name, reserve, oracle] of [["ceUSX", deusxReserve, deusxOracle], ["sUSDC", solUsdcReserve, solUsdcOracle]] as const) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    tx.add({ programId: KLEND, data: disc("refresh_reserve"), keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
    ]});
    const sim = await conn.simulateTransaction(tx, [auth]);
    console.log(`  ${name}: ${sim.value.err ? "FAIL" : "OK"}`);
  }

  // Save config
  const config = {
    market: MARKET.toBase58(),
    collateral: {
      name: "ceUSX",
      reserve: deusxReserve.toBase58(),
      mint: DEUSX.toBase58(),
      underlying: EUSX.toBase58(),
      oracle: deusxOracle.toBase58(),
      price: 1.08,
      tokenProgram: "Token-2022",
    },
    borrow: {
      name: "Solstice USDC",
      reserve: solUsdcReserve.toBase58(),
      mint: SOLSTICE_USDC.toBase58(),
      oracle: solUsdcOracle.toBase58(),
      price: 1.00,
      tokenProgram: "Token",
    },
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs/devnet/eusx-market.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║    eUSX Market Ready                          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Collateral: ceUSX ${deusxReserve.toBase58().slice(0, 12)}... ($1.08)`);
  console.log(`  Borrow:     sUSDC ${solUsdcReserve.toBase58().slice(0, 12)}... ($1.00)`);
  console.log(`  Config:     ${outPath}`);
}

main().catch(console.error);
