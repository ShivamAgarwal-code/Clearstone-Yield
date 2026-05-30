/**
 * HTTP-handler tests for /whitelist.
 *
 * The whitelist module shells out to Solana RPC via raw `fetch` (not
 * `@solana/web3.js`), so the fetch shim pattern from edge.test.ts
 * transfers cleanly.
 *
 * Coverage focus:
 *   - Cache-hit path (KV returns JSON, no RPC call).
 *   - RPC happy path (parse WhitelistEntry layout, attach POOL_NAMES).
 *   - Per-wallet filter.
 *   - Error path (RPC returns JSON-RPC error).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

function memKV() {
  const store = new Map<string, string>();
  return {
    async get(k: string): Promise<string | null> {
      return store.get(k) ?? null;
    },
    async put(k: string, v: string): Promise<void> {
      store.set(k, v);
    },
    async delete(k: string): Promise<void> {
      store.delete(k);
    },
    _store: store,
  };
}

function env() {
  return {
    WHITELIST_CACHE: memKV() as unknown as KVNamespace,
    SOLANA_RPC_URL: "http://mock-rpc",
  } as unknown as Env;
}

function withFetch<T>(
  fn: typeof globalThis.fetch,
  block: () => Promise<T>
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  return block().finally(() => {
    globalThis.fetch = orig;
  });
}

/**
 * Build an 83-byte WhitelistEntry account payload matching the on-chain
 * layout documented in src/whitelist.ts.
 *
 *   8     discriminator
 *   32    wallet
 *   32    mint_config
 *   1     approved
 *   1     role (0=Holder, 1=Liquidator)
 *   8     approved_at (i64 LE)
 *   1     bump
 */
function encodeEntry(params: {
  wallet: string;
  mintConfig: string;
  approved: boolean;
  role: "Holder" | "Liquidator";
  approvedAt: number;
}): string {
  const buf = new Uint8Array(83);
  new PublicKey(params.wallet).toBuffer().copy(buf, 8);
  new PublicKey(params.mintConfig).toBuffer().copy(buf, 40);
  buf[72] = params.approved ? 1 : 0;
  buf[73] = params.role === "Holder" ? 0 : 1;
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigInt64(
    74,
    BigInt(params.approvedAt),
    true
  );
  buf[82] = 255;
  // Base64 encode the 83-byte blob the way @solana RPC returns it.
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

const KNOWN_POOL = "JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD"; // eUSX
const WALLET_A = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const WALLET_B = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2";

// ---------------------------------------------------------------------------
// GET / (list all)
// ---------------------------------------------------------------------------

test("GET /whitelist: RPC happy path decodes entries + attaches pool name", async () => {
  const encoded = encodeEntry({
    wallet: WALLET_A,
    mintConfig: KNOWN_POOL,
    approved: true,
    role: "Holder",
    approvedAt: 1_700_000_000,
  });
  const mockFetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: [{ account: { data: [encoded, "base64"] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const body = await withFetch(mockFetch, async () => {
    const res = await app.fetch(new Request("http://test/whitelist"), env());
    return (await res.json()) as {
      success: boolean;
      cached: boolean;
      data: Array<{
        wallet: string;
        mintConfig: string;
        role: string;
        approved: boolean;
        approvedAt: number;
        poolName: string;
      }>;
      pools: string[];
    };
  });
  assert.equal(body.success, true);
  assert.equal(body.cached, false);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].wallet, WALLET_A);
  assert.equal(body.data[0].mintConfig, KNOWN_POOL);
  assert.equal(body.data[0].role, "Holder");
  assert.equal(body.data[0].approved, true);
  assert.equal(body.data[0].approvedAt, 1_700_000_000);
  assert.equal(body.data[0].poolName, "eUSX (Yield Vault)");
  assert.deepEqual(body.pools, ["eUSX (Yield Vault)"]);
});

test("GET /whitelist: unknown mintConfig maps to 'Unknown Pool'", async () => {
  const UNKNOWN_POOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const encoded = encodeEntry({
    wallet: WALLET_A,
    mintConfig: UNKNOWN_POOL,
    approved: false,
    role: "Liquidator",
    approvedAt: 0,
  });
  const mockFetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: [{ account: { data: [encoded, "base64"] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const body = await withFetch(mockFetch, async () => {
    const res = await app.fetch(new Request("http://test/whitelist"), env());
    return (await res.json()) as {
      data: Array<{ poolName: string; role: string; approved: boolean }>;
    };
  });
  assert.equal(body.data[0].poolName, "Unknown Pool");
  assert.equal(body.data[0].role, "Liquidator");
  assert.equal(body.data[0].approved, false);
});

test("GET /whitelist: cached path returns KV payload without hitting RPC", async () => {
  const e = env();
  const payload = {
    data: [
      {
        wallet: WALLET_A,
        mintConfig: KNOWN_POOL,
        role: "Holder",
        approved: true,
        approvedAt: 1,
        poolName: "eUSX (Yield Vault)",
      },
    ],
    count: 1,
    pools: ["eUSX (Yield Vault)"],
    fetchedAt: "2024-01-01T00:00:00.000Z",
  };
  await (e.WHITELIST_CACHE as unknown as KVNamespace).put(
    "all-whitelist",
    JSON.stringify(payload)
  );

  let rpcCalled = false;
  const mockFetch: typeof globalThis.fetch = async () => {
    rpcCalled = true;
    return new Response("", { status: 500 });
  };
  const body = await withFetch(mockFetch, async () => {
    const res = await app.fetch(new Request("http://test/whitelist"), e);
    return (await res.json()) as { cached: boolean; data: unknown[] };
  });
  assert.equal(rpcCalled, false, "cached response must not hit RPC");
  assert.equal(body.cached, true);
  assert.equal(body.data.length, 1);
});

test("GET /whitelist: 502 when RPC returns a JSON-RPC error", async () => {
  const mockFetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "rate-limited" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const res = await withFetch(mockFetch, async () =>
    app.fetch(new Request("http://test/whitelist"), env())
  );
  assert.equal(res.status, 502);
  const body = (await res.json()) as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.match(body.error, /rate-limited/);
});

// ---------------------------------------------------------------------------
// GET /:wallet
// ---------------------------------------------------------------------------

test("GET /whitelist/:wallet: filters RPC results to the requested wallet", async () => {
  const entryA = encodeEntry({
    wallet: WALLET_A,
    mintConfig: KNOWN_POOL,
    approved: true,
    role: "Holder",
    approvedAt: 1,
  });
  const entryB = encodeEntry({
    wallet: WALLET_B,
    mintConfig: KNOWN_POOL,
    approved: true,
    role: "Holder",
    approvedAt: 2,
  });
  const mockFetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: [
          { account: { data: [entryA, "base64"] } },
          { account: { data: [entryB, "base64"] } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const body = await withFetch(mockFetch, async () => {
    const res = await app.fetch(
      new Request(`http://test/whitelist/${WALLET_A}`),
      env()
    );
    return (await res.json()) as {
      data: Array<{ wallet: string }>;
      count: number;
      wallet: string;
    };
  });
  assert.equal(body.wallet, WALLET_A);
  assert.equal(body.count, 1);
  assert.equal(body.data[0].wallet, WALLET_A);
});

test("GET /whitelist/:wallet: returns empty when no entries match", async () => {
  const entryB = encodeEntry({
    wallet: WALLET_B,
    mintConfig: KNOWN_POOL,
    approved: true,
    role: "Holder",
    approvedAt: 2,
  });
  const mockFetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: [{ account: { data: [entryB, "base64"] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const body = await withFetch(mockFetch, async () => {
    const res = await app.fetch(
      new Request(`http://test/whitelist/${WALLET_A}`),
      env()
    );
    return (await res.json()) as { count: number; data: unknown[] };
  });
  assert.equal(body.count, 0);
  assert.deepEqual(body.data, []);
});
