/**
 * migrate-usx-into-cssol-market.ts — Add ceUSX + Solstice USDC reserves to
 * the csSOL klend market (cross-margin migration).
 *
 * Today we run two separate klend markets on devnet:
 *   - csSOL/wSOL LST market (`2gRy7f…heyejW`) — wSOL, csSOL, csSOL-WT
 *   - eUSX collateral market (`45FNL648…2tc98`)  — ceUSX, Solstice USDC
 *
 * Two markets means an institution that wants both LST exposure and USX
 * collateral has to maintain two obligations and can't cross-margin
 * between them. This script adds the ceUSX and Solstice USDC reserves
 * directly into the csSOL market so a single obligation covers all four
 * collateral types and both debt assets.
 *
 * Steps (mirrors setup-eusx-market.ts but targets MARKET=csSOL):
 *   1. Create mock-oracle PriceUpdateV2 accounts for ceUSX ($1.08) and
 *      sUSDC ($1.00). We reuse the mock-oracle program so the price
 *      stays static — accrual-oracle isn't needed for stable assets.
 *   2. Run `init_reserve` on the csSOL market for ceUSX (Token-2022).
 *   3. Run `init_reserve` on the csSOL market for Solstice USDC.
 *   4. Configure each reserve via `update_reserve_config` (name, oracle,
 *      LTV 75 / liq 85 / borrow factor 100 / limits).
 *   5. Save the merged config to configs/devnet/cssol-market-merged.json.
 *
 * The eUSX-only market is left in place so existing positions can wind
 * down naturally. After all positions migrate over, that market can be
 * decommissioned (empty obligations + zero deposits ⇒ no on-chain action
 * needed beyond wallet UX).
 *
 * Usage: npx tsx scripts/migrate-usx-into-cssol-market.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
// Target market: csSOL/wSOL LST market (used by the playground).
const MARKET = new PublicKey("2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW");
const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");

// Mints we're importing from the eUSX market.
const SOLSTICE_USDC = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const DEUSX = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");
const EUSX = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");

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

  const tx1 = new Transaction().add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey,
    newAccountPubkey: oracleKp.publicKey,
    lamports: rent,
    space: 133,
    programId: MOCK_ORACLE,
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

async function createReserve(
  conn: Connection, auth: Keypair, mint: PublicKey, tokenProgram: PublicKey,
): Promise<PublicKey> {
  const reserveKp = Keypair.generate();
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);

  // klend's `init_reserve` takes a seed deposit ATA from the authority
  // — needs to exist + be owned by `auth` even though no balance is
  // transferred at init time (klend just reads the mint relationship).
  const seedAta = (await getOrCreateAssociatedTokenAccount(
    conn, auth, mint, auth.publicKey, false, undefined, undefined, tokenProgram,
  )).address;

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
  conn: Connection, auth: Keypair, reserve: PublicKey, oracle: PublicKey, name: string,
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

  await update(16, nameBuf, true);           console.log(`    Name: ${name}`);
  await update(17, maxAge, true);            console.log(`    PriceMaxAge: u64::MAX`);
  await update(18, maxAge, true);            console.log(`    TwapMaxAge: u64::MAX`);
  await update(20, oracle.toBuffer(), true); console.log(`    Oracle: ${oracle.toBase58().slice(0, 12)}...`);
  // Strict-validation order — klend runs full reserve_config_check on
  // every non-skip update. Defaults are zero, so the fields validated
  // by `reserve_config_check` must be brought to legal values in
  // dependency order:
  //   borrow_factor ≥ 100 (mode 32)            → set first
  //   liq_threshold ∈ [ltv, 100] (mode 2)       → still satisfied at ltv=0
  //   ltv ≤ liq_threshold (mode 0)              → set last
  // Otherwise the first non-skip call fails with InvalidConfig (6004).
  const bf = Buffer.alloc(8); bf.writeBigUInt64LE(BigInt(100), 0);
  await update(32, bf);                      console.log(`    BorrowFactor: 100%`);
  await update(2, Buffer.from([85]));        console.log(`    LiqThreshold: 85%`);
  await update(0, Buffer.from([75]));        console.log(`    LTV: 75%`);

  const curve = Buffer.alloc(88);
  curve.writeUInt32LE(0, 0); curve.writeUInt32LE(0, 4);
  curve.writeUInt32LE(8000, 8); curve.writeUInt32LE(500, 12);
  for (let i = 2; i < 11; i++) { curve.writeUInt32LE(10000, i * 8); curve.writeUInt32LE(5000, i * 8 + 4); }
  await update(23, curve);                   console.log(`    BorrowRateCurve: 0-5-50%`);

  await update(8, bigLimit, false);          console.log(`    DepositLimit: 1T`);
  await update(9, bigLimit, false);          console.log(`    BorrowLimit: 1T`);

  const maxLimit = Buffer.alloc(8); maxLimit.writeBigUInt64LE(BigInt("18446744073709551615"), 0);
  await update(44, maxLimit, false);         console.log(`    BorrowLimitOutsideEG: u64::MAX`);
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  USX → csSOL Market Migration                 ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Authority: ${auth.publicKey.toBase58()}`);
  console.log(`  Balance:   ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);
  console.log(`  Market:    ${MARKET.toBase58()} (csSOL market)`);
  console.log("");

  // ── Idempotency: if a checkpoint file exists, skip create steps and
  // reuse the on-chain accounts. Lets us re-run after a config-step
  // failure without burning rent on fresh reserves.
  const checkpointPath = path.join(__dirname, "..", "configs/devnet/cssol-market-merged.checkpoint.json");
  let checkpoint: { deusxOracle?: string; solUsdcOracle?: string; deusxReserve?: string; solUsdcReserve?: string } = {};
  if (fs.existsSync(checkpointPath)) {
    checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    console.log(`  Resuming from checkpoint: ${checkpointPath}`);
    console.log(`    ${JSON.stringify(checkpoint, null, 2).split("\n").join("\n    ")}`);
  }
  function persist() { fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2)); }

  // Step 1: Create oracles (skip if already in checkpoint)
  console.log("\n=== Step 1: Create Oracles ===");
  const deusxOracle = checkpoint.deusxOracle
    ? new PublicKey(checkpoint.deusxOracle)
    : await createOracle(conn, auth, 1.08, "ceUSX");
  if (!checkpoint.deusxOracle) { checkpoint.deusxOracle = deusxOracle.toBase58(); persist(); }
  else console.log(`  Reusing ceUSX oracle: ${deusxOracle.toBase58()}`);

  const solUsdcOracle = checkpoint.solUsdcOracle
    ? new PublicKey(checkpoint.solUsdcOracle)
    : await createOracle(conn, auth, 1.00, "Solstice USDC");
  if (!checkpoint.solUsdcOracle) { checkpoint.solUsdcOracle = solUsdcOracle.toBase58(); persist(); }
  else console.log(`  Reusing sUSDC oracle: ${solUsdcOracle.toBase58()}`);

  // Step 2: ceUSX reserve (Token-2022)
  console.log("\n=== Step 2: Create ceUSX Reserve (Collateral, Token-2022) ===");
  const deusxReserve = checkpoint.deusxReserve
    ? new PublicKey(checkpoint.deusxReserve)
    : await createReserve(conn, auth, DEUSX, TOKEN_2022_PROGRAM_ID);
  if (!checkpoint.deusxReserve) { checkpoint.deusxReserve = deusxReserve.toBase58(); persist(); }
  console.log(`  Reserve: ${deusxReserve.toBase58()}`);

  // Step 3: Solstice USDC reserve (regular Token)
  console.log("\n=== Step 3: Create Solstice USDC Reserve (Borrow) ===");
  const solUsdcReserve = checkpoint.solUsdcReserve
    ? new PublicKey(checkpoint.solUsdcReserve)
    : await createReserve(conn, auth, SOLSTICE_USDC, TOKEN_PROGRAM_ID);
  if (!checkpoint.solUsdcReserve) { checkpoint.solUsdcReserve = solUsdcReserve.toBase58(); persist(); }
  console.log(`  Reserve: ${solUsdcReserve.toBase58()}`);

  // Step 4: Configure both
  console.log("\n=== Step 4: Configure ceUSX Reserve ===");
  await configureReserve(conn, auth, deusxReserve, deusxOracle, "ceUSX");

  console.log("\n=== Step 5: Configure Solstice USDC Reserve ===");
  await configureReserve(conn, auth, solUsdcReserve, solUsdcOracle, "sUSDC");

  // Step 6: Verify RefreshReserve simulates
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
    console.log(`  ${name}: ${sim.value.err ? "FAIL " + JSON.stringify(sim.value.err) : "OK"}`);
  }

  const config = {
    market: MARKET.toBase58(),
    addedReserves: {
      ceUSX: {
        name: "ceUSX",
        reserve: deusxReserve.toBase58(),
        mint: DEUSX.toBase58(),
        underlying: EUSX.toBase58(),
        oracle: deusxOracle.toBase58(),
        price: 1.08,
        tokenProgram: "Token-2022",
        role: "collateral",
      },
      sUSDC: {
        name: "Solstice USDC",
        reserve: solUsdcReserve.toBase58(),
        mint: SOLSTICE_USDC.toBase58(),
        oracle: solUsdcOracle.toBase58(),
        price: 1.00,
        tokenProgram: "Token",
        role: "borrow",
      },
    },
    migratedAt: new Date().toISOString(),
    note: "Migration of eUSX market reserves into csSOL market for cross-margin. The standalone eUSX market (45FNL648…2tc98) is left in place during a deprecation window.",
  };
  const outPath = path.join(__dirname, "..", "configs/devnet/cssol-market-merged.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Migration complete                           ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  ceUSX reserve:  ${deusxReserve.toBase58()}`);
  console.log(`  sUSDC reserve:  ${solUsdcReserve.toBase58()}`);
  console.log(`  Config:         ${outPath}`);
  console.log("");
  console.log("Next: rerun the playground — discoverMarketReserves will pick up the");
  console.log("new reserves automatically. Add ceUSX/sUSDC entries to KNOWN_MINTS in");
  console.log("LendingPositionTab.tsx to attach friendly symbols + token program.");
}

main().catch(console.error);
