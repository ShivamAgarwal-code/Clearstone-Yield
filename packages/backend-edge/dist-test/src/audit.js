import { Hono } from "hono";
const audit = new Hono();
/**
 * POST /audit/log
 * Write a compliance audit entry to KV.
 * Body: { wallet, action, actor, metadata? }
 */
audit.post("/log", async (c) => {
    const body = await c.req.json();
    if (!body.wallet || !body.action || !body.actor) {
        return c.json({ success: false, error: "wallet, action, and actor are required" }, 400);
    }
    const entry = {
        wallet: body.wallet,
        action: body.action,
        actor: body.actor,
        metadata: body.metadata ?? {},
        timestamp: new Date().toISOString(),
    };
    // Date.now() alone collides when two log calls land in the same ms
    // — append a uuid so every entry is a distinct KV key and the index
    // is append-only without losing writes.
    const key = `audit:${entry.wallet}:${Date.now()}:${crypto.randomUUID()}`;
    // Write entry
    await c.env.AUDIT_KV.put(key, JSON.stringify(entry), {
        // Keep audit logs for 1 year
        expirationTtl: 365 * 24 * 60 * 60,
    });
    // Update index (append key to wallet's entry list)
    const indexKey = `audit-idx:${entry.wallet}`;
    const existingRaw = await c.env.AUDIT_KV.get(indexKey);
    const existing = existingRaw ? JSON.parse(existingRaw) : [];
    existing.push(key);
    // Cap at 1000 entries per wallet
    if (existing.length > 1000)
        existing.splice(0, existing.length - 1000);
    await c.env.AUDIT_KV.put(indexKey, JSON.stringify(existing));
    return c.json({ success: true, key, entry });
});
/**
 * GET /audit/logs?wallet=<address>
 * List all audit entries for a wallet.
 */
audit.get("/logs", async (c) => {
    const wallet = c.req.query("wallet");
    if (!wallet) {
        return c.json({ success: false, error: "wallet query param is required" }, 400);
    }
    const indexKey = `audit-idx:${wallet}`;
    const indexRaw = await c.env.AUDIT_KV.get(indexKey);
    if (!indexRaw) {
        return c.json({ success: true, data: [], count: 0 });
    }
    const keys = JSON.parse(indexRaw);
    const entries = [];
    // Fetch all entries (KV multi-get via Promise.all)
    const results = await Promise.all(keys.map((k) => c.env.AUDIT_KV.get(k)));
    for (const raw of results) {
        if (raw)
            entries.push(JSON.parse(raw));
    }
    return c.json({ success: true, data: entries, count: entries.length });
});
/**
 * GET /audit/report/:wallet
 * Formatted compliance report with action summary.
 */
audit.get("/report/:wallet", async (c) => {
    const wallet = c.req.param("wallet");
    const indexKey = `audit-idx:${wallet}`;
    const indexRaw = await c.env.AUDIT_KV.get(indexKey);
    if (!indexRaw) {
        return c.json({
            success: true,
            data: {
                wallet,
                entries: [],
                summary: {},
                generatedAt: new Date().toISOString(),
            },
        });
    }
    const keys = JSON.parse(indexRaw);
    const entries = [];
    const results = await Promise.all(keys.map((k) => c.env.AUDIT_KV.get(k)));
    for (const raw of results) {
        if (raw)
            entries.push(JSON.parse(raw));
    }
    // Summarise by action type
    const summary = {};
    for (const e of entries) {
        summary[e.action] = (summary[e.action] ?? 0) + 1;
    }
    return c.json({
        success: true,
        data: {
            wallet,
            entries,
            summary,
            totalEvents: entries.length,
            generatedAt: new Date().toISOString(),
        },
    });
});
export { audit };
//# sourceMappingURL=audit.js.map