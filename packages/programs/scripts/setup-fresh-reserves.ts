/**
 * setup-fresh-reserves.ts — Create fresh klend reserves with configurable rate curves
 *
 * Creates new reserves on the existing lending market, replacing the old locked ones.
 * Configures oracles, LTV, limits, and borrow rate curves from scratch.
 *
 * Usage: npx tsx scripts/setup-fresh-reserves.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
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
const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");

function disc(name: string) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

// ── Oracle ──

function buildPriceUpdateV2(authority: PublicKey, price: number, slot: number): Buffer {
  const buf = Buffer.alloc(133);
  let off = 0;
  PRICE_UPDATE_V2_DISC.copy(buf, off); off += 8;
  authority.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(1, off); off += 1;
  off += 32; // feed_id
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(10000n, off); off += 8;
  buf.writeInt32LE(-8, off); off += 4;
  const ts = BigInt(Math.floor(Date.now() / 1000));
  buf.writeBigInt64LE(ts, off); off += 8;
  buf.writeBigInt64LE(ts - 1n, off); off += 8;
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(10000n, off); off += 8;
  buf.writeBigUInt64LE(BigInt(slot), off);
  return buf;
}

async function createOracle(conn: Connection, auth: Keypair, price: number, label: string): Promise<PublicKey> {
  const oracleKp = Keypair.generate();
  const slot = await conn.getSlot();
  const rent = await conn.getMinimumBalanceForRentExemption(133);
  const data = buildPriceUpdateV2(auth.publicKey, price, slot);

  const tx1 = new Transaction().add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey, newAccountPubkey: oracleKp.publicKey,
    lamports: rent, space: 133, programId: MOCK_ORACLE,
  }));
  await sendAndConfirmTransaction(conn, tx1, [auth, oracleKp]);

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

// ── Reserve ──

async function createReserve(
  conn: Connection, auth: Keypair, mint: PublicKey, tokenProgram: PublicKey
): Promise<PublicKey> {
  const reserveKp = Keypair.generate();
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);

  const seedAta = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? (await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey, false, undefined, undefined, tokenProgram)).address
    : (await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey)).address;

  const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), reserveKp.publicKey.toBuffer()], KLEND);
  const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), reserveKp.publicKey.toBuffer()], KLEND);
  const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), reserveKp.publicKey.toBuffer()], KLEND);
  const [feeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), reserveKp.publicKey.toBuffer()], KLEND);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
  tx.add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey, newAccountPubkey: reserveKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(8624),
    space: 8624, programId: KLEND,
  }));
  tx.add({
    programId: KLEND, data: Buffer.from(disc("init_reserve")),
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

// ── Config ──

async function configureReserve(
  conn: Connection, auth: Keypair, reserve: PublicKey, opts: {
    name: string; oracle: PublicKey;
    ltvPct: number; liqThresholdPct: number;
    borrowCurve: [number, number][]; // [utilBps, rateBps][]
    depositLimit: bigint; borrowLimit: bigint;
    isCollateralOnly?: boolean;
  }
) {
  const cfgDisc = disc("update_reserve_config");

  async function update(mode: number, value: Buffer, skip = true) {
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

  const nameBuf = Buffer.alloc(32); Buffer.from(opts.name).copy(nameBuf);
  const maxAge = Buffer.alloc(8); maxAge.writeBigUInt64LE(BigInt("18446744073709551615"));
  const bf = Buffer.alloc(8); bf.writeBigUInt64LE(100n);

  // Phase 1: skip=true (building up config)
  await update(16, nameBuf);            console.log(`    Name: ${opts.name}`);
  await update(17, maxAge);             console.log(`    PriceMaxAge: u64::MAX`);
  await update(18, maxAge);             console.log(`    TwapMaxAge: u64::MAX`);
  await update(20, opts.oracle.toBuffer()); console.log(`    Oracle: ${opts.oracle.toBase58().slice(0, 12)}...`);
  await update(0, Buffer.from([opts.ltvPct]));          console.log(`    LTV: ${opts.ltvPct}%`);
  await update(2, Buffer.from([opts.liqThresholdPct])); console.log(`    LiqThreshold: ${opts.liqThresholdPct}%`);
  await update(32, bf);                 console.log(`    BorrowFactor: 100%`);

  // Borrow rate curve
  const curve = Buffer.alloc(88);
  if (opts.borrowCurve.length === 11) {
    opts.borrowCurve.forEach(([util, rate], i) => {
      curve.writeUInt32LE(util, i * 8);
      curve.writeUInt32LE(rate, i * 8 + 4);
    });
  } else {
    // Pad: use first N points then fill remaining with last point
    const pts = opts.borrowCurve;
    for (let i = 0; i < 11; i++) {
      const p = i < pts.length ? pts[i] : pts[pts.length - 1];
      curve.writeUInt32LE(p[0], i * 8);
      curve.writeUInt32LE(p[1], i * 8 + 4);
    }
  }
  await update(23, curve);              console.log(`    BorrowRateCurve: ${opts.borrowCurve.length} points`);

  // Phase 2: limits (skip=false for final validation)
  const depBuf = Buffer.alloc(8); depBuf.writeBigUInt64LE(opts.depositLimit);
  const borBuf = Buffer.alloc(8); borBuf.writeBigUInt64LE(opts.borrowLimit);
  await update(8, depBuf, false);       console.log(`    DepositLimit: ${opts.depositLimit}`);
  await update(9, borBuf, false);       console.log(`    BorrowLimit: ${opts.borrowLimit}`);

  // Borrow limit outside elevation group
  const maxLimit = Buffer.alloc(8); maxLimit.writeBigUInt64LE(BigInt("18446744073709551615"));
  await update(44, maxLimit, false);    console.log(`    BorrowLimitOutsideEG: u64::MAX`);
}

// ── Main ──

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    Fresh Reserve Setup                        ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Authority: ${auth.publicKey.toBase58()}`);
  console.log(`  Balance:   ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);
  console.log(`  Market:    ${MARKET.toBase58()}`);
  console.log();

  // ── dtUSDY collateral reserve ──
  const DTUSDY = new PublicKey("6SV8ecHhfgWYHTiec2uDMPXHUXqqT2puNjR73gj6AvYu");
  const SUSDC = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");

  console.log("=== Step 1: Create Oracles ===");
  const dtUsdyOracle = await createOracle(conn, auth, 1.08, "dtUSDY");
  const susdcOracle = await createOracle(conn, auth, 1.00, "sUSDC");

  console.log("\n=== Step 2: Create dtUSDY Reserve (Collateral) ===");
  const dtUsdyReserve = await createReserve(conn, auth, DTUSDY, TOKEN_2022_PROGRAM_ID);
  console.log(`  Reserve: ${dtUsdyReserve.toBase58()}`);

  console.log("\n=== Step 3: Create sUSDC Reserve (Borrow) ===");
  const susdcReserve = await createReserve(conn, auth, SUSDC, TOKEN_PROGRAM_ID);
  console.log(`  Reserve: ${susdcReserve.toBase58()}`);

  console.log("\n=== Step 4: Configure dtUSDY Reserve ===");
  await configureReserve(conn, auth, dtUsdyReserve, {
    name: "dtUSDY",
    oracle: dtUsdyOracle,
    ltvPct: 75,
    liqThresholdPct: 85,
    borrowCurve: [
      [0, 0], [8000, 500], [10000, 5000],
      [10000, 5000], [10000, 5000], [10000, 5000], [10000, 5000],
      [10000, 5000], [10000, 5000], [10000, 5000], [10000, 5000],
    ],
    depositLimit: 1_000_000_000_000_000n,
    borrowLimit: 0n, // collateral only
    isCollateralOnly: true,
  });

  console.log("\n=== Step 5: Configure sUSDC Reserve ===");
  await configureReserve(conn, auth, susdcReserve, {
    name: "sUSDC",
    oracle: susdcOracle,
    ltvPct: 0,
    liqThresholdPct: 0,
    borrowCurve: [
      [0, 0], [8000, 500], [10000, 5000],
      [10000, 5000], [10000, 5000], [10000, 5000], [10000, 5000],
      [10000, 5000], [10000, 5000], [10000, 5000], [10000, 5000],
    ],
    depositLimit: 1_000_000_000_000_000n,
    borrowLimit: 1_000_000_000_000_000n,
  });

  // Verify
  console.log("\n=== Step 6: Verify RefreshReserve ===");
  for (const [name, reserve, oracle] of [
    ["dtUSDY", dtUsdyReserve, dtUsdyOracle],
    ["sUSDC", susdcReserve, susdcOracle],
  ] as const) {
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
    console.log(`  ${name}: ${sim.value.err ? "FAIL " + JSON.stringify(sim.value.err) : "OK"}`);
  }

  // Save config
  const config = {
    market: MARKET.toBase58(),
    dtUsdyReserve: { address: dtUsdyReserve.toBase58(), mint: DTUSDY.toBase58(), oracle: dtUsdyOracle.toBase58(), role: "collateral", ltvPct: 75 },
    susdcReserve: { address: susdcReserve.toBase58(), mint: SUSDC.toBase58(), oracle: susdcOracle.toBase58(), role: "borrow" },
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs/devnet/fresh-reserves.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║    Done! Update devnet.ts configs with:       ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  dtUSDY reserve: ${dtUsdyReserve.toBase58()}`);
  console.log(`  dtUSDY oracle:  ${dtUsdyOracle.toBase58()}`);
  console.log(`  sUSDC reserve:  ${susdcReserve.toBase58()}`);
  console.log(`  sUSDC oracle:   ${susdcOracle.toBase58()}`);
  console.log(`  Config saved:   ${outPath}`);
}

main().catch(console.error);
