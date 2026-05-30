/**
 * HTTP-handler tests for the /audit routes.
 *
 * These are compliance-side endpoints — a regression here drops audit
 * records silently, which is exactly the failure mode we can't detect
 * after the fact. Pin the write-then-read loop and the summary math.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";
// ---------------------------------------------------------------------------
// Minimal in-memory KVNamespace — implements the three methods the audit
// routes call. A fuller shim (list, expirations, metadata) would be more
// coverage than the surface needs.
// ---------------------------------------------------------------------------
function memKV() {
    const store = new Map();
    return {
        async get(key) {
            return store.get(key) ?? null;
        },
        async put(key, value) {
            store.set(key, value);
        },
        async delete(key) {
            store.delete(key);
        },
        // Exposed for assertions; not on the real KVNamespace.
        _store: store,
    };
}
function envWithAuditKv() {
    return {
        AUDIT_KV: memKV(),
    };
}
// ---------------------------------------------------------------------------
// POST /audit/log
// ---------------------------------------------------------------------------
test("POST /audit/log: writes entry + returns { success, key, entry }", async () => {
    const env = envWithAuditKv();
    const res = await app.fetch(new Request("http://test/audit/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            wallet: "abc",
            action: "deposit",
            actor: "admin",
            metadata: { amount: 100 },
        }),
    }), env);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.success, true);
    assert.ok(body.key.startsWith("audit:abc:"));
    assert.equal(body.entry.wallet, "abc");
    assert.equal(body.entry.action, "deposit");
    assert.deepEqual(body.entry.metadata, { amount: 100 });
    assert.ok(!Number.isNaN(Date.parse(body.entry.timestamp)));
});
test("POST /audit/log: 400 when wallet/action/actor missing", async () => {
    const env = envWithAuditKv();
    const res = await app.fetch(new Request("http://test/audit/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: "abc" }),
    }), env);
    assert.equal(res.status, 400);
    const body = (await res.json());
    assert.equal(body.success, false);
    assert.match(body.error, /required/);
});
test("POST /audit/log: defaults metadata to {} when omitted", async () => {
    const env = envWithAuditKv();
    const res = await app.fetch(new Request("http://test/audit/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: "a", action: "b", actor: "c" }),
    }), env);
    const body = (await res.json());
    assert.deepEqual(body.entry.metadata, {});
});
// ---------------------------------------------------------------------------
// GET /audit/logs?wallet=... (the write-then-read loop)
// ---------------------------------------------------------------------------
test("GET /audit/logs: returns every entry previously logged for the wallet", async () => {
    const env = envWithAuditKv();
    // Two POSTs for wallet=w1, one for w2.
    for (const action of ["deposit", "withdraw"]) {
        await app.fetch(new Request("http://test/audit/log", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ wallet: "w1", action, actor: "admin" }),
        }), env);
    }
    await app.fetch(new Request("http://test/audit/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: "w2", action: "deposit", actor: "admin" }),
    }), env);
    const res = await app.fetch(new Request("http://test/audit/logs?wallet=w1"), env);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.count, 2);
    assert.ok(body.data.every((e) => e.wallet === "w1"));
    const actions = new Set(body.data.map((e) => e.action));
    assert.ok(actions.has("deposit"));
    assert.ok(actions.has("withdraw"));
});
test("GET /audit/logs: empty list when wallet has no entries", async () => {
    const env = envWithAuditKv();
    const res = await app.fetch(new Request("http://test/audit/logs?wallet=never"), env);
    const body = (await res.json());
    assert.deepEqual(body.data, []);
    assert.equal(body.count, 0);
});
test("GET /audit/logs: 400 when wallet query param is missing", async () => {
    const env = envWithAuditKv();
    const res = await app.fetch(new Request("http://test/audit/logs"), env);
    assert.equal(res.status, 400);
});
// ---------------------------------------------------------------------------
// GET /audit/report/:wallet
// ---------------------------------------------------------------------------
test("GET /audit/report/:wallet: groups entries by action count", async () => {
    const env = envWithAuditKv();
    for (const action of ["deposit", "deposit", "withdraw"]) {
        await app.fetch(new Request("http://test/audit/log", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ wallet: "w1", action, actor: "admin" }),
        }), env);
    }
    const res = await app.fetch(new Request("http://test/audit/report/w1"), env);
    const body = (await res.json());
    assert.equal(body.data.wallet, "w1");
    assert.equal(body.data.summary.deposit, 2);
    assert.equal(body.data.summary.withdraw, 1);
    assert.equal(body.data.totalEvents, 3);
});
test("GET /audit/report/:wallet: empty report for unknown wallet", async () => {
    const env = envWithAuditKv();
    const res = await app.fetch(new Request("http://test/audit/report/nobody"), env);
    const body = (await res.json());
    assert.equal(body.data.wallet, "nobody");
    assert.deepEqual(body.data.entries, []);
    assert.deepEqual(body.data.summary, {});
});
//# sourceMappingURL=audit.test.js.map