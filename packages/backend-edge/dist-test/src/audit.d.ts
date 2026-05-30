import { Hono } from "hono";
import type { Env } from "./types.js";
declare const audit: Hono<{
    Bindings: Env;
}, import("hono/types").BlankSchema, "/">;
export { audit };
//# sourceMappingURL=audit.d.ts.map