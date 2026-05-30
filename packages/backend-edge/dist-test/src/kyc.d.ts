/**
 * KYC routes for Cloudflare Workers — submit, check status, approve.
 * On-chain whitelisting builds raw Solana txns signed with admin key.
 */
import { Hono } from "hono";
import type { Env } from "./types.js";
declare const kyc: Hono<{
    Bindings: Env;
}, import("hono/types").BlankSchema, "/">;
export { kyc };
//# sourceMappingURL=kyc.d.ts.map