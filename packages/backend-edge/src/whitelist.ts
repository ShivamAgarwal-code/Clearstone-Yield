import { Hono } from "hono";
import type { Env, WhitelistRecord } from "./types.js";

const whitelist = new Hono<{ Bindings: Env }>();

// delta-mint program ID
const DELTA_MINT_PROGRAM = "13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn";

// WhitelistEntry account size: discriminator(8) + wallet(32) + mint_config(32) + approved(1) + role(1) + approved_at(8) + bump(1) = 83
const WHITELIST_ENTRY_SIZE = 83;

// Known pools — map mint_config pubkeys to human-readable names
const POOL_NAMES: Record<string, string> = {
  JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD: "eUSX (Yield Vault)",
  GjKooeks153zrhHSyxjnigWukHANbg2ydKZ8qMrY9SAg: "USX (Stablecoin)",
  "9mFCzbnAUSM5fUgCbkvbSoKiXizpRePhWcCQr7RpyQMo": "tUSDY (Test USDY)",
  C8XZRejf1vaLRpLWqCZSjegzyAFFdfpBZKXFhs7kSDLs: "Legacy Pool",
};

/** Decode a base58 pubkey from 32 raw bytes. */
function bytesToBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(0);
  for (const b of bytes) num = num * 256n + BigInt(b);
  let str = "";
  while (num > 0n) {
    str = ALPHABET[Number(num % 58n)] + str;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) str = "1" + str;
    else break;
  }
  return str;
}

/** Parse WhitelistEntry account data (83 bytes). */
function parseWhitelistEntry(data: Uint8Array): Omit<WhitelistRecord, "poolName"> | null {
  if (data.length < WHITELIST_ENTRY_SIZE) return null;

  // Skip 8-byte discriminator
  const wallet = bytesToBase58(data.slice(8, 40));
  const mintConfig = bytesToBase58(data.slice(40, 72));
  const approved = data[72] === 1;
  const role = data[73] === 0 ? "Holder" as const : "Liquidator" as const;

  // approved_at: i64 little-endian at offset 74
  const view = new DataView(data.buffer, data.byteOffset + 74, 8);
  const approvedAt = Number(view.getBigInt64(0, true));

  return { wallet, mintConfig, role, approved, approvedAt };
}

async function fetchWhitelistFromChain(rpcUrl: string): Promise<WhitelistRecord[]> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getProgramAccounts",
    params: [
      DELTA_MINT_PROGRAM,
      {
        encoding: "base64",
        filters: [{ dataSize: WHITELIST_ENTRY_SIZE }],
      },
    ],
  };

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as {
    result?: Array<{ account: { data: [string, string] } }>;
    error?: { message: string };
  };

  if (json.error) throw new Error(json.error.message);
  if (!json.result) return [];

  const records: WhitelistRecord[] = [];

  for (const item of json.result) {
    const raw = Uint8Array.from(atob(item.account.data[0]), (c) => c.charCodeAt(0));
    const parsed = parseWhitelistEntry(raw);
    if (!parsed) continue;

    records.push({
      ...parsed,
      poolName: POOL_NAMES[parsed.mintConfig] ?? "Unknown Pool",
    });
  }

  return records;
}

/**
 * GET /whitelist
 * Returns full whitelist from all delta-mint pools.
 * Cached in KV for 60s to avoid hammering RPC.
 */
whitelist.get("/", async (c) => {
  const cacheKey = "all-whitelist";
  const cached = await c.env.WHITELIST_CACHE.get(cacheKey);

  if (cached) {
    return c.json({ success: true, cached: true, ...JSON.parse(cached) });
  }

  try {
    const records = await fetchWhitelistFromChain(c.env.SOLANA_RPC_URL);

    const payload = {
      data: records,
      count: records.length,
      pools: [...new Set(records.map((r) => r.poolName))],
      fetchedAt: new Date().toISOString(),
    };

    await c.env.WHITELIST_CACHE.put(cacheKey, JSON.stringify(payload), {
      expirationTtl: 60,
    });

    return c.json({ success: true, cached: false, ...payload });
  } catch (err: any) {
    return c.json({ success: false, error: err.message ?? "RPC error" }, 502);
  }
});

/**
 * GET /whitelist/:wallet
 * Returns whitelist entries for a specific wallet.
 */
whitelist.get("/:wallet", async (c) => {
  const wallet = c.req.param("wallet");

  // Try cache first
  const cacheKey = "all-whitelist";
  let records: WhitelistRecord[];

  const cached = await c.env.WHITELIST_CACHE.get(cacheKey);
  if (cached) {
    records = JSON.parse(cached).data;
  } else {
    try {
      records = await fetchWhitelistFromChain(c.env.SOLANA_RPC_URL);
    } catch (err: any) {
      return c.json({ success: false, error: err.message ?? "RPC error" }, 502);
    }
  }

  const filtered = records.filter((r) => r.wallet === wallet);

  return c.json({
    success: true,
    data: filtered,
    count: filtered.length,
    wallet,
  });
});

export { whitelist };
