/**
 * Integration tests for the `fetchMarketsOnChain` branch of
 * `/fixed-yield/markets` — the path that takes over once an operator
 * populates `MARKET_REGISTRY`.
 *
 * Coverage here complements fixed-yield-decoders.test.ts: the decoders
 * run against hand-built buffers, but this test also exercises the
 * orchestration (registry parse → batched getMultipleAccountsInfo →
 * per-entry decoration → JSON envelope). A drift between documented
 * field indices and the handler's orchestration-level indexing (e.g.
 * `infos[i * 2]` vs `infos[i * 2 + 1]`) only shows up here.
 *
 * Strategy: patch `Connection.prototype.getMultipleAccountsInfo` for the
 * duration of the test. Supplies hand-built Vault + MarketTwo buffers
 * at the documented offsets. Every handler creates its own Connection
 * inside the route, so a prototype patch is the simplest shim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import type { MarketRegistryEntry } from "../src/fixed-yield.js";
import {
  VAULT_START_TS_OFFSET,
  VAULT_DURATION_OFFSET,
  MARKET_PT_BALANCE_OFFSET,
  MARKET_SY_BALANCE_OFFSET,
} from "../src/fixed-yield.js";

// ---------------------------------------------------------------------------
// Buffer builders matching the documented layouts.
// ---------------------------------------------------------------------------

function vaultBuffer(startTs: number, duration: number): Uint8Array {
  const buf = new Uint8Array(512);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setUint32(VAULT_START_TS_OFFSET, startTs, true);
  v.setUint32(VAULT_DURATION_OFFSET, duration, true);
  return buf;
}

function marketBuffer(ptBalance: bigint, syBalance: bigint): Uint8Array {
  const buf = new Uint8Array(512);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setBigUint64(MARKET_PT_BALANCE_OFFSET, ptBalance, true);
  v.setBigUint64(MARKET_SY_BALANCE_OFFSET, syBalance, true);
  return buf;
}

function installConnectionPatch(accounts: Map<string, Uint8Array>): () => void {
  const orig = Connection.prototype.getMultipleAccountsInfo;
  Connection.prototype.getMultipleAccountsInfo = async function (keys) {
    return keys.map((k) => {
      const data = accounts.get(k.toBase58());
      if (!data) return null;
      return {
        data: data as unknown as Buffer, // web3.js types this as Buffer
        executable: false,
        lamports: 0,
        owner: PublicKey.default,
        rentEpoch: 0,
      };
    });
  } as typeof Connection.prototype.getMultipleAccountsInfo;
  return () => {
    Connection.prototype.getMultipleAccountsInfo = orig;
  };
}

// ---------------------------------------------------------------------------
// Minimal accounts DTO — required by the MarketRegistryEntry schema but
// not touched on the on-chain read path. Values are cosmetic.
// ---------------------------------------------------------------------------

const COSMETIC_ACCOUNTS = {
  syProgram: "11111111111111111111111111111111",
  syMarket: "11111111111111111111111111111111",
  syMint: "11111111111111111111111111111111",
  baseVault: "11111111111111111111111111111111",
  vaultAuthority: "11111111111111111111111111111111",
  yieldPosition: "11111111111111111111111111111111",
  mintPt: "11111111111111111111111111111111",
  mintYt: "11111111111111111111111111111111",
  escrowSy: "11111111111111111111111111111111",
  vaultAlt: "11111111111111111111111111111111",
  coreEventAuthority: "11111111111111111111111111111111",
  mintLp: "11111111111111111111111111111111",
  marketEscrowPt: "11111111111111111111111111111111",
  marketEscrowSy: "11111111111111111111111111111111",
  marketAlt: "11111111111111111111111111111111",
  tokenFeeTreasurySy: "11111111111111111111111111111111",
};

function makeRegistry(): MarketRegistryEntry[] {
  return [
    {
      id: "usdc-30d",
      label: "USDC · 30d",
      baseSymbol: "USDC",
      baseDecimals: 6,
      kycGated: false,
      vault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      market: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
      baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      accounts: COSMETIC_ACCOUNTS,
    },
    {
      id: "usdt-90d",
      label: "USDT · 90d (KYC)",
      baseSymbol: "USDT",
      baseDecimals: 6,
      kycGated: true,
      vault: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      market: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
      baseMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      accounts: COSMETIC_ACCOUNTS,
    },
  ];
}

function envWith(registry: MarketRegistryEntry[]): Env {
  return {
    MARKET_REGISTRY: JSON.stringify(registry),
    SOLANA_RPC_URL: "http://mock",
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("fetchMarketsOnChain: returns decoded markets when registry + RPC both populated", async () => {
  const registry = makeRegistry();
  const startTs = 1_700_000_000;
  const duration = 30 * 86_400;

  const accounts = new Map<string, Uint8Array>([
    [registry[0].vault, vaultBuffer(startTs, duration)],
    [registry[0].market, marketBuffer(1_000_000n, 990_000n)], // 0.99
    [registry[1].vault, vaultBuffer(startTs, 90 * 86_400)],
    [registry[1].market, marketBuffer(1_000_000n, 950_000n)], // 0.95
  ]);

  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/markets"),
      envWith(registry)
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      markets: Array<{
        id: string;
        maturityTs: number;
        ptPrice: number;
        kycGated: boolean;
        accounts: Record<string, string>;
      }>;
    };
    assert.equal(body.markets.length, 2);

    // Entry 0: 30d market, PT ~0.99.
    assert.equal(body.markets[0].id, "usdc-30d");
    assert.equal(body.markets[0].maturityTs, startTs + duration);
    assert.ok(Math.abs(body.markets[0].ptPrice - 0.99) < 1e-9);
    assert.equal(body.markets[0].kycGated, false);
    assert.ok(body.markets[0].accounts); // passthrough from registry

    // Entry 1: 90d market, PT 0.95, KYC-gated.
    assert.equal(body.markets[1].id, "usdt-90d");
    assert.equal(body.markets[1].maturityTs, startTs + 90 * 86_400);
    assert.ok(Math.abs(body.markets[1].ptPrice - 0.95) < 1e-9);
    assert.equal(body.markets[1].kycGated, true);
  } finally {
    restore();
  }
});

test("fetchMarketsOnChain: skips entries whose RPC returns null", async () => {
  const registry = makeRegistry();
  // Only register entry 0's accounts. Entry 1's vault + market return null.
  const accounts = new Map<string, Uint8Array>([
    [registry[0].vault, vaultBuffer(1_700_000_000, 30 * 86_400)],
    [registry[0].market, marketBuffer(1_000_000n, 980_000n)],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/markets"),
      envWith(registry)
    );
    const body = (await res.json()) as { markets: Array<{ id: string }> };
    // Entry 0 decoded, entry 1 skipped, falls through to the fixture path
    // only if the live path returned nothing — here we got 1 live result,
    // so `getMarkets` returns the live array (fixture is the last-resort
    // branch when `live && live.length > 0` is false).
    assert.equal(body.markets.length, 1);
    assert.equal(body.markets[0].id, "usdc-30d");
  } finally {
    restore();
  }
});

test("fetchMarketsOnChain: falls back to fixture when every entry's RPC is missing", async () => {
  const registry = makeRegistry();
  const accounts = new Map<string, Uint8Array>(); // every lookup → null
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/markets"),
      envWith(registry)
    );
    const body = (await res.json()) as { markets: Array<{ id: string }> };
    // All live entries missing → live array is empty → falls through to
    // the 3-entry fixture.
    assert.equal(body.markets.length, 3);
    // Fixture entries have stable `fx-*` ids.
    for (const m of body.markets) {
      assert.ok(m.id.startsWith("fx-"), `expected fixture id, got ${m.id}`);
    }
  } finally {
    restore();
  }
});

test("fetchMarketsOnChain: registry parse error falls through to fixture", async () => {
  const badEnv = {
    MARKET_REGISTRY: "not-json",
    SOLANA_RPC_URL: "http://mock",
  } as unknown as Env;
  // Don't patch Connection — parse failure should never reach it.
  const res = await app.fetch(
    new Request("http://test/fixed-yield/markets"),
    badEnv
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { markets: Array<{ id: string }> };
  assert.ok(
    body.markets.every((m) => m.id.startsWith("fx-")),
    "malformed registry must fall through to the fixture"
  );
});

test("fetchMarketsOnChain: orchestration-level index math — infos[i*2] is vault, [i*2+1] is market", async () => {
  // If the handler ever accidentally reads `infos[i]` instead of
  // `infos[i*2]` the decoder would try to pull market_pt_balance from
  // the Vault buffer at offset 373, which has rent-epoch-ish bytes and
  // would produce wild values. Catch that by assigning distinct markers
  // so a swap flips the expected maturity/price.
  const registry = makeRegistry();
  const accounts = new Map<string, Uint8Array>([
    // Entry 0's vault encodes a maturity near 1_705_000_000.
    [registry[0].vault, vaultBuffer(1_700_000_000, 5_000_000)],
    [registry[0].market, marketBuffer(1_000_000n, 900_000n)], // 0.9
    [registry[1].vault, vaultBuffer(1_600_000_000, 10_000)],
    [registry[1].market, marketBuffer(1_000_000n, 800_000n)], // 0.8
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/markets"),
      envWith(registry)
    );
    const body = (await res.json()) as {
      markets: Array<{ id: string; maturityTs: number; ptPrice: number }>;
    };
    assert.equal(body.markets[0].maturityTs, 1_705_000_000);
    assert.equal(body.markets[1].maturityTs, 1_600_010_000);
    assert.ok(Math.abs(body.markets[0].ptPrice - 0.9) < 1e-9);
    assert.ok(Math.abs(body.markets[1].ptPrice - 0.8) < 1e-9);
  } finally {
    restore();
  }
});
