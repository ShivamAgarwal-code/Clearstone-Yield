import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types.js";
import { audit } from "./audit.js";
import { whitelist } from "./whitelist.js";
import { kyc } from "./kyc.js";
import { fixedYield } from "./fixed-yield.js";

const app = new Hono<{ Bindings: Env }>();

// CORS — allow frontends. `x-api-key` is required so the Solstice
// proxy below can forward the user's API key from the browser.
app.use(
  "*",
  cors({
    origin: "*", // Allow all origins for hackathon demo
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "x-api-key"],
  })
);

// Health check
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "clearstone-backend-edge",
    timestamp: new Date().toISOString(),
  })
);

// Mount route groups
app.route("/audit", audit);
app.route("/whitelist", whitelist);
app.route("/kyc", kyc);
app.route("/fixed-yield", fixedYield);

// Solstice REST proxy — frontends POST `{ type, data }` here and the
// Worker forwards to `instructions.solstice.finance/v1/instructions`,
// passing through the `x-api-key` header. Replaces the previous
// `_redirects`-based external rewrite which hit Cloudflare Pages'
// "Failed to publish your Function" bug for synthetic external
// rewrites in monorepo deploys. Pure pass-through — no auth or
// rate-limiting yet, matches the dev-time Vite proxy.
app.post("/solstice", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey) {
    return c.json({ error: "x-api-key header required" }, 400);
  }
  const body = await c.req.text();
  const upstream = await fetch(
    "https://instructions.solstice.finance/v1/instructions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body,
    },
  );
  // Pass body + status straight through. Strip hop-by-hop headers
  // (Cloudflare Workers' Response constructor handles those for us).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
});

export default app;
