/**
 * bootstrap-cssol-market-v2.ts — Fresh klend market with all five reserves
 * (csSOL, wSOL, csSOL-WT, ceUSX, sUSDC) and both elevation groups
 * (1 = stables, 2 = LST/SOL) configured correctly from scratch.
 *
 * Why a v2 market?
 *   The original market `2gRy7f…heyejW` is locked: registering elevation
 *   group 1 left every reserve un-updateable (deployed klend ignores
 *   `skipConfigIntegrityValidation` and runs reserve_config_check
 *   unconditionally — see setup-stables-emode.ts header for the full
 *   blocker writeup). The lock is permanent; we can't unregister a
 *   group on klend, so the only clean path is a brand-new market with
 *   all bonus fields populated *before* any group is registered.
 *
 * Order of operations (mirrors setup-cssol-market.ts but covers 5
 * reserves and 2 groups):
 *
 *   1. createAccount + init_lending_market         (fresh market)
 *   2. createAccount + init_reserve × 5            (csSOL, wSOL, csSOL-WT,
 *                                                   ceUSX, sUSDC)
 *   3. Mock-oracle PriceUpdateV2 accounts for ceUSX ($1.08), sUSDC ($1)
 *   4. update_reserve_config phase-1 × 5
 *      (name, oracle, ltv, liq_threshold, MIN/MAX/BAD-DEBT bonuses,
 *      borrow_factor, borrow_rate_curve)            ← bonus fields here
 *   5. update_lending_market(UpdateElevationGroup) for groups 2 then 1
 *   6. update_reserve_config phase-2 × 5
 *      (elevation_groups, disable_usage_outside_emode,
 *      borrow_limit_outside_emode, deposit_limit, borrow_limit)
 *   7. governor.register_lending_market           (point governor at v2)
 *   8. Save configs/devnet/cssol-market-v2.json + print env updates
 *
 * Environment:
 *   - DEPLOY_KEYPAIR (default ~/.config/solana/id.json) — must be the
 *     pool authority (csSOL-VRT issuer) AND have ≥ ~0.3 SOL for rent.
 *   - Reuses existing csSOL/csSOL-WT oracle addresses (accrual oracle
 *     output) and wSOL oracle. New mock oracles only for the stables.
 *
 * Usage: npx tsx scripts/bootstrap-cssol-market-v2.ts
 *
 * After it succeeds, set in packages/frontend-playground/.env:
 *   VITE_KLEND_MARKET=<new market pubkey>
 *   VITE_CSSOL_RESERVE=<…>
 *   VITE_WSOL_RESERVE=<…>
 *   VITE_CSSOL_WT_RESERVE=<…>
 *   (ceUSX/sUSDC reserves are discovered automatically.)
 */

import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  TransactionInstruction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { buildUpdateElevationGroupIx } from "./lib/klend-elevation-group.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");

// Mints (from configs/devnet/cssol-pool.json + cssol-wt.json)
const CSSOL_MINT    = new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt");
const CSSOL_WT_MINT = new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva");
const DEUSX_MINT  = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");
const SUSDC_MINT  = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");

// Reuse existing oracles for csSOL/csSOL-WT/wSOL — the accrual oracle
// output and the Pyth-receiver wSOL feed are stable PriceUpdateV2
// accounts that any market can read.
const CSSOL_ORACLE   = new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P");
const WSOL_ORACLE    = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const CSSOL_WT_ORACLE = CSSOL_ORACLE; // shares the csSOL feed in v1

// klend account sizes
const LENDING_MARKET_SIZE = 4664;
const RESERVE_SIZE = 8624;
const PRICE_UPDATE_V2_SIZE = 133;
const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");

// Discriminators
const disc = (name: string) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const D = {
  initLendingMarket: disc("init_lending_market"),
  initReserve: disc("init_reserve"),
  updateReserveConfig: disc("update_reserve_config"),
  seedDepositOnInitReserve: disc("seed_deposit_on_init_reserve"),
};

const CFG = {
  UpdateLoanToValuePct: 0,
  UpdateMaxLiquidationBonusBps: 1,
  UpdateLiquidationThresholdPct: 2,
  UpdateDepositLimit: 8,
  UpdateBorrowLimit: 9,
  UpdateTokenInfoName: 16,
  UpdateTokenInfoPriceMaxAge: 17,
  UpdateTokenInfoTwapMaxAge: 18,
  UpdatePythPrice: 20,
  UpdateBorrowRateCurve: 23,
  UpdateBadDebtLiquidationBonusBps: 29,
  UpdateMinLiquidationBonusBps: 30,
  UpdateBorrowFactor: 32,
  UpdateElevationGroups: 34,
  UpdateDisableUsageAsCollateralOutsideEmode: 41,
  UpdateBorrowLimitOutsideElevationGroup: 44,
  UpdateBorrowLimitsInElevationGroupAgainstThisReserve: 45,
  UpdateFeesFlashLoanFee: 6,
  UpdateFeesOriginationFee: 5,
} as const;

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

const lmaPda = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("lma"), m.toBuffer()], KLEND)[0];
const rPda   = (s: string, r: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(s), r.toBuffer()], KLEND)[0];

function u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u64(n: bigint | string | number) { const b = Buffer.alloc(8); b.writeBigUInt64LE(typeof n === "bigint" ? n : BigInt(n)); return b; }

function buildInitMarketIx(owner: PublicKey, market: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: lmaPda(market), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([D.initLendingMarket, Buffer.alloc(32)]), // quoteCurrency = zeroes
  });
}

function buildInitReserveIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  mint: PublicKey, seedAta: PublicKey, tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    data: D.initReserve,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: lmaPda(market), isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: rPda("reserve_liq_supply", reserve), isSigner: false, isWritable: true },
      { pubkey: rPda("fee_receiver", reserve), isSigner: false, isWritable: true },
      { pubkey: rPda("reserve_coll_mint", reserve), isSigner: false, isWritable: true },
      { pubkey: rPda("reserve_coll_supply", reserve), isSigner: false, isWritable: true },
      { pubkey: seedAta, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

function buildUpdateCfgIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  mode: number, value: Buffer, skip = true,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let o = 0;
  D.updateReserveConfig.copy(data, o); o += 8;
  data.writeUInt8(mode, o); o += 1;
  data.writeUInt32LE(value.length, o); o += 4;
  value.copy(data, o); o += value.length;
  data.writeUInt8(skip ? 1 : 0, o);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function buildPriceUpdateV2(authority: PublicKey, price: number, slot: number): Buffer {
  const b = Buffer.alloc(PRICE_UPDATE_V2_SIZE);
  let o = 0;
  PRICE_UPDATE_V2_DISC.copy(b, o); o += 8;
  authority.toBuffer().copy(b, o); o += 32;
  b.writeUInt8(1, o); o += 1; o += 32;
  b.writeBigInt64LE(BigInt(Math.round(price * 1e8)), o); o += 8;
  b.writeBigUInt64LE(10000n, o); o += 8;
  b.writeInt32LE(-8, o); o += 4;
  const ts = BigInt(Math.floor(Date.now() / 1000));
  b.writeBigInt64LE(ts, o); o += 8;
  b.writeBigInt64LE(ts - 1n, o); o += 8;
  b.writeBigInt64LE(BigInt(Math.round(price * 1e8)), o); o += 8;
  b.writeBigUInt64LE(10000n, o); o += 8;
  b.writeBigUInt64LE(BigInt(slot), o);
  return b;
}

async function createMockOracle(conn: Connection, auth: Keypair, price: number, label: string): Promise<PublicKey> {
  const kp = Keypair.generate();
  const slot = await conn.getSlot();
  const data = buildPriceUpdateV2(auth.publicKey, price, slot);
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({
    fromPubkey: auth.publicKey, newAccountPubkey: kp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(PRICE_UPDATE_V2_SIZE),
    space: PRICE_UPDATE_V2_SIZE, programId: MOCK_ORACLE,
  })), [auth, kp]);
  const writeArgs = Buffer.alloc(4 + 4 + data.length);
  writeArgs.writeUInt32LE(0, 0); writeArgs.writeUInt32LE(data.length, 4); data.copy(writeArgs, 8);
  await sendAndConfirmTransaction(conn, new Transaction().add({
    programId: MOCK_ORACLE,
    keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },
      { pubkey: kp.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("write_raw"), writeArgs]),
  }), [auth]);
  console.log(`  oracle ${label} → ${kp.publicKey.toBase58()} ($${price})`);
  return kp.publicKey;
}

interface ReserveSpec {
  name: string;          // <=32 chars
  reserveKp: Keypair;
  mint: PublicKey;
  oracle: PublicKey;
  tokenProgram: PublicKey;
  seedAta: PublicKey;
  ltvPct: number;
  liqThresholdPct: number;
  minLiqBonusBps: number;
  maxLiqBonusBps: number;
  badDebtLiqBonusBps: number;
  borrowFactorPct: bigint;
  // [lo, hi] points in bps for the borrow-rate curve. Auto-padded to 11 points.
  curvePts: { utilizationRateBps: number; borrowRateBps: number }[];
  elevationGroups: number[]; // length 20
  disableUsageOutsideEmode: 0 | 1;
  borrowLimitOutsideEmode: bigint;
  depositLimit: bigint;
  borrowLimit: bigint;
  /** Per-elevation-group borrow caps for when this reserve is used
   *  as collateral. Indexed by `groupId - 1` (group ids are 1-based;
   *  klend SDK reads `borrowLimitAgainstThisCollateralInElevationGroup[item - 1]`).
   *  Leaving the slot at 0 produces `ElevationGroupBorrowLimitExceeded`
   *  (6101) on every borrow. */
  borrowLimitAgainstThisCollInEg: { groupId: number; limit: bigint }[];
}

function curveBuf(pts: { utilizationRateBps: number; borrowRateBps: number }[]): Buffer {
  const padded = [...pts];
  while (padded.length < 11) padded.push(padded[padded.length - 1]);
  const buf = Buffer.alloc(88);
  padded.slice(0, 11).forEach((p, i) => {
    buf.writeUInt32LE(p.utilizationRateBps, i * 8);
    buf.writeUInt32LE(p.borrowRateBps, i * 8 + 4);
  });
  return buf;
}

function elevationGroupsBuf(g: number[]): Buffer {
  if (g.length !== 20) throw new Error(`elevationGroups must have 20 entries, got ${g.length}`);
  return Buffer.from(g.map((x) => x & 0xff));
}

async function applyPhase1(conn: Connection, auth: Keypair, market: PublicKey, s: ReserveSpec) {
  const nameBuf = Buffer.alloc(32); Buffer.from(s.name).copy(nameBuf);
  const maxAge = u64(BigInt("18446744073709551615"));
  // Mode order: bonuses BEFORE LTV/LiqThreshold so the
  // liq_threshold ∈ [ltv, 100] check has room to grow.
  const ixs: { mode: number; value: Buffer }[] = [
    { mode: CFG.UpdateTokenInfoName,             value: nameBuf },
    { mode: CFG.UpdateTokenInfoPriceMaxAge,      value: maxAge },
    { mode: CFG.UpdateTokenInfoTwapMaxAge,       value: maxAge },
    { mode: CFG.UpdatePythPrice,                 value: s.oracle.toBuffer() },
    { mode: CFG.UpdateMaxLiquidationBonusBps,    value: u16(s.maxLiqBonusBps) },
    { mode: CFG.UpdateMinLiquidationBonusBps,    value: u16(s.minLiqBonusBps) },
    { mode: CFG.UpdateBadDebtLiquidationBonusBps,value: u16(s.badDebtLiqBonusBps) },
    { mode: CFG.UpdateBorrowFactor,              value: u64(s.borrowFactorPct) },
    { mode: CFG.UpdateLiquidationThresholdPct,   value: Buffer.from([s.liqThresholdPct]) },
    { mode: CFG.UpdateLoanToValuePct,            value: Buffer.from([s.ltvPct]) },
    { mode: CFG.UpdateBorrowRateCurve,           value: curveBuf(s.curvePts) },
    // Flash-loan + origination fees zeroed for the credit-trade flow.
    // The credit-trade open ix relies on a wSOL flash loan (borrow +
    // wrap → csSOL → deposit → borrow → repay) — a non-zero flash
    // fee would force us to either borrow `loan + fee` (slightly
    // more leverage than the user requested) or deduct from
    // collateral. Zeroing both keeps the math 1:1. We control the
    // market so this is just protocol-level config.
    { mode: CFG.UpdateFeesFlashLoanFee,          value: u64(0n) },
    { mode: CFG.UpdateFeesOriginationFee,        value: u64(0n) },
  ];
  for (const { mode, value } of ixs) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateCfgIx(auth.publicKey, market, s.reserveKp.publicKey, mode, value, true)),
      [auth]);
  }
  console.log(`  phase-1 ${s.name}: bonuses + ltv/liq + curve set`);
}

/** Pack the 32×u64 per-elevation-group borrow-limit array. The
 *  array is indexed by `groupId - 1` (klend SDK uses `[item - 1]`,
 *  see market.ts line 357). */
function packBorrowLimitsAgainstColl(slots: { groupId: number; limit: bigint }[]): Buffer {
  const buf = Buffer.alloc(32 * 8);
  for (const { groupId, limit } of slots) {
    if (groupId < 1 || groupId > 32) throw new Error(`group id must be 1..32, got ${groupId}`);
    buf.writeBigUInt64LE(limit, (groupId - 1) * 8);
  }
  return buf;
}

async function applyPhase2(conn: Connection, auth: Keypair, market: PublicKey, s: ReserveSpec) {
  const ixs: { mode: number; value: Buffer; skip: boolean }[] = [
    { mode: CFG.UpdateElevationGroups, value: elevationGroupsBuf(s.elevationGroups), skip: true },
    { mode: CFG.UpdateDisableUsageAsCollateralOutsideEmode, value: Buffer.from([s.disableUsageOutsideEmode]), skip: true },
    { mode: CFG.UpdateBorrowLimitOutsideElevationGroup, value: u64(s.borrowLimitOutsideEmode), skip: true },
    { mode: CFG.UpdateDepositLimit, value: u64(s.depositLimit), skip: false },
    // borrow_limit must be set BEFORE the per-EG slot — klend's
    // reserve_config_check enforces `slot[i] ≤ borrow_limit`.
    { mode: CFG.UpdateBorrowLimit,  value: u64(s.borrowLimit),  skip: false },
    // Per-collateral borrow caps in each elevation group. Empty
    // array → all-zero blob is fine (this reserve isn't used as
    // collateral in any group). When set, it caps how much debt can
    // be secured by this reserve when borrowed against in group N.
    // Run mode 45 with skip=false — mode 45's validator with skip=true
    // appears to incorrectly fail (klend bug?). With skip=false the
    // mode-specific check actually passes for valid `slot[i] ≤ borrow_limit`.
    { mode: CFG.UpdateBorrowLimitsInElevationGroupAgainstThisReserve,
      value: packBorrowLimitsAgainstColl(s.borrowLimitAgainstThisCollInEg),
      skip: false },
  ];
  for (const { mode, value, skip } of ixs) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateCfgIx(auth.publicKey, market, s.reserveKp.publicKey, mode, value, skip)),
      [auth]);
  }
  console.log(`  phase-2 ${s.name}: groups + limits set`);
}

async function ensureSeedAta(conn: Connection, auth: Keypair, mint: PublicKey, tokenProgram: PublicKey, label: string): Promise<PublicKey> {
  const ata = await getOrCreateAssociatedTokenAccount(conn, auth, mint, auth.publicKey, false, "confirmed", undefined, tokenProgram);
  console.log(`  ${label} ATA: ${ata.address.toBase58()}`);
  if (ata.amount === 0n) {
    throw new Error(`${label} ATA has zero balance — init_reserve will reject the seed deposit. Mint at least 1 lamport-unit before running.`);
  }
  return ata.address;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  csSOL Market v2 Bootstrap                   ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Authority:  ${auth.publicKey.toBase58()}`);
  console.log(`  Balance:    ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);

  // Idempotency: resume from checkpoint if a run failed mid-way.
  // Override `MARKET_VERSION` to bootstrap a fresh market (v3, v4, …)
  // rather than reuse the v2 keypairs.
  const version = process.env.MARKET_VERSION ?? "v2";
  const checkpointPath = path.join(__dirname, "..", `configs/devnet/cssol-market-${version}.checkpoint.json`);
  let cp: Record<string, string> = {};
  if (fs.existsSync(checkpointPath)) {
    cp = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    console.log(`  Resuming checkpoint: ${Object.keys(cp).length} keys`);
  }
  const persist = () => fs.writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
  const stepKey = (k: string, gen: () => Keypair): Keypair => {
    if (cp[k]) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cp[k])));
    const kp = gen();
    cp[k] = JSON.stringify(Array.from(kp.secretKey));
    persist();
    return kp;
  };

  // ── Loan-asset selector (v4+ uses the cSOL KYC wrapper instead of
  //    raw wSOL — gates the borrow leg of the credit trade). ────────
  const useCsol = parseInt(version.replace(/^v/, ""), 10) >= 4;
  const csolPoolPath = path.join(__dirname, "..", "configs/devnet/csol-pool.json");
  let CSOL_MINT: PublicKey | null = null;
  if (useCsol) {
    if (!fs.existsSync(csolPoolPath)) {
      throw new Error(`csol-pool.json missing — run scripts/deploy-csol-pool-devnet.ts first`);
    }
    const csolPool = JSON.parse(fs.readFileSync(csolPoolPath, "utf8"));
    CSOL_MINT = new PublicKey(csolPool.csolMint);
    console.log(`  Loan asset: cSOL ${CSOL_MINT.toBase58()} (KYC-wrapped wSOL)`);
  } else {
    console.log(`  Loan asset: wSOL ${NATIVE_MINT.toBase58()} (un-gated)`);
  }

  // --- Step 1: market ---
  const marketKp = stepKey("market", () => Keypair.generate());
  console.log(`\nStep 1: lending market → ${marketKp.publicKey.toBase58()}`);
  if (!(await conn.getAccountInfo(marketKp.publicKey))) {
    await sendAndConfirmTransaction(conn, new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(SystemProgram.createAccount({
        fromPubkey: auth.publicKey, newAccountPubkey: marketKp.publicKey,
        lamports: await conn.getMinimumBalanceForRentExemption(LENDING_MARKET_SIZE),
        space: LENDING_MARKET_SIZE, programId: KLEND,
      }))
      .add(buildInitMarketIx(auth.publicKey, marketKp.publicKey)),
      [auth, marketKp]);
    console.log("  market created");
  } else {
    console.log("  market already exists");
  }

  // --- Step 2: oracles for stables (csSOL/wSOL/csSOL-WT reuse existing) ---
  console.log("\nStep 2: oracles");
  const deusxOracle = cp.deusxOracle
    ? new PublicKey(cp.deusxOracle)
    : await createMockOracle(conn, auth, 1.08, "ceUSX");
  if (!cp.deusxOracle) { cp.deusxOracle = deusxOracle.toBase58(); persist(); }
  const susdcOracle = cp.susdcOracle
    ? new PublicKey(cp.susdcOracle)
    : await createMockOracle(conn, auth, 1.00, "sUSDC");
  if (!cp.susdcOracle) { cp.susdcOracle = susdcOracle.toBase58(); persist(); }

  // --- Step 3: seed ATAs ---
  console.log("\nStep 3: seed ATAs");
  const cssolAta   = await ensureSeedAta(conn, auth, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, "csSOL");
  const cssolWtAta = await ensureSeedAta(conn, auth, CSSOL_WT_MINT, TOKEN_2022_PROGRAM_ID, "csSOL-WT");
  const deusxAta   = await ensureSeedAta(conn, auth, DEUSX_MINT, TOKEN_2022_PROGRAM_ID, "ceUSX");
  const susdcAta   = await ensureSeedAta(conn, auth, SUSDC_MINT, TOKEN_PROGRAM_ID, "sUSDC");
  // Loan-asset seed ATA: wSOL (v3) or cSOL (v4+).
  let loanAssetMint: PublicKey;
  let loanAssetTp: PublicKey;
  let loanAssetAta: PublicKey;
  let loanAssetSymbol: string;
  if (useCsol && CSOL_MINT) {
    loanAssetMint = CSOL_MINT;
    loanAssetTp = TOKEN_2022_PROGRAM_ID;
    loanAssetAta = await ensureSeedAta(conn, auth, CSOL_MINT, TOKEN_2022_PROGRAM_ID, "cSOL ");
    loanAssetSymbol = "cSOL";
  } else {
    loanAssetMint = NATIVE_MINT;
    loanAssetTp = TOKEN_PROGRAM_ID;
    loanAssetAta = (await getOrCreateAssociatedTokenAccount(conn, auth, NATIVE_MINT, auth.publicKey, false, "confirmed")).address;
    const wsolBalBig = BigInt((await conn.getTokenAccountBalance(loanAssetAta).catch(() => null))?.value.amount ?? "0");
    if (wsolBalBig < 1_000_000n) {
      await sendAndConfirmTransaction(conn, new Transaction()
        .add(SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: loanAssetAta, lamports: 1_000_000 }))
        .add(createSyncNativeInstruction(loanAssetAta)), [auth]);
    }
    loanAssetSymbol = "wSOL";
  }
  console.log(`  ${loanAssetSymbol} ATA: ${loanAssetAta.toBase58()}`);

  // --- Step 4: init 5 reserves ---
  console.log("\nStep 4: init reserves");
  const reserveRent = await conn.getMinimumBalanceForRentExemption(RESERVE_SIZE);
  async function initReserve(label: string, ckptKey: string, mint: PublicKey, seedAta: PublicKey, tp: PublicKey): Promise<Keypair> {
    const kp = stepKey(ckptKey, () => Keypair.generate());
    const liqSupply = rPda("reserve_liq_supply", kp.publicKey);
    const seedDepositIx = new TransactionInstruction({
      programId: KLEND,
      data: D.seedDepositOnInitReserve,
      keys: [
        { pubkey: auth.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: kp.publicKey, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: liqSupply, isSigner: false, isWritable: true },
        { pubkey: seedAta, isSigner: false, isWritable: true },
        { pubkey: tp, isSigner: false, isWritable: false },
      ],
    });
    const existed = await conn.getAccountInfo(kp.publicKey);
    if (!existed) {
      // init_reserve + seed_deposit_on_init_reserve in one tx so the
      // reserve never spends a slot in `usage_blocked = true` state.
      await sendAndConfirmTransaction(conn, new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }))
        .add(SystemProgram.createAccount({
          fromPubkey: auth.publicKey, newAccountPubkey: kp.publicKey,
          lamports: reserveRent, space: RESERVE_SIZE, programId: KLEND,
        }))
        .add(buildInitReserveIx(auth.publicKey, marketKp.publicKey, kp.publicKey, mint, seedAta, tp))
        .add(seedDepositIx),
        [auth, kp]);
      console.log(`  ${label}: ${kp.publicKey.toBase58()}  (init + seed)`);
    } else {
      // Existing reserve from a partial run — try seed_deposit alone
      // (idempotent: returns 6130 if already done).
      try {
        await sendAndConfirmTransaction(conn, new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(seedDepositIx), [auth]);
        console.log(`  ${label}: ${kp.publicKey.toBase58()}  (resumed, seed ✓)`);
      } catch (e: any) {
        const logs = JSON.stringify(e?.transactionLogs ?? "");
        if (logs.includes("InitialAdminDepositExecuted") || logs.includes("6130")) {
          console.log(`  ${label}: ${kp.publicKey.toBase58()}  (resumed, seed already done)`);
        } else {
          throw e;
        }
      }
    }
    return kp;
  }
  const csSolKp    = await initReserve("csSOL   ", "csSolReserve", CSSOL_MINT, cssolAta, TOKEN_2022_PROGRAM_ID);
  const loanKp     = await initReserve(`${loanAssetSymbol.padEnd(7)}`, "loanReserve", loanAssetMint, loanAssetAta, loanAssetTp);
  const csSolWtKp  = await initReserve("csSOL-WT", "csSolWtReserve", CSSOL_WT_MINT, cssolWtAta, TOKEN_2022_PROGRAM_ID);
  const deusxKp    = await initReserve("ceUSX   ", "deusxReserve", DEUSX_MINT, deusxAta, TOKEN_2022_PROGRAM_ID);
  const susdcKp    = await initReserve("sUSDC   ", "susdcReserve", SUSDC_MINT, susdcAta, TOKEN_PROGRAM_ID);

  // --- Step 5: phase-1 reserve config (everything except elevation groups
  // and limits — bonus fields go in here BEFORE we register any group). ---
  console.log("\nStep 5: phase-1 reserve config");

  // Long-tail SOL bonus profile, matching csSOL-WT's existing config.
  const SOL_BONUSES = { min: 200, max: 500, bad: 99 };
  const STABLE_BONUSES = { min: 100, max: 200, bad: 50 };

  // Borrow rate curves: sane defaults — interest curve at 0–5–50% for utility,
  // flat 0% for collateral-only reserves like csSOL/csSOL-WT.
  const FLAT_CURVE = [{ utilizationRateBps: 0, borrowRateBps: 0 }, { utilizationRateBps: 10000, borrowRateBps: 0 }];
  const NORMAL_CURVE = [
    { utilizationRateBps: 0, borrowRateBps: 0 },
    { utilizationRateBps: 8000, borrowRateBps: 500 },
    { utilizationRateBps: 10000, borrowRateBps: 5000 },
  ];

  // Per-collateral elevation-group borrow caps. csSOL & csSOL-WT
  // secure wSOL debt under group 2; ceUSX secures sUSDC debt under
  // group 1. wSOL/sUSDC are the debt sides — they don't appear here.
  const COLL_EG_LIMIT = BigInt("100000000000000"); // 100T base units
  const specs: ReserveSpec[] = [
    {
      name: "csSOL", reserveKp: csSolKp, mint: CSSOL_MINT, oracle: CSSOL_ORACLE, tokenProgram: TOKEN_2022_PROGRAM_ID, seedAta: cssolAta,
      ltvPct: 55, liqThresholdPct: 65, minLiqBonusBps: SOL_BONUSES.min, maxLiqBonusBps: SOL_BONUSES.max, badDebtLiqBonusBps: SOL_BONUSES.bad,
      borrowFactorPct: 100n, curvePts: FLAT_CURVE,
      elevationGroups: [2, ...Array(19).fill(0)], disableUsageOutsideEmode: 1,
      borrowLimitOutsideEmode: 0n, depositLimit: 100_000_000_000_000n,
      // borrow_limit must be ≥ borrowLimitAgainstThisCollInEg[i] —
      // klend's reserve_config_check rejects the per-EG slot
      // otherwise. `disable_usage_outside_emode = 1` still keeps
      // direct borrows blocked; this cap is purely the in-eMode
      // collateral-secured-debt ceiling.
      borrowLimit: COLL_EG_LIMIT,
      borrowLimitAgainstThisCollInEg: [{ groupId: 2, limit: COLL_EG_LIMIT }],
    },
    {
      name: loanAssetSymbol, reserveKp: loanKp, mint: loanAssetMint, oracle: WSOL_ORACLE, tokenProgram: loanAssetTp, seedAta: loanAssetAta,
      ltvPct: 0, liqThresholdPct: 0, minLiqBonusBps: SOL_BONUSES.min, maxLiqBonusBps: SOL_BONUSES.max, badDebtLiqBonusBps: SOL_BONUSES.bad,
      borrowFactorPct: 100n, curvePts: NORMAL_CURVE,
      elevationGroups: [2, ...Array(19).fill(0)], disableUsageOutsideEmode: 0,
      borrowLimitOutsideEmode: BigInt("18446744073709551615"), depositLimit: 100_000_000_000_000n, borrowLimit: 100_000_000_000_000n,
      borrowLimitAgainstThisCollInEg: [], // loan asset is the debt reserve, never the collateral
    },
    {
      name: "csSOL-WT", reserveKp: csSolWtKp, mint: CSSOL_WT_MINT, oracle: CSSOL_WT_ORACLE, tokenProgram: TOKEN_2022_PROGRAM_ID, seedAta: cssolWtAta,
      ltvPct: 55, liqThresholdPct: 65, minLiqBonusBps: SOL_BONUSES.min, maxLiqBonusBps: SOL_BONUSES.max, badDebtLiqBonusBps: SOL_BONUSES.bad,
      borrowFactorPct: 100n, curvePts: FLAT_CURVE,
      elevationGroups: [2, ...Array(19).fill(0)], disableUsageOutsideEmode: 1,
      borrowLimitOutsideEmode: 0n, depositLimit: 100_000_000_000_000n, borrowLimit: COLL_EG_LIMIT,
      borrowLimitAgainstThisCollInEg: [{ groupId: 2, limit: COLL_EG_LIMIT }],
    },
    {
      name: "ceUSX", reserveKp: deusxKp, mint: DEUSX_MINT, oracle: deusxOracle, tokenProgram: TOKEN_2022_PROGRAM_ID, seedAta: deusxAta,
      ltvPct: 75, liqThresholdPct: 85, minLiqBonusBps: STABLE_BONUSES.min, maxLiqBonusBps: STABLE_BONUSES.max, badDebtLiqBonusBps: STABLE_BONUSES.bad,
      borrowFactorPct: 100n, curvePts: FLAT_CURVE,
      elevationGroups: [1, ...Array(19).fill(0)], disableUsageOutsideEmode: 1,
      borrowLimitOutsideEmode: 0n, depositLimit: 100_000_000_000_000n, borrowLimit: COLL_EG_LIMIT,
      borrowLimitAgainstThisCollInEg: [{ groupId: 1, limit: COLL_EG_LIMIT }],
    },
    {
      name: "sUSDC", reserveKp: susdcKp, mint: SUSDC_MINT, oracle: susdcOracle, tokenProgram: TOKEN_PROGRAM_ID, seedAta: susdcAta,
      ltvPct: 0, liqThresholdPct: 0, minLiqBonusBps: STABLE_BONUSES.min, maxLiqBonusBps: STABLE_BONUSES.max, badDebtLiqBonusBps: STABLE_BONUSES.bad,
      borrowFactorPct: 100n, curvePts: NORMAL_CURVE,
      elevationGroups: [1, ...Array(19).fill(0)], disableUsageOutsideEmode: 0,
      borrowLimitOutsideEmode: BigInt("18446744073709551615"), depositLimit: 100_000_000_000_000n, borrowLimit: 100_000_000_000_000n,
      borrowLimitAgainstThisCollInEg: [], // sUSDC is the debt reserve, never the collateral
    },
  ];

  for (const s of specs) await applyPhase1(conn, auth, marketKp.publicKey, s);

  // --- Step 6: register elevation groups BEFORE phase-2 — phase-2
  // sets `elevation_groups[i] = group_id` on each reserve, and klend's
  // mode-34 validator rejects unregistered group ids (6069). ---
  console.log("\nStep 6: register elevation groups");
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(buildUpdateElevationGroupIx(auth.publicKey, marketKp.publicKey, {
      id: 2, ltvPct: 90, liquidationThresholdPct: 92,
      maxLiquidationBonusBps: 200, allowNewLoans: 1,
      maxReservesAsCollateral: 2, debtReserve: loanKp.publicKey,
    })), [auth]);
  console.log("  group 2 (LST/SOL): registered");

  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(buildUpdateElevationGroupIx(auth.publicKey, marketKp.publicKey, {
      id: 1, ltvPct: 90, liquidationThresholdPct: 92,
      maxLiquidationBonusBps: 100, allowNewLoans: 1,
      maxReservesAsCollateral: 1, debtReserve: susdcKp.publicKey,
    })), [auth]);
  console.log("  group 1 (Stables): registered");

  // --- Step 7: phase-2 reserve config (groups must already be
  // registered for `UpdateElevationGroups` (mode 34) to pass). ---
  console.log("\nStep 7: phase-2 reserve config");
  for (const s of specs) await applyPhase2(conn, auth, marketKp.publicKey, s);

  // --- Step 8: persist final config ---
  const out = {
    cluster: "devnet",
    market: marketKp.publicKey.toBase58(),
    reserves: {
      csSOL:    csSolKp.publicKey.toBase58(),
      [loanAssetSymbol]: loanKp.publicKey.toBase58(),
      csSOL_WT: csSolWtKp.publicKey.toBase58(),
      ceUSX:    deusxKp.publicKey.toBase58(),
      sUSDC:    susdcKp.publicKey.toBase58(),
    },
    oracles: {
      csSOL: CSSOL_ORACLE.toBase58(),
      [loanAssetSymbol]: WSOL_ORACLE.toBase58(),
      csSOL_WT: CSSOL_WT_ORACLE.toBase58(),
      ceUSX: deusxOracle.toBase58(),
      sUSDC: susdcOracle.toBase58(),
    },
    loanAsset: { symbol: loanAssetSymbol, mint: loanAssetMint.toBase58() },
    elevationGroups: {
      "1": { name: "Stables", ltv: 90, liqThreshold: 92, debtReserve: susdcKp.publicKey.toBase58(), collateral: ["ceUSX"] },
      "2": { name: "LST/SOL", ltv: 90, liqThreshold: 92, debtReserve: loanKp.publicKey.toBase58(), collateral: ["csSOL", "csSOL-WT"] },
    },
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", `configs/devnet/cssol-market-${version}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║  Bootstrap complete                          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  market:        ${marketKp.publicKey.toBase58()}`);
  console.log(`  reserves:      csSOL/${csSolKp.publicKey.toBase58().slice(0,8)} wSOL/${loanKp.publicKey.toBase58().slice(0,8)} csSOL-WT/${csSolWtKp.publicKey.toBase58().slice(0,8)} ceUSX/${deusxKp.publicKey.toBase58().slice(0,8)} sUSDC/${susdcKp.publicKey.toBase58().slice(0,8)}`);
  console.log(`  config:        ${outPath}`);
  console.log("\n  Next: update packages/frontend-playground/.env (or addresses.ts):");
  console.log(`    VITE_KLEND_MARKET=${marketKp.publicKey.toBase58()}`);
  console.log(`    VITE_CSSOL_RESERVE=${csSolKp.publicKey.toBase58()}`);
  console.log(`    VITE_WSOL_RESERVE=${loanKp.publicKey.toBase58()}`);
  console.log(`    VITE_CSSOL_WT_RESERVE=${csSolWtKp.publicKey.toBase58()}`);
  console.log(`    VITE_WSOL_RESERVE_ORACLE=${WSOL_ORACLE.toBase58()}`);
  console.log(`    VITE_CSSOL_RESERVE_ORACLE=${CSSOL_ORACLE.toBase58()}`);
  console.log(`  Then update LendingPositionTab.tsx KNOWN_MINTS oracle for ceUSX → ${deusxOracle.toBase58()}, sUSDC → ${susdcOracle.toBase58()}`);
  console.log(`  And register the new market with the governor: scripts/register-cssol-market.ts (re-run with new VITE addresses)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
