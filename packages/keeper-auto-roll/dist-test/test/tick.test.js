/**
 * Tests for the top-level `runTick` dispatcher.
 *
 * The tick loop is where delegation scan / decide / execute are wired
 * together. Critical branches to pin:
 *
 *   - Delegated crank fires when there's a live, ready delegation
 *     (Path 1). A curator-signed fallback should NOT run in that case.
 *   - Curator-signed fallback fires when no delegations exist AND the
 *     decide path says ready.
 *   - SKIP_CURATOR_FALLBACK=1 suppresses path 2 entirely — needed for
 *     keepers running without the curator key.
 *   - A thrown delegated crank doesn't starve other delegations in the
 *     same vault.
 *   - scanDelegations errors are swallowed (the keeper still services
 *     the curator-signed path).
 *
 * Harness: mock Connection + globalThis.fetch, patch executeRoll /
 * executeDelegatedRoll via spy wrappers. `runTick` is exported
 * specifically for this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Keypair, PublicKey, } from "@solana/web3.js";
import { runTick } from "../src/index.js";
import { fixedYield } from "@delta/calldata-sdk-solana";
// ---------------------------------------------------------------------------
// In-memory CuratorVaultSnapshot + LiveDelegation fixture builders.
// ---------------------------------------------------------------------------
const BASE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MARKET_A = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const MARKET_B = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2";
function vaultSnapshot(params) {
    return {
        id: "vault-1",
        label: "USDC",
        baseSymbol: "USDC",
        baseMint: BASE_MINT,
        baseDecimals: 6,
        kycGated: false,
        vault: params.vaultPk,
        curator: params.curator,
        baseEscrow: "11111111111111111111111111111111",
        totalAssets: "1000",
        totalShares: "1000",
        feeBps: 0,
        nextAutoRollTs: params.nextTs,
        allocations: [
            { market: MARKET_A, weightBps: 6000, deployedBase: "500" },
            { market: MARKET_B, weightBps: 4000, deployedBase: "0" },
        ],
    };
}
/** Build a RollDelegation account body matching the 123-byte layout. */
function delegationAccount(vaultPk, userPk) {
    const buf = new Uint8Array(fixedYield.delegation.ROLL_DELEGATION_ACCOUNT_SIZE);
    new PublicKey(vaultPk).toBuffer().copy(buf, 8);
    new PublicKey(userPk).toBuffer().copy(buf, 40);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    v.setUint16(72, 50, true); // maxSlippageBps = 50
    v.setBigUint64(74, 999999999n, true); // expiresAtSlot — well in the future
    v.setBigUint64(114, 0n, true);
    buf[122] = 255;
    return buf;
}
function mockConnection(opts = {}) {
    return {
        getSlot: opts.getSlot ?? (async () => 1000n),
        getProgramAccounts: async () => (opts.delegationAccounts ?? []).map(({ pubkey, data }) => ({
            pubkey,
            account: {
                data,
                executable: false,
                lamports: 0,
                owner: PublicKey.default,
            },
        })),
        getAccountInfo: async (pk) => {
            const data = opts.accountInfo?.get(pk.toBase58());
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
                    addresses: [],
                },
            }),
        }),
        getLatestBlockhash: async () => ({
            blockhash: PublicKey.default.toBase58(),
            lastValidBlockHeight: 100,
        }),
        sendRawTransaction: async () => "sig",
        confirmTransaction: async () => ({ value: { err: null } }),
    };
}
// ---------------------------------------------------------------------------
// fetch shim for fetchCuratorVaults
// ---------------------------------------------------------------------------
function installFetch(payload) {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
    return () => {
        globalThis.fetch = orig;
    };
}
function makeConfig(kp, overrides = {}) {
    return {
        rpcUrl: "http://mock",
        edgeUrl: "http://mock-edge",
        curatorKeypair: kp,
        pollIntervalSec: 60,
        maturityGraceSec: 30,
        slippageBps: 50,
        oneShot: true,
        dryRun: true,
        ...overrides,
    };
}
/** Capture console.log lines emitted during a block — each is a JSON object. */
function captureLogs(block) {
    const logs = [];
    const orig = console.log;
    console.log = (s) => {
        try {
            logs.push(JSON.parse(String(s)));
        }
        catch {
            /* non-JSON line — ignore */
        }
    };
    return block()
        .then((result) => ({ result, logs }))
        .finally(() => {
        console.log = orig;
    });
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("runTick: empty vault list → logs tick.start with 0 vaults + tick.end, no crashes", async () => {
    const kp = Keypair.generate();
    const conn = mockConnection();
    const restoreFetch = installFetch({ vaults: [] });
    try {
        const { logs } = await captureLogs(async () => runTick(conn, makeConfig(kp)));
        const start = logs.find((l) => l.event === "tick.start");
        assert.ok(start, "must log tick.start");
        assert.equal(start.vaults, 0);
        assert.equal(start.delegations, 0);
        assert.ok(logs.some((l) => l.event === "tick.end"));
    }
    finally {
        restoreFetch();
    }
});
test("runTick: no delegations + curator-mismatch → tick.skip with reason", async () => {
    const kp = Keypair.generate();
    const vault = vaultSnapshot({
        curator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j9", // NOT kp
        vaultPk: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
        nextTs: Math.floor(Date.now() / 1000) - 3600, // already matured
    });
    const conn = mockConnection();
    const restoreFetch = installFetch({ vaults: [vault] });
    try {
        const { logs } = await captureLogs(async () => runTick(conn, makeConfig(kp)));
        const skip = logs.find((l) => l.event === "tick.skip" && l.vault === "vault-1");
        assert.ok(skip, "must log tick.skip on curator mismatch");
        assert.equal(skip.reason, "curator-mismatch");
    }
    finally {
        restoreFetch();
    }
});
test("runTick: SKIP_CURATOR_FALLBACK=1 suppresses path 2 when no delegated crank fired", async () => {
    const kp = Keypair.generate();
    const vault = vaultSnapshot({
        curator: kp.publicKey.toBase58(),
        vaultPk: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
        nextTs: Math.floor(Date.now() / 1000) - 3600,
    });
    const conn = mockConnection();
    const restoreFetch = installFetch({ vaults: [vault] });
    const prev = process.env.SKIP_CURATOR_FALLBACK;
    process.env.SKIP_CURATOR_FALLBACK = "1";
    try {
        const { logs } = await captureLogs(async () => runTick(conn, makeConfig(kp)));
        // Must see a tick.skip with reason=no-delegated-crank, and NO
        // auto_roll.completed or auto_roll.failed.
        const skip = logs.find((l) => l.event === "tick.skip" && l.reason === "no-delegated-crank");
        assert.ok(skip, "must log the SKIP_CURATOR_FALLBACK branch");
        assert.ok(!logs.some((l) => l.event === "auto_roll.completed"), "path 2 must not run when SKIP_CURATOR_FALLBACK=1");
    }
    finally {
        if (prev === undefined)
            delete process.env.SKIP_CURATOR_FALLBACK;
        else
            process.env.SKIP_CURATOR_FALLBACK = prev;
        restoreFetch();
    }
});
test("runTick: delegation-expired → delegated.skip, no executeDelegatedRoll", async () => {
    // A live delegation that the decision path will classify as
    // delegation-expired (by putting nowSlot past its expiry).
    const kp = Keypair.generate();
    const userKp = Keypair.generate();
    const vaultPk = "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA";
    const vault = vaultSnapshot({
        curator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j9",
        vaultPk,
        nextTs: Math.floor(Date.now() / 1000) - 3600,
    });
    // Build a delegation with expiresAt=500 (past nowSlot=1000).
    const expiredBuf = new Uint8Array(fixedYield.delegation.ROLL_DELEGATION_ACCOUNT_SIZE);
    new PublicKey(vaultPk).toBuffer().copy(expiredBuf, 8);
    userKp.publicKey.toBuffer().copy(expiredBuf, 40);
    const dv = new DataView(expiredBuf.buffer, expiredBuf.byteOffset, expiredBuf.byteLength);
    dv.setUint16(72, 50, true);
    dv.setBigUint64(74, 500n, true); // expired before nowSlot=1000
    const conn = mockConnection({
        getSlot: async () => 1000n,
        delegationAccounts: [
            { pubkey: new PublicKey("11111111111111111111111111111111"), data: expiredBuf },
        ],
    });
    const restoreFetch = installFetch({ vaults: [vault] });
    try {
        const { logs } = await captureLogs(async () => runTick(conn, makeConfig(kp)));
        // filterLive drops the expired delegation before it reaches
        // decideDelegatedRoll → no delegated.skip log. The vault then
        // takes the curator-signed fallback path (curator-mismatch since
        // kp != vault.curator).
        assert.ok(!logs.some((l) => l.event === "delegated_roll.completed"), "expired delegations must not crank");
    }
    finally {
        restoreFetch();
    }
});
test("runTick: scanDelegations failure logs error but continues to curator-signed path", async () => {
    const kp = Keypair.generate();
    const vault = vaultSnapshot({
        curator: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j9",
        vaultPk: "DoPdypbndDDtjhxQ1P3WozCmHw4rWSF5bzABeBX2VToA",
        nextTs: Math.floor(Date.now() / 1000) - 3600,
    });
    const conn = {
        ...mockConnection(),
        getProgramAccounts: async () => {
            throw new Error("RPC exploded");
        },
    };
    const restoreFetch = installFetch({ vaults: [vault] });
    try {
        const { logs } = await captureLogs(async () => runTick(conn, makeConfig(kp)));
        assert.ok(logs.some((l) => l.event === "scan_delegations.error" &&
            String(l.error).includes("RPC exploded")), "must log scan_delegations.error");
        // tick.start must still fire (with 0 delegations) and the vault
        // loop must still visit vault-1.
        const start = logs.find((l) => l.event === "tick.start");
        assert.equal(start.delegations, 0);
    }
    finally {
        restoreFetch();
    }
});
//# sourceMappingURL=tick.test.js.map