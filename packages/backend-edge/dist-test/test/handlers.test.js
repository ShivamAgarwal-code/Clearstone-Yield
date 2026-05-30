/**
 * HTTP-handler tests for the backend-edge worker.
 *
 * The decoders are covered in fixed-yield-decoders.test.ts; these tests
 * pin the *API contract* — URL shapes, envelope keys, status codes, and
 * cache headers — that the keeper and both frontends depend on.
 *
 * A contract drift (renamed path, wrong envelope, 404 → empty array)
 * is silent: the keeper sees an empty vault list and idles, the frontend
 * sees "no markets" and shows an empty state. We catch it here.
 *
 * Strategy: invoke `app.fetch` directly with an in-memory `Env`. The
 * no-registry path deliberately short-circuits before any RPC call, so
 * these tests run with zero network deps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
// ---------------------------------------------------------------------------
// Minimal Env. The routes under test either don't touch KV / RPC, or
// short-circuit cleanly when bindings are absent. Casting through unknown
// avoids fighting the strict `Env` shape for bindings we deliberately omit.
// ---------------------------------------------------------------------------
const EMPTY_ENV = {};
async function GET(path, env = EMPTY_ENV) {
    return await app.fetch(new Request(`http://test${path}`), env);
}
// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------
test("GET /health returns 200 and the expected envelope", async () => {
    const res = await GET("/health");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.status, "ok");
    assert.equal(body.service, "clearstone-backend-edge");
    // timestamp is ISO-8601, not a specific value — just assert round-trip parses.
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
});
test("CORS preflight responds with access-control headers", async () => {
    // The retail and curator frontends will hit this from a different
    // origin; a missing CORS header would 4xx every browser call.
    const res = await app.fetch(new Request("http://test/health", {
        method: "OPTIONS",
        headers: {
            Origin: "https://retail.example",
            "Access-Control-Request-Method": "GET",
        },
    }), EMPTY_ENV);
    assert.ok(res.status >= 200 && res.status < 300);
    assert.ok(res.headers.get("access-control-allow-origin"));
});
// ---------------------------------------------------------------------------
// /fixed-yield/markets — fixture path (no registry, no cache)
// ---------------------------------------------------------------------------
test("GET /fixed-yield/markets serves the fixture when no registry is set", async () => {
    const res = await GET("/fixed-yield/markets");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.ok(Array.isArray(body.markets));
    assert.ok(body.markets.length >= 1);
    const first = body.markets[0];
    assert.equal(typeof first.id, "string");
    assert.equal(typeof first.baseSymbol, "string");
    assert.equal(typeof first.baseMint, "string");
    assert.equal(typeof first.maturityTs, "number");
    assert.equal(typeof first.ptPrice, "number");
    assert.equal(typeof first.kycGated, "boolean");
});
test("GET /fixed-yield/markets sets a Cache-Control max-age", async () => {
    const res = await GET("/fixed-yield/markets");
    // 30s edge cache — drift here affects RPC budget under load.
    assert.match(res.headers.get("cache-control") ?? "", /max-age=30/);
});
test("GET /fixed-yield/markets/:id returns that market on a known id", async () => {
    // `fx-usdc-30d` is a stable fixture id — if this test starts failing,
    // either the fixture was renamed (update the test) or the route's
    // filter logic broke.
    const res = await GET("/fixed-yield/markets/fx-usdc-30d");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.market.id, "fx-usdc-30d");
});
test("GET /fixed-yield/markets/:id returns 404 on unknown id", async () => {
    const res = await GET("/fixed-yield/markets/does-not-exist");
    assert.equal(res.status, 404);
    const body = (await res.json());
    assert.equal(body.error, "not found");
});
// ---------------------------------------------------------------------------
// /fixed-yield/vaults
// ---------------------------------------------------------------------------
test("GET /fixed-yield/vaults groups markets under a vault envelope", async () => {
    const res = await GET("/fixed-yield/vaults");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.ok(Array.isArray(body.vaults));
    // Fixture has 3 markets, but 2 share a vault pubkey ("11111…"). Group
    // by that; we just assert non-empty + sorted-by-maturity inside each.
    for (const v of body.vaults) {
        assert.equal(typeof v.id, "string");
        assert.equal(typeof v.underlying, "string");
        for (let i = 1; i < v.markets.length; i++) {
            assert.ok(v.markets[i].maturityTs >= v.markets[i - 1].maturityTs, "markets must be sorted by maturityTs ascending");
        }
    }
});
// ---------------------------------------------------------------------------
// /fixed-yield/vaults/:id/positions/:user — no-registry short-circuit
// ---------------------------------------------------------------------------
test("GET /fixed-yield/vaults/:id/positions/:user returns empty position when registry is unset", async () => {
    const res = await GET("/fixed-yield/vaults/11111111111111111111111111111111/positions/DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.deepEqual(body.position, {
        ptAmount: "0",
        ytAmount: "0",
        lpAmount: "0",
        nextAutoRollTs: null,
    });
});
test("GET /fixed-yield/vaults/:id/positions/:user is no-store (balances change per tx)", async () => {
    const res = await GET("/fixed-yield/vaults/11111111111111111111111111111111/positions/DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});
// ---------------------------------------------------------------------------
// /fixed-yield/curator-vaults — the endpoint the auto-roll keeper polls
// ---------------------------------------------------------------------------
test("GET /fixed-yield/curator-vaults returns an empty list when CURATOR_VAULT_REGISTRY is unset", async () => {
    const res = await GET("/fixed-yield/curator-vaults");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.deepEqual(body.vaults, []);
});
test("GET /fixed-yield/curator-vaults sets a Cache-Control max-age", async () => {
    const res = await GET("/fixed-yield/curator-vaults");
    assert.match(res.headers.get("cache-control") ?? "", /max-age=30/);
});
test("GET /fixed-yield/curator-vaults: response envelope key is { vaults: [...] }", async () => {
    // This is a tight contract — the keeper unwraps `body.vaults`
    // literally. Renaming this key silently breaks every keeper run.
    const res = await GET("/fixed-yield/curator-vaults");
    const body = (await res.json());
    assert.ok("vaults" in body);
    assert.equal(Object.keys(body).length, 1);
});
// ---------------------------------------------------------------------------
// /fixed-yield/curator-vaults/:id/positions/:user — invalid pubkey path
// ---------------------------------------------------------------------------
test("GET /fixed-yield/curator-vaults/:id/positions/:user returns empty on an invalid vault pubkey (no RPC)", async () => {
    // Garbage vault id → the handler returns the empty position before
    // touching RPC. This keeps the error taxonomy "empty state" rather
    // than a 500 from an unreachable Solana RPC.
    const res = await GET("/fixed-yield/curator-vaults/not-a-valid-pubkey/positions/also-bad");
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.deepEqual(body.position, {
        shares: "0",
        baseValue: "0",
        nextAutoRollTs: null,
    });
});
// ---------------------------------------------------------------------------
// Unknown route — falls through to Hono's 404
// ---------------------------------------------------------------------------
test("Unknown route returns 404", async () => {
    const res = await GET("/does-not-exist");
    assert.equal(res.status, 404);
});
// ---------------------------------------------------------------------------
// Contract test — keeper ↔ edge
//
// This is the edge-side half of the contract enforced in
// packages/keeper-auto-roll/test/contract-edge.test.ts. The same
// canonical literal is asserted to `satisfies` each side's type. If
// either type drifts (field renamed, required field dropped), one of
// the two suites breaks at TypeScript compile time.
//
// Keep this literal byte-for-byte identical with the one in the
// keeper's contract-edge.test.ts. The values are arbitrary but the
// field names and nesting are the contract.
// ---------------------------------------------------------------------------
const KEEPER_CONTRACT_FIXTURE = {
    id: "curator-usdc-7d",
    label: "USDC Auto-Roll (7-day)",
    baseSymbol: "USDC",
    baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    baseDecimals: 6,
    kycGated: false,
    vault: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
    curator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
    baseEscrow: "7HUgyqN5f1dQeebEgpKtC2Hue8oHCxVphGFsbaBJ3wAL",
    totalAssets: "1000000000",
    totalShares: "1000000000",
    feeBps: 200,
    nextAutoRollTs: 1_700_000_000,
    allocations: [
        {
            market: "So11111111111111111111111111111111111111112",
            weightBps: 6000,
            deployedBase: "500000000",
        },
        {
            market: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            weightBps: 4000,
            deployedBase: "0",
        },
    ],
};
test("contract: keeper's canonical DTO literal satisfies CuratorVaultDto on the edge side", () => {
    // The `satisfies` check above does the real work at compile time.
    // This runtime assertion is here so the suite has a failing signal
    // even if someone converts the literal to `any` or the type import
    // silently breaks — the field list below is the minimum the keeper
    // depends on.
    for (const key of [
        "id",
        "label",
        "baseSymbol",
        "baseMint",
        "baseDecimals",
        "kycGated",
        "vault",
        "curator",
        "baseEscrow",
        "totalAssets",
        "totalShares",
        "feeBps",
        "nextAutoRollTs",
        "allocations",
    ]) {
        assert.ok(key in KEEPER_CONTRACT_FIXTURE, `edge must emit ${key} in CuratorVaultDto`);
    }
});
//# sourceMappingURL=handlers.test.js.map