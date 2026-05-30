/**
 * replace-reserve-irm.ts — Replace a reserve's interest rate model
 *
 * Since klend blocks post-init curve updates, this creates a brand new reserve
 * with the desired borrow rate curve, replacing the old one.
 *
 * Usage:
 *   npx tsx scripts/replace-reserve-irm.ts --reserve sUSDC --curve stable
 *   npx tsx scripts/replace-reserve-irm.ts --reserve dtUSDY --curve '[[0,0],[8000,300],[10000,2000]]'
 *
 * Presets: stable, moderate, steep
 * Custom: JSON array of [utilBps, rateBps] pairs (padded to 11 with last value)
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
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");
const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");

// Reserve definitions
const RESERVES: Record<string, {
  name: string; mint: PublicKey; tokenProgram: PublicKey; price: number;
  ltvPct: number; liqThresholdPct: number;
  depositLimit: bigint; borrowLimit: bigint;
}> = {
  dtUSDY: {
    name: "dtUSDY", mint: new PublicKey("6SV8ecHhfgWYHTiec2uDMPXHUXqqT2puNjR73gj6AvYu"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.08,
    ltvPct: 75, liqThresholdPct: 85,
    depositLimit: 1_000_000_000_000_000n, borrowLimit: 0n,
  },
  sUSDC: {
    name: "sUSDC", mint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    tokenProgram: TOKEN_PROGRAM_ID, price: 1.00,
    ltvPct: 0, liqThresholdPct: 0,
    depositLimit: 1_000_000_000_000_000n, borrowLimit: 1_000_000_000_000_000n,
  },
  ceUSX: {
    name: "ceUSX", mint: new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.08,
    ltvPct: 75, liqThresholdPct: 85,
    depositLimit: 1_000_000_000_000_000n, borrowLimit: 0n,
  },
};

const CURVE_PRESETS: Record<string, [number, number][]> = {
  stable: [[0,0],[1000,50],[2000,100],[4000,200],[5000,300],[6000,400],[7000,500],[8000,700],[8500,1000],[9000,1500],[10000,2000]],
  moderate: [[0,0],[1000,100],[2000,200],[4000,400],[6000,600],[7000,800],[7500,1200],[8000,1800],[8500,2800],[9000,3800],[10000,5000]],
  steep: [[0,0],[1000,200],[2000,400],[4000,600],[6000,1000],[7000,1500],[7500,2000],[8000,3000],[8500,3800],[9000,4500],[10000,5000]],
};

function disc(name: string) { return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8); }
function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function padCurve(pts: [number, number][]): [number, number][] {
  if (pts.length >= 11) return pts.slice(0, 11);
  const last = pts[pts.length - 1];
  return [...pts, ...Array(11 - pts.length).fill(last)];
}

async function createOracle(conn: Connection, auth: Keypair, price: number): Promise<PublicKey> {
  const kp = Keypair.generate();
  const slot = await conn.getSlot();
  const buf = Buffer.alloc(133);
  let off = 0;
  PRICE_UPDATE_V2_DISC.copy(buf, off); off += 8;
  auth.publicKey.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(1, off); off += 1; off += 32;
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(10000n, off); off += 8;
  buf.writeInt32LE(-8, off); off += 4;
  const ts = BigInt(Math.floor(Date.now() / 1000));
  buf.writeBigInt64LE(ts, off); off += 8;
  buf.writeBigInt64LE(ts - 1n, off); off += 8;
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(10000n, off); off += 8;
  buf.writeBigUInt64LE(BigInt(slot), off);

  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey, newAccountPubkey: kp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(133), space: 133, programId: MOCK_ORACLE,
  })), [auth, kp]);

  const wd = disc("write_raw");
  const args = Buffer.alloc(4 + 4 + buf.length);
  args.writeUInt32LE(0, 0); args.writeUInt32LE(buf.length, 4); buf.copy(args, 8);
  await sendAndConfirmTransaction(conn, new Transaction().add({
    programId: MOCK_ORACLE, data: Buffer.concat([wd, args]),
    keys: [{ pubkey: auth.publicKey, isSigner: true, isWritable: true }, { pubkey: kp.publicKey, isSigner: false, isWritable: true }],
  }), [auth]);
  return kp.publicKey;
}

async function main() {
  const args = process.argv.slice(2);
  const reserveIdx = args.indexOf("--reserve");
  const curveIdx = args.indexOf("--curve");

  if (reserveIdx === -1) {
    console.log("Usage: npx tsx scripts/replace-reserve-irm.ts --reserve <sUSDC|dtUSDY|ceUSX> --curve <stable|moderate|steep|JSON>");
    console.log("\nPresets:");
    for (const [k, pts] of Object.entries(CURVE_PRESETS)) {
      console.log(`  ${k}: ${pts.map(([u,r]) => `${u/100}%→${r/100}%`).join(", ")}`);
    }
    process.exit(0);
  }

  const reserveName = args[reserveIdx + 1];
  const curveArg = curveIdx !== -1 ? args[curveIdx + 1] : "moderate";
  const reserveDef = RESERVES[reserveName];
  if (!reserveDef) { console.error(`Unknown reserve: ${reserveName}. Options: ${Object.keys(RESERVES).join(", ")}`); process.exit(1); }

  let curvePoints: [number, number][];
  if (CURVE_PRESETS[curveArg]) {
    curvePoints = CURVE_PRESETS[curveArg];
    console.log(`Using preset: ${curveArg}`);
  } else {
    curvePoints = padCurve(JSON.parse(curveArg));
    console.log(`Using custom curve (${curvePoints.length} points)`);
  }

  console.log("\nCurve:");
  curvePoints.forEach(([u, r], i) => console.log(`  ${i + 1}. ${(u/100).toFixed(0)}% util → ${(r/100).toFixed(1)}% rate`));

  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();
  console.log(`\nAuthority: ${auth.publicKey.toBase58()}`);
  console.log(`Balance: ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);

  // Create oracle
  console.log(`\nCreating oracle ($${reserveDef.price})...`);
  const oracle = await createOracle(conn, auth, reserveDef.price);
  console.log(`  Oracle: ${oracle.toBase58()}`);

  // Create reserve
  console.log(`Creating ${reserveDef.name} reserve...`);
  const reserveKp = Keypair.generate();
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
  const seedAta = (await getOrCreateAssociatedTokenAccount(
    conn, auth, reserveDef.mint, auth.publicKey, false, undefined, undefined,
    reserveDef.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : undefined
  )).address;

  const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed), reserveKp.publicKey.toBuffer()], KLEND)[0];
  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
  tx1.add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey, newAccountPubkey: reserveKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(8624), space: 8624, programId: KLEND,
  }));
  tx1.add({ programId: KLEND, data: Buffer.from(disc("init_reserve")), keys: [
    { pubkey: auth.publicKey, isSigner: true, isWritable: true },
    { pubkey: MARKET, isSigner: false, isWritable: false },
    { pubkey: lma, isSigner: false, isWritable: false },
    { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
    { pubkey: reserveDef.mint, isSigner: false, isWritable: false },
    { pubkey: pda("reserve_liq_supply"), isSigner: false, isWritable: true },
    { pubkey: pda("fee_receiver"), isSigner: false, isWritable: true },
    { pubkey: pda("reserve_coll_mint"), isSigner: false, isWritable: true },
    { pubkey: pda("reserve_coll_supply"), isSigner: false, isWritable: true },
    { pubkey: seedAta, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: reserveDef.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]});
  await sendAndConfirmTransaction(conn, tx1, [auth, reserveKp]);
  console.log(`  Reserve: ${reserveKp.publicKey.toBase58()}`);

  // Configure
  const cfgDisc = disc("update_reserve_config");
  async function cfg(mode: number, value: Buffer, skip = true) {
    const d = Buffer.alloc(1 + 4 + value.length + 1);
    d.writeUInt8(mode, 0); d.writeUInt32LE(value.length, 1); value.copy(d, 5);
    d.writeUInt8(skip ? 1 : 0, 5 + value.length);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }));
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }));
    tx.add({ programId: KLEND, data: Buffer.concat([Buffer.from(cfgDisc), d]), keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: false },
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
    ]});
    await sendAndConfirmTransaction(conn, tx, [auth]);
  }

  const nameBuf = Buffer.alloc(32); Buffer.from(reserveDef.name).copy(nameBuf);
  const maxAge = Buffer.alloc(8); maxAge.writeBigUInt64LE(BigInt("18446744073709551615"));
  const bf = Buffer.alloc(8); bf.writeBigUInt64LE(100n);

  console.log("Configuring...");
  await cfg(16, nameBuf);                                          process.stdout.write("  name");
  await cfg(17, maxAge);                                           process.stdout.write(" priceAge");
  await cfg(18, maxAge);                                           process.stdout.write(" twapAge");
  await cfg(20, oracle.toBuffer());                                process.stdout.write(" oracle");
  await cfg(0, Buffer.from([reserveDef.ltvPct]));                  process.stdout.write(" ltv");
  await cfg(2, Buffer.from([reserveDef.liqThresholdPct]));         process.stdout.write(" liqThresh");
  await cfg(32, bf);                                               process.stdout.write(" borrowFactor");

  const curve = Buffer.alloc(88);
  curvePoints.forEach(([u, r], i) => { curve.writeUInt32LE(u, i * 8); curve.writeUInt32LE(r, i * 8 + 4); });
  await cfg(23, curve);                                            process.stdout.write(" curve");

  const depBuf = Buffer.alloc(8); depBuf.writeBigUInt64LE(reserveDef.depositLimit);
  const borBuf = Buffer.alloc(8); borBuf.writeBigUInt64LE(reserveDef.borrowLimit);
  await cfg(8, depBuf, false);                                     process.stdout.write(" depLimit");
  await cfg(9, borBuf, false);                                     process.stdout.write(" borLimit");
  const maxLimit = Buffer.alloc(8); maxLimit.writeBigUInt64LE(BigInt("18446744073709551615"));
  await cfg(44, maxLimit, false);                                  process.stdout.write(" borLimitEG");
  console.log(" ✓");

  // Verify
  const refreshTx = new Transaction();
  refreshTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  refreshTx.add({ programId: KLEND, data: disc("refresh_reserve"), keys: [
    { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
    { pubkey: MARKET, isSigner: false, isWritable: false },
    { pubkey: oracle, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false },
  ]});
  const sim = await conn.simulateTransaction(refreshTx, [auth]);
  console.log(`RefreshReserve: ${sim.value.err ? "FAIL" : "OK"}`);

  console.log(`\n✅ New ${reserveDef.name} reserve: ${reserveKp.publicKey.toBase58()}`);
  console.log(`   Oracle: ${oracle.toBase58()}`);
  console.log(`\nUpdate devnet.ts configs with these addresses.`);
}

main().catch(console.error);
