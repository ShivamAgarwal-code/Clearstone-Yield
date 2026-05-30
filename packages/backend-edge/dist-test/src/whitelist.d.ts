import { Hono } from "hono";
import type { Env } from "./types.js";
declare const whitelist: Hono<{
    Bindings: Env;
}, import("hono/types").BlankSchema, "/">;
export { whitelist };
//# sourceMappingURL=whitelist.d.ts.map