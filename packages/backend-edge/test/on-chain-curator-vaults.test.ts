/**
 * Integration test for `getCuratorVaults` — the endpoint the auto-roll
 * keeper polls in production. Exercises the full on-chain decode:
 *
 *   1. `CURATOR_VAULT_REGISTRY` JSON parsed.
 *   2. Batch 1: fetch every CuratorVault account. Decode header + allocations.
 *   3. Batch 2: fetch every *distinct* allocation market. Read
 *      `financials.expiration_ts` @ 365 to resolve per-market maturity.
 *   4. Emit the DTO with `nextAutoRollTs` = earliest-maturity allocation.
 *
 * This is the keeper-facing contract: a drift in step 3's offset or
 * step 4's `min` resolution would produce an nextAutoRollTs that's
 * wrong by months, and the keeper would either roll early (slippage
 * loss) or sit indefinitely. Pin it.
 *
 * The handlers.test.ts suite already covers the empty-registry + URL
 * envelope path; this file complements with the live-decode branch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import type { CuratorVaultRegistryEntry } from "../src/fixed-yield.js";
import {
  CURATOR_VAULT_TOTAL_ASSETS_OFFSET,
  CURATOR_VAULT_TOTAL_SHARES_OFFSET,
  CURATOR_VAULT_FEE_BPS_OFFSET,
  CURATOR_VAULT_ALLOCATIONS_OFFSET,
  CURATOR_ALLOCATION_SIZE,
} from "../src/fixed-yield.js";

// ---------------------------------------------------------------------------
// Buffer builders for CuratorVault + MarketTwo accounts.
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

interface VaultFixture {
  curator: string;
  baseMint: string;
  baseEscrow: string;
  totalAssets: bigint;
  totalShares: bigint;
  feeBps: number;
  allocations: Array<{
    market: string;
    weightBps: number;
    capBase: bigint;
    deployedBase: bigint;
  }>;
}

function curatorVaultBuffer(f: VaultFixture): Uint8Array {
  const allocStart = CURATOR_VAULT_ALLOCATIONS_OFFSET + 4;
  const size = allocStart + f.allocations.length * CURATOR_ALLOCATION_SIZE + 1;
  const buf = new Uint8Array(size);
  writePubkey(buf, 8, f.curator);
  writePubkey(buf, 40, f.baseMint);
  writePubkey(buf, 72, f.baseEscrow);
  writeU64(buf, CURATOR_VAULT_TOTAL_ASSETS_OFFSET, f.totalAssets);
  writeU64(buf, CURATOR_VAULT_TOTAL_SHARES_OFFSET, f.totalShares);
  writeU16(buf, CURATOR_VAULT_FEE_BPS_OFFSET, f.feeBps);
  writeU32(buf, CURATOR_VAULT_ALLOCATIONS_OFFSET, f.allocations.length);
  for (let i = 0; i < f.allocations.length; i++) {
    const off = allocStart + i * CURATOR_ALLOCATION_SIZE;
    const a = f.allocations[i];
    writePubkey(buf, off, a.market);
    writeU16(buf, off + 32, a.weightBps);
    writeU64(buf, off + 34, a.capBase);
    writeU64(buf, off + 42, a.deployedBase);
  }
  return buf;
}

/** MarketTwo buffer sized just large enough for expiration_ts @ 365. */
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VAULT_PK = "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA";
const VAULT2_PK = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const CURATOR = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2";
const BASE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE_ESCROW = "7HUgyqN5f1dQeebEgpKtC2Hue8oHCxVphGFsbaBJ3wAL";
const MARKET_A = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MARKET_B = "So11111111111111111111111111111111111111112";

function baseRegistry(): CuratorVaultRegistryEntry[] {
  return [
    {
      id: "curator-usdc",
      label: "USDC Auto-Roll",
      baseSymbol: "USDC",
      baseDecimals: 6,
      kycGated: false,
      vault: VAULT_PK,
    },
  ];
}

function envWith(registry: CuratorVaultRegistryEntry[]): Env {
  return {
    CURATOR_VAULT_REGISTRY: JSON.stringify(registry),
    SOLANA_RPC_URL: "http://mock",
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("getCuratorVaults: decodes header + allocations + earliest-maturity nextAutoRollTs", async () => {
  const registry = baseRegistry();
  const vaultBuf = curatorVaultBuffer({
    curator: CURATOR,
    baseMint: BASE_MINT,
    baseEscrow: BASE_ESCROW,
    totalAssets: 1_000_000_000n,
    totalShares: 900_000_000n,
    feeBps: 200,
    allocations: [
      {
        market: MARKET_A,
        weightBps: 6000,
        capBase: 2_000_000_000n,
        deployedBase: 500_000_000n,
      },
      {
        market: MARKET_B,
        weightBps: 4000,
        capBase: 1_000_000_000n,
        deployedBase: 0n,
      },
    ],
  });
  const accounts = new Map<string, Uint8Array>([
    [VAULT_PK, vaultBuf],
    // Market A expires earlier → this should be nextAutoRollTs.
    [MARKET_A, marketWithExpiry(1_700_000_000)],
    [MARKET_B, marketWithExpiry(1_710_000_000)],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/curator-vaults"),
      envWith(registry)
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      vaults: Array<{
        id: string;
        vault: string;
        curator: string;
        baseMint: string;
        baseEscrow: string;
        totalAssets: string;
        totalShares: string;
        feeBps: number;
        nextAutoRollTs: number | null;
        allocations: Array<{
          market: string;
          weightBps: number;
          deployedBase: string;
        }>;
      }>;
    };
    assert.equal(body.vaults.length, 1);
    const v = body.vaults[0];
    assert.equal(v.id, "curator-usdc");
    assert.equal(v.vault, VAULT_PK);
    assert.equal(v.curator, CURATOR);
    assert.equal(v.baseMint, BASE_MINT, "header's baseMint overrides registry");
    assert.equal(v.baseEscrow, BASE_ESCROW);
    assert.equal(v.totalAssets, "1000000000");
    assert.equal(v.totalShares, "900000000");
    assert.equal(v.feeBps, 200);
    assert.equal(v.nextAutoRollTs, 1_700_000_000, "earliest expiry wins");
    assert.equal(v.allocations.length, 2);
    assert.equal(v.allocations[0].market, MARKET_A);
    assert.equal(v.allocations[0].weightBps, 6000);
    assert.equal(v.allocations[0].deployedBase, "500000000");
    assert.equal(v.allocations[1].weightBps, 4000);
    assert.equal(v.allocations[1].deployedBase, "0");
  } finally {
    restore();
  }
});

test("getCuratorVaults: nextAutoRollTs is null when every allocation market's RPC returns null", async () => {
  const registry = baseRegistry();
  const accounts = new Map<string, Uint8Array>([
    [
      VAULT_PK,
      curatorVaultBuffer({
        curator: CURATOR,
        baseMint: BASE_MINT,
        baseEscrow: BASE_ESCROW,
        totalAssets: 100n,
        totalShares: 100n,
        feeBps: 0,
        allocations: [
          {
            market: MARKET_A,
            weightBps: 10_000,
            capBase: 1_000n,
            deployedBase: 500n,
          },
        ],
      }),
    ],
    // MARKET_A deliberately absent → maturity lookup returns null.
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/curator-vaults"),
      envWith(registry)
    );
    const body = (await res.json()) as {
      vaults: Array<{ nextAutoRollTs: number | null }>;
    };
    assert.equal(body.vaults[0].nextAutoRollTs, null);
  } finally {
    restore();
  }
});

test("getCuratorVaults: dedupes allocation markets across vaults in the second batch", async () => {
  // Two vaults both pointing at MARKET_A — the handler builds a Set of
  // market pubkeys before the second RPC call, so it should fetch only
  // once. We can't observe the RPC call count directly from the route
  // response, but we can prove the result is consistent: both vaults'
  // nextAutoRollTs resolves to the same expiry.
  const registry: CuratorVaultRegistryEntry[] = [
    ...baseRegistry(),
    {
      id: "curator-usdc-2",
      label: "USDC Auto-Roll 2",
      baseSymbol: "USDC",
      baseDecimals: 6,
      kycGated: false,
      vault: VAULT2_PK,
    },
  ];
  const mkVault = (deployed: bigint): Uint8Array =>
    curatorVaultBuffer({
      curator: CURATOR,
      baseMint: BASE_MINT,
      baseEscrow: BASE_ESCROW,
      totalAssets: 1n,
      totalShares: 1n,
      feeBps: 0,
      allocations: [
        {
          market: MARKET_A,
          weightBps: 10_000,
          capBase: 1n,
          deployedBase: deployed,
        },
      ],
    });
  const accounts = new Map<string, Uint8Array>([
    [VAULT_PK, mkVault(100n)],
    [VAULT2_PK, mkVault(200n)],
    [MARKET_A, marketWithExpiry(1_700_000_000)],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/curator-vaults"),
      envWith(registry)
    );
    const body = (await res.json()) as {
      vaults: Array<{ id: string; nextAutoRollTs: number | null }>;
    };
    assert.equal(body.vaults.length, 2);
    for (const v of body.vaults) {
      assert.equal(v.nextAutoRollTs, 1_700_000_000);
    }
  } finally {
    restore();
  }
});

test("getCuratorVaults: skips vaults whose account RPC returns null (logs a warning, omits from result)", async () => {
  // Registry has two vaults but only one is resolvable. The handler
  // should drop the missing one rather than surfacing a partial entry.
  const registry: CuratorVaultRegistryEntry[] = [
    baseRegistry()[0],
    {
      id: "curator-missing",
      label: "Missing",
      baseSymbol: "USDC",
      baseDecimals: 6,
      kycGated: false,
      vault: VAULT2_PK,
    },
  ];
  const accounts = new Map<string, Uint8Array>([
    [
      VAULT_PK,
      curatorVaultBuffer({
        curator: CURATOR,
        baseMint: BASE_MINT,
        baseEscrow: BASE_ESCROW,
        totalAssets: 1n,
        totalShares: 1n,
        feeBps: 0,
        allocations: [],
      }),
    ],
    // VAULT2_PK intentionally missing.
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/curator-vaults"),
      envWith(registry)
    );
    const body = (await res.json()) as { vaults: Array<{ id: string }> };
    assert.equal(body.vaults.length, 1);
    assert.equal(body.vaults[0].id, "curator-usdc");
  } finally {
    restore();
  }
});

test("getCuratorVaults: empty allocations list → nextAutoRollTs null, allocations: []", async () => {
  const registry = baseRegistry();
  const accounts = new Map<string, Uint8Array>([
    [
      VAULT_PK,
      curatorVaultBuffer({
        curator: CURATOR,
        baseMint: BASE_MINT,
        baseEscrow: BASE_ESCROW,
        totalAssets: 0n,
        totalShares: 0n,
        feeBps: 0,
        allocations: [],
      }),
    ],
  ]);
  const restore = installConnectionPatch(accounts);
  try {
    const res = await app.fetch(
      new Request("http://test/fixed-yield/curator-vaults"),
      envWith(registry)
    );
    const body = (await res.json()) as {
      vaults: Array<{ nextAutoRollTs: number | null; allocations: unknown[] }>;
    };
    assert.equal(body.vaults[0].nextAutoRollTs, null);
    assert.deepEqual(body.vaults[0].allocations, []);
  } finally {
    restore();
  }
});

test("getCuratorVaults: CURATOR_VAULT_REGISTRY parse error returns empty list (no throw)", async () => {
  const badEnv = {
    CURATOR_VAULT_REGISTRY: "not-json",
    SOLANA_RPC_URL: "http://mock",
  } as unknown as Env;
  const res = await app.fetch(
    new Request("http://test/fixed-yield/curator-vaults"),
    badEnv
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { vaults: unknown[] };
  assert.deepEqual(body.vaults, []);
});
