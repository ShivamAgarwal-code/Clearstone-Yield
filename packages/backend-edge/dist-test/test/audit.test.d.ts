/**
 * HTTP-handler tests for the /audit routes.
 *
 * These are compliance-side endpoints — a regression here drops audit
 * records silently, which is exactly the failure mode we can't detect
 * after the fact. Pin the write-then-read loop and the summary math.
 */
export {};
//# sourceMappingURL=audit.test.d.ts.map