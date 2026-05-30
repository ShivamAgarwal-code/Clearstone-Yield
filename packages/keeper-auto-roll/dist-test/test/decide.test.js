/**
 * Unit tests for the keeper's decision logic.
 *
 * `decideRoll` (curator-signed path) and `decideDelegatedRoll`
 * (permissionless path) are discriminated-union returning pure
 * functions — no RPC, no keypair. That makes them trivial to
 * table-test, and they're the only code paths that can silently
 * mis-route a keeper run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { decideRoll } from "../src/roll.js";
import { decideDelegatedRoll } from "../src/roll-delegated.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const CURATOR = "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA";
const VAULT_PK = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
function vault(overrides = {}) {
    return {
        id: "test-vault",
        label: "USDC Test",
        baseSymbol: "USDC",
        baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        baseDecimals: 6,
        kycGated: false,
        vault: VAULT_PK,
        curator: CURATOR,
        baseEscrow: "11111111111111111111111111111111",
        totalAssets: "1000000000",
        totalShares: "1000000000",
        feeBps: 200,
        nextAutoRollTs: 1_700_000_000,
        allocations: [
            {
                market: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                weightBps: 6000,
                deployedBase: "500000000",
            },
            {
                market: "So11111111111111111111111111111111111111112",
                weightBps: 4000,
                deployedBase: "0",
            },
        ],
        ...overrides,
    };
}
function liveDelegation(overrides = {}) {
    return {
        pda: new PublicKey("11111111111111111111111111111111"),
        vault: new PublicKey(VAULT_PK),
        user: new PublicKey("11111111111111111111111111111111"),
        maxSlippageBps: 50,
        expiresAtSlot: 10000000n,
        allocationsHash: new Uint8Array(32),
        createdAtSlot: 9000000n,
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// decideRoll (curator-signed)
// ---------------------------------------------------------------------------
test("decideRoll: curator-mismatch when keeper != vault.curator", () => {
    const d = decideRoll(vault(), "OtherCurator1111111111111111111111111111111", 1_700_000_100, 30);
    assert.equal(d.reason, "curator-mismatch");
});
test("decideRoll: no-matured-allocation when nextAutoRollTs is null", () => {
    const d = decideRoll(vault({ nextAutoRollTs: null }), CURATOR, 1_700_000_100, 30);
    assert.equal(d.reason, "no-matured-allocation");
});
test("decideRoll: no-matured-allocation when within grace window", () => {
    const d = decideRoll(vault({ nextAutoRollTs: 1_700_000_000 }), CURATOR, 1_700_000_000 + 29, // still inside 30s grace
    30);
    assert.equal(d.reason, "no-matured-allocation");
});
test("decideRoll: ready when matured + grace elapsed", () => {
    const d = decideRoll(vault({ nextAutoRollTs: 1_700_000_000 }), CURATOR, 1_700_000_000 + 31, 30);
    assert.equal(d.reason, "ready");
    if (d.reason === "ready") {
        assert.equal(d.maturedIndex, 0); // first allocation with deployed > 0
        assert.equal(d.nextIndex, 1); // best remaining weight
    }
});
test("decideRoll: no-matured-allocation when no allocation has deployed > 0", () => {
    const d = decideRoll(vault({
        nextAutoRollTs: 1_700_000_000,
        allocations: [
            {
                market: "So11111111111111111111111111111111111111112",
                weightBps: 10_000,
                deployedBase: "0",
            },
        ],
    }), CURATOR, 1_700_000_100, 30);
    assert.equal(d.reason, "no-matured-allocation");
});
test("decideRoll: no-next-allocation when only one allocation exists", () => {
    const d = decideRoll(vault({
        nextAutoRollTs: 1_700_000_000,
        allocations: [
            {
                market: "So11111111111111111111111111111111111111112",
                weightBps: 10_000,
                deployedBase: "1000000000",
            },
        ],
    }), CURATOR, 1_700_000_100, 30);
    assert.equal(d.reason, "no-next-allocation");
});
test("decideRoll: picks highest-weight allocation for nextIndex", () => {
    const d = decideRoll(vault({
        nextAutoRollTs: 1_700_000_000,
        allocations: [
            {
                market: "So11111111111111111111111111111111111111112",
                weightBps: 100,
                deployedBase: "1000000000",
            },
            {
                market: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
                weightBps: 2000,
                deployedBase: "0",
            },
            {
                market: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYC",
                weightBps: 7900,
                deployedBase: "0",
            },
        ],
    }), CURATOR, 1_700_000_100, 30);
    assert.equal(d.reason, "ready");
    if (d.reason === "ready") {
        assert.equal(d.maturedIndex, 0);
        assert.equal(d.nextIndex, 2, "should pick the 7900 bps allocation");
    }
});
// ---------------------------------------------------------------------------
// decideDelegatedRoll (permissionless)
// ---------------------------------------------------------------------------
test("decideDelegatedRoll: delegation-expired when nowSlot >= expiresAtSlot", () => {
    const d = decideDelegatedRoll(vault(), liveDelegation({ expiresAtSlot: 1000n }), 1_700_000_100, 1000n, // exact expiry — handler treats this as expired
    30);
    assert.equal(d.reason, "delegation-expired");
});
test("decideDelegatedRoll: ready computes minBaseOut from slippage floor", () => {
    // deployed = 500_000_000, slippage 50 bps → floor = 500_000_000 × 9950 / 10000 = 497_500_000
    const d = decideDelegatedRoll(vault({ nextAutoRollTs: 1_700_000_000 }), liveDelegation({ maxSlippageBps: 50 }), 1_700_000_100, 1000n, 30);
    assert.equal(d.reason, "ready");
    if (d.reason === "ready") {
        assert.equal(d.minBaseOut, 497500000n);
        assert.equal(d.deployedBase, 500000000n);
        assert.equal(d.fromIndex, 0);
        assert.equal(d.toIndex, 1);
    }
});
test("decideDelegatedRoll: ready with 0 bps slippage floor == deployedBase", () => {
    const d = decideDelegatedRoll(vault({ nextAutoRollTs: 1_700_000_000 }), liveDelegation({ maxSlippageBps: 0 }), 1_700_000_100, 1000n, 30);
    assert.equal(d.reason, "ready");
    if (d.reason === "ready") {
        assert.equal(d.minBaseOut, d.deployedBase);
    }
});
test("decideDelegatedRoll: no-matured-allocation inside grace window", () => {
    const d = decideDelegatedRoll(vault({ nextAutoRollTs: 1_700_000_000 }), liveDelegation(), 1_700_000_000 + 29, 1000n, 30);
    assert.equal(d.reason, "no-matured-allocation");
});
test("decideDelegatedRoll: no-matured-allocation when nextAutoRollTs null", () => {
    const d = decideDelegatedRoll(vault({ nextAutoRollTs: null }), liveDelegation(), 1_700_000_100, 1000n, 30);
    assert.equal(d.reason, "no-matured-allocation");
});
test("decideDelegatedRoll: no-next-allocation with single allocation", () => {
    const d = decideDelegatedRoll(vault({
        nextAutoRollTs: 1_700_000_000,
        allocations: [
            {
                market: "So11111111111111111111111111111111111111112",
                weightBps: 10_000,
                deployedBase: "1000000000",
            },
        ],
    }), liveDelegation(), 1_700_000_100, 1000n, 30);
    assert.equal(d.reason, "no-next-allocation");
});
//# sourceMappingURL=decide.test.js.map