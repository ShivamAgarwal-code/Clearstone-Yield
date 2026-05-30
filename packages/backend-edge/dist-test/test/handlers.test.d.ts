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
export {};
//# sourceMappingURL=handlers.test.d.ts.map