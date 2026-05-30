/**
 * Unit tests for the edge HTTP client.
 *
 * `fetchCuratorVaults` is the single ingress point for the keeper — if
 * it drifts (wrong path, wrong envelope) the keeper sees an empty vault
 * list and silently idles. Pin the URL shape and error path so a server
 * regression surfaces here rather than in keeper logs at 3am.
 */
export {};
//# sourceMappingURL=edge.test.d.ts.map