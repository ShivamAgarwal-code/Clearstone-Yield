import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { kycRoutes } from "./routes/kyc.routes.js";
import { kytRoutes } from "./routes/kyt.routes.js";
import { travelRuleRoutes } from "./routes/travel-rule.routes.js";
import { auditRoutes } from "./routes/audit.routes.js";
import { riskRoutes } from "./routes/risk.routes.js";
import { authRoutes } from "./routes/auth.routes.js";
import { config } from "./config.js";

const app = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

await app.register(cors, {
  origin: [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
});

await app.register(helmet, {
  contentSecurityPolicy: false, // CSP breaks Solana wallet adapters
});

await app.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.timeWindowMs,
  errorResponseBuilder: (_req, context) => ({
    success: false,
    error: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s`,
  }),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
}));

await app.register(authRoutes);
await app.register(kycRoutes);
await app.register(kytRoutes);
await app.register(travelRuleRoutes);
await app.register(auditRoutes);
await app.register(riskRoutes);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
