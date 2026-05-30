/**
 * setup-cusdc-reserve.ts — registers cUSDC as a klend reserve in the v3
 * lending market and applies its full config (LTV, IRM curve, EG flags,
 * deposit/borrow caps).
 *
 * Adapted directly from setup-csol-reserve.ts. Differences:
 *   * Mint: cUSDC (Token-2022 KYC wrapper around sUSDC, 6 decimals).
 *   * Reserve config: configs/delta_cUSDC_reserve.json — 0/0 LTV (debt-
 *     only outside EG-4 collateral usage), 2.5% IRM floor, 11-point
 *     curve.
 *   * Oracle: USDC Pyth Receiver feed (cUSDC is 1:1 vs sUSDC, no
 *     exchange-rate drift) — pinned in the JSON.
 *   * Reads cUSDC mint + dmMintConfig from configs/devnet/cusdc-pool.json
 *     (written by deploy-cusdc-pool-devnet.ts).
 *
 * Output: configs/devnet/cusdc-deployed.json with
 *   { cusdcReserve, cusdcCollMint, cusdcCollSupply, cusdcLiqSupply, market }
 * which migrate-eg-debt-to-cusdc.ts reads to repoint EG-1 + EG-3 debt.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/setup-cusdc-reserve.ts
 *
 * Authority: must be the lending-market owner (`AhKNm…aJX` on devnet —
 * id.json), since update_reserve_config is gated on it.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const RESERVE_SIZE = 8624;

// cUSDC has 6 decimals (matches sUSDC). 800k raw = 0.8 cUSDC of seed —
// generous so init_reserve always has headroom. The pool deploy mints
// 1.0 cUSDC to the deployer ATA so this is reachable.
const SEED_AMOUNT = 800_000n;

const V3_MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
const DISC = {
  initReserve: disc("init_reserve"),
  updateReserveConfig: disc("update_reserve_config"),
};

const CONFIG_MODE = {
  UpdateLoanToValuePct: 0,
  UpdateMaxLiquidationBonusBps: 1,
  UpdateLiquidationThresholdPct: 2,
  UpdateDepositLimit: 8,
  UpdateBorrowLimit: 9,
  UpdateName: 16,
  UpdatePriceMaxAge: 17,
  UpdateTwapMaxAge: 18,
  UpdatePythPrice: 20,
  UpdateBorrowRateCurve: 23,
  UpdateBadDebtLiquidationBonusBps: 29,
  UpdateMinLiquidationBonusBps: 30,
  UpdateBorrowFactor: 32,
  UpdateElevationGroups: 34,
  UpdateDisableUsageAsCollateralOutsideEmode: 41,
  UpdateBorrowLimitOutsideElevationGroup: 44,
} as const;

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function marketAuthorityPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND_PROGRAM_ID)[0];
}
function reservePda(seed: string, reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), reserve.toBuffer()], KLEND_PROGRAM_ID)[0];
}

function buildInitReserveIx(
  signer: PublicKey, market: PublicKey, reserve: PublicKey, mint: PublicKey,
  initialLiquiditySource: PublicKey, liquidityTokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: marketAuthorityPda(market), isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: reservePda("reserve_liq_supply", reserve), isSigner: false, isWritable: true },
      { pubkey: reservePda("fee_receiver", reserve), isSigner: false, isWritable: true },
      { pubkey: reservePda("reserve_coll_mint", reserve), isSigner: false, isWritable: true },
      { pubkey: reservePda("reserve_coll_supply", reserve), isSigner: false, isWritable: true },
      { pubkey: initialLiquiditySource, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.initReserve,
  });
}

function buildUpdateReserveConfigIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  mode: number, value: Buffer, skipValidation: boolean,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  DISC.updateReserveConfig.copy(data, off); off += 8;
  data.writeUInt8(mode, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, off);
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

interface ReserveConfigJson {
  loanToValuePct: number;
  liquidationThresholdPct: number;
  minLiquidationBonusBps: number;
  maxLiquidationBonusBps: number;
  badDebtLiquidationBonusBps: number;
  depositLimit: string;
  borrowLimit: string;
  borrowRateCurve: { points: { utilizationRateBps: number; borrowRateBps: number }[] };
  tokenInfo: {
    name: string;
    maxAgePriceSeconds: string;
    maxAgeTwapSeconds: string;
    pythConfiguration: { price: string };
  };
  borrowFactorPct: string;
  elevationGroups: number[];
  disableUsageAsCollOutsideEmode: number;
  borrowLimitOutsideElevationGroup: string;
}
function curveBuf(points: { utilizationRateBps: number; borrowRateBps: number }[]): Buffer {
  if (points.length !== 11) throw new Error("borrowRateCurve must have exactly 11 points");
  const buf = Buffer.alloc(88);
  points.forEach((p, i) => {
    buf.writeUInt32LE(p.utilizationRateBps, i * 8);
    buf.writeUInt32LE(p.borrowRateBps, i * 8 + 4);
  });
  return buf;
}
function elevationGroupsBuf(groups: number[]): Buffer {
  if (groups.length !== 20) throw new Error("elevationGroups must have exactly 20 entries");
  return Buffer.from(groups.map((g) => g & 0xff));
}

// Wrap sendAndConfirmTransaction so the script is idempotent across
// partial-failure re-runs: klend rejects update_reserve_config ixes
// where old == new value (handler_update_reserve_config.rs:49 throws
// InvalidConfig 0x1774 / 6004), but those are exactly the ops we want
// to no-op on a re-run. Any *other* InvalidConfig (e.g. failed validator
// rule) still aborts.
async function sendOrSkipNoop(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<void> {
  try {
    await sendAndConfirmTransaction(conn, tx, signers);
  } catch (e: any) {
    const logs: string[] = e?.transactionLogs ?? e?.logs ?? [];
    const isNoop = logs.some((l) =>
      l.includes("handler_update_reserve_config.rs:49") ||
      (l.includes("Prv value:") && logs.find((m) => m.includes("New value:") &&
        m.split("=")[1]?.trim() === l.split("=")[1]?.trim())),
    );
    if (isNoop) {
      console.log(`  [skip] ${label} — value already applied`);
      return;
    }
    throw e;
  }
}

async function applyPhase1(conn: Connection, auth: Keypair, market: PublicKey, reserve: PublicKey, cfg: ReserveConfigJson) {
  const u64 = (s: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(s)); return b; };
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const nameBuf = Buffer.alloc(32);
  Buffer.from(cfg.tokenInfo.name).copy(nameBuf);
  const ixs = [
    { mode: CONFIG_MODE.UpdateName, value: nameBuf },
    { mode: CONFIG_MODE.UpdatePriceMaxAge, value: u64(cfg.tokenInfo.maxAgePriceSeconds) },
    { mode: CONFIG_MODE.UpdateTwapMaxAge, value: u64(cfg.tokenInfo.maxAgeTwapSeconds) },
    { mode: CONFIG_MODE.UpdatePythPrice, value: new PublicKey(cfg.tokenInfo.pythConfiguration.price).toBuffer() },
    { mode: CONFIG_MODE.UpdateLoanToValuePct, value: Buffer.from([cfg.loanToValuePct]) },
    { mode: CONFIG_MODE.UpdateLiquidationThresholdPct, value: Buffer.from([cfg.liquidationThresholdPct]) },
    { mode: CONFIG_MODE.UpdateMinLiquidationBonusBps, value: u16(cfg.minLiquidationBonusBps) },
    { mode: CONFIG_MODE.UpdateMaxLiquidationBonusBps, value: u16(cfg.maxLiquidationBonusBps) },
    { mode: CONFIG_MODE.UpdateBadDebtLiquidationBonusBps, value: u16(cfg.badDebtLiquidationBonusBps) },
    { mode: CONFIG_MODE.UpdateBorrowFactor, value: u64(cfg.borrowFactorPct) },
    { mode: CONFIG_MODE.UpdateBorrowRateCurve, value: curveBuf(cfg.borrowRateCurve.points) },
  ];
  for (const { mode, value } of ixs) {
    await sendOrSkipNoop(conn, new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, mode, value, true)),
      [auth], `phase1 mode=${mode}`);
  }
}

async function applyPhase2(conn: Connection, auth: Keypair, market: PublicKey, reserve: PublicKey, cfg: ReserveConfigJson) {
  const u64 = (s: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(s)); return b; };
  // mode 34: list the EG ids in which this reserve can be COLLATERAL.
  // For cUSDC that's just EG-4 (margin short SOL). EG-1 / EG-3 use cUSDC
  // as the *debt* asset, configured via update_lending_market(mode=9)
  // separately by migrate-eg-debt-to-cusdc.ts — no entry needed here.
  await sendOrSkipNoop(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateElevationGroups, elevationGroupsBuf(cfg.elevationGroups), true)),
    [auth], "phase2 elevationGroups");
  await sendOrSkipNoop(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateDisableUsageAsCollateralOutsideEmode, Buffer.from([cfg.disableUsageAsCollOutsideEmode]), true)),
    [auth], "phase2 disableUsageAsCollOutsideEmode");
  // Order matters: the integrity validator (skipValidation=false) runs
  // a full state check on every validated edit, including the rule
  //   borrow_limit >= borrow_limit_outside_elevation_group.
  // If we set borrow_limit_outside_elevation_group first while
  // borrow_limit is still the post-init zero, the next validated edit
  // (UpdateDepositLimit) trips error 6004. Set borrow_limit first
  // (validated, against current borrow_limit_outside_elevation_group=0),
  // then borrow_limit_outside_elevation_group (skipValidation=true since
  // klend's validator can't decrease it), then deposit_limit (validated,
  // against fully-populated state).
  // skipValidation=false on cap edits routes through the integrity-
  // validator branch — memory: "klend skip-validation flag inverted".
  await sendOrSkipNoop(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimit, u64(cfg.borrowLimit), false)),
    [auth], "phase2 borrowLimit");
  await sendOrSkipNoop(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimitOutsideElevationGroup, u64(cfg.borrowLimitOutsideElevationGroup), true)),
    [auth], "phase2 borrowLimitOutsideEG");
  await sendOrSkipNoop(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateDepositLimit, u64(cfg.depositLimit), false)),
    [auth], "phase2 depositLimit");
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const auth = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  console.log("=== cUSDC klend reserve setup ===");
  console.log("Authority:", auth.publicKey.toBase58());

  const cfgsDir = path.join(__dirname, "..", "configs");
  const devnetDir = path.join(cfgsDir, "devnet");
  const market = V3_MARKET;

  // Read cUSDC pool deploy outputs.
  const poolPath = path.join(devnetDir, "cusdc-pool.json");
  if (!fs.existsSync(poolPath)) {
    throw new Error(`Missing ${poolPath} — run scripts/deploy-cusdc-pool-devnet.ts first.`);
  }
  const poolOut = JSON.parse(fs.readFileSync(poolPath, "utf8"));
  const cusdcMint = new PublicKey(poolOut.cusdcMint);
  console.log("cUSDC mint:", cusdcMint.toBase58());

  const reserveCfg: ReserveConfigJson = JSON.parse(fs.readFileSync(path.join(cfgsDir, "delta_cUSDC_reserve.json"), "utf8"));
  console.log("Market:    ", market.toBase58());
  console.log("Oracle:    ", reserveCfg.tokenInfo.pythConfiguration.price, "(USDC Pyth Receiver)");

  // --- Persistence file ---
  const outPath = path.join(devnetDir, "cusdc-deployed.json");
  let out: any = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

  // --- Step 1: reserve keypair (reuse if exists) ---
  let reserveKp: Keypair;
  let reserve: PublicKey;
  if (out.cusdcReserve) {
    reserve = new PublicKey(out.cusdcReserve);
    console.log("\nStep 1: reserve already exists at", reserve.toBase58(), "— reusing");
    reserveKp = Keypair.generate(); // placeholder, won't be used
  } else {
    reserveKp = Keypair.generate();
    reserve = reserveKp.publicKey;
    console.log("\nStep 1: new reserve keypair", reserve.toBase58());
  }

  // --- Step 2: ensure deployer has cUSDC seed ---
  const cusdcAta = getAssociatedTokenAddressSync(cusdcMint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const balInfo = await conn.getTokenAccountBalance(cusdcAta).catch(() => null);
  const bal = balInfo ? BigInt(balInfo.value.amount) : 0n;
  if (bal < SEED_AMOUNT) {
    throw new Error(`Need ${SEED_AMOUNT} cUSDC raw units in deployer ATA ${cusdcAta.toBase58()}, have ${bal}. Re-run scripts/deploy-cusdc-pool-devnet.ts to top up the seed mint.`);
  }
  console.log(`Step 2: deployer cUSDC balance ${bal} >= seed ${SEED_AMOUNT} ✓`);

  // --- Step 3: init_reserve ---
  const reserveInfo = await conn.getAccountInfo(reserve);
  if (reserveInfo) {
    console.log("Step 3: reserve already initialized, size", reserveInfo.data.length, "— skipping init_reserve");
  } else {
    console.log("Step 3: klend init_reserve …");
    const rentLamports = await conn.getMinimumBalanceForRentExemption(RESERVE_SIZE);
    const sig = await sendAndConfirmTransaction(conn, new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
      .add(SystemProgram.createAccount({
        fromPubkey: auth.publicKey, newAccountPubkey: reserve,
        lamports: rentLamports, space: RESERVE_SIZE, programId: KLEND_PROGRAM_ID,
      }))
      .add(buildInitReserveIx(auth.publicKey, market, reserve, cusdcMint, cusdcAta, TOKEN_2022_PROGRAM_ID)),
      [auth, reserveKp]);
    console.log("  tx:", sig);
    out.cusdcReserve = reserve.toBase58();
    out.cusdcCollMint = reservePda("reserve_coll_mint", reserve).toBase58();
    out.cusdcCollSupply = reservePda("reserve_coll_supply", reserve).toBase58();
    out.cusdcLiqSupply = reservePda("reserve_liq_supply", reserve).toBase58();
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  }

  // --- Step 4: phase 1 reserve config ---
  console.log("Step 4: phase 1 reserve config …");
  await applyPhase1(conn, auth, market, reserve, reserveCfg);
  console.log("  done");

  // --- Step 5: phase 2 reserve config (elevation_groups, deposit/borrow limits, …) ---
  console.log("Step 5: phase 2 reserve config …");
  await applyPhase2(conn, auth, market, reserve, reserveCfg);
  console.log("  done");

  out.cusdcReserve = reserve.toBase58();
  out.cusdcMint = cusdcMint.toBase58();
  out.cusdcCollMint = reservePda("reserve_coll_mint", reserve).toBase58();
  out.cusdcCollSupply = reservePda("reserve_coll_supply", reserve).toBase58();
  out.cusdcLiqSupply = reservePda("reserve_liq_supply", reserve).toBase58();
  out.market = market.toBase58();
  out.completedAt = new Date().toISOString();
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("\nDone. Wrote", path.relative(process.cwd(), outPath));
  console.log("\nNext: scripts/migrate-eg-debt-to-cusdc.ts (repoints EG-1 + EG-3 debt from sUSDC to cUSDC)");

  // Idempotent ATA create for the deployer's collateral (cToken) ATA — needed
  // for any flash-loan / seed-deposit follow-up.
  const collMint = reservePda("reserve_coll_mint", reserve);
  const deployerCollAta = getAssociatedTokenAddressSync(collMint, auth.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  if (!(await conn.getAccountInfo(deployerCollAta))) {
    await sendAndConfirmTransaction(conn, new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        auth.publicKey, deployerCollAta, auth.publicKey, collMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    ), [auth]);
    console.log("Created deployer collateral (cToken) ATA:", deployerCollAta.toBase58());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
