/**
 * setup-devnet-curator-vault.ts — Stand up a clearstone_curator vault on devnet
 * with USDC base + Kamino-backed yield.
 *
 * Spec: clearstone-fixed-yield/deployments/devnet-vault-init.md
 *
 * Implements steps 1, 4, 5 of the 5-step bring-up. Steps 2-3
 * (clearstone_core::initialize_vault + init_market_two) are NOT here yet
 * — they need full ALT + ATA + adapter-CPI account wiring; lift the
 * pattern from clearstone-fixed-yield/tests/fixtures.ts (`setupVault` +
 * `setupMarket`) into a follow-up script.
 *
 * Steps run by default:
 *   1. kamino_sy_adapter::init_sy_params  → SY wrapping kUSDC (KycMode::None)
 *   4. clearstone_curator::initialize_vault → USDC savings vault
 *
 * Step 5 (set_allocations) needs a market PDA from step 3, so it's
 * gated on $MARKET_PDA being set in env.
 *
 * Idempotent — checks each PDA before issuing the init tx.
 *
 * Usage:
 *   npx tsx scripts/setup-devnet-curator-vault.ts
 *
 * Environment variables (all optional):
 *   RPC               default https://api.devnet.solana.com
 *   DEPLOY_KEYPAIR    default ~/.config/solana/id.json
 *   CURATOR_KEYPAIR   default = DEPLOY_KEYPAIR
 *   FEE_BPS           default 1000 (10%; max 2000)
 *   STEPS             comma-separated step numbers, default "1,4"
 *   MARKET_PDA        required for step 5
 *   WEIGHT_BPS        default 10000 (used in step 5)
 *   CAP_BASE          default 100_000_000_000 (=100k USDC at 6dp)
 *   DRY_RUN           "true" to print without sending
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config — devnet addresses, sourced from clearstone-fixed-yield/deployments/devnet.json
// and clearstone-finance/packages/programs/configs/devnet/{addresses,market-deployed}.json
// ---------------------------------------------------------------------------

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";

const KAMINO_SY_ADAPTER = new PublicKey("29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd");
const CLEARSTONE_CURATOR = new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm");

const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_LENDING_MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
// Solstice USDC reserve — active (status=0), oracle is being kept fresh
// by the production USX flow. See deployments/devnet.json `external.solstice`.
const KLEND_USDC_RESERVE = new PublicKey("AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb");
const USDC_MINT = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");

// Real Kamino Lend V2 Reserve layout: collateral.mint_pubkey at byte 2560.
// See clearstone-fixed-yield/reference_adapters/kamino_sy_adapter/src/lib.rs:524.
const REAL_KLEND_RESERVE_LEN = 8624;
const REAL_KLEND_COLLATERAL_MINT_OFFSET = 2560;

// Discriminators
const ADAPTER_INIT_SY_PARAMS_DISC = Buffer.from([0]);                 // explicit 1-byte override
const CURATOR_INIT_VAULT_DISC = Buffer.from(                          // sha256("global:initialize_vault")[..8]
  [48, 191, 163, 44, 71, 129, 63, 164]
);
const CURATOR_SET_ALLOCATIONS_DISC = Buffer.from(                     // sha256("global:set_allocations")[..8]
  [66, 88, 197, 213, 234, 204, 219, 244]
);

// PDA seeds
const SEED_SY_METADATA = Buffer.from("sy_metadata");
const SEED_SY_MINT = Buffer.from("sy_mint");
const SEED_COLL_VAULT = Buffer.from("coll_vault");
const SEED_POOL_ESCROW = Buffer.from("pool_escrow");
const SEED_CURATOR_VAULT = Buffer.from("curator_vault");
const SEED_BASE_ESCROW = Buffer.from("base_escrow");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(envVar: string, fallback?: string): Keypair {
  const p =
    process.env[envVar] ??
    fallback ??
    path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))
  );
}

function ro(pubkey: PublicKey) { return { pubkey, isSigner: false, isWritable: false }; }
function rw(pubkey: PublicKey) { return { pubkey, isSigner: false, isWritable: true }; }
function signerRo(pubkey: PublicKey) { return { pubkey, isSigner: true, isWritable: false }; }
function signerRw(pubkey: PublicKey) { return { pubkey, isSigner: true, isWritable: true }; }

async function exists(conn: Connection, addr: PublicKey): Promise<boolean> {
  return (await conn.getAccountInfo(addr, "confirmed")) !== null;
}

async function send(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  extraSigners: Keypair[] = [],
  label: string = "tx"
): Promise<string> {
  const tx = new Transaction().add(ix);
  if (process.env.DRY_RUN === "true") {
    console.log(`[DRY_RUN] would send ${label}`);
    console.log(`         ${ix.keys.length} accounts, ${ix.data.length} bytes data`);
    return "DRY_RUN";
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...extraSigners], {
    commitment: "confirmed",
  });
  console.log(`  ✓ ${label}: ${sig}`);
  return sig;
}

// ---------------------------------------------------------------------------
// Borsh-ish encoders (sufficient for the args we serialize)
// ---------------------------------------------------------------------------

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

// ---------------------------------------------------------------------------
// PDA derivations
// ---------------------------------------------------------------------------

function findSyMetadata(underlyingMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_SY_METADATA, underlyingMint.toBuffer()],
    KAMINO_SY_ADAPTER
  );
}
function findSyMint(syMetadata: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_SY_MINT, syMetadata.toBuffer()],
    KAMINO_SY_ADAPTER
  );
}
function findCollateralVault(syMetadata: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_COLL_VAULT, syMetadata.toBuffer()],
    KAMINO_SY_ADAPTER
  );
}
function findPoolEscrow(syMetadata: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_POOL_ESCROW, syMetadata.toBuffer()],
    KAMINO_SY_ADAPTER
  );
}
function findCuratorVault(curator: PublicKey, baseMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_CURATOR_VAULT, curator.toBuffer(), baseMint.toBuffer()],
    CLEARSTONE_CURATOR
  );
}
function findBaseEscrow(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_BASE_ESCROW, vault.toBuffer()],
    CLEARSTONE_CURATOR
  );
}

// ---------------------------------------------------------------------------
// kUSDC mint discovery
// ---------------------------------------------------------------------------

async function readKusdcCollateralMint(conn: Connection): Promise<PublicKey> {
  const info = await conn.getAccountInfo(KLEND_USDC_RESERVE, "confirmed");
  if (!info) throw new Error(`Klend USDC reserve not found: ${KLEND_USDC_RESERVE.toBase58()}`);
  if (!info.owner.equals(KLEND_PROGRAM)) {
    throw new Error(
      `Reserve owner mismatch: expected ${KLEND_PROGRAM.toBase58()}, got ${info.owner.toBase58()}`
    );
  }
  if (info.data.length !== REAL_KLEND_RESERVE_LEN) {
    throw new Error(
      `Reserve data length ${info.data.length}, expected ${REAL_KLEND_RESERVE_LEN} (real klend layout). ` +
        `Mock klend has a different offset; this script targets real klend.`
    );
  }
  const slice = info.data.subarray(
    REAL_KLEND_COLLATERAL_MINT_OFFSET,
    REAL_KLEND_COLLATERAL_MINT_OFFSET + 32
  );
  return new PublicKey(slice);
}

// ---------------------------------------------------------------------------
// Step 1 — kamino_sy_adapter::init_sy_params (KycMode::None)
// ---------------------------------------------------------------------------

interface KaminoSyHandles {
  syMetadata: PublicKey;
  syMint: PublicKey;
  collateralVault: PublicKey;
  poolEscrow: PublicKey;
  klendCollateralMint: PublicKey;
}

function buildInitSyParamsIx(args: {
  payer: PublicKey;
  curator: PublicKey;
  underlyingMint: PublicKey;
  syMetadata: PublicKey;
  syMint: PublicKey;
  collateralVault: PublicKey;
  poolEscrow: PublicKey;
  klendReserve: PublicKey;
  klendLendingMarket: PublicKey;
  klendCollateralMint: PublicKey;
  klendProgram: PublicKey;
}): TransactionInstruction {
  // Args: kyc_mode (enum, variant 0 = None), core_pdas_to_whitelist (Vec<Pubkey> = empty)
  const data = Buffer.concat([
    ADAPTER_INIT_SY_PARAMS_DISC,
    Buffer.from([0]),       // KycMode::None variant tag
    u32le(0),               // empty Vec<Pubkey>
  ]);

  // Anchor 0.30+ convention: `Option<Account>` slots are still positional in
  // the keys list. For `None`, pass the program's own ID as the sentinel.
  const NONE = ro(KAMINO_SY_ADAPTER);
  const keys = [
    signerRw(args.payer),
    signerRo(args.curator),
    ro(args.underlyingMint),
    rw(args.syMetadata),
    rw(args.syMint),
    rw(args.collateralVault),
    rw(args.poolEscrow),
    ro(args.klendReserve),
    ro(args.klendLendingMarket),
    ro(args.klendCollateralMint),
    ro(args.klendProgram),
    // 4 optional governor/delta-mint accounts — KycMode::None ⇒ all sentinel.
    NONE, NONE, NONE, NONE,
    ro(TOKEN_PROGRAM_ID),
    ro(SystemProgram.programId),
    ro(SYSVAR_RENT_PUBKEY),
  ];

  return new TransactionInstruction({
    programId: KAMINO_SY_ADAPTER,
    keys,
    data,
  });
}

async function step1InitSyParams(args: {
  conn: Connection;
  payer: Keypair;
  curator: Keypair;
  klendCollateralMint: PublicKey;
}): Promise<KaminoSyHandles> {
  const { conn, payer, curator, klendCollateralMint } = args;

  const [syMetadata] = findSyMetadata(USDC_MINT);
  const [syMint] = findSyMint(syMetadata);
  const [collateralVault] = findCollateralVault(syMetadata);
  const [poolEscrow] = findPoolEscrow(syMetadata);

  console.log("Step 1 — kamino_sy_adapter::init_sy_params (KycMode::None)");
  console.log(`  underlying USDC:    ${USDC_MINT.toBase58()}`);
  console.log(`  klend reserve:      ${KLEND_USDC_RESERVE.toBase58()}`);
  console.log(`  klend kUSDC mint:   ${klendCollateralMint.toBase58()}`);
  console.log(`  PDA sy_metadata:    ${syMetadata.toBase58()}`);
  console.log(`  PDA sy_mint:        ${syMint.toBase58()}`);
  console.log(`  PDA coll_vault:     ${collateralVault.toBase58()}`);
  console.log(`  PDA pool_escrow:    ${poolEscrow.toBase58()}`);

  if (await exists(conn, syMetadata)) {
    console.log("  ↳ sy_metadata already exists, skipping init.");
  } else {
    const ix = buildInitSyParamsIx({
      payer: payer.publicKey,
      curator: curator.publicKey,
      underlyingMint: USDC_MINT,
      syMetadata,
      syMint,
      collateralVault,
      poolEscrow,
      klendReserve: KLEND_USDC_RESERVE,
      klendLendingMarket: KLEND_LENDING_MARKET,
      klendCollateralMint,
      klendProgram: KLEND_PROGRAM,
    });
    await send(conn, payer, ix, [curator], "init_sy_params");
  }

  return { syMetadata, syMint, collateralVault, poolEscrow, klendCollateralMint };
}

// ---------------------------------------------------------------------------
// Step 4 — clearstone_curator::initialize_vault
// ---------------------------------------------------------------------------

interface CuratorVaultHandles {
  vault: PublicKey;
  baseEscrow: PublicKey;
  curator: PublicKey;
}

function buildCuratorInitVaultIx(args: {
  payer: PublicKey;
  curator: PublicKey;
  baseMint: PublicKey;
  vault: PublicKey;
  baseEscrow: PublicKey;
  feeBps: number;
}): TransactionInstruction {
  if (args.feeBps < 0 || args.feeBps > 2000) {
    throw new Error(`fee_bps must be in [0, 2000], got ${args.feeBps}`);
  }
  const data = Buffer.concat([CURATOR_INIT_VAULT_DISC, u16le(args.feeBps)]);

  const keys = [
    signerRw(args.payer),
    ro(args.curator),
    ro(args.baseMint),
    rw(args.vault),
    rw(args.baseEscrow),
    ro(TOKEN_PROGRAM_ID),
    ro(SystemProgram.programId),
    ro(SYSVAR_RENT_PUBKEY),
  ];

  return new TransactionInstruction({
    programId: CLEARSTONE_CURATOR,
    keys,
    data,
  });
}

async function step4InitializeVault(args: {
  conn: Connection;
  payer: Keypair;
  curator: PublicKey;
  feeBps: number;
}): Promise<CuratorVaultHandles> {
  const { conn, payer, curator, feeBps } = args;

  const [vault] = findCuratorVault(curator, USDC_MINT);
  const [baseEscrow] = findBaseEscrow(vault);

  console.log("Step 4 — clearstone_curator::initialize_vault");
  console.log(`  curator:            ${curator.toBase58()}`);
  console.log(`  base_mint USDC:     ${USDC_MINT.toBase58()}`);
  console.log(`  fee_bps:            ${feeBps}`);
  console.log(`  PDA vault:          ${vault.toBase58()}`);
  console.log(`  PDA base_escrow:    ${baseEscrow.toBase58()}`);

  if (await exists(conn, vault)) {
    console.log("  ↳ vault already exists, skipping init.");
  } else {
    const ix = buildCuratorInitVaultIx({
      payer: payer.publicKey,
      curator,
      baseMint: USDC_MINT,
      vault,
      baseEscrow,
      feeBps,
    });
    await send(conn, payer, ix, [], "initialize_vault");
  }

  return { vault, baseEscrow, curator };
}

// ---------------------------------------------------------------------------
// Step 5 — clearstone_curator::set_allocations
// ---------------------------------------------------------------------------

interface AllocationInput {
  market: PublicKey;
  weightBps: number;
  capBase: bigint;
}

function encodeAllocations(items: AllocationInput[]): Buffer {
  // Vec<Allocation> Borsh encoding:
  //   u32 length || repeated [Pubkey(32) || u16 weight_bps || u64 cap_base || u64 deployed_base]
  const parts: Buffer[] = [u32le(items.length)];
  for (const a of items) {
    parts.push(a.market.toBuffer());
    parts.push(u16le(a.weightBps));
    parts.push(u64le(a.capBase));
    parts.push(u64le(0n)); // deployed_base — initialized to 0
  }
  return Buffer.concat(parts);
}

function buildSetAllocationsIx(args: {
  vault: PublicKey;
  curator: PublicKey;
  allocations: AllocationInput[];
}): TransactionInstruction {
  const data = Buffer.concat([
    CURATOR_SET_ALLOCATIONS_DISC,
    encodeAllocations(args.allocations),
  ]);

  const keys = [
    rw(args.vault),
    signerRo(args.curator),
  ];

  return new TransactionInstruction({
    programId: CLEARSTONE_CURATOR,
    keys,
    data,
  });
}

async function step5SetAllocations(args: {
  conn: Connection;
  payer: Keypair;
  curator: Keypair;
  vault: PublicKey;
  allocations: AllocationInput[];
}): Promise<void> {
  const { conn, payer, curator, vault, allocations } = args;

  console.log("Step 5 — clearstone_curator::set_allocations");
  for (const a of allocations) {
    console.log(`  market ${a.market.toBase58()} weight=${a.weightBps}bps cap=${a.capBase}`);
  }
  const total = allocations.reduce((s, a) => s + a.weightBps, 0);
  if (total > 10_000) {
    throw new Error(`sum of weight_bps = ${total} > 10_000`);
  }

  const ix = buildSetAllocationsIx({
    vault,
    curator: curator.publicKey,
    allocations,
  });
  await send(conn, payer, ix, [curator], "set_allocations");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKeypair("DEPLOY_KEYPAIR");
  const curator = process.env.CURATOR_KEYPAIR
    ? loadKeypair("CURATOR_KEYPAIR")
    : payer;
  const feeBps = Number(process.env.FEE_BPS ?? "1000");
  const stepsRaw = process.env.STEPS ?? "1,4";
  const steps = new Set(stepsRaw.split(",").map((s) => s.trim()));

  console.log("=== Devnet curator-vault setup ===");
  console.log(`RPC:                ${RPC}`);
  console.log(`payer:              ${payer.publicKey.toBase58()}`);
  console.log(`curator:            ${curator.publicKey.toBase58()}`);
  console.log(`steps:              ${[...steps].sort().join(",")}`);
  if (process.env.DRY_RUN === "true") console.log("(DRY_RUN — no transactions sent)");
  console.log("");

  const klendCollateralMint = await readKusdcCollateralMint(conn);
  console.log(`Kamino kUSDC mint (read from reserve): ${klendCollateralMint.toBase58()}\n`);

  let syHandles: KaminoSyHandles | undefined;
  let vaultHandles: CuratorVaultHandles | undefined;

  if (steps.has("1")) {
    syHandles = await step1InitSyParams({ conn, payer, curator, klendCollateralMint });
    console.log("");
  }

  if (steps.has("2") || steps.has("3")) {
    console.log(
      "Steps 2 and 3 (clearstone_core::initialize_vault + init_market_two) " +
        "not implemented in this script — port the patterns from " +
        "clearstone-fixed-yield/tests/fixtures.ts (`setupVault` + `setupMarket`).\n"
    );
  }

  if (steps.has("4")) {
    vaultHandles = await step4InitializeVault({
      conn,
      payer,
      curator: curator.publicKey,
      feeBps,
    });
    console.log("");
  }

  if (steps.has("5")) {
    if (!vaultHandles) {
      const [vault] = findCuratorVault(curator.publicKey, USDC_MINT);
      vaultHandles = { vault, baseEscrow: findBaseEscrow(vault)[0], curator: curator.publicKey };
    }
    const marketEnv = process.env.MARKET_PDA;
    if (!marketEnv) throw new Error("Step 5 requires MARKET_PDA in env (the PT/SY market PDA from step 3).");
    const allocations: AllocationInput[] = [
      {
        market: new PublicKey(marketEnv),
        weightBps: Number(process.env.WEIGHT_BPS ?? "10000"),
        capBase: BigInt(process.env.CAP_BASE ?? "100000000000"),
      },
    ];
    await step5SetAllocations({
      conn,
      payer,
      curator,
      vault: vaultHandles.vault,
      allocations,
    });
    console.log("");
  }

  console.log("Done.");
  if (syHandles) {
    console.log("");
    console.log("Save for next steps:");
    console.log(`  SY_METADATA=${syHandles.syMetadata.toBase58()}`);
    console.log(`  SY_MINT=${syHandles.syMint.toBase58()}`);
    console.log(`  KAMINO_KUSDC_MINT=${klendCollateralMint.toBase58()}`);
  }
  if (vaultHandles) {
    console.log(`  CURATOR_VAULT=${vaultHandles.vault.toBase58()}`);
    console.log(`  BASE_ESCROW=${vaultHandles.baseEscrow.toBase58()}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
