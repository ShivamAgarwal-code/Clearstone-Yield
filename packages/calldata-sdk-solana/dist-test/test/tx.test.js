/**
 * Unit tests for tx.ts — versioned-transaction packaging.
 *
 * These helpers are the last mile before the frontend signs and sends.
 * They (1) prepend ComputeBudget ixs per Solana's "first-ix" rule,
 * (2) wire LUTs into compileToV0Message, and (3) return unsigned
 * VersionedTransactions. A drift in prelude ordering, LUT plumbing,
 * or payer wiring silently breaks every retail tx.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, PublicKey, TransactionInstruction, VersionedTransaction, } from "@solana/web3.js";
import { packV0Tx, buildZapInToPtV0Tx, buildZapOutToBaseV0Tx, } from "../src/fixed-yield/tx.js";
import { ROUTER_DISC } from "../src/fixed-yield/constants.js";
function dummy(i) {
    const arr = new Uint8Array(32);
    arr[0] = i;
    arr[1] = (i >> 8) & 0xff;
    return new PublicKey(arr);
}
function noopIx(marker) {
    return new TransactionInstruction({
        programId: dummy(0xee),
        keys: [],
        data: Buffer.from([marker]),
    });
}
/** Blockhash must base58-decode to 32 bytes. System program pubkey fits. */
const BLOCKHASH = PublicKey.default.toBase58();
const COMPUTE_BUDGET_PROG = "ComputeBudget111111111111111111111111111111";
// ---------------------------------------------------------------------------
// packV0Tx
// ---------------------------------------------------------------------------
test("packV0Tx: without computeBudget, returns an unsigned v0 tx with only the supplied ixs", () => {
    const tx = packV0Tx({
        ixs: [noopIx(1), noopIx(2)],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
    });
    assert.ok(tx instanceof VersionedTransaction);
    // Unsigned — signatures slot is allocated but all-zero.
    for (const sig of tx.signatures) {
        assert.ok(sig.every((b) => b === 0), "tx must be unsigned");
    }
    assert.equal(tx.message.compiledInstructions.length, 2);
});
test("packV0Tx: payer becomes staticAccountKeys[0]", () => {
    const payer = dummy(0xa1);
    const tx = packV0Tx({
        ixs: [noopIx(1)],
        payer,
        recentBlockhash: BLOCKHASH,
    });
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), payer.toBase58());
});
test("packV0Tx: with computeBudget.unitLimit, prepends SetComputeUnitLimit as ix[0]", () => {
    const tx = packV0Tx({
        ixs: [noopIx(1)],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
        computeBudget: { unitLimit: 400_000 },
    });
    assert.equal(tx.message.compiledInstructions.length, 2);
    const firstProg = tx.message.staticAccountKeys[tx.message.compiledInstructions[0].programIdIndex];
    assert.equal(firstProg.toBase58(), COMPUTE_BUDGET_PROG);
});
test("packV0Tx: with both unitLimit and microLamportsPerCu, ordering is limit then price", () => {
    const tx = packV0Tx({
        ixs: [noopIx(1)],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
        computeBudget: { unitLimit: 400_000, microLamportsPerCu: 5_000 },
    });
    // 2 compute-budget ixs + 1 user ix = 3 total.
    assert.equal(tx.message.compiledInstructions.length, 3);
    const progAt = (i) => tx.message.staticAccountKeys[tx.message.compiledInstructions[i].programIdIndex].toBase58();
    assert.equal(progAt(0), COMPUTE_BUDGET_PROG);
    assert.equal(progAt(1), COMPUTE_BUDGET_PROG);
    assert.notEqual(progAt(2), COMPUTE_BUDGET_PROG, "user ix must come last");
    // SetComputeUnitLimit's data tag is 0x02, SetComputeUnitPrice is 0x03.
    // The compiled instructions carry the data as Uint8Array; the leading
    // byte is the Solana "discriminator" of the ComputeBudget ix.
    assert.equal(tx.message.compiledInstructions[0].data[0], 0x02);
    assert.equal(tx.message.compiledInstructions[1].data[0], 0x03);
});
test("packV0Tx: microLamportsPerCu alone → only SetComputeUnitPrice is prepended", () => {
    const tx = packV0Tx({
        ixs: [noopIx(1)],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
        computeBudget: { microLamportsPerCu: 1_000 },
    });
    assert.equal(tx.message.compiledInstructions.length, 2);
    assert.equal(tx.message.compiledInstructions[0].data[0], 0x03);
});
test("packV0Tx: empty lookupTables array is accepted (treated as no LUTs)", () => {
    const tx = packV0Tx({
        ixs: [noopIx(1)],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
        lookupTables: [],
    });
    assert.equal(tx.message.addressTableLookups.length, 0);
});
test("packV0Tx: lookupTables passed through to compileToV0Message and dedupe keys", () => {
    const lutKey = dummy(0xc1);
    const sharedKey = dummy(0xc2);
    const lut = new AddressLookupTableAccount({
        key: lutKey,
        state: {
            deactivationSlot: BigInt("18446744073709551615"),
            lastExtendedSlot: 0,
            lastExtendedSlotStartIndex: 0,
            authority: undefined,
            addresses: [sharedKey],
        },
    });
    const ixReferencingLutKey = new TransactionInstruction({
        programId: dummy(0xee),
        keys: [{ pubkey: sharedKey, isSigner: false, isWritable: false }],
        data: Buffer.from([1]),
    });
    const tx = packV0Tx({
        ixs: [ixReferencingLutKey],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
        lookupTables: [lut],
    });
    // sharedKey should be compressed into the LUT — appears in
    // addressTableLookups, not staticAccountKeys.
    assert.equal(tx.message.addressTableLookups.length, 1);
    assert.equal(tx.message.addressTableLookups[0].accountKey.toBase58(), lutKey.toBase58());
    assert.ok(!tx.message.staticAccountKeys.some((k) => k.toBase58() === sharedKey.toBase58()), "key present in LUT should not also appear in staticAccountKeys");
});
test("packV0Tx: recentBlockhash is preserved on the compiled message", () => {
    const tx = packV0Tx({
        ixs: [noopIx(1)],
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
    });
    assert.equal(tx.message.recentBlockhash, BLOCKHASH);
});
// ---------------------------------------------------------------------------
// buildZapInToPtV0Tx
// ---------------------------------------------------------------------------
function zapInParams() {
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
        baseSrc: dummy(0x20),
        sySrc: dummy(0x21),
        escrowSy: dummy(0x22),
        ytDst: dummy(0x23),
        ptDst: dummy(0x24),
        mintPt: dummy(0x25),
        mintYt: dummy(0x26),
        amountBase: 1_000_000,
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
    };
}
test("buildZapInToPtV0Tx: strip-only → ComputeBudget + strip (2 ixs), unitLimit default 250_000", () => {
    const tx = buildZapInToPtV0Tx(zapInParams());
    assert.equal(tx.message.compiledInstructions.length, 2);
    // First ix must be ComputeBudget (SetComputeUnitLimit).
    const firstProg = tx.message.staticAccountKeys[tx.message.compiledInstructions[0].programIdIndex];
    assert.equal(firstProg.toBase58(), COMPUTE_BUDGET_PROG);
    // Second ix data starts with wrapper_strip discriminator.
    const stripData = tx.message.compiledInstructions[1].data;
    assert.deepEqual([...stripData.subarray(0, 8)], [...ROUTER_DISC.wrapperStrip]);
});
test("buildZapInToPtV0Tx: with sellYt → 3 ixs (ComputeBudget + strip + sell_yt), default unitLimit 400_000", () => {
    const tx = buildZapInToPtV0Tx({
        ...zapInParams(),
        sellYt: {
            ytIn: 1_000_000,
            minSyOut: 990_000,
            market: dummy(0x70),
            marketEscrowSy: dummy(0x71),
            marketEscrowPt: dummy(0x72),
            marketAlt: dummy(0x73),
            tokenFeeTreasurySy: dummy(0x74),
        },
    });
    assert.equal(tx.message.compiledInstructions.length, 3);
    // ix 2 is the sell_yt.
    const sellData = tx.message.compiledInstructions[2].data;
    assert.deepEqual([...sellData.subarray(0, 8)], [...ROUTER_DISC.wrapperSellYt]);
});
test("buildZapInToPtV0Tx: caller-supplied computeBudget overrides defaultZapInCompute", () => {
    const tx = buildZapInToPtV0Tx({
        ...zapInParams(),
        computeBudget: { unitLimit: 123_456, microLamportsPerCu: 777 },
    });
    // 2 compute-budget ixs + strip = 3 total on the no-sellYt path.
    assert.equal(tx.message.compiledInstructions.length, 3);
    // First ix: SetComputeUnitLimit with unitLimit=123_456. The encoded
    // data is [0x02, <u32 LE>] — 5 bytes total.
    const d = tx.message.compiledInstructions[0].data;
    assert.equal(d[0], 0x02);
    const limit = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(1, true);
    assert.equal(limit, 123_456);
});
test("buildZapInToPtV0Tx: payer on message matches the supplied payer", () => {
    const payer = dummy(0xa1);
    const tx = buildZapInToPtV0Tx({ ...zapInParams(), payer });
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), payer.toBase58());
});
test("buildZapInToPtV0Tx: returns an unsigned tx", () => {
    const tx = buildZapInToPtV0Tx(zapInParams());
    for (const sig of tx.signatures) {
        assert.ok(sig.every((b) => b === 0));
    }
});
// ---------------------------------------------------------------------------
// buildZapOutToBaseV0Tx
// ---------------------------------------------------------------------------
function zapOutParams() {
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
        sySrc: dummy(0x30),
        baseDst: dummy(0x31),
        escrowSy: dummy(0x32),
        ytSrc: dummy(0x33),
        ptSrc: dummy(0x34),
        mintPt: dummy(0x35),
        mintYt: dummy(0x36),
        amountPy: 500_000,
        payer: dummy(0x01),
        recentBlockhash: BLOCKHASH,
    };
}
test("buildZapOutToBaseV0Tx: ComputeBudget + merge (2 ixs), default unitLimit 300_000", () => {
    const tx = buildZapOutToBaseV0Tx(zapOutParams());
    assert.equal(tx.message.compiledInstructions.length, 2);
    const mergeData = tx.message.compiledInstructions[1].data;
    assert.deepEqual([...mergeData.subarray(0, 8)], [...ROUTER_DISC.wrapperMerge]);
    // Default unitLimit = 300_000.
    const cbData = tx.message.compiledInstructions[0].data;
    const limit = new DataView(cbData.buffer, cbData.byteOffset, cbData.byteLength).getUint32(1, true);
    assert.equal(limit, 300_000);
});
test("buildZapOutToBaseV0Tx: unsigned + correct payer", () => {
    const payer = dummy(0xa2);
    const tx = buildZapOutToBaseV0Tx({ ...zapOutParams(), payer });
    assert.equal(tx.message.staticAccountKeys[0].toBase58(), payer.toBase58());
    for (const sig of tx.signatures) {
        assert.ok(sig.every((b) => b === 0));
    }
});
