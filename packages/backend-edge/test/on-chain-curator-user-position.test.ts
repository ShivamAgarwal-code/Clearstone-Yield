/**
 * Integration tests for `fetchCuratorUserPosition` — the per-user
 * position endpoint the retail UI polls.
 *
 * This is where the pro-rata NAV math lives:
 *
 *   baseValue = shares × vault.totalAssets ÷ vault.totalShares
 *
 * Plus an earliest-maturity resolver over the vault's allocations. Both
 * are silent-drift risks: a bigint precision slip or `max < min` swap
 * would produce a plausible-looking but wrong display value for every
 * retail user.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import {
  CURATOR_VAULT_TOTAL_ASSETS_OFFSET,
  CURATOR_VAULT_TOTAL_SHARES_OFFSET,
  CURATOR_VAULT_FEE_BPS_OFFSET,
  CURATOR_VAULT_ALLOCATIONS_OFFSET,
  CURATOR_ALLOCATION_SIZE,
  CURATOR_USER_POSITION_SHARES_OFFSET,
} from "../src/fixed-yield.js";

// ---------------------------------------------------------------------------
// Buffer builders
// ---------------------------------------------------------------------------

function writePubkey(buf: Uint8Array, off: number, b58: string): void {
  buf.set(new PublicKey(b58).toBuffer(), off);
}
function writeU16(buf: Uint8Array, off: number, n: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint16(off, n, true);
}
function writeU32(buf: Uint8Array, off: number, n: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(off, n, true);
}
function writeU64(buf: Uint8Array, off: number, n: bigint): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(off, n, true);
}

function userPositionBuffer(shares: bigint): Uint8Array {
  const buf = new Uint8Array(CURATOR_USER_POSITION_SHARES_OFFSET + 8);
  writeU64(buf, CURATOR_USER_POSITION_SHARES_OFFSET, shares);
  return buf;
}

function curatorVaultBuffer(params: {
  totalAssets: bigint;
  totalShares: bigint;
  allocations?: Array<{ market: string; deployedBase: bigint }>;
}): Uint8Array {
  const allocs = params.allocations ?? [];
  const allocStart = CURATOR_VAULT_ALLOCATIONS_OFFSET + 4;
  const size = allocStart + allocs.length * CURATOR_ALLOCATION_SIZE + 1;
  const buf = new Uint8Array(size);
  writePubkey(buf, 8, "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2"); // curator
  writePubkey(buf, 40, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // baseMint
  writePubkey(buf, 72, "7HUgyqN5f1dQeebEgpKtC2Hue8oHCxVphGFsbaBJ3wAL"); // baseEscrow
  writeU64(buf, CURATOR_VAULT_TOTAL_ASSETS_OFFSET, params.totalAssets);
  writeU64(buf, CURATOR_VAULT_TOTAL_SHARES_OFFSET, params.totalShares);
  writeU16(buf, CURATOR_VAULT_FEE_BPS_OFFSET, 0);
  writeU32(buf, CURATOR_VAULT_ALLOCATIONS_OFFSET, allocs.length);
  for (let i = 0; i < allocs.length; i++) {
    const off = allocStart + i * CURATOR_ALLOCATION_SIZE;
    writePubkey(buf, off, allocs[i].market);
    writeU16(buf, off + 32, 10_000);
    writeU64(buf, off + 34, 0n);
    writeU64(buf, off + 42, allocs[i].deployedBase);
  }
  return buf;
}

function marketWithExpiry(expirationTs: number): Uint8Array {
  const buf = new Uint8Array(373);
  writeU64(buf, 365, BigInt(expirationTs));
  return buf;
}

function installConnectionPatch(accounts: Map<string, Uint8Array>): () => void {
  const orig = Connection.prototype.getMultipleAccountsInfo;
  Connection.prototype.getMultipleAccountsInfo = async function (keys) {
    return keys.map((k) => {
      const data = accounts.get(k.toBase58());
      if (!data) return null;
      return {
        data: data as unknown as Buffer,
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

/** Derive the user_pos PDA the handler uses internally. */
function userPosPda(vault: string, user: string): PublicKey {
  const [p] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("user_pos"),
      new PublicKey(vault).toBuffer(),
      new PublicKey(user).toBuffer(),
    ],
    new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm")
  );
  return p;
}

const ENV: Env = {
  SOLANA_RPC_URL: "http://mock",
} as unknown as Env;

const VAULT = "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA";
const USER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const MARKET_A = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MARKET_B = "So11111111111111111111111111111111111111112";

async function getPosition(vault: string, user: string) {
  const res = await app.fetch(
    new Request(
      `http://test/fixed-yield/curator-vaults/${vault}/positions/${user}`
    ),
    ENV
  );
  return (await res.json()) as {
    position: {
      shares: string;
      baseValue: string;
      nextAutoRollTs: number | null;
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("fetchCuratorUserPosition: happy path — shares + pro-rata baseValue + earliest maturity", async () => {
  // shares=100, totalShares=1_000, totalAssets=1_500 → baseValue = 150.
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(100n)],
    [
      VAULT,
      curatorVaultBuffer({
        totalAssets: 1_500n,
        totalShares: 1_000n,
        allocations: [
          { market: MARKET_A, deployedBase: 500n },
          { market: MARKET_B, deployedBase: 500n },
        ],
      }),
    ],
    [MARKET_A, marketWithExpiry(1_700_000_000)],
    [MARKET_B, marketWithExpiry(1_710_000_000)],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.shares, "100");
    assert.equal(body.position.baseValue, "150");
    assert.equal(body.position.nextAutoRollTs, 1_700_000_000);
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: pro-rata math uses bigint, no float truncation at large magnitudes", async () => {
  // shares = 1e9, totalShares = 1e9, totalAssets = 1.234e18 → baseValue = 1.234e18.
  // Confirms we don't round-trip through Number (which would lose precision).
  const huge = 1_234_567_890_123_456_789n;
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(1_000_000_000n)],
    [
      VAULT,
      curatorVaultBuffer({
        totalAssets: huge,
        totalShares: 1_000_000_000n,
      }),
    ],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.baseValue, huge.toString());
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: pro-rata floors instead of rounding (bigint /)", async () => {
  // shares=7, totalShares=10, totalAssets=100 → 7*100/10 = 70.
  // shares=3, totalShares=10, totalAssets=11  → 3*11/10  = 33/10 = 3 (floor).
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(3n)],
    [
      VAULT,
      curatorVaultBuffer({ totalAssets: 11n, totalShares: 10n }),
    ],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.baseValue, "3");
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: user_pos missing → empty position, no vault decode needed", async () => {
  // The handler must short-circuit when the user has never deposited.
  const accounts = new Map<string, Uint8Array>();
  // Vault *is* present, but user_pos is not — still returns empty.
  accounts.set(
    VAULT,
    curatorVaultBuffer({ totalAssets: 1n, totalShares: 1n })
  );
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.deepEqual(body.position, {
      shares: "0",
      baseValue: "0",
      nextAutoRollTs: null,
    });
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: user_pos present but zero shares → empty position", async () => {
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(0n)],
    [VAULT, curatorVaultBuffer({ totalAssets: 1n, totalShares: 1n })],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.shares, "0");
    assert.equal(body.position.baseValue, "0");
    assert.equal(body.position.nextAutoRollTs, null);
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: vault account missing → shares returned, baseValue 0, no crash", async () => {
  // Edge case: user_pos exists but vault didn't come back. Handler
  // should still surface shares (per-user truth) but can't compute NAV.
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(100n)],
    // VAULT deliberately absent.
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.shares, "100");
    assert.equal(body.position.baseValue, "0");
    assert.equal(body.position.nextAutoRollTs, null);
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: vault has zero totalShares → baseValue 0 (no divide-by-zero)", async () => {
  // Pre-first-deposit or fully-drained vault state.
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(100n)],
    [VAULT, curatorVaultBuffer({ totalAssets: 1_000n, totalShares: 0n })],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.baseValue, "0");
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: vault has no allocations → nextAutoRollTs is null", async () => {
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(50n)],
    [
      VAULT,
      curatorVaultBuffer({
        totalAssets: 500n,
        totalShares: 1_000n,
        allocations: [],
      }),
    ],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    // 50 × 500 / 1_000 = 25.
    assert.equal(body.position.shares, "50");
    assert.equal(body.position.baseValue, "25");
    assert.equal(body.position.nextAutoRollTs, null);
  } finally {
    restore();
  }
});

test("fetchCuratorUserPosition: earliest-maturity wins even when ordered last in the allocations vec", async () => {
  // Order matters: the handler iterates the vec linearly. If the min()
  // accidentally becomes a first-wins, this test flips.
  const accounts = new Map<string, Uint8Array>([
    [userPosPda(VAULT, USER).toBase58(), userPositionBuffer(1n)],
    [
      VAULT,
      curatorVaultBuffer({
        totalAssets: 1n,
        totalShares: 1n,
        allocations: [
          { market: MARKET_B, deployedBase: 1n },
          { market: MARKET_A, deployedBase: 1n },
        ],
      }),
    ],
    [MARKET_A, marketWithExpiry(1_650_000_000)],
    [MARKET_B, marketWithExpiry(1_700_000_000)],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const body = await getPosition(VAULT, USER);
    assert.equal(body.position.nextAutoRollTs, 1_650_000_000);
  } finally {
    restore();
  }
});
