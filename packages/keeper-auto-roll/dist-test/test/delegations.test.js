/**
 * Unit tests for the keeper's delegation scan / filter logic.
 *
 * `scanDelegations` is the only bridge between the RPC view of
 * `RollDelegation` accounts and the keeper's tick loop. A decode drift
 * (wrong size, wrong field order) would silently hide every live
 * delegation — the keeper would keep ticking and finding "nothing to do."
 *
 * `filterLive` is a one-liner, but the comparison is on bigints across
 * a slot boundary — worth pinning to avoid an off-by-one that leaves
 * keepers cranking an expired delegation (which the on-chain check
 * would reject, but burns fee + logs spam).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { filterLive, scanDelegations } from "../src/delegations.js";
import { fixedYield } from "@delta/calldata-sdk-solana";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function liveDelegation(overrides = {}) {
    return {
        pda: new PublicKey("11111111111111111111111111111111"),
        vault: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        user: new PublicKey("11111111111111111111111111111111"),
        maxSlippageBps: 50,
        expiresAtSlot: 1000n,
        allocationsHash: new Uint8Array(32),
        createdAtSlot: 900n,
        ...overrides,
    };
}
/**
 * Produce a byte-exact `RollDelegation` account. Mirrors the 123-byte
 * layout from delegation.ts and is the same shape the keeper decodes
 * on the wire.
 */
function encodeDelegation(vault, user, maxSlippageBps, expiresAtSlot, createdAtSlot) {
    const buf = Buffer.alloc(fixedYield.delegation.ROLL_DELEGATION_ACCOUNT_SIZE);
    // 0..8: discriminator (leave zeros — decoder doesn't validate it).
    vault.toBuffer().copy(buf, 8);
    user.toBuffer().copy(buf, 40);
    buf.writeUInt16LE(maxSlippageBps, 72);
    buf.writeBigUInt64LE(expiresAtSlot, 74);
    // 82..114: allocations_hash (leave zeros).
    buf.writeBigUInt64LE(createdAtSlot, 114);
    buf[122] = 255; // bump
    return buf;
}
// ---------------------------------------------------------------------------
// filterLive
// ---------------------------------------------------------------------------
test("filterLive: nowSlot < expiresAtSlot → kept", () => {
    const live = [liveDelegation({ expiresAtSlot: 1000n })];
    assert.equal(filterLive(live, 999n).length, 1);
});
test("filterLive: nowSlot == expiresAtSlot → dropped (exact expiry is expired)", () => {
    const live = [liveDelegation({ expiresAtSlot: 1000n })];
    assert.equal(filterLive(live, 1000n).length, 0);
});
test("filterLive: nowSlot > expiresAtSlot → dropped", () => {
    const live = [liveDelegation({ expiresAtSlot: 1000n })];
    assert.equal(filterLive(live, 1001n).length, 0);
});
test("filterLive: partitions a mixed list", () => {
    const list = [
        liveDelegation({ expiresAtSlot: 900n }),
        liveDelegation({ expiresAtSlot: 1000n }),
        liveDelegation({ expiresAtSlot: 1500n }),
    ];
    const kept = filterLive(list, 1000n);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].expiresAtSlot, 1500n);
});
// ---------------------------------------------------------------------------
// scanDelegations — with a mocked Connection
// ---------------------------------------------------------------------------
function mockConnection(accounts) {
    // Return only the methods the function under test actually calls — a
    // full `Connection` mock is overkill and would drag in @solana/web3.js
    // internals the test shouldn't care about.
    return {
        getProgramAccounts: async () => accounts.map(({ pubkey, data }) => ({
            pubkey,
            account: {
                data,
                executable: false,
                lamports: 0,
                owner: PublicKey.default,
            },
        })),
    };
}
test("scanDelegations: groups multiple delegations by vault", async () => {
    const vaultA = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const vaultB = new PublicKey("So11111111111111111111111111111111111111112");
    const userA = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
    const userB = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2");
    const userC = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j3");
    const pda = (i) => {
        const a = new Uint8Array(32);
        a[31] = i;
        return new PublicKey(a);
    };
    const accounts = [
        {
            pubkey: pda(1),
            data: encodeDelegation(vaultA, userA, 50, 1000n, 900n),
        },
        {
            pubkey: pda(2),
            data: encodeDelegation(vaultA, userB, 100, 2000n, 1500n),
        },
        {
            pubkey: pda(3),
            data: encodeDelegation(vaultB, userC, 25, 3000n, 2500n),
        },
    ];
    const byVault = await scanDelegations(mockConnection(accounts));
    assert.equal(byVault.size, 2);
    assert.equal(byVault.get(vaultA.toBase58())?.length, 2);
    assert.equal(byVault.get(vaultB.toBase58())?.length, 1);
    const vaultAList = byVault.get(vaultA.toBase58());
    const slippages = vaultAList.map((d) => d.maxSlippageBps).sort((a, b) => a - b);
    assert.deepEqual(slippages, [50, 100]);
});
test("scanDelegations: pda is carried through from getProgramAccounts result", async () => {
    const vault = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const user = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
    const expectedPda = new PublicKey("DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA");
    const byVault = await scanDelegations(mockConnection([
        {
            pubkey: expectedPda,
            data: encodeDelegation(vault, user, 50, 1000n, 900n),
        },
    ]));
    const list = byVault.get(vault.toBase58());
    assert.equal(list.length, 1);
    assert.equal(list[0].pda.toBase58(), expectedPda.toBase58());
});
test("scanDelegations: silently skips accounts that fail to decode", async () => {
    const vault = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const user = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
    const good = encodeDelegation(vault, user, 50, 1000n, 900n);
    // Buffer that passes the dataSize filter but fails the decoder —
    // truncate so decoder's size check triggers.
    const bad = Buffer.alloc(10);
    const pda = (i) => {
        const a = new Uint8Array(32);
        a[31] = i;
        return new PublicKey(a);
    };
    const byVault = await scanDelegations(mockConnection([
        { pubkey: pda(1), data: bad },
        { pubkey: pda(2), data: good },
    ]));
    // Bad account dropped; good one lands in its vault bucket.
    assert.equal(byVault.size, 1);
    assert.equal(byVault.get(vault.toBase58())?.length, 1);
});
test("scanDelegations: empty result yields empty map", async () => {
    const byVault = await scanDelegations(mockConnection([]));
    assert.equal(byVault.size, 0);
});
//# sourceMappingURL=delegations.test.js.map