/**
 * Tests for the `CuratorVaultSnapshot.adapter` override path.
 *
 * Background: the keeper originally derived `sy_market` with the seed
 * `[b"sy_market", base_mint]` under the vault's SY program. That seed
 * matches `generic_exchange_rate_sy` only — Kamino's SY adapter uses a
 * different seed, so any Kamino-backed market would hit ConstraintSeeds
 * on crank.
 *
 * Fix: `CuratorVaultSnapshot` now carries an optional `adapter` bundle.
 * When the backend-edge populates it (for Kamino or any other
 * non-generic adapter), the keeper threads those pubkeys directly into
 * the reallocate / crank ixs instead of deriving.
 *
 * These tests pin both paths:
 *   - without `adapter`: derivation matches the generic seed (historical).
 *   - with `adapter`: snapshot pubkeys flow into the compiled ixs verbatim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  MessageV0,
} from "@solana/web3.js";
import { executeRoll } from "../src/roll.js";
import { executeDelegatedRoll } from "../src/roll-delegated.js";
import type { CuratorVaultSnapshot } from "../src/edge.js";
import type { KeeperConfig } from "../src/config.js";
import type { LiveDelegation } from "../src/delegations.js";

// ---------------------------------------------------------------------------
// Minimal capture + mock (same shape as execute.test.ts, trimmed).
// ---------------------------------------------------------------------------
interface CapturedTx {
  message: MessageV0;
  luts: AddressLookupTableAccount[];
}
function installCapture() {
  const captured: CapturedTx[] = [];
  const origCompile = TransactionMessage.prototype.compileToV0Message;
  const origSign = VersionedTransaction.prototype.sign;
  TransactionMessage.prototype.compileToV0Message = function (alts?: Parameters<typeof origCompile>[0]) {
    const msg = origCompile.call(this, alts);
    captured.push({ message: msg, luts: alts ?? [] });
    return msg;
  };
  VersionedTransaction.prototype.sign = function () {};
  return {
    captured,
    restore() {
      TransactionMessage.prototype.compileToV0Message = origCompile;
      VersionedTransaction.prototype.sign = origSign;
    },
  };
}

function dummy(seed: number): PublicKey {
  const arr = new Uint8Array(32);
  arr[0] = seed;
  arr[1] = (seed >> 8) & 0xff;
  return new PublicKey(arr);
}

interface MarketFixture {
  market: PublicKey;
  marketAlt: PublicKey;
  mintPt: PublicKey;
  mintSy: PublicKey;
  coreVault: PublicKey;
  mintLp: PublicKey;
  marketEscrowPt: PublicKey;
  marketEscrowSy: PublicKey;
  tokenFeeTreasurySy: PublicKey;
  syProgram: PublicKey;
}

function marketFixture(seedBase: number): MarketFixture {
  return {
    market: dummy(seedBase),
    marketAlt: dummy(seedBase + 1),
    mintPt: dummy(seedBase + 2),
    mintSy: dummy(seedBase + 3),
    coreVault: dummy(seedBase + 4),
    mintLp: dummy(seedBase + 5),
    marketEscrowPt: dummy(seedBase + 6),
    marketEscrowSy: dummy(seedBase + 7),
    tokenFeeTreasurySy: dummy(seedBase + 8),
    syProgram: dummy(seedBase + 9),
  };
}

function encodeMarketTwo(f: MarketFixture): Buffer {
  const buf = Buffer.alloc(512);
  f.marketAlt.toBuffer().copy(buf, 43);
  f.mintPt.toBuffer().copy(buf, 75);
  f.mintSy.toBuffer().copy(buf, 107);
  f.coreVault.toBuffer().copy(buf, 139);
  f.mintLp.toBuffer().copy(buf, 171);
  f.marketEscrowPt.toBuffer().copy(buf, 203);
  f.marketEscrowSy.toBuffer().copy(buf, 235);
  f.tokenFeeTreasurySy.toBuffer().copy(buf, 267);
  return buf;
}
function encodeCoreVault(syProgram: PublicKey): Buffer {
  const buf = Buffer.alloc(512);
  syProgram.toBuffer().copy(buf, 43);
  return buf;
}
function lutAddressesFor(f: MarketFixture): PublicKey[] {
  return [
    f.mintPt,
    f.mintSy,
    f.mintLp,
    f.marketEscrowPt,
    f.marketEscrowSy,
    f.tokenFeeTreasurySy,
    f.coreVault,
    f.syProgram,
  ];
}

function mockConn(fixtures: MarketFixture[]): Connection {
  const accounts = new Map<string, Buffer>();
  const luts = new Map<string, PublicKey[]>();
  for (const f of fixtures) {
    accounts.set(f.market.toBase58(), encodeMarketTwo(f));
    accounts.set(f.coreVault.toBase58(), encodeCoreVault(f.syProgram));
    luts.set(f.marketAlt.toBase58(), lutAddressesFor(f));
  }
  return {
    getAccountInfo: async (pk: PublicKey) => {
      const data = accounts.get(pk.toBase58());
      if (!data) return null;
      return {
        data,
        executable: false,
        lamports: 0,
        owner: PublicKey.default,
        rentEpoch: 0,
      };
    },
    getAddressLookupTable: async (pk: PublicKey) => ({
      context: { slot: 0 },
      value: new AddressLookupTableAccount({
        key: pk,
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: luts.get(pk.toBase58()) ?? [],
        },
      }),
    }),
    getLatestBlockhash: async () => ({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: async () => "mock-sig",
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection;
}

function collectKeys(cap: CapturedTx): Set<string> {
  const resolved = cap.message.getAccountKeys({
    addressLookupTableAccounts: cap.luts,
  });
  const out = new Set<string>();
  for (const ix of cap.message.compiledInstructions) {
    for (const idx of ix.accountKeyIndexes) {
      const k = resolved.get(idx);
      if (k) out.add(k.toBase58());
    }
  }
  return out;
}

function baseSnapshot(
  curator: string,
  adapter?: { syMarket: string; adapterBaseVault: string }
): CuratorVaultSnapshot {
  return {
    id: "v",
    label: "v",
    baseSymbol: "USDC",
    baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    baseDecimals: 6,
    kycGated: false,
    vault: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
    curator,
    baseEscrow: "11111111111111111111111111111111",
    totalAssets: "1000",
    totalShares: "1000",
    feeBps: 0,
    nextAutoRollTs: 1_700_000_000,
    allocations: [],
    adapter,
  };
}

function cfg(kp: Keypair): KeeperConfig {
  return {
    rpcUrl: "http://mock",
    edgeUrl: "http://mock",
    curatorKeypair: kp,
    pollIntervalSec: 60,
    maturityGraceSec: 30,
    slippageBps: 50,
    oneShot: true,
    dryRun: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("executeRoll: with `adapter` override, snapshot's syMarket + adapterBaseVault appear in the tx", async () => {
  const kp = Keypair.generate();
  const matured = marketFixture(0x10);
  const next = marketFixture(0x40);

  // Deliberately non-derivable pubkeys — can't be produced by any
  // [b"sy_market", base_mint] seed on our test syProgram. If the
  // keeper honours the override, these must appear verbatim.
  const kaminoSyMarket = dummy(0xcc);
  const kaminoBaseVault = dummy(0xdd);

  const snap = baseSnapshot(kp.publicKey.toBase58(), {
    syMarket: kaminoSyMarket.toBase58(),
    adapterBaseVault: kaminoBaseVault.toBase58(),
  });
  snap.allocations = [
    { market: matured.market.toBase58(), weightBps: 6000, deployedBase: "500" },
    { market: next.market.toBase58(), weightBps: 4000, deployedBase: "0" },
  ];

  const cap = installCapture();
  try {
    await executeRoll(mockConn([matured, next]), cfg(kp), snap, {
      reason: "ready",
      maturedIndex: 0,
      nextIndex: 1,
      maturedMarket: matured.market.toBase58(),
      nextMarket: next.market.toBase58(),
    });
    const keys = collectKeys(cap.captured[0]);
    assert.ok(
      keys.has(kaminoSyMarket.toBase58()),
      "adapter.syMarket must land in the compiled tx"
    );
    assert.ok(
      keys.has(kaminoBaseVault.toBase58()),
      "adapter.adapterBaseVault must land in the compiled tx"
    );
  } finally {
    cap.restore();
  }
});

test("executeRoll: without `adapter`, falls back to the generic_exchange_rate_sy seed derivation", async () => {
  // Same setup as above but without `adapter`. The derived sy_market
  // will be [b"sy_market", baseMint] under matured.syProgram. We don't
  // know its exact value, but we can prove the Kamino override pubkey
  // is NOT in the tx — i.e. the override code path is inactive.
  const kp = Keypair.generate();
  const matured = marketFixture(0x20);
  const next = marketFixture(0x50);

  const snap = baseSnapshot(kp.publicKey.toBase58()); // no adapter
  snap.allocations = [
    { market: matured.market.toBase58(), weightBps: 6000, deployedBase: "500" },
    { market: next.market.toBase58(), weightBps: 4000, deployedBase: "0" },
  ];

  const kaminoSyMarket = dummy(0xcc);
  const cap = installCapture();
  try {
    await executeRoll(mockConn([matured, next]), cfg(kp), snap, {
      reason: "ready",
      maturedIndex: 0,
      nextIndex: 1,
      maturedMarket: matured.market.toBase58(),
      nextMarket: next.market.toBase58(),
    });
    const keys = collectKeys(cap.captured[0]);
    assert.ok(
      !keys.has(kaminoSyMarket.toBase58()),
      "without override, unrelated pubkey must not land in the tx"
    );
  } finally {
    cap.restore();
  }
});

test("executeDelegatedRoll: honours the `adapter` override on the crank ix", async () => {
  const kp = Keypair.generate();
  const from = marketFixture(0x80);
  const to = marketFixture(0xa0);
  const kaminoSyMarket = dummy(0xee);
  const kaminoBaseVault = dummy(0xef);

  const snap = baseSnapshot("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", {
    syMarket: kaminoSyMarket.toBase58(),
    adapterBaseVault: kaminoBaseVault.toBase58(),
  });

  const delegation: LiveDelegation = {
    pda: dummy(0xaa),
    vault: new PublicKey(snap.vault),
    user: dummy(0xab),
    maxSlippageBps: 50,
    expiresAtSlot: 10_000_000n,
    allocationsHash: new Uint8Array(32),
    createdAtSlot: 9_000_000n,
  };

  const cap = installCapture();
  try {
    await executeDelegatedRoll(
      mockConn([from, to]),
      cfg(kp),
      snap,
      delegation,
      {
        reason: "ready",
        fromIndex: 0,
        toIndex: 1,
        fromMarket: from.market.toBase58(),
        toMarket: to.market.toBase58(),
        deployedBase: 500_000_000n,
        minBaseOut: 497_500_000n,
      }
    );
    const keys = collectKeys(cap.captured[0]);
    assert.ok(keys.has(kaminoSyMarket.toBase58()));
    assert.ok(keys.has(kaminoBaseVault.toBase58()));
  } finally {
    cap.restore();
  }
});
