/**
 * Keeper ↔ backend-edge contract test.
 *
 * The keeper and the edge live in separate packages and don't share a
 * types module — the edge defines `CuratorVaultDto` in
 * packages/backend-edge/src/fixed-yield.ts, and the keeper re-declares
 * an identically-shaped `CuratorVaultSnapshot` in src/edge.ts. A silent
 * field rename on either side (say, the edge starts emitting
 * `base_escrow` while the keeper still looks for `baseEscrow`) produces
 * a keeper that polls successfully and finds "nothing to do" forever.
 *
 * This test pins the wire shape from the keeper's perspective:
 *
 *   1. A canonical DTO literal is declared in-file and `satisfies` the
 *      keeper's snapshot type. Drift on the keeper side → TypeScript
 *      build failure here.
 *
 *   2. `fetchCuratorVaults` is driven through a fetch mock that returns
 *      the DTO — if the URL shape or envelope changes, this breaks.
 *
 *   3. The decoded snapshot is run through BOTH decide paths
 *      (`decideRoll` + `decideDelegatedRoll`) to confirm every field
 *      the keeper actually reads is populated and well-typed. A silent
 *      drop of `nextAutoRollTs` (for instance) would make decideRoll
 *      return "no-matured-allocation" regardless of state — this test
 *      catches that by verifying a deliberately-ready fixture produces
 *      `reason: "ready"`.
 *
 * There is a companion test on the edge side
 * (packages/backend-edge/test/handlers.test.ts) that asserts the
 * envelope and cache-control for the same endpoint. If the two ever
 * describe different shapes, one of the two test suites fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  fetchCuratorVaults,
  type CuratorVaultSnapshot,
} from "../src/edge.js";
import { decideRoll } from "../src/roll.js";
import { decideDelegatedRoll } from "../src/roll-delegated.js";
import type { LiveDelegation } from "../src/delegations.js";

// ---------------------------------------------------------------------------
// Canonical DTO. Kept in lock-step with CuratorVaultDto in
// packages/backend-edge/src/fixed-yield.ts (see backend-edge's
// handlers.test.ts for the corresponding edge-side assertion).
//
// Every field here is populated with a plausible value — not the empty
// string / zero — so the `satisfies` check also rules out accidentally
// loose types.
// ---------------------------------------------------------------------------
const FIXTURE = {
  id: "curator-usdc-7d",
  label: "USDC Auto-Roll (7-day)",
  baseSymbol: "USDC",
  baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  baseDecimals: 6,
  kycGated: false,
  vault: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
  curator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  baseEscrow: "7HUgyqN5f1dQeebEgpKtC2Hue8oHCxVphGFsbaBJ3wAL",
  totalAssets: "1000000000",
  totalShares: "1000000000",
  feeBps: 200,
  nextAutoRollTs: 1_700_000_000,
  allocations: [
    {
      market: "So11111111111111111111111111111111111111112",
      weightBps: 6000,
      deployedBase: "500000000",
    },
    {
      market: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      weightBps: 4000,
      deployedBase: "0",
    },
  ],
} as const satisfies CuratorVaultSnapshot;

// ---------------------------------------------------------------------------
// Fetch-shim helpers — same pattern as edge.test.ts.
// ---------------------------------------------------------------------------
function withFetch<T>(
  fn: typeof globalThis.fetch,
  block: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return block().finally(() => {
    globalThis.fetch = original;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("contract: fetchCuratorVaults consumes the canonical DTO shape verbatim", async () => {
  const mock: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ vaults: [FIXTURE] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const result = await withFetch(mock, () =>
    fetchCuratorVaults("https://edge.test")
  );
  assert.equal(result.length, 1);
  // Deep-equal guards against accidental transform inside fetchCuratorVaults.
  assert.deepEqual(result[0], FIXTURE);
});

test("contract: decoded snapshot feeds decideRoll to a `ready` decision", async () => {
  // Pick a `now` past nextAutoRollTs + grace and match curator — the
  // decision should reach `ready`. If any field the keeper reads
  // (curator, nextAutoRollTs, allocations[].deployedBase, weightBps) has
  // silently drifted, this falls off the happy path.
  const now = FIXTURE.nextAutoRollTs + 60;
  const grace = 30;
  const d = decideRoll(FIXTURE, FIXTURE.curator, now, grace);
  assert.equal(d.reason, "ready");
  if (d.reason === "ready") {
    assert.equal(d.maturedIndex, 0);
    assert.equal(d.nextIndex, 1);
    assert.equal(d.maturedMarket, FIXTURE.allocations[0].market);
    assert.equal(d.nextMarket, FIXTURE.allocations[1].market);
  }
});

test("contract: decoded snapshot + live delegation feeds decideDelegatedRoll to `ready`", async () => {
  const delegation: LiveDelegation = {
    pda: new PublicKey("11111111111111111111111111111111"),
    vault: new PublicKey(FIXTURE.vault),
    user: new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2"),
    maxSlippageBps: 50,
    expiresAtSlot: 10_000_000n,
    allocationsHash: new Uint8Array(32),
    createdAtSlot: 9_000_000n,
  };
  const d = decideDelegatedRoll(
    FIXTURE,
    delegation,
    FIXTURE.nextAutoRollTs + 60,
    1_000_000n,
    30
  );
  assert.equal(d.reason, "ready");
  if (d.reason === "ready") {
    // deployed = 500_000_000 × (10000 - 50) / 10000 = 497_500_000
    assert.equal(d.deployedBase, 500_000_000n);
    assert.equal(d.minBaseOut, 497_500_000n);
  }
});

test("contract: every field the keeper reads is exercised against the DTO", () => {
  // Explicit field-presence check — redundant with `satisfies` above,
  // but it's a clearer failure site when someone deletes an optional
  // field from the interface and the compile-time check gets weaker.
  // Listed in the order decideRoll / executeRoll access them.
  const required = [
    "id",
    "vault",
    "curator",
    "baseMint",
    "baseEscrow",
    "nextAutoRollTs",
    "allocations",
  ] as const;
  for (const key of required) {
    assert.ok(
      key in FIXTURE,
      `keeper expects ${key} on CuratorVaultSnapshot`
    );
  }
  for (const a of FIXTURE.allocations) {
    assert.equal(typeof a.market, "string");
    assert.equal(typeof a.weightBps, "number");
    assert.equal(typeof a.deployedBase, "string");
  }
});

test("contract: envelope shape is { vaults: [...] } with a plural key", async () => {
  // This is the other half of the contract — the key name. A singular
  // rename ("vault" instead of "vaults") would make fetchCuratorVaults
  // return undefined.length at runtime. Prove the edge-side envelope
  // matches by testing against the exact unwrap the keeper does.
  let url = "";
  const mock: typeof globalThis.fetch = async (input) => {
    url = String(input);
    return new Response(JSON.stringify({ vaults: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await withFetch(mock, () =>
    fetchCuratorVaults("https://edge.test")
  );
  assert.deepEqual(result, []);
  assert.equal(url, "https://edge.test/fixed-yield/curator-vaults");
});
