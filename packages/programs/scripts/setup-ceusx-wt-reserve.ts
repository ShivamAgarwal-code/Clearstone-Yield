/**
 * setup-ceusx-wt-reserve.ts — Add ceUSX-WT as a new reserve to the
 * existing v3 csSOL/wSOL/csSOL-WT/ceUSX/sUSDC market and re-register
 * elevation group 1 (Stables) to allow ceUSX + ceUSX-WT as simultaneous
 * collateral.
 *
 * Why simultaneous: the institutional unwind path is a klend flash-loan
 * collateral swap (`flashBorrow(WT) → deposit(WT) → withdraw(ceUSX) →
 * yield_vault.Unlock → mint_WT → flashRepay(WT)` in one tx). Between
 * the deposit and withdraw, the obligation briefly holds *both* ceUSX
 * and ceUSX-WT, which requires `elevation_group.max_reserves_as_collateral
 * >= 2`.
 *
 * Mirror of `setup-cssol-wt-reserve.ts` — only the market reserves, the
 * mint, the elevation-group ID, and the debt-reserve target differ.
 *
 * Steps (idempotent — re-running picks up where the last run left off):
 *   1. Load existing market + ceUSX/sUSDC reserves + ceUSX-WT mint config.
 *   2. Generate (or reuse) the ceUSX-WT reserve keypair.
 *   3. klend `init_reserve` with deployer's ceUSX-WT ATA as the seed
 *      source. ⚠️  Requires SEED_AMOUNT in deployer's ceUSX-WT ATA —
 *      blocked until either (a) the governor upgrade adds a temporary
 *      `admin_mint_wt` ix or (b) the new `enqueue_eusx_unlock_via_pool`
 *      ix is deployed and the deployer runs it once. Without the seed
 *      this script aborts at step 3 with a clear message.
 *   4. Phase 1 update_reserve_config: basic params from
 *      `delta_ceUSX_WT_reserve.json`.
 *   5. Re-register elevation group 1 (Stables) with
 *      `max_reserves_as_collateral = 2` and `debt_reserve = sUSDC`.
 *   6. Phase 2 update_reserve_config: elevation_groups,
 *      disable_outside_emode, deposit/borrow limits.
 *   7. Persist to configs/devnet/ceusx-wt-deployed.json.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/setup-ceusx-wt-reserve.ts
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

import {
  buildUpdateElevationGroupIx,
} from "./lib/klend-elevation-group";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const RESERVE_SIZE = 8624;
const SEED_AMOUNT = 1_000_000n; // 1 ceUSX-WT (6 decimals); klend's init_reserve rejects zero-deposit init.

const ELEVATION_GROUP_STABLES = 1;

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
  UpdateBorrowLimitsInElevationGroupAgainstThisReserve: 45,
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
    try {
      await sendAndConfirmTransaction(conn, new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, mode, value, true)),
        [auth]);
    } catch (e: any) {
      // klend rejects no-op updates with InvalidConfig (0x1774). When
      // re-running after a partial setup, fields already at the target
      // value will throw — treat as idempotent success and move on.
      const msg = e?.transactionMessage ?? e?.message ?? "";
      if (msg.includes("0x1774")) {
        console.log(`    skip mode ${mode}: already at target value`);
        continue;
      }
      throw e;
    }
  }
}

async function applyPhase2(conn: Connection, auth: Keypair, market: PublicKey, reserve: PublicKey, cfg: ReserveConfigJson) {
  const u64 = (s: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(s)); return b; };
  const sendIdempotent = async (label: string, txp: Transaction) => {
    try {
      await sendAndConfirmTransaction(conn, txp, [auth]);
    } catch (e: any) {
      const msg = e?.transactionMessage ?? e?.message ?? "";
      if (msg.includes("0x1774")) {
        console.log(`    skip ${label}: already at target value`);
        return;
      }
      throw e;
    }
  };
  await sendIdempotent("UpdateElevationGroups", new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateElevationGroups, elevationGroupsBuf(cfg.elevationGroups), true)));
  await sendIdempotent("UpdateDisableUsageAsCollateralOutsideEmode", new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateDisableUsageAsCollateralOutsideEmode, Buffer.from([cfg.disableUsageAsCollOutsideEmode]), true)));
  await sendIdempotent("UpdateBorrowLimitOutsideElevationGroup", new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimitOutsideElevationGroup, u64(cfg.borrowLimitOutsideElevationGroup), true)));
  await sendIdempotent("UpdateDepositLimit", new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateDepositLimit, u64(cfg.depositLimit), false)));
  await sendIdempotent("UpdateBorrowLimit", new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimit, u64(cfg.borrowLimit), false)));

  // Mode 45 — `borrow_limit_against_this_collateral_in_elevation_group`.
  // 256-byte buffer = 32 u64 slots, indexed by (groupId - 1) per the
  // klend SDK convention (see market.ts:357 `[item - 1]`). Applied to
  // the COLLATERAL reserve (ceUSX-WT in our case): for EG-1 (Stables),
  // when ceUSX-WT is used as collateral, allow up to u64::MAX of any
  // debt asset to be borrowed against it. Other groups left at 0
  // (ceUSX-WT can't be collateral outside EG-1 anyway, per
  // disableUsageAsCollOutsideEmode = 1).
  const mode45Buf = Buffer.alloc(32 * 8);
  mode45Buf.writeBigUInt64LE(BigInt("18446744073709551615"), (ELEVATION_GROUP_STABLES - 1) * 8);
  await sendIdempotent("UpdateBorrowLimitsInElevationGroupAgainstThisReserve", new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(buildUpdateReserveConfigIx(auth.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimitsInElevationGroupAgainstThisReserve, mode45Buf, false)));
  console.log(`  mode 45 on ceUSX-WT reserve: EG-${ELEVATION_GROUP_STABLES} per-collateral borrow cap = u64::MAX`);
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const auth = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  console.log("=== ceUSX-WT klend reserve setup ===");
  console.log("Authority:", auth.publicKey.toBase58());

  const cfgsDir = path.join(__dirname, "..", "configs");
  const devnetDir = path.join(cfgsDir, "devnet");
  const v3 = JSON.parse(fs.readFileSync(path.join(devnetDir, "cssol-market-v3.json"), "utf8"));
  const market = new PublicKey(v3.market);
  const sUsdcReserve = new PublicKey(v3.reserves.sUSDC);
  const wtMint = new PublicKey(JSON.parse(fs.readFileSync(path.join(devnetDir, "ceusx-wt.json"), "utf8")).mint);
  const reserveCfg: ReserveConfigJson = JSON.parse(fs.readFileSync(path.join(cfgsDir, "delta_ceUSX_WT_reserve.json"), "utf8"));

  // Optional: paste accrual oracle output if it exists.
  const wtOraclePath = path.join(devnetDir, "ceusx-wt-oracle.json");
  if (fs.existsSync(wtOraclePath)) {
    const wtOracle = JSON.parse(fs.readFileSync(wtOraclePath, "utf8"));
    reserveCfg.tokenInfo.pythConfiguration.price = wtOracle.accrualOutput;
    console.log("Using ceUSX-WT accrual oracle:", wtOracle.accrualOutput);
  } else {
    // Fall back to the ceUSX accrual oracle since they bind to the same
    // YieldVault — pricing is identical at v1 anyway (1:1 to USX pre-yield).
    reserveCfg.tokenInfo.pythConfiguration.price = v3.oracles.ceUSX;
    console.log("Using ceUSX accrual oracle (fallback):", v3.oracles.ceUSX);
  }

  console.log("Market:    ", market.toBase58());
  console.log("sUSDC res: ", sUsdcReserve.toBase58(), "(EG-1 debt reserve)");
  console.log("WT mint:   ", wtMint.toBase58());

  // --- Persistence file ---
  const outPath = path.join(devnetDir, "ceusx-wt-deployed.json");
  let out: any = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

  // --- Step 1: reserve keypair (reuse if exists) ---
  let reserveKp: Keypair;
  let reserve: PublicKey;
  if (out.ceusxWtReserve) {
    reserve = new PublicKey(out.ceusxWtReserve);
    console.log("\nStep 1: reserve already exists at", reserve.toBase58(), "— reusing");
    reserveKp = Keypair.generate(); // placeholder, won't be used
  } else {
    reserveKp = Keypair.generate();
    reserve = reserveKp.publicKey;
    console.log("\nStep 1: new reserve keypair", reserve.toBase58());
  }

  // --- Step 2: ensure deployer has ceUSX-WT seed ---
  const wtAta = getAssociatedTokenAddressSync(wtMint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const balInfo = await conn.getTokenAccountBalance(wtAta).catch(() => null);
  const bal = balInfo ? BigInt(balInfo.value.amount) : 0n;
  if (bal < SEED_AMOUNT) {
    console.error(`\n❌ SEED BLOCKED: need ${SEED_AMOUNT} ceUSX-WT in deployer ATA ${wtAta.toBase58()}, have ${bal}.`);
    console.error(`\nTo unblock:`);
    console.error(`  Option A — governor upgrade:`);
    console.error(`    Add a temporary admin-only \`admin_mint_wt(amount, target_mint_config)\` ix to the new`);
    console.error(`    governor program (or relax \`mint_wrapped\`'s wrapped_mint constraint to accept any`);
    console.error(`    MintConfig under the host pool's authority). Build, deploy, run, remove in v2.`);
    console.error(`  Option B — wait until step 3 of the eUSX-WT plan:`);
    console.error(`    Once \`enqueue_eusx_unlock_via_pool\` is implemented and deployed, the deployer`);
    console.error(`    can run it once with their own wallet (using existing eUSX → ceUSX → ceUSX-WT)`);
    console.error(`    to mint the seed. Then re-run this script.`);
    process.exit(2);
  }
  console.log(`Step 2: deployer ceUSX-WT balance ${bal} >= seed ${SEED_AMOUNT} ✓`);

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
      .add(buildInitReserveIx(auth.publicKey, market, reserve, wtMint, wtAta, TOKEN_2022_PROGRAM_ID)),
      [auth, reserveKp]);
    console.log("  tx:", sig);
    out.ceusxWtReserve = reserve.toBase58();
    out.ceusxWtCollMint = reservePda("reserve_coll_mint", reserve).toBase58();
    out.ceusxWtCollSupply = reservePda("reserve_coll_supply", reserve).toBase58();
    out.ceusxWtLiqSupply = reservePda("reserve_liq_supply", reserve).toBase58();
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  }

  // --- Step 4: phase 1 reserve config ---
  console.log("Step 4: phase 1 reserve config …");
  await applyPhase1(conn, auth, market, reserve, reserveCfg);
  console.log("  done");

  // --- Step 5: re-register elevation group 1 with max_reserves_as_collateral=2 ---
  console.log("Step 5: re-register elevation group 1 (Stables, max_reserves_as_collateral = 2) …");
  await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(buildUpdateElevationGroupIx(auth.publicKey, market, {
      id: ELEVATION_GROUP_STABLES,
      ltvPct: 90,
      liquidationThresholdPct: 92,
      maxLiquidationBonusBps: 200,
      allowNewLoans: 1,
      maxReservesAsCollateral: 2,
      debtReserve: sUsdcReserve,
    })),
    [auth]);
  console.log("  done");

  // --- Step 6: phase 2 reserve config ---
  console.log("Step 6: phase 2 reserve config …");
  await applyPhase2(conn, auth, market, reserve, reserveCfg);
  console.log("  done");

  out.ceusxWtReserve = reserve.toBase58();
  out.ceusxWtCollMint = reservePda("reserve_coll_mint", reserve).toBase58();
  out.ceusxWtCollSupply = reservePda("reserve_coll_supply", reserve).toBase58();
  out.ceusxWtLiqSupply = reservePda("reserve_liq_supply", reserve).toBase58();
  out.market = market.toBase58();
  out.elevationGroup = ELEVATION_GROUP_STABLES;
  out.completedAt = new Date().toISOString();
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("\nDone. Wrote", path.relative(process.cwd(), outPath));

  // Idempotent ATA create for the deployer's collateral (cToken) ATA — needed
  // by the future enqueue ix when the deployer flash-borrows from this reserve.
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

  console.log("\nNext: governor upgrade — add `enqueue_eusx_unlock_via_pool` and `redeem_ceusx_wt`.");
}

main().catch((e) => { console.error(e); process.exit(1); });
