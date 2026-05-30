/**
 * Tx-assembly tests for the keeper's execute paths.
 *
 * `decide*` tests cover WHETHER to roll; these cover WHAT tx gets built.
 * The risk is in `deriveReallocateAccounts` / `deriveCrankAccountsFor`:
 * both pull ~6-8 pubkeys out of MarketTwo + core Vault account buffers
 * at hard-coded offsets. A silent offset drift here produces a tx that
 * passes client-side checks but fails on-chain with opaque AccountNotFound
 * or ConstraintSeeds errors — which the keeper then retries forever.
 *
 * Strategy: mock `Connection.getAccountInfo` + `getLatestBlockhash` with
 * in-memory fixtures matching the documented MarketTwo / Vault layouts.
 * Run execute* in dryRun mode so nothing hits the wire. Assert the
 * compiled tx has the right ixs, right signer, and a plausible size.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Keypair, PublicKey, VersionedTransaction, TransactionMessage, } from "@solana/web3.js";
import { executeRoll } from "../src/roll.js";
import { executeDelegatedRoll } from "../src/roll-delegated.js";
function installCapture() {
    const captured = [];
    const origCompile = TransactionMessage.prototype.compileToV0Message;
    const origSign = VersionedTransaction.prototype.sign;
    TransactionMessage.prototype.compileToV0Message = function (alts) {
        const msg = origCompile.call(this, alts);
        captured.push({ message: msg, luts: alts ?? [] });
        return msg;
    };
    VersionedTransaction.prototype.sign = function () {
        // noop — tests assert structure, not signature bytes.
    };
    return {
        captured,
        restore() {
            TransactionMessage.prototype.compileToV0Message = origCompile;
            VersionedTransaction.prototype.sign = origSign;
        },
    };
}
// ---------------------------------------------------------------------------
// Constants — mirror the offsets from the Rust layout. If `roll.ts` /
// `roll-delegated.ts` are updated, these must move in lock-step.
//
// MarketTwo header (from roll.ts comments):
//   8 + 32 + 2 + 1 = 43     address_lookup_table (32)
//   43 + 32 = 75            mint_pt (32)   ← roll.ts reads @ 8+32+2+1+32 = 75
//   75 + 32 = 107           mint_sy (32)
//   107 + 32 = 139          vault (32)     ← roll.ts reads @ 8+32+2+1+32+32+32 = 139
//   139 + 32 = 171          mint_lp (32)
//   171 + 32 = 203          token_pt_escrow (32)
//   203 + 32 = 235          token_sy_escrow (32)
//   235 + 32 = 267          token_fee_treasury_sy (32)
//   Total needed: 299 bytes.
//
// Core Vault: sy_program @ 43.
// ---------------------------------------------------------------------------
function dummy(seed) {
    const arr = new Uint8Array(32);
    arr[0] = seed;
    arr[1] = (seed >> 8) & 0xff;
    return new PublicKey(arr);
}
function makeMarketFixture(seedBase) {
    return {
        market: dummy(seedBase + 0),
        marketAlt: dummy(seedBase + 1),
        mintPt: dummy(seedBase + 2),
        mintSy: dummy(seedBase + 3),
        coreVault: dummy(seedBase + 4),
        mintLp: dummy(seedBase + 5),
        marketEscrowPt: dummy(seedBase + 6),
        marketEscrowSy: dummy(seedBase + 7),
        tokenFeeTreasurySy: dummy(seedBase + 8),
        syProgram: dummy(seedBase + 9),
    };
}
/** Build a 512-byte MarketTwo buffer with pubkeys at documented offsets. */
function encodeMarketTwo(f) {
    const buf = Buffer.alloc(512);
    f.marketAlt.toBuffer().copy(buf, 43);
    f.mintPt.toBuffer().copy(buf, 75);
    f.mintSy.toBuffer().copy(buf, 107);
    f.coreVault.toBuffer().copy(buf, 139);
    f.mintLp.toBuffer().copy(buf, 171);
    f.marketEscrowPt.toBuffer().copy(buf, 203);
    f.marketEscrowSy.toBuffer().copy(buf, 235);
    f.tokenFeeTreasurySy.toBuffer().copy(buf, 267);
    return buf;
}
/** Build a core Vault buffer with sy_program @ 43. */
function encodeCoreVault(syProgram) {
    const buf = Buffer.alloc(512);
    syProgram.toBuffer().copy(buf, 43);
    return buf;
}
/**
 * Build the `accounts` + `lutAddresses` maps for a set of market
 * fixtures. Each fixture contributes its market + core-vault buffers
 * and registers its marketAlt pubkey as a LUT containing the readonly
 * per-market keys.
 */
function accountsAndLutsFor(fixtures) {
    const accounts = new Map();
    const lutAddresses = new Map();
    for (const f of fixtures) {
        accounts.set(f.market.toBase58(), encodeMarketTwo(f));
        accounts.set(f.coreVault.toBase58(), encodeCoreVault(f.syProgram));
        lutAddresses.set(f.marketAlt.toBase58(), lutAddressesFor(f));
    }
    return { accounts, lutAddresses };
}
/**
 * Collect every readonly per-market key that should live in that
 * market's address_lookup_table. These are the pubkeys the on-chain
 * market publishes; a real operator bakes them into the LUT at market
 * creation time. Keeping them in the LUT is what brings the compiled
 * reallocate tx back under Solana's 1232-byte packet cap.
 */
function lutAddressesFor(f) {
    return [
        f.mintPt,
        f.mintSy,
        f.mintLp,
        f.marketEscrowPt,
        f.marketEscrowSy,
        f.tokenFeeTreasurySy,
        f.coreVault,
        f.syProgram,
    ];
}
/**
 * Mock `Connection` that returns canned account buffers by pubkey. Only
 * the methods executeRoll / executeDelegatedRoll actually call are
 * implemented — a fuller shim would be more coverage than this surface
 * needs.
 *
 * `lutAddresses` supplies the per-LUT address list so compileToV0Message
 * can actually compress. Without it the v0 tx would still exceed the
 * packet cap and serialize() would throw.
 */
function mockConnection(byKey, opts = {}) {
    return {
        getAccountInfo: async (pk) => {
            const data = byKey.get(pk.toBase58());
            if (!data)
                return null;
            return {
                data,
                executable: false,
                lamports: 0,
                owner: PublicKey.default,
                rentEpoch: 0,
            };
        },
        getAddressLookupTable: async (pk) => ({
            context: { slot: 0 },
            value: new AddressLookupTableAccount({
                key: pk,
                state: {
                    deactivationSlot: BigInt("18446744073709551615"),
                    lastExtendedSlot: 0,
                    lastExtendedSlotStartIndex: 0,
                    authority: undefined,
                    addresses: opts.lutAddresses?.get(pk.toBase58()) ?? [],
                },
            }),
        }),
        // Blockhashes must base58-decode to exactly 32 bytes. The all-1s
        // system-program pubkey fits and avoids a blob-size overrun in
        // MessageV0.serialize when a random 32-char string decodes short.
        getLatestBlockhash: async () => ({
            blockhash: PublicKey.default.toBase58(),
            lastValidBlockHeight: 100,
        }),
        sendRawTransaction: async (raw) => {
            opts.captureSent?.push(Buffer.from(raw));
            return "mock-signature";
        },
        confirmTransaction: async () => ({ value: { err: null } }),
    };
}
function vaultSnapshot(overrides = {}) {
    return {
        id: "test-vault",
        label: "USDC Test",
        baseSymbol: "USDC",
        baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        baseDecimals: 6,
        kycGated: false,
        vault: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
        curator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        baseEscrow: "11111111111111111111111111111111",
        totalAssets: "1000000000",
        totalShares: "1000000000",
        feeBps: 200,
        nextAutoRollTs: 1_700_000_000,
        allocations: [],
        ...overrides,
    };
}
function makeConfig(curatorKp, dryRun = true) {
    return {
        rpcUrl: "http://mock",
        edgeUrl: "http://mock",
        curatorKeypair: curatorKp,
        pollIntervalSec: 60,
        maturityGraceSec: 30,
        slippageBps: 50,
        oneShot: false,
        dryRun,
    };
}
function describeMessage(cap) {
    const msg = cap.message;
    // v0 messages resolve ix account indexes across static keys + writable
    // lookup addresses + readonly lookup addresses. `getAccountKeys`
    // produces the combined view the runtime would see.
    const resolved = msg.getAccountKeys({
        addressLookupTableAccounts: cap.luts,
    });
    const ixAccountSets = [];
    const programIds = [];
    for (const ix of msg.compiledInstructions) {
        const progKey = resolved.get(ix.programIdIndex);
        if (!progKey)
            throw new Error(`unresolved programIdIndex ${ix.programIdIndex}`);
        programIds.push(progKey.toBase58());
        const set = new Set();
        for (const idx of ix.accountKeyIndexes) {
            const k = resolved.get(idx);
            if (!k)
                throw new Error(`unresolved accountKeyIndex ${idx}`);
            set.add(k.toBase58());
        }
        ixAccountSets.push(set);
    }
    return {
        signerCount: msg.header.numRequiredSignatures,
        instructionCount: msg.compiledInstructions.length,
        programIds,
        ixAccountSets,
        payer: msg.staticAccountKeys[0].toBase58(),
    };
}
// ---------------------------------------------------------------------------
// executeRoll (curator-signed) — dry-run path
// ---------------------------------------------------------------------------
test("executeRoll: dryRun returns null and never calls sendRawTransaction", async () => {
    const curatorKp = Keypair.generate();
    const matured = makeMarketFixture(0x10);
    const next = makeMarketFixture(0x40);
    const { accounts, lutAddresses } = accountsAndLutsFor([matured, next]);
    const sent = [];
    const conn = mockConnection(accounts, { captureSent: sent, lutAddresses });
    const vault = vaultSnapshot({
        curator: curatorKp.publicKey.toBase58(),
        allocations: [
            {
                market: matured.market.toBase58(),
                weightBps: 6000,
                deployedBase: "500000000",
            },
            {
                market: next.market.toBase58(),
                weightBps: 4000,
                deployedBase: "0",
            },
        ],
    });
    const cap = installCapture();
    try {
        const sig = await executeRoll(conn, makeConfig(curatorKp, true), vault, {
            reason: "ready",
            maturedIndex: 0,
            nextIndex: 1,
            maturedMarket: matured.market.toBase58(),
            nextMarket: next.market.toBase58(),
        });
        assert.equal(sig, null, "dryRun returns null — no tx sent");
        assert.equal(sent.length, 0, "dryRun must not call sendRawTransaction");
        assert.equal(cap.captured.length, 1, "exactly one tx compiled");
    }
    finally {
        cap.restore();
    }
});
test("executeRoll: compiles a 3-ix tx (compute-budget + from + to) with curator as sole signer", async () => {
    const curatorKp = Keypair.generate();
    const matured = makeMarketFixture(0x20);
    const next = makeMarketFixture(0x50);
    const { accounts, lutAddresses } = accountsAndLutsFor([matured, next]);
    const conn = mockConnection(accounts, { lutAddresses });
    const vault = vaultSnapshot({
        curator: curatorKp.publicKey.toBase58(),
        allocations: [
            {
                market: matured.market.toBase58(),
                weightBps: 6000,
                deployedBase: "500000000",
            },
            {
                market: next.market.toBase58(),
                weightBps: 4000,
                deployedBase: "0",
            },
        ],
    });
    const cap = installCapture();
    try {
        await executeRoll(conn, makeConfig(curatorKp, true), vault, {
            reason: "ready",
            maturedIndex: 0,
            nextIndex: 1,
            maturedMarket: matured.market.toBase58(),
            nextMarket: next.market.toBase58(),
        });
        assert.equal(cap.captured.length, 1);
        const shape = describeMessage(cap.captured[0]);
        assert.equal(shape.signerCount, 1, "only curator signs");
        assert.equal(shape.payer, curatorKp.publicKey.toBase58());
        assert.equal(shape.instructionCount, 3, "ComputeBudget + reallocate_from + reallocate_to");
        assert.equal(shape.programIds[0], "ComputeBudget111111111111111111111111111111");
        const curatorProgram = "831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm";
        assert.equal(shape.programIds[1], curatorProgram);
        assert.equal(shape.programIds[2], curatorProgram);
    }
    finally {
        cap.restore();
    }
});
test("executeRoll: account metas on both reallocate ixs reflect the market-header decode", async () => {
    // deriveReallocateAccounts pulls mint_pt, mint_lp, marketEscrowPt,
    // marketEscrowSy, tokenFeeTreasurySy, marketAlt, syProgram out of the
    // MarketTwo buffer (and coreVault → syProgram). Verify those land in
    // the correct ix's account list.
    const curatorKp = Keypair.generate();
    const matured = makeMarketFixture(0x30);
    const next = makeMarketFixture(0x60);
    const { accounts, lutAddresses } = accountsAndLutsFor([matured, next]);
    const conn = mockConnection(accounts, { lutAddresses });
    const vault = vaultSnapshot({
        curator: curatorKp.publicKey.toBase58(),
        allocations: [
            {
                market: matured.market.toBase58(),
                weightBps: 6000,
                deployedBase: "500000000",
            },
            {
                market: next.market.toBase58(),
                weightBps: 4000,
                deployedBase: "0",
            },
        ],
    });
    const cap = installCapture();
    try {
        await executeRoll(conn, makeConfig(curatorKp, true), vault, {
            reason: "ready",
            maturedIndex: 0,
            nextIndex: 1,
            maturedMarket: matured.market.toBase58(),
            nextMarket: next.market.toBase58(),
        });
        const shape = describeMessage(cap.captured[0]);
        // Ix 1 = reallocate_from(matured); ix 2 = reallocate_to(next).
        const fromAccounts = shape.ixAccountSets[1];
        const toAccounts = shape.ixAccountSets[2];
        for (const pk of [
            matured.market,
            matured.marketAlt,
            matured.mintPt,
            matured.mintLp,
            matured.marketEscrowPt,
            matured.marketEscrowSy,
            matured.tokenFeeTreasurySy,
            matured.syProgram,
        ]) {
            assert.ok(fromAccounts.has(pk.toBase58()), `reallocate_from must reference matured-header key ${pk.toBase58()}`);
        }
        for (const pk of [
            next.market,
            next.marketAlt,
            next.mintPt,
            next.mintLp,
            next.marketEscrowPt,
            next.marketEscrowSy,
            next.tokenFeeTreasurySy,
            next.syProgram,
        ]) {
            assert.ok(toAccounts.has(pk.toBase58()), `reallocate_to must reference next-header key ${pk.toBase58()}`);
        }
    }
    finally {
        cap.restore();
    }
});
test("executeRoll: throws when a market account is missing from RPC", async () => {
    const curatorKp = Keypair.generate();
    const matured = makeMarketFixture(0x70);
    // Only register matured.market — next.market is deliberately missing.
    const { accounts, lutAddresses } = accountsAndLutsFor([matured]);
    const conn = mockConnection(accounts, { lutAddresses });
    const nextMarket = dummy(0xcc).toBase58();
    const vault = vaultSnapshot({
        curator: curatorKp.publicKey.toBase58(),
        allocations: [
            {
                market: matured.market.toBase58(),
                weightBps: 6000,
                deployedBase: "500000000",
            },
            { market: nextMarket, weightBps: 4000, deployedBase: "0" },
        ],
    });
    await assert.rejects(() => executeRoll(conn, makeConfig(curatorKp, true), vault, {
        reason: "ready",
        maturedIndex: 0,
        nextIndex: 1,
        maturedMarket: matured.market.toBase58(),
        nextMarket,
    }), /missing/);
});
// ---------------------------------------------------------------------------
// executeDelegatedRoll (permissionless) — dry-run path
// ---------------------------------------------------------------------------
test("executeDelegatedRoll: dryRun returns null without sending", async () => {
    const keeperKp = Keypair.generate();
    const from = makeMarketFixture(0x80);
    const to = makeMarketFixture(0xa0);
    const { accounts, lutAddresses } = accountsAndLutsFor([from, to]);
    const sent = [];
    const conn = mockConnection(accounts, { captureSent: sent, lutAddresses });
    const vault = vaultSnapshot();
    const delegation = {
        pda: dummy(0xee),
        vault: new PublicKey(vault.vault),
        user: dummy(0xef),
        maxSlippageBps: 50,
        expiresAtSlot: 10000000n,
        allocationsHash: new Uint8Array(32),
        createdAtSlot: 9000000n,
    };
    const cap = installCapture();
    try {
        const sig = await executeDelegatedRoll(conn, makeConfig(keeperKp, true), vault, delegation, {
            reason: "ready",
            fromIndex: 0,
            toIndex: 1,
            fromMarket: from.market.toBase58(),
            toMarket: to.market.toBase58(),
            deployedBase: 500000000n,
            minBaseOut: 497500000n,
        });
        assert.equal(sig, null);
        assert.equal(sent.length, 0);
        assert.equal(cap.captured.length, 1);
    }
    finally {
        cap.restore();
    }
});
test("executeDelegatedRoll: compiles compute-budget + 2 pre-ATA ixs + crank ix, keeper is sole signer", async () => {
    const keeperKp = Keypair.generate();
    const from = makeMarketFixture(0xb0);
    const to = makeMarketFixture(0xd0);
    const { accounts, lutAddresses } = accountsAndLutsFor([from, to]);
    const conn = mockConnection(accounts, { lutAddresses });
    const vault = vaultSnapshot();
    const delegation = {
        pda: dummy(0xfa),
        vault: new PublicKey(vault.vault),
        user: dummy(0xfb),
        maxSlippageBps: 25,
        expiresAtSlot: 10000000n,
        allocationsHash: new Uint8Array(32),
        createdAtSlot: 9000000n,
    };
    const cap = installCapture();
    try {
        await executeDelegatedRoll(conn, makeConfig(keeperKp, true), vault, delegation, {
            reason: "ready",
            fromIndex: 0,
            toIndex: 1,
            fromMarket: from.market.toBase58(),
            toMarket: to.market.toBase58(),
            deployedBase: 1000000000n,
            minBaseOut: 997500000n,
        });
        const shape = describeMessage(cap.captured[0]);
        // ComputeBudget + 2 createATAIdempotent + crank_roll_delegated = 4 ixs.
        assert.equal(shape.instructionCount, 4);
        assert.equal(shape.signerCount, 1, "only the keeper signs");
        assert.equal(shape.payer, keeperKp.publicKey.toBase58());
        assert.equal(shape.programIds[0], "ComputeBudget111111111111111111111111111111");
        assert.equal(shape.programIds[1], "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
        assert.equal(shape.programIds[2], "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
        assert.equal(shape.programIds[3], "831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm");
    }
    finally {
        cap.restore();
    }
});
test("executeDelegatedRoll: crank ix carries both sides' decoded header keys + delegation PDA + keeper", async () => {
    const keeperKp = Keypair.generate();
    const from = makeMarketFixture(0xe0);
    const to = makeMarketFixture(0x100);
    const { accounts, lutAddresses } = accountsAndLutsFor([from, to]);
    const conn = mockConnection(accounts, { lutAddresses });
    const vault = vaultSnapshot();
    const delegation = {
        pda: dummy(0xaa),
        vault: new PublicKey(vault.vault),
        user: dummy(0xab),
        maxSlippageBps: 50,
        expiresAtSlot: 10000000n,
        allocationsHash: new Uint8Array(32),
        createdAtSlot: 9000000n,
    };
    const cap = installCapture();
    try {
        await executeDelegatedRoll(conn, makeConfig(keeperKp, true), vault, delegation, {
            reason: "ready",
            fromIndex: 0,
            toIndex: 1,
            fromMarket: from.market.toBase58(),
            toMarket: to.market.toBase58(),
            deployedBase: 500000000n,
            minBaseOut: 497500000n,
        });
        const shape = describeMessage(cap.captured[0]);
        // Last ix is the crank.
        const crankAccounts = shape.ixAccountSets[shape.ixAccountSets.length - 1];
        for (const side of [from, to]) {
            for (const pk of [
                side.market,
                side.marketAlt,
                side.mintPt,
                side.mintLp,
                side.marketEscrowPt,
                side.marketEscrowSy,
                side.tokenFeeTreasurySy,
            ]) {
                assert.ok(crankAccounts.has(pk.toBase58()), `crank ix must reference decoded key ${pk.toBase58()}`);
            }
        }
        assert.ok(crankAccounts.has(delegation.pda.toBase58()));
        assert.ok(crankAccounts.has(keeperKp.publicKey.toBase58()));
    }
    finally {
        cap.restore();
    }
});
test("executeDelegatedRoll: throws when a market account is missing", async () => {
    const keeperKp = Keypair.generate();
    const from = makeMarketFixture(0x120);
    // to.market intentionally not in the map.
    const { accounts, lutAddresses } = accountsAndLutsFor([from]);
    const conn = mockConnection(accounts, { lutAddresses });
    const vault = vaultSnapshot();
    const delegation = {
        pda: dummy(0xcd),
        vault: new PublicKey(vault.vault),
        user: dummy(0xce),
        maxSlippageBps: 50,
        expiresAtSlot: 10000000n,
        allocationsHash: new Uint8Array(32),
        createdAtSlot: 9000000n,
    };
    const toMarket = dummy(0x140).toBase58();
    await assert.rejects(() => executeDelegatedRoll(conn, makeConfig(keeperKp, true), vault, delegation, {
        reason: "ready",
        fromIndex: 0,
        toIndex: 1,
        fromMarket: from.market.toBase58(),
        toMarket,
        deployedBase: 500000000n,
        minBaseOut: 497500000n,
    }), /derive crank accounts/);
});
//# sourceMappingURL=execute.test.js.map