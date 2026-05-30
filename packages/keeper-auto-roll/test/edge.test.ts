/**
 * Unit tests for the edge HTTP client.
 *
 * `fetchCuratorVaults` is the single ingress point for the keeper — if
 * it drifts (wrong path, wrong envelope) the keeper sees an empty vault
 * list and silently idles. Pin the URL shape and error path so a server
 * regression surfaces here rather than in keeper logs at 3am.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCuratorVaults } from "../src/edge.js";

// Preserve-restore pattern keeps tests independent — each one installs
// its own fetch, then rolls back.
function withFetch<T>(
  fn: typeof globalThis.fetch,
  block: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return block().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchCuratorVaults: issues GET /fixed-yield/curator-vaults", async () => {
  let capturedUrl: string | URL = "";
  const mock: typeof globalThis.fetch = async (input) => {
    capturedUrl = typeof input === "string" || input instanceof URL ? input : (input as Request).url;
    return jsonResponse({ vaults: [] });
  };
  await withFetch(mock, async () => {
    await fetchCuratorVaults("https://edge.test");
  });
  assert.equal(String(capturedUrl), "https://edge.test/fixed-yield/curator-vaults");
});

test("fetchCuratorVaults: unwraps { vaults: [...] } envelope", async () => {
  const snapshot = {
    id: "vault-1",
    label: "USDC Vault",
    baseSymbol: "USDC",
    baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    baseDecimals: 6,
    kycGated: false,
    vault: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    curator: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
    baseEscrow: "11111111111111111111111111111111",
    totalAssets: "1000",
    totalShares: "1000",
    feeBps: 100,
    nextAutoRollTs: 1_700_000_000,
    allocations: [],
  };
  const result = await withFetch(
    async () => jsonResponse({ vaults: [snapshot] }),
    () => fetchCuratorVaults("https://edge.test")
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "vault-1");
  assert.equal(result[0].feeBps, 100);
});

test("fetchCuratorVaults: throws on non-2xx with the status code in the message", async () => {
  await withFetch(
    async () => new Response("boom", { status: 503 }),
    async () => {
      await assert.rejects(
        () => fetchCuratorVaults("https://edge.test"),
        /503/
      );
    }
  );
});

test("fetchCuratorVaults: tolerates empty vault list", async () => {
  const result = await withFetch(
    async () => jsonResponse({ vaults: [] }),
    () => fetchCuratorVaults("https://edge.test")
  );
  assert.deepEqual(result, []);
});

test("fetchCuratorVaults: respects the caller-supplied base URL", async () => {
  let capturedUrl: string | URL = "";
  const mock: typeof globalThis.fetch = async (input) => {
    capturedUrl = typeof input === "string" || input instanceof URL ? input : (input as Request).url;
    return jsonResponse({ vaults: [] });
  };
  await withFetch(mock, async () => {
    await fetchCuratorVaults("https://different.host:8080/api/v2");
  });
  assert.equal(
    String(capturedUrl),
    "https://different.host:8080/api/v2/fixed-yield/curator-vaults"
  );
});
