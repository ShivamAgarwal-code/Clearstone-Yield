import { Hono } from "hono";
import { cors } from "hono/cors";
import { audit } from "./audit.js";
import { whitelist } from "./whitelist.js";
import { kyc } from "./kyc.js";
import { fixedYield } from "./fixed-yield.js";
const app = new Hono();
// CORS — allow frontends
app.use("*", cors({
    origin: "*", // Allow all origins for hackathon demo
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type"],
}));
// Health check
app.get("/health", (c) => c.json({
    status: "ok",
    service: "clearstone-backend-edge",
    timestamp: new Date().toISOString(),
}));
// Mount route groups
app.route("/audit", audit);
app.route("/whitelist", whitelist);
app.route("/kyc", kyc);
app.route("/fixed-yield", fixedYield);
export default app;
//# sourceMappingURL=index.js.map