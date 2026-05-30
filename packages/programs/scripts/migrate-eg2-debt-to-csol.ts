/**
 * migrate-eg2-debt-to-csol.ts — Phase 2 of the wSOL → cSOL migration.
 *
 * Flips the v3 lending market's EG-2 (LST/SOL) `debtReserve` from the
 * unregulated wSOL reserve to the KYC-gated cSOL reserve. Uses klend's
 * `update_lending_market(mode=UpdateElevationGroup=9, value=ElevationGroup[72])`,
 * which atomically replaces a single elevation group's full struct on
 * the market.
 *
 * Reads the current EG-2 first, preserves every other field (ltv,
 * liqThreshold, allowNewLoans, etc.), and only swaps the debt_reserve
 * pubkey. Always simulates first; `--send` to broadcast.
 *
 * Pre-conditions verified by Phase 1:
 *   - cSOL reserve `7dRBLGfk…YTg` has deposit_limit > 0, borrow_limit > 0.
 *   - cSOL reserve's `elevationGroups[]` contains 2 (registered via
 *     update-reserve-config.ts set-elevation-groups 2,3,4).
 *
 * Post-condition:
 *   - EG-2 binds (csSOL + csSOL-WT) collateral to cSOL debt.
 *   - Existing EG-2 obligations (none today after the wSOL drain) would
 *     be left in an inconsistent state — verify via list-wsol-depositors
 *     that no EG-2 obligations are open before running this.
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const CSOL_RESERVE = new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg");
const WSOL_RESERVE = new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8");

// klend UpdateLendingMarketMode enum order (from IDL):
//   0=UpdateOwner / 1=UpdateEmergencyMode / 2=UpdateLiquidationCloseFactor
//   3=UpdateLiquidationMaxValue / 4=DeprecatedUpdateGlobalUnhealthyBorrow
//   5=UpdateGlobalAllowedBorrow / 6=UpdateRiskCouncil
//   7=UpdateMinFullLiquidationThreshold / 8=UpdateInsolvencyRiskLtv
//   9=UpdateElevationGroup / 10=UpdateReferralFeeBps / …
const MODE_UPDATE_ELEVATION_GROUP = 9;

// LendingMarket layout (with 8-byte anchor disc):
//   8       disc
// + 8       version u64
// + 8       bumpSeed u64
// + 32      lendingMarketOwner
// + 32      lendingMarketOwnerCached
// + 32      quoteCurrency [u8;32]
// + 2       referralFeeBps u16
// + 1+1+1+1+1+1  emergencyMode/autoDeleverage/borrowDisabled/priceRefresh/liqMaxDebtClose/insolvencyRisk
// + 8       minFullLiquidationValueThreshold u64
// + 8       maxLiquidatableDebtMarketValueAtOnce u64
// + 8       reserved0 [u8;8]
// + 8       globalAllowedBorrowValue u64
// + 32      riskCouncil
// + 8       reserved1 [u8;8]
// = 200 → elevationGroups[32] starts at offset 200, each 72 bytes.
const EG_ARRAY_OFFSET = 200;
const EG_STRUCT_SIZE = 72;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

interface ElevationGroup {
  maxLiquidationBonusBps: number; // u16
  id: number;                     // u8
  ltvPct: number;                 // u8
  liquidationThresholdPct: number; // u8
  allowNewLoans: number;          // u8
  maxReservesAsCollateral: number; // u8
  padding0: number;               // u8
  debtReserve: PublicKey;         // 32
  padding1: bigint[];             // 4 × u64 (32)
}

function decodeEG(buf: Buffer, offset: number): ElevationGroup {
  let o = offset;
  const maxLiquidationBonusBps = buf.readUInt16LE(o); o += 2;
  const id = buf.readUInt8(o); o += 1;
  const ltvPct = buf.readUInt8(o); o += 1;
  const liquidationThresholdPct = buf.readUInt8(o); o += 1;
  const allowNewLoans = buf.readUInt8(o); o += 1;
  const maxReservesAsCollateral = buf.readUInt8(o); o += 1;
  const padding0 = buf.readUInt8(o); o += 1;
  const debtReserve = new PublicKey(buf.subarray(o, o + 32)); o += 32;
  const padding1 = [
    buf.readBigUInt64LE(o),
    buf.readBigUInt64LE(o + 8),
    buf.readBigUInt64LE(o + 16),
    buf.readBigUInt64LE(o + 24),
  ];
  return { maxLiquidationBonusBps, id, ltvPct, liquidationThresholdPct, allowNewLoans, maxReservesAsCollateral, padding0, debtReserve, padding1 };
}

function encodeEG(eg: ElevationGroup): Buffer {
  const buf = Buffer.alloc(EG_STRUCT_SIZE);
  let o = 0;
  buf.writeUInt16LE(eg.maxLiquidationBonusBps, o); o += 2;
  buf.writeUInt8(eg.id, o); o += 1;
  buf.writeUInt8(eg.ltvPct, o); o += 1;
  buf.writeUInt8(eg.liquidationThresholdPct, o); o += 1;
  buf.writeUInt8(eg.allowNewLoans, o); o += 1;
  buf.writeUInt8(eg.maxReservesAsCollateral, o); o += 1;
  buf.writeUInt8(eg.padding0, o); o += 1;
  eg.debtReserve.toBuffer().copy(buf, o); o += 32;
  for (const v of eg.padding1) { buf.writeBigUInt64LE(v, o); o += 8; }
  return buf;
}

function fmtEG(eg: ElevationGroup): string {
  return `id=${eg.id} ltv=${eg.ltvPct}% liqThr=${eg.liquidationThresholdPct}% maxBonus=${eg.maxLiquidationBonusBps}bps `
    + `allowNew=${eg.allowNewLoans} maxColl=${eg.maxReservesAsCollateral} debt=${eg.debtReserve.toBase58().slice(0,8)}…`;
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKeypair();

  console.log("Network:        ", RPC);
  console.log("Authority:      ", auth.publicKey.toBase58());
  console.log("Market:         ", MARKET.toBase58());
  console.log("");

  const mktInfo = await conn.getAccountInfo(MARKET);
  if (!mktInfo) throw new Error("market not found");

  // Find EG with id=2
  let eg2Index = -1;
  let eg2: ElevationGroup | null = null;
  for (let i = 0; i < 32; i++) {
    const off = EG_ARRAY_OFFSET + i * EG_STRUCT_SIZE;
    const eg = decodeEG(mktInfo.data, off);
    if (eg.id === 2) { eg2Index = i; eg2 = eg; break; }
  }
  if (!eg2 || eg2Index < 0) {
    throw new Error("EG-2 not registered on the market — register it first.");
  }

  console.log("Found EG-2 at array index", eg2Index);
  console.log("  current:", fmtEG(eg2));

  if (eg2.debtReserve.equals(CSOL_RESERVE)) {
    console.log("✓ EG-2's debt reserve is already cSOL. Nothing to do.");
    return;
  }
  if (!eg2.debtReserve.equals(WSOL_RESERVE)) {
    console.log("⚠ EG-2's current debt reserve is neither wSOL nor cSOL:");
    console.log("    ", eg2.debtReserve.toBase58());
    console.log("Refusing to overwrite blindly. Re-check market state.");
    process.exit(1);
  }

  // Build the new EG with only debt_reserve flipped.
  const newEg: ElevationGroup = { ...eg2, debtReserve: CSOL_RESERVE };
  console.log("  target: ", fmtEG(newEg));
  console.log("");

  // klend.update_lending_market(mode: u64, value: [u8; 72])
  // Anchor encodes the args as: mode_u64_le || value_72_bytes
  const updateDisc = disc("update_lending_market");
  const data = Buffer.concat([
    updateDisc,
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(MODE_UPDATE_ELEVATION_GROUP)); return b; })(),
    encodeEG(newEg),
  ]);

  const ix = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: auth.publicKey, isSigner: true,  isWritable: false }, // lendingMarketOwner
      { pubkey: MARKET,         isSigner: false, isWritable: true  },
    ],
    data,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = auth.publicKey;

  const sim = await conn.simulateTransaction(tx, [auth]);
  if (sim.value.err) {
    console.error("Simulation REJECTED:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.error("Logs:\n  " + sim.value.logs.join("\n  "));
    process.exit(1);
  }
  console.log("Simulation OK. Logs (last 8):");
  for (const l of (sim.value.logs ?? []).slice(-8)) console.log("  " + l);
  console.log("");

  if (!send) {
    console.log("Dry-run only. Re-run with --send to broadcast.");
    return;
  }

  console.log("Sending...");
  const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
  console.log("Confirmed:", sig);
  console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");

  const after = await conn.getAccountInfo(MARKET);
  if (after) {
    const eg2After = decodeEG(after.data, EG_ARRAY_OFFSET + eg2Index * EG_STRUCT_SIZE);
    console.log("");
    console.log("New on-chain EG-2:", fmtEG(eg2After));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
