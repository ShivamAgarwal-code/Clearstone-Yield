/**
 * HTTP-handler tests for /kyc.
 *
 * The on-chain whitelisting path in kyc.ts is heavy (ed25519 signing,
 * PDA derivation, raw tx construction) and requires an `ADMIN_KEYPAIR_JSON`
 * env plus a reachable RPC. These tests cover the *lifecycle*
 * (submit → status → approve) under the `no_admin_key_configured`
 * branch — i.e. the development/fixture path. That's the only branch
 * we can test without a real cluster; on-chain whitelisting is covered
 * by DEPLOY.md's manual smoke test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
function memKV() {
    const store = new Map();
    return {
        async get(k) {
            return store.get(k) ?? null;
        },
        async put(k, v) {
            store.set(k, v);
        },
        async delete(k) {
            store.delete(k);
        },
        _store: store,
    };
}
function env() {
    return {
        WHITELIST_CACHE: memKV(),
        SOLANA_RPC_URL: "http://mock-rpc",
        // ADMIN_KEYPAIR_JSON deliberately unset → approve path returns
        // "no_admin_key_configured" instead of hitting RPC.
    };
}
const WALLET = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
// ---------------------------------------------------------------------------
// POST /kyc/submit
// ---------------------------------------------------------------------------
test("POST /kyc/submit: creates a `pending` record with caller-supplied fields", async () => {
    const res = await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            walletAddress: WALLET,
            entityType: "company",
            name: "Acme Corp",
            email: "ops@acme.com",
        }),
    }), env());
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.success, true);
    assert.equal(body.data.walletAddress, WALLET);
    assert.equal(body.data.entityType, "company");
    assert.equal(body.data.name, "Acme Corp");
    assert.equal(body.data.status, "pending");
    assert.ok(!Number.isNaN(Date.parse(body.data.submittedAt)));
});
test("POST /kyc/submit: 400 on short/invalid walletAddress", async () => {
    const res = await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: "short" }),
    }), env());
    assert.equal(res.status, 400);
    const body = (await res.json());
    assert.equal(body.success, false);
    assert.match(body.error, /Invalid wallet address/);
});
test("POST /kyc/submit: defaults entityType=individual, name=Unknown when fields omitted", async () => {
    const res = await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
    }), env());
    const body = (await res.json());
    assert.equal(body.data.entityType, "individual");
    assert.equal(body.data.name, "Unknown");
    assert.equal(body.data.email, "");
});
test("POST /kyc/submit: second submit is idempotent (returns existing record)", async () => {
    const e = env();
    const first = await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET, name: "First" }),
    }), e);
    const firstBody = (await first.json());
    assert.equal(firstBody.data.name, "First");
    const second = await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET, name: "Second" }),
    }), e);
    const secondBody = (await second.json());
    assert.equal(secondBody.data.name, "First", "must not overwrite on re-submit");
    assert.match(secondBody.message, /Already submitted/);
});
// ---------------------------------------------------------------------------
// GET /kyc/status/:wallet
// ---------------------------------------------------------------------------
test("GET /kyc/status/:wallet: 404 when wallet has never submitted", async () => {
    const res = await app.fetch(new Request(`http://test/kyc/status/${WALLET}`), env());
    assert.equal(res.status, 404);
    const body = (await res.json());
    assert.equal(body.success, false);
    assert.match(body.error, new RegExp(WALLET));
});
test("GET /kyc/status/:wallet: returns the record after submit", async () => {
    const e = env();
    await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET, name: "Alice" }),
    }), e);
    const res = await app.fetch(new Request(`http://test/kyc/status/${WALLET}`), e);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.data.name, "Alice");
    assert.equal(body.data.status, "pending");
});
// ---------------------------------------------------------------------------
// POST /kyc/approve (dev path — no ADMIN_KEYPAIR_JSON)
// ---------------------------------------------------------------------------
test("POST /kyc/approve: 400 when walletAddress is missing", async () => {
    const res = await app.fetch(new Request("http://test/kyc/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
    }), env());
    assert.equal(res.status, 400);
});
test("POST /kyc/approve: flips status → approved, records `no_admin_key_configured` when key unset", async () => {
    const e = env();
    await app.fetch(new Request("http://test/kyc/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
    }), e);
    const res = await app.fetch(new Request("http://test/kyc/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
    }), e);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.data.status, "approved");
    assert.ok(body.data.approvedAt);
    assert.deepEqual(body.data.txSignatures, ["no_admin_key_configured"]);
});
test("POST /kyc/approve: auto-registers walletAddress that never submitted", async () => {
    const res = await app.fetch(new Request("http://test/kyc/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
    }), env());
    const body = (await res.json());
    assert.equal(body.data.status, "approved");
    assert.equal(body.data.name, "Auto-registered");
});
test("POST /kyc/approve: second approve is idempotent (still returns approved)", async () => {
    const e = env();
    await app.fetch(new Request("http://test/kyc/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
    }), e);
    const res = await app.fetch(new Request("http://test/kyc/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: WALLET }),
    }), e);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.data.status, "approved");
    assert.match(body.message ?? "", /Already approved/);
});
//# sourceMappingURL=kyc.test.js.map