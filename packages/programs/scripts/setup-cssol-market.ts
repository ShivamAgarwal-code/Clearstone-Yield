/**
 * setup-cssol-market.ts
 *
 * Stands up a fresh klend lending market with the csSOL/wSOL reserve pair and
 * registers elevation group 2 (LST/SOL).
 *
 * Why a fresh market: the existing devnet cUSDY/USDC market predates the
 * elevation-group config and the new accrual-oracle wiring. Decoupling avoids
 * any migration of the live cUSDY position; the cUSDY market keeps working
 * unchanged.
 *
 * What this script DOES:
 *   1. Reads cssol-oracle.json (output of setup-cssol-oracle.ts).
 *   2. Reads cssol-pool.json (output of deploy-cssol-governor.ts) for the
 *      csSOL Token-2022 mint + governor PoolConfig PDA.
 *   3. Creates a fresh klend lending market.
 *   4. Initializes csSOL collateral reserve (seed: deployer's whitelisted
 *      csSOL ATA, must be pre-minted).
 *   5. Initializes wSOL borrow reserve (seed: deployer's wSOL ATA).
 *   6. Applies update_reserve_config × N for each reserve from the JSON.
 *   7. Registers elevation group 2 on the market via the new helper.
 *   8. Calls governor::register_lending_market.
 *   9. Writes addresses to configs/devnet/cssol-deployed.json.
 *
 * What this script does NOT do:
 *   - Create the csSOL governor pool / Token-2022 mint (run
 *     deploy-cssol-governor-devnet.ts first; it follows the same pattern as
 *     deploy-governor-devnet.ts, just with PoolParams.elevationGroup = 2 and
 *     underlying_mint = wSOL).
 *   - Touch the existing cUSDY market.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/setup-cssol-market.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

import {
  buildElevationGroupIxsFromConfig,
  type GroupsConfig,
} from "./lib/klend-elevation-group";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const GOVERNOR_PROGRAM_ID = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");

const LENDING_MARKET_SIZE = 4664;
const RESERVE_SIZE = 8624;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

const DISC = {
  initLendingMarket: disc("init_lending_market"),
  initReserve: disc("init_reserve"),
  updateReserveConfig: disc("update_reserve_config"),
  registerLendingMarket: disc("register_lending_market"),
};

// Indices match the klend `UpdateConfigMode` enum exactly. Verified against
// node_modules/@kamino-finance/klend-sdk/dist/idl/klend.json.
//
// NOTE: klend gates a subset of modes to its protocol global admin
// (`GLOBAL_ADMIN_ONLY_MODES` in klend-sdk/src/classes/reserve.ts). We MUST
// NOT include any of these — klend rejects with InvalidSigner (6005)
// regardless of who signs:
//   UpdateProtocolTakeRate (4)
//   UpdateProtocolLiquidationFee (3)
//   UpdateHostFixedInterestRateBps (47)
//   UpdateProtocolOrderExecutionFee (50)
//   UpdateFeesOriginationFee (5)
//   UpdateFeesFlashLoanFee (6)
//   UpdateBlockCTokenUsage (53)
// These default to safe values in init_reserve; Kamino controls them.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function marketAuthorityPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND_PROGRAM_ID)[0];
}

function reservePda(seed: string, reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), reserve.toBuffer()], KLEND_PROGRAM_ID)[0];
}

function buildInitLendingMarketIx(owner: PublicKey, market: PublicKey): TransactionInstruction {
  const quoteCurrency = Buffer.alloc(32); // "USD" left as zeros
  const data = Buffer.concat([DISC.initLendingMarket, quoteCurrency]);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: marketAuthorityPda(market), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitReserveIx(
  signer: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  mint: PublicKey,
  initialLiquiditySource: PublicKey,
  liquidityTokenProgram: PublicKey,
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
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // collateral always SPL
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.initReserve,
  });
}

function buildUpdateReserveConfigIx(
  owner: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  mode: number,
  value: Buffer,
  skipValidation: boolean,
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
  protocolLiquidationFeePct: number;
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
  if (points.length !== 11) throw new Error(`borrowRateCurve must have exactly 11 points, got ${points.length}`);
  const buf = Buffer.alloc(88);
  points.forEach((p, i) => {
    buf.writeUInt32LE(p.utilizationRateBps, i * 8);
    buf.writeUInt32LE(p.borrowRateBps, i * 8 + 4);
  });
  return buf;
}

function elevationGroupsBuf(groups: number[]): Buffer {
  if (groups.length !== 20) throw new Error(`elevationGroups must have exactly 20 entries, got ${groups.length}`);
  return Buffer.from(groups.map((g) => g & 0xff));
}

// Apply config in two phases. Caller must register the elevation group on
// the market BETWEEN the two phases — otherwise the phase-2 integrity check
// (skip=false) rejects reserves whose elevationGroups array points at an
// unregistered group with InvalidElevationGroup (0x17b5).
async function applyReserveConfigPhase1(
  conn: Connection,
  authority: Keypair,
  market: PublicKey,
  reserve: PublicKey,
  cfg: ReserveConfigJson,
): Promise<void> {
  const u64 = (s: string): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(s));
    return buf;
  };
  const nameBuf = Buffer.alloc(32);
  Buffer.from(cfg.tokenInfo.name).copy(nameBuf);

  const u16 = (n: number): Buffer => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(n);
    return buf;
  };
  const ixs: { mode: number; value: Buffer }[] = [
    { mode: CONFIG_MODE.UpdateName, value: nameBuf },
    { mode: CONFIG_MODE.UpdatePriceMaxAge, value: u64(cfg.tokenInfo.maxAgePriceSeconds) },
    { mode: CONFIG_MODE.UpdateTwapMaxAge, value: u64(cfg.tokenInfo.maxAgeTwapSeconds) },
    { mode: CONFIG_MODE.UpdatePythPrice, value: new PublicKey(cfg.tokenInfo.pythConfiguration.price).toBuffer() },
    { mode: CONFIG_MODE.UpdateLoanToValuePct, value: Buffer.from([cfg.loanToValuePct]) },
    { mode: CONFIG_MODE.UpdateLiquidationThresholdPct, value: Buffer.from([cfg.liquidationThresholdPct]) },
    { mode: CONFIG_MODE.UpdateMinLiquidationBonusBps, value: u16(cfg.minLiquidationBonusBps) },
    { mode: CONFIG_MODE.UpdateMaxLiquidationBonusBps, value: u16(cfg.maxLiquidationBonusBps) },
    { mode: CONFIG_MODE.UpdateBadDebtLiquidationBonusBps, value: u16(cfg.badDebtLiquidationBonusBps) },
    // protocolLiquidationFeePct is globalAdmin-only — klend keeps the
    // init_reserve default. Skipping; cfg.protocolLiquidationFeePct ignored.
    { mode: CONFIG_MODE.UpdateBorrowFactor, value: u64(cfg.borrowFactorPct) },
    { mode: CONFIG_MODE.UpdateBorrowRateCurve, value: curveBuf(cfg.borrowRateCurve.points) },
  ];

  for (const { mode, value } of ixs) {
    await sendAndConfirmTransaction(
      conn,
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(buildUpdateReserveConfigIx(authority.publicKey, market, reserve, mode, value, true)),
      [authority],
    );
  }
}

async function applyReserveConfigPhase2(
  conn: Connection,
  authority: Keypair,
  market: PublicKey,
  reserve: PublicKey,
  cfg: ReserveConfigJson,
): Promise<void> {
  const u64 = (s: string): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(s));
    return buf;
  };

  // Register elevation-group membership and disable-outside-emode (skip=true,
  // since limits-driven integrity check happens in the final ixs below).
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(authority.publicKey, market, reserve, CONFIG_MODE.UpdateElevationGroups, elevationGroupsBuf(cfg.elevationGroups), true)),
    [authority],
  );
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(authority.publicKey, market, reserve, CONFIG_MODE.UpdateDisableUsageAsCollateralOutsideEmode, Buffer.from([cfg.disableUsageAsCollOutsideEmode]), true)),
    [authority],
  );

  // Final ixs run with skip=false → triggers the full integrity check.
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(authority.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimitOutsideElevationGroup, u64(cfg.borrowLimitOutsideElevationGroup), true)),
    [authority],
  );
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(authority.publicKey, market, reserve, CONFIG_MODE.UpdateDepositLimit, u64(cfg.depositLimit), false)),
    [authority],
  );
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(buildUpdateReserveConfigIx(authority.publicKey, market, reserve, CONFIG_MODE.UpdateBorrowLimit, u64(cfg.borrowLimit), false)),
    [authority],
  );
}

function buildRegisterLendingMarketIx(
  authority: PublicKey,
  poolConfig: PublicKey,
  lendingMarket: PublicKey,
  collateralReserve: PublicKey,
  borrowReserve: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([
    DISC.registerLendingMarket,
    lendingMarket.toBuffer(),
    collateralReserve.toBuffer(),
    borrowReserve.toBuffer(),
  ]);
  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolConfig, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();

  console.log("=== csSOL/wSOL market deploy ===");
  console.log("RPC:      ", RPC_URL);
  console.log("Authority:", authority.publicKey.toBase58());

  // --- Load prerequisites --------------------------------------------------
  const oracleCfgPath = path.join(__dirname, "..", "configs", "devnet", "cssol-oracle.json");
  if (!fs.existsSync(oracleCfgPath)) throw new Error(`run setup-cssol-oracle.ts first — ${oracleCfgPath} missing`);
  const oracleCfg = loadJson<{ accrualOutput: string; accrualConfig: string }>(oracleCfgPath);

  const poolCfgPath = path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  if (!fs.existsSync(poolCfgPath)) {
    throw new Error(
      `run deploy-cssol-governor-devnet.ts first — ${poolCfgPath} missing.\n` +
        `That script should call governor.initialize_pool(elevationGroup=2, underlying=wSOL,\n` +
        `borrow=wSOL, decimals=9), whitelist the deployer, and mint a small csSOL seed.`,
    );
  }
  const poolCfg = loadJson<{
    pool: { poolConfig: string };
    cssolMint: string;          // Token-2022 csSOL mint
  }>(poolCfgPath);

  const csSolReserveCfg = loadJson<ReserveConfigJson>(
    path.join(__dirname, "..", "configs", "delta_csSOL_reserve.json"),
  );
  const wsolReserveCfg = loadJson<ReserveConfigJson>(
    path.join(__dirname, "..", "configs", "wsol_borrow_reserve.json"),
  );
  const groupsCfg = loadJson<GroupsConfig>(
    path.join(__dirname, "..", "configs", "elevation_groups.json"),
  );

  const cssolMint = new PublicKey(poolCfg.cssolMint);
  const poolConfig = new PublicKey(poolCfg.pool.poolConfig);
  const accrualOutput = new PublicKey(oracleCfg.accrualOutput);

  console.log("csSOL mint:    ", cssolMint.toBase58());
  console.log("Pool config:   ", poolConfig.toBase58());
  console.log("Accrual output:", accrualOutput.toBase58());
  console.log();

  // --- Step 1: lending market ----------------------------------------------
  const marketKp = Keypair.generate();
  console.log("Step 1: create lending market →", marketKp.publicKey.toBase58());
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: marketKp.publicKey,
          lamports: await conn.getMinimumBalanceForRentExemption(LENDING_MARKET_SIZE),
          space: LENDING_MARKET_SIZE,
          programId: KLEND_PROGRAM_ID,
        }),
      )
      .add(buildInitLendingMarketIx(authority.publicKey, marketKp.publicKey)),
    [authority, marketKp],
  );

  // --- Step 2: seed ATAs ---------------------------------------------------
  console.log("Step 2: ensure seed ATAs (csSOL, wSOL)");
  const cssolAta = await getOrCreateAssociatedTokenAccount(
    conn, authority, cssolMint, authority.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
  );
  console.log("  csSOL ATA:", cssolAta.address.toBase58());
  if (cssolAta.amount === 0n) {
    throw new Error(
      "csSOL ATA has zero balance. deploy-cssol-governor-devnet.ts must mint a small seed (≥1 lamport-unit) before this script runs.",
    );
  }

  const wsolAta = await getOrCreateAssociatedTokenAccount(
    conn, authority, NATIVE_MINT, authority.publicKey, false, "confirmed",
  );
  // Wrap a small amount of native SOL into wSOL ATA (idempotent — sync_native picks up new lamports).
  const wsolAcct = await conn.getTokenAccountBalance(wsolAta.address).catch(() => null);
  const wsolBal = wsolAcct ? BigInt(wsolAcct.value.amount) : 0n;
  if (wsolBal < 1_000_000n /* 0.001 SOL */) {
    await sendAndConfirmTransaction(
      conn,
      new Transaction()
        .add(SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: wsolAta.address,
          lamports: 1_000_000,
        }))
        .add(createSyncNativeInstruction(wsolAta.address)),
      [authority],
    );
  }
  console.log("  wSOL ATA: ", wsolAta.address.toBase58());

  // --- Step 3: reserves -----------------------------------------------------
  console.log("Step 3: init reserves");
  const reserveRent = await conn.getMinimumBalanceForRentExemption(RESERVE_SIZE);

  const cssolReserveKp = Keypair.generate();
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }))
      .add(SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: cssolReserveKp.publicKey,
        lamports: reserveRent,
        space: RESERVE_SIZE,
        programId: KLEND_PROGRAM_ID,
      }))
      .add(buildInitReserveIx(
        authority.publicKey, marketKp.publicKey, cssolReserveKp.publicKey,
        cssolMint, cssolAta.address, TOKEN_2022_PROGRAM_ID,
      )),
    [authority, cssolReserveKp],
  );
  console.log("  csSOL reserve:", cssolReserveKp.publicKey.toBase58());

  const wsolReserveKp = Keypair.generate();
  await sendAndConfirmTransaction(
    conn,
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }))
      .add(SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: wsolReserveKp.publicKey,
        lamports: reserveRent,
        space: RESERVE_SIZE,
        programId: KLEND_PROGRAM_ID,
      }))
      .add(buildInitReserveIx(
        authority.publicKey, marketKp.publicKey, wsolReserveKp.publicKey,
        NATIVE_MINT, wsolAta.address, TOKEN_PROGRAM_ID,
      )),
    [authority, wsolReserveKp],
  );
  console.log("  wSOL reserve: ", wsolReserveKp.publicKey.toBase58());

  // --- Step 4a: phase-1 reserve config (no elevation-group reference yet) ---
  console.log("Step 4a: apply phase-1 reserve configs");
  csSolReserveCfg.tokenInfo.pythConfiguration.price = accrualOutput.toBase58();
  await applyReserveConfigPhase1(conn, authority, marketKp.publicKey, cssolReserveKp.publicKey, csSolReserveCfg);
  await applyReserveConfigPhase1(conn, authority, marketKp.publicKey, wsolReserveKp.publicKey, wsolReserveCfg);

  // --- Step 4b: register elevation group 2 on the market --------------------
  console.log("Step 4b: register elevation group 2 on market (debt = wSOL)");
  const lstGroupOnly: GroupsConfig = {
    groups: groupsCfg.groups.filter((g) => g.id === 2),
  };
  if (lstGroupOnly.groups.length !== 1) throw new Error("expected exactly one group with id=2 in elevation_groups.json");
  const groupIxs = buildElevationGroupIxsFromConfig(authority.publicKey, marketKp.publicKey, lstGroupOnly, {
    wSOL: wsolReserveKp.publicKey,
    csSOL: cssolReserveKp.publicKey,
  });
  await sendAndConfirmTransaction(conn, new Transaction().add(...groupIxs), [authority]);

  // --- Step 4c: phase-2 reserve config (now safe to reference group 2) -----
  console.log("Step 4c: apply phase-2 reserve configs (limits + group membership)");
  await applyReserveConfigPhase2(conn, authority, marketKp.publicKey, cssolReserveKp.publicKey, csSolReserveCfg);
  await applyReserveConfigPhase2(conn, authority, marketKp.publicKey, wsolReserveKp.publicKey, wsolReserveCfg);

  // --- Step 5: register with governor --------------------------------------
  // The governor pool's `authority` was set when initialize_pool was called
  // (deploy-cssol-governor-devnet.ts). If that wallet differs from the klend
  // builder used for steps 1–4 (e.g. when klend is gated to a specific
  // signer), set POOL_AUTHORITY_KEYPAIR to point at the original pool
  // authority's keypair so the final ix can be signed correctly.
  console.log("Step 5: governor.register_lending_market");
  const poolAuthority = process.env.POOL_AUTHORITY_KEYPAIR
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.POOL_AUTHORITY_KEYPAIR, "utf8"))))
    : authority;
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(buildRegisterLendingMarketIx(
      poolAuthority.publicKey,
      poolConfig,
      marketKp.publicKey,
      cssolReserveKp.publicKey,
      wsolReserveKp.publicKey,
    )),
    [poolAuthority],
  );

  // --- Output ---------------------------------------------------------------
  const out = {
    cluster: "devnet",
    rpc: RPC_URL,
    market: marketKp.publicKey.toBase58(),
    elevationGroup: 2,
    reserves: {
      csSOL: { address: cssolReserveKp.publicKey.toBase58(), mint: cssolMint.toBase58(), oracle: accrualOutput.toBase58(), tokenProgram: "Token-2022", role: "collateral" },
      wSOL:  { address: wsolReserveKp.publicKey.toBase58(),  mint: NATIVE_MINT.toBase58(), oracle: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", tokenProgram: "Token Program", role: "borrow" },
    },
    governor: { poolConfig: poolConfig.toBase58() },
    completedAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== done ===");
  console.log(`Market:        ${marketKp.publicKey.toBase58()}`);
  console.log(`csSOL reserve: ${cssolReserveKp.publicKey.toBase58()}`);
  console.log(`wSOL reserve:  ${wsolReserveKp.publicKey.toBase58()}`);
  console.log(`Saved → ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
