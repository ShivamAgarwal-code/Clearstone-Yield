/**
 * Tests for the admin/mint + admin/market instruction builders.
 *
 * These are lower-traffic than the retail surface, but they're the
 * builders the KYC/whitelist admin console and market-init scripts
 * drive. Same risk profile: silent on-chain failure if the wire
 * bytes drift.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  initializeMint,
  addToWhitelist,
  mintTokens,
} from "../src/admin/mint.js";
import {
  createLendingMarket,
  initReserve,
  updateReserveConfig,
  u64Value,
  pubkeyValue,
  configBatch,
} from "../src/admin/market.js";
import {
  DELTA_MINT_PROGRAM_ID,
  KLEND_PROGRAM_ID,
  KLEND_GLOBAL_CONFIG,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  DISC,
  CONFIG_MODE,
} from "../src/common/constants.js";
import {
  whitelistPda,
  marketAuthorityPda,
  ata,
  reserveCollateralMintPda,
  reserveLiquiditySupplyPda,
  reserveCollateralSupplyPda,
  reserveFeeVaultPda,
} from "../src/common/pda.js";

const AUTH = new PublicKey("DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA");
const WALLET = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// ---------------------------------------------------------------------------
// admin/mint
// ---------------------------------------------------------------------------

test("initializeMint: programId + 4-key layout, mint keypair is signer", () => {
  const mintKp = Keypair.generate();
  const ix = initializeMint(AUTH, mintKp);
  assert.equal(ix.programId.toBase58(), DELTA_MINT_PROGRAM_ID.toBase58());
  assert.equal(ix.keys.length, 4);
  assert.equal(ix.keys[0].pubkey.toBase58(), AUTH.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, true);
  assert.equal(ix.keys[1].pubkey.toBase58(), mintKp.publicKey.toBase58());
  assert.equal(ix.keys[1].isSigner, true);
  assert.equal(ix.keys[2].pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(ix.keys[3].pubkey.toBase58(), SystemProgram.programId.toBase58());
  assert.deepEqual([...ix.data], [...DISC.initializeMint]);
});

test("addToWhitelist: discriminator + 32-byte wallet pubkey in data", () => {
  const mint = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const ix = addToWhitelist(AUTH, mint, WALLET);
  assert.equal(ix.data.length, 8 + 32);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.addToWhitelist]);
  assert.deepEqual([...ix.data.subarray(8)], [...WALLET.toBuffer()]);
  // Whitelist PDA at index 1 uses the documented seed.
  assert.equal(ix.keys[1].pubkey.toBase58(), whitelistPda(mint).toBase58());
});

test("mintTokens: data = disc + u64 LE amount", () => {
  const mint = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const ix = mintTokens(AUTH, mint, WALLET, 0x0102030405060708n);
  assert.equal(ix.data.length, 16);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.mintTokens]);
  assert.deepEqual(
    [...ix.data.subarray(8, 16)],
    [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]
  );
});

test("mintTokens: recipient ATA is resolved against TOKEN_2022", () => {
  const mint = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const ix = mintTokens(AUTH, mint, WALLET, 1n);
  const expectedAta = ata(mint, WALLET, TOKEN_2022_PROGRAM_ID);
  // Index 2 is the recipient ATA per the layout in admin/mint.ts.
  assert.equal(ix.keys[2].pubkey.toBase58(), expectedAta.toBase58());
});

// ---------------------------------------------------------------------------
// admin/market
// ---------------------------------------------------------------------------

test("createLendingMarket: data = disc + 32-byte quoteCurrency (zeroed by default)", () => {
  const kp = Keypair.generate();
  const ix = createLendingMarket(AUTH, kp);
  assert.equal(ix.data.length, 8 + 32);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.initLendingMarket]);
  for (let i = 8; i < 40; i++) assert.equal(ix.data[i], 0);
  assert.equal(ix.programId.toBase58(), KLEND_PROGRAM_ID.toBase58());
  // Market authority PDA is at index 2 by the layout in admin/market.ts.
  assert.equal(
    ix.keys[2].pubkey.toBase58(),
    marketAuthorityPda(kp.publicKey).toBase58()
  );
  // Global config at index 3.
  assert.equal(ix.keys[3].pubkey.toBase58(), KLEND_GLOBAL_CONFIG.toBase58());
});

test("createLendingMarket: honours caller-supplied 32-byte quoteCurrency", () => {
  const kp = Keypair.generate();
  const qc = Buffer.alloc(32, 0xab);
  const ix = createLendingMarket(AUTH, kp, qc);
  for (let i = 8; i < 40; i++) assert.equal(ix.data[i], 0xab);
});

test("initReserve: 14 accounts with resolved PDAs (supply, fee, cMint)", () => {
  const market = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const reserveKp = Keypair.generate();
  const mint = WALLET;
  const ix = initReserve(AUTH, market, reserveKp, mint);
  assert.equal(ix.keys.length, 14);
  // Signers: owner (0), reserve (3).
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[3].isSigner, true);
  assert.equal(ix.keys[3].pubkey.toBase58(), reserveKp.publicKey.toBase58());
  // Supply / fee / cMint PDAs land at documented slots.
  const r = reserveKp.publicKey;
  assert.equal(
    ix.keys[5].pubkey.toBase58(),
    reserveLiquiditySupplyPda(r, market).toBase58()
  );
  assert.equal(
    ix.keys[6].pubkey.toBase58(),
    reserveFeeVaultPda(r, market).toBase58()
  );
  assert.equal(
    ix.keys[7].pubkey.toBase58(),
    reserveCollateralMintPda(r, market).toBase58()
  );
  assert.equal(
    ix.keys[8].pubkey.toBase58(),
    reserveCollateralSupplyPda(r, market).toBase58()
  );
  assert.deepEqual([...ix.data], [...DISC.initReserve]);
});

test("updateReserveConfig: Borsh = disc + u32 mode + u32 len + value + bool skipValidation", () => {
  const market = WALLET;
  const reserve = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const value = u64Value(7_500n); // 75% LTV in bps
  const ix = updateReserveConfig(
    AUTH,
    market,
    reserve,
    CONFIG_MODE.UpdateLoanToValuePct,
    value,
    /* skipValidation */ false
  );
  // Layout: 8 disc + 4 mode + 4 veclen + 8 value + 1 bool = 25 bytes.
  assert.equal(ix.data.length, 25);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...DISC.updateReserveConfig]);
  // mode u32 LE
  assert.equal(
    ix.data.readUInt32LE(8),
    CONFIG_MODE.UpdateLoanToValuePct
  );
  // vec len u32 LE
  assert.equal(ix.data.readUInt32LE(12), 8);
  // value
  assert.equal(ix.data.readBigUInt64LE(16), 7_500n);
  // bool
  assert.equal(ix.data[24], 0);
});

test("updateReserveConfig: defaults skipValidation to true (for batching)", () => {
  const market = WALLET;
  const reserve = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const ix = updateReserveConfig(
    AUTH,
    market,
    reserve,
    CONFIG_MODE.UpdateBorrowLimit,
    u64Value(1_000_000n)
  );
  assert.equal(ix.data[ix.data.length - 1], 1);
});

test("u64Value / pubkeyValue: encode as expected", () => {
  const v = u64Value(0x1122334455667788n);
  assert.equal(v.length, 8);
  assert.equal(v.readBigUInt64LE(), 0x1122334455667788n);

  const pkBuf = pubkeyValue(WALLET);
  assert.deepEqual([...pkBuf], [...WALLET.toBuffer()]);
});

test("configBatch: one ix per update, all scoped to the same (market, reserve)", () => {
  const market = WALLET;
  const reserve = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
  const updates = [
    { mode: CONFIG_MODE.UpdateLoanToValuePct, value: u64Value(7_500n) },
    { mode: CONFIG_MODE.UpdateBorrowLimit, value: u64Value(1_000_000n) },
    { mode: CONFIG_MODE.UpdateDepositLimit, value: u64Value(2_000_000n) },
  ];
  const ixs = configBatch(AUTH, market, reserve, updates);
  assert.equal(ixs.length, 3);
  for (const ix of ixs) {
    assert.equal(ix.programId.toBase58(), KLEND_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[2].pubkey.toBase58(), market.toBase58());
    assert.equal(ix.keys[3].pubkey.toBase58(), reserve.toBase58());
  }
  // Per-mode discriminator lines up with the provided mode.
  assert.equal(ixs[0].data.readUInt32LE(8), CONFIG_MODE.UpdateLoanToValuePct);
  assert.equal(ixs[1].data.readUInt32LE(8), CONFIG_MODE.UpdateBorrowLimit);
  assert.equal(ixs[2].data.readUInt32LE(8), CONFIG_MODE.UpdateDepositLimit);
});
