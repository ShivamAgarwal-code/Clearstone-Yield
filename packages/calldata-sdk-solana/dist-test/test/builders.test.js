/**
 * Unit tests for the router wrapper_* builders in src/fixed-yield/builders.ts.
 *
 * These are the widest untested wire-format surface in the SDK. Each
 * wrapper is a single-ix cascade: adapter (mint_sy / redeem_sy) CPI'ing
 * into core (strip / merge / trade / sell_yt). The router dedupes
 * accounts across the inner CPIs, so the ix layout is non-obvious —
 * a swap of two accounts silently breaks every retail tx.
 *
 * Test strategy: pin discriminator bytes, arg serialization, account
 * count, signer/writability per slot, and program defaults for each
 * builder. BN/bigint/number equivalence checked once — it's shared
 * helper behavior, not per-builder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { buildWrapperStrip, buildWrapperMerge, buildWrapperBuyPt, buildWrapperBuyYt, buildWrapperSellPt, buildWrapperSellYt, } from "../src/fixed-yield/builders.js";
import { ROUTER_DISC } from "../src/fixed-yield/constants.js";
import { CLEARSTONE_ROUTER_PROGRAM_ID, CLEARSTONE_CORE_PROGRAM_ID, GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID, TOKEN_PROGRAM_ID, } from "../src/common/constants.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function dummy(i) {
    const arr = new Uint8Array(32);
    arr[0] = i;
    arr[1] = (i >> 8) & 0xff;
    return new PublicKey(arr);
}
/**
 * Shared `WrapperCommon` block. Every wrapper builder takes this plus
 * direction-specific params.
 */
function common() {
    return {
        user: dummy(0x01),
        syMarket: dummy(0x02),
        baseMint: dummy(0x03),
        syMint: dummy(0x04),
        baseVault: dummy(0x05),
        authority: dummy(0x06),
        vault: dummy(0x07),
        yieldPosition: dummy(0x08),
        addressLookupTable: dummy(0x09),
        coreEventAuthority: dummy(0x0a),
    };
}
// ---------------------------------------------------------------------------
// wrapper_strip
// ---------------------------------------------------------------------------
function stripParams() {
    return {
        ...common(),
        baseSrc: dummy(0x20),
        sySrc: dummy(0x21),
        escrowSy: dummy(0x22),
        ytDst: dummy(0x23),
        ptDst: dummy(0x24),
        mintPt: dummy(0x25),
        mintYt: dummy(0x26),
        amountBase: 1_000_000,
    };
}
test("buildWrapperStrip: programId defaults to CLEARSTONE_ROUTER_PROGRAM_ID", () => {
    const ix = buildWrapperStrip(stripParams());
    assert.equal(ix.programId.toBase58(), CLEARSTONE_ROUTER_PROGRAM_ID.toBase58());
});
test("buildWrapperStrip: data = disc + u64 LE amountBase", () => {
    const ix = buildWrapperStrip({
        ...stripParams(),
        amountBase: 0x0102030405060708n,
    });
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperStrip]);
    assert.deepEqual([...ix.data.subarray(8, 16)], [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
});
test("buildWrapperStrip: 20-key layout, user is sole signer, all program keys default", () => {
    const p = stripParams();
    const ix = buildWrapperStrip(p);
    assert.equal(ix.keys.length, 20);
    const signers = ix.keys.filter((k) => k.isSigner);
    assert.equal(signers.length, 1);
    assert.equal(signers[0].pubkey.toBase58(), p.user.toBase58());
    // Readonly slots: syMarket, baseMint, tokenProgram, addressLookupTable,
    // syProgram, coreProgram, coreEventAuthority.
    const readonlyIndices = [1, 2, 14, 15, 16, 17, 19];
    for (const i of readonlyIndices) {
        assert.equal(ix.keys[i].isWritable, false, `index ${i} must be readonly`);
    }
    // Program defaults at their documented slots.
    assert.equal(ix.keys[14].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[16].pubkey.toBase58(), GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[17].pubkey.toBase58(), CLEARSTONE_CORE_PROGRAM_ID.toBase58());
});
test("buildWrapperStrip: forwards remainingAccounts past the fixed tail", () => {
    const extra1 = dummy(0xf0);
    const extra2 = dummy(0xf1);
    const ix = buildWrapperStrip({
        ...stripParams(),
        remainingAccounts: [
            { pubkey: extra1, isSigner: false, isWritable: false },
            { pubkey: extra2, isSigner: false, isWritable: true },
        ],
    });
    assert.equal(ix.keys.length, 22);
    assert.equal(ix.keys[20].pubkey.toBase58(), extra1.toBase58());
    assert.equal(ix.keys[21].pubkey.toBase58(), extra2.toBase58());
    assert.equal(ix.keys[21].isWritable, true);
});
test("buildWrapperStrip: BN and bigint produce identical data", () => {
    const p = stripParams();
    const a = buildWrapperStrip({ ...p, amountBase: 1000000n });
    const b = buildWrapperStrip({ ...p, amountBase: new BN(1_000_000) });
    assert.deepEqual([...a.data], [...b.data]);
});
test("buildWrapperStrip: program-id overrides are honoured", () => {
    const override = dummy(0xfe);
    const ix = buildWrapperStrip({
        ...stripParams(),
        tokenProgram: override,
        syProgram: override,
        coreProgram: override,
        routerProgram: override,
    });
    assert.equal(ix.programId.toBase58(), override.toBase58());
    assert.equal(ix.keys[14].pubkey.toBase58(), override.toBase58());
    assert.equal(ix.keys[16].pubkey.toBase58(), override.toBase58());
    assert.equal(ix.keys[17].pubkey.toBase58(), override.toBase58());
});
// ---------------------------------------------------------------------------
// wrapper_merge
// ---------------------------------------------------------------------------
function mergeParams() {
    return {
        ...common(),
        sySrc: dummy(0x30),
        baseDst: dummy(0x31),
        escrowSy: dummy(0x32),
        ytSrc: dummy(0x33),
        ptSrc: dummy(0x34),
        mintPt: dummy(0x35),
        mintYt: dummy(0x36),
        amountPy: 500_000,
    };
}
test("buildWrapperMerge: discriminator + u64 LE amountPy", () => {
    const ix = buildWrapperMerge({ ...mergeParams(), amountPy: 0xabcdef });
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperMerge]);
    assert.equal(ix.data[8], 0xef);
    assert.equal(ix.data[9], 0xcd);
    assert.equal(ix.data[10], 0xab);
    for (let i = 11; i < 16; i++)
        assert.equal(ix.data[i], 0);
});
test("buildWrapperMerge: 20-key layout, user signs, programs at documented slots", () => {
    const p = mergeParams();
    const ix = buildWrapperMerge(p);
    assert.equal(ix.keys.length, 20);
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].pubkey.toBase58(), p.user.toBase58());
    assert.equal(ix.keys[14].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[16].pubkey.toBase58(), GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[17].pubkey.toBase58(), CLEARSTONE_CORE_PROGRAM_ID.toBase58());
});
test("buildWrapperMerge: yield_position is writable (pre-/post-maturity both touch it)", () => {
    const p = mergeParams();
    const ix = buildWrapperMerge(p);
    // Position is at index 18 in the layout (after coreProgram at 17).
    const positionSlot = ix.keys.findIndex((k) => k.pubkey.toBase58() === p.yieldPosition.toBase58());
    assert.notEqual(positionSlot, -1);
    assert.equal(ix.keys[positionSlot].isWritable, true);
});
// ---------------------------------------------------------------------------
// wrapper_buy_pt
// ---------------------------------------------------------------------------
function buyPtParams() {
    return {
        ...common(),
        baseSrc: dummy(0x40),
        sySrc: dummy(0x41),
        ptDst: dummy(0x42),
        market: dummy(0x43),
        marketEscrowSy: dummy(0x44),
        marketEscrowPt: dummy(0x45),
        marketAlt: dummy(0x46),
        tokenFeeTreasurySy: dummy(0x47),
        ptAmount: 1_000_000,
        maxBase: 2_000_000,
        maxSyIn: 1_500_000,
    };
}
test("buildWrapperBuyPt: args = disc + u64 ptAmount + u64 maxBase + i64 maxSyIn", () => {
    const ix = buildWrapperBuyPt({
        ...buyPtParams(),
        ptAmount: 1,
        maxBase: 2,
        maxSyIn: 3,
    });
    assert.equal(ix.data.length, 32); // 8 + 8 + 8 + 8
    assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperBuyPt]);
    assert.equal(ix.data[8], 1);
    assert.equal(ix.data[16], 2);
    assert.equal(ix.data[24], 3);
});
test("buildWrapperBuyPt: negative maxSyIn encodes as two's-complement i64", () => {
    const ix = buildWrapperBuyPt({
        ...buyPtParams(),
        ptAmount: 1,
        maxBase: 1,
        maxSyIn: -1,
    });
    for (let i = 24; i < 32; i++) {
        assert.equal(ix.data[i], 0xff, `byte ${i} of i64 two's-complement -1`);
    }
});
test("buildWrapperBuyPt: user is sole signer, 17-key layout (no yieldPosition)", () => {
    const p = buyPtParams();
    const ix = buildWrapperBuyPt(p);
    assert.equal(ix.keys.length, 17);
    const signers = ix.keys.filter((k) => k.isSigner);
    assert.equal(signers.length, 1);
    assert.equal(signers[0].pubkey.toBase58(), p.user.toBase58());
    // Trade-only wrapper doesn't touch yieldPosition.
    assert.ok(!ix.keys.some((k) => k.pubkey.toBase58() === p.yieldPosition.toBase58()));
});
// ---------------------------------------------------------------------------
// wrapper_buy_yt
// ---------------------------------------------------------------------------
function buyYtParams() {
    return {
        ...common(),
        baseSrc: dummy(0x50),
        sySrc: dummy(0x51),
        ytDst: dummy(0x52),
        ptDst: dummy(0x53),
        market: dummy(0x54),
        marketEscrowSy: dummy(0x55),
        marketEscrowPt: dummy(0x56),
        marketAlt: dummy(0x57),
        tokenFeeTreasurySy: dummy(0x58),
        vaultAuthority: dummy(0x59),
        escrowSyVault: dummy(0x5a),
        mintYt: dummy(0x5b),
        mintPt: dummy(0x5c),
        vaultAlt: dummy(0x5d),
        baseIn: 1_000_000,
        syIn: 900_000,
        ytOut: 1_100_000,
    };
}
test("buildWrapperBuyYt: args = disc + u64 baseIn + u64 syIn + u64 ytOut", () => {
    const ix = buildWrapperBuyYt({
        ...buyYtParams(),
        baseIn: 1,
        syIn: 2,
        ytOut: 3,
    });
    assert.equal(ix.data.length, 32);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperBuyYt]);
    assert.equal(ix.data[8], 1);
    assert.equal(ix.data[16], 2);
    assert.equal(ix.data[24], 3);
});
test("buildWrapperBuyYt: strip-cascade contributes vault-level accounts", () => {
    const p = buyYtParams();
    const ix = buildWrapperBuyYt(p);
    // buy_yt self-CPIs into strip, so vault/vaultAuthority/escrowSyVault/
    // mintYt/mintPt/vaultAlt/yieldPosition all need to appear.
    const allKeys = new Set(ix.keys.map((k) => k.pubkey.toBase58()));
    for (const pk of [
        p.vault,
        p.vaultAuthority,
        p.escrowSyVault,
        p.mintYt,
        p.mintPt,
        p.vaultAlt,
        p.yieldPosition,
    ]) {
        assert.ok(allKeys.has(pk.toBase58()), `buy_yt must reference strip-cascade key ${pk.toBase58()}`);
    }
});
// ---------------------------------------------------------------------------
// wrapper_sell_pt
// ---------------------------------------------------------------------------
function sellPtParams() {
    return {
        ...common(),
        sySrc: dummy(0x60),
        ptSrc: dummy(0x61),
        baseDst: dummy(0x62),
        market: dummy(0x63),
        marketEscrowSy: dummy(0x64),
        marketEscrowPt: dummy(0x65),
        marketAlt: dummy(0x66),
        tokenFeeTreasurySy: dummy(0x67),
        ptIn: 500_000,
        minSyOut: 490_000,
    };
}
test("buildWrapperSellPt: args = disc + u64 ptIn + u64 minSyOut", () => {
    const ix = buildWrapperSellPt({
        ...sellPtParams(),
        ptIn: 0x1122,
        minSyOut: 0x3344,
    });
    assert.equal(ix.data.length, 24); // 8 + 8 + 8
    assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperSellPt]);
    assert.equal(ix.data[8], 0x22);
    assert.equal(ix.data[9], 0x11);
    assert.equal(ix.data[16], 0x44);
    assert.equal(ix.data[17], 0x33);
});
test("buildWrapperSellPt: 17-key layout — core trade + adapter redeem only", () => {
    const ix = buildWrapperSellPt(sellPtParams());
    assert.equal(ix.keys.length, 17);
    const signers = ix.keys.filter((k) => k.isSigner);
    assert.equal(signers.length, 1);
});
// ---------------------------------------------------------------------------
// wrapper_sell_yt
// ---------------------------------------------------------------------------
function sellYtParams() {
    const c = common();
    return {
        user: c.user,
        market: dummy(0x70),
        ytSrc: dummy(0x71),
        ptSrc: dummy(0x72),
        sySrc: dummy(0x73),
        marketEscrowSy: dummy(0x74),
        marketEscrowPt: dummy(0x75),
        marketAlt: dummy(0x76),
        tokenFeeTreasurySy: dummy(0x77),
        vault: c.vault,
        vaultAuthority: dummy(0x78),
        escrowSyVault: dummy(0x79),
        mintYt: dummy(0x7a),
        mintPt: dummy(0x7b),
        vaultAlt: c.addressLookupTable,
        yieldPosition: c.yieldPosition,
        syMarket: c.syMarket,
        baseMint: c.baseMint,
        syMint: c.syMint,
        baseVault: c.baseVault,
        baseDst: dummy(0x7c),
        ytIn: 400_000,
        minSyOut: 380_000,
        coreEventAuthority: c.coreEventAuthority,
    };
}
test("buildWrapperSellYt: args = disc + u64 ytIn + u64 minSyOut", () => {
    const ix = buildWrapperSellYt(sellYtParams());
    assert.equal(ix.data.length, 24);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...ROUTER_DISC.wrapperSellYt]);
});
test("buildWrapperSellYt: merge-cascade accounts present, user is sole signer", () => {
    const p = sellYtParams();
    const ix = buildWrapperSellYt(p);
    const signers = ix.keys.filter((k) => k.isSigner);
    assert.equal(signers.length, 1);
    assert.equal(signers[0].pubkey.toBase58(), p.user.toBase58());
    const allKeys = new Set(ix.keys.map((k) => k.pubkey.toBase58()));
    for (const pk of [
        p.vault,
        p.vaultAuthority,
        p.escrowSyVault,
        p.mintYt,
        p.mintPt,
        p.vaultAlt,
        p.yieldPosition,
    ]) {
        assert.ok(allKeys.has(pk.toBase58()), `sell_yt must reference merge-cascade key ${pk.toBase58()}`);
    }
});
