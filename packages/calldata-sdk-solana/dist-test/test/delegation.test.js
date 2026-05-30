/**
 * Unit tests for the delegation SDK builders.
 *
 * The builders live outside of Anchor's IDL layer, so every ix is
 * hand-assembled. These tests assert the wire format matches what the
 * on-chain program expects: discriminator bytes, account ordering,
 * writability flags, arg serialization. A mismatch here = a silent
 * failure in every delegated crank attempt.
 *
 * Test strategy: construct each ix against known fixed inputs and
 * compare serialized bytes / account meta against the spec-locked
 * layouts documented in CURATOR_ROLL_DELEGATION.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buildCreateDelegation, buildCloseDelegation, buildCrankRollDelegated, rollDelegationPda, decodeRollDelegation, slippageFloor, MAX_DELEGATION_SLIPPAGE_BPS, MIN_DELEGATION_TTL_SLOTS, MAX_DELEGATION_TTL_SLOTS, ROLL_DELEGATION_ACCOUNT_SIZE, } from "../src/fixed-yield/delegation.js";
import { CURATOR_DISC } from "../src/fixed-yield/constants.js";
import { CLEARSTONE_CURATOR_PROGRAM_ID } from "../src/common/constants.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER = new PublicKey("11111111111111111111111111111111");
const VAULT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// ---------------------------------------------------------------------------
// PDA
// ---------------------------------------------------------------------------
test("rollDelegationPda: stable derivation for (vault, user)", () => {
    const a = rollDelegationPda(VAULT, USER);
    const b = rollDelegationPda(VAULT, USER);
    assert.equal(a.toBase58(), b.toBase58());
});
test("rollDelegationPda: distinct users produce distinct PDAs", () => {
    const u2 = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    assert.notEqual(rollDelegationPda(VAULT, USER).toBase58(), rollDelegationPda(VAULT, u2).toBase58());
});
test("rollDelegationPda: distinct vaults produce distinct PDAs", () => {
    const v2 = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    assert.notEqual(rollDelegationPda(VAULT, USER).toBase58(), rollDelegationPda(v2, USER).toBase58());
});
// ---------------------------------------------------------------------------
// create_delegation
// ---------------------------------------------------------------------------
test("buildCreateDelegation: programId defaults to CLEARSTONE_CURATOR_PROGRAM_ID", () => {
    const ix = buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: 50,
        ttlSlots: 1_512_000,
    });
    assert.equal(ix.programId.toBase58(), CLEARSTONE_CURATOR_PROGRAM_ID.toBase58());
});
test("buildCreateDelegation: data prefix matches discriminator", () => {
    const ix = buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: 50,
        ttlSlots: 1_512_000,
    });
    const prefix = Buffer.from(ix.data.subarray(0, 8));
    assert.deepEqual([...prefix], [...CURATOR_DISC.createDelegation], "first 8 bytes must be the create_delegation sha256 discriminator");
});
test("buildCreateDelegation: args serialise as u16 LE + u64 LE (max valid vectors)", () => {
    // Use boundary values within the accepted range so we test both
    // validation AND serialisation in one pass.
    //   maxSlippageBps = 1000 (0x03E8) → bytes: E8 03
    //   ttlSlots = 21_600_000 (0x01499700) → bytes: 00 97 49 01 00 00 00 00
    const ix = buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: MAX_DELEGATION_SLIPPAGE_BPS,
        ttlSlots: MAX_DELEGATION_TTL_SLOTS,
    });
    // bytes 8..10 = slippage u16 LE
    assert.equal(ix.data[8], 0xe8);
    assert.equal(ix.data[9], 0x03);
    // bytes 10..18 = ttl u64 LE
    assert.equal(ix.data[10], 0x00);
    assert.equal(ix.data[11], 0x97);
    assert.equal(ix.data[12], 0x49);
    assert.equal(ix.data[13], 0x01);
    for (let i = 14; i < 18; i++)
        assert.equal(ix.data[i], 0x00);
});
test("buildCreateDelegation: account order matches spec", () => {
    const ix = buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: 50,
        ttlSlots: 1_512_000,
    });
    const names = ["user (Signer,mut)", "vault (ro)", "delegation (mut)", "system_program (ro)"];
    assert.equal(ix.keys.length, 4, `expected 4 keys, got ${ix.keys.length}: ${names}`);
    // user: signer + writable
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[0].pubkey.toBase58(), USER.toBase58());
    // vault: readonly
    assert.equal(ix.keys[1].isSigner, false);
    assert.equal(ix.keys[1].isWritable, false);
    assert.equal(ix.keys[1].pubkey.toBase58(), VAULT.toBase58());
    // delegation: writable (init_if_needed)
    assert.equal(ix.keys[2].isWritable, true);
    assert.equal(ix.keys[2].pubkey.toBase58(), rollDelegationPda(VAULT, USER).toBase58(), "delegation must be the (vault, user) PDA");
    // system_program
    assert.equal(ix.keys[3].pubkey.toBase58(), "11111111111111111111111111111111");
});
test("buildCreateDelegation: rejects slippage > MAX", () => {
    assert.throws(() => buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: MAX_DELEGATION_SLIPPAGE_BPS + 1,
        ttlSlots: 1_512_000,
    }));
});
test("buildCreateDelegation: rejects negative slippage", () => {
    assert.throws(() => buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: -1,
        ttlSlots: 1_512_000,
    }));
});
test("buildCreateDelegation: rejects ttl < MIN", () => {
    assert.throws(() => buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: 50,
        ttlSlots: MIN_DELEGATION_TTL_SLOTS - 1,
    }));
});
test("buildCreateDelegation: rejects ttl > MAX", () => {
    assert.throws(() => buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: 50,
        ttlSlots: MAX_DELEGATION_TTL_SLOTS + 1,
    }));
});
test("buildCreateDelegation: accepts boundary values (0 bps, MIN_TTL, MAX_TTL)", () => {
    buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: 0,
        ttlSlots: MIN_DELEGATION_TTL_SLOTS,
    });
    buildCreateDelegation({
        user: USER,
        vault: VAULT,
        maxSlippageBps: MAX_DELEGATION_SLIPPAGE_BPS,
        ttlSlots: MAX_DELEGATION_TTL_SLOTS,
    });
});
// ---------------------------------------------------------------------------
// close_delegation
// ---------------------------------------------------------------------------
test("buildCloseDelegation: data is the discriminator only (no args)", () => {
    const ix = buildCloseDelegation({ user: USER, vault: VAULT });
    assert.equal(ix.data.length, 8);
    assert.deepEqual([...ix.data], [...CURATOR_DISC.closeDelegation]);
});
test("buildCloseDelegation: account layout — user Signer, delegation writable", () => {
    const ix = buildCloseDelegation({ user: USER, vault: VAULT });
    assert.equal(ix.keys.length, 2);
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[0].pubkey.toBase58(), USER.toBase58());
    assert.equal(ix.keys[1].isWritable, true);
    assert.equal(ix.keys[1].pubkey.toBase58(), rollDelegationPda(VAULT, USER).toBase58());
});
// ---------------------------------------------------------------------------
// crank_roll_delegated
// ---------------------------------------------------------------------------
function dummy(i) {
    // Deterministic filler keys for testing account-slot presence.
    const arr = new Uint8Array(32);
    arr[0] = i;
    return new PublicKey(arr);
}
test("buildCrankRollDelegated: discriminator prefix + arg layout", () => {
    const ix = buildCrankRollDelegated(makeCrankParams());
    assert.deepEqual([...ix.data.subarray(0, 8)], [...CURATOR_DISC.crankRollDelegated]);
    // fromIndex (u16) at 8..10
    assert.equal(ix.data[8], 0x07);
    assert.equal(ix.data[9], 0x00);
    // toIndex (u16) at 10..12
    assert.equal(ix.data[10], 0x02);
    assert.equal(ix.data[11], 0x00);
    // minBaseOut (u64) at 12..20 — 1000 = 0xe8 0x03 ...
    assert.equal(ix.data[12], 0xe8);
    assert.equal(ix.data[13], 0x03);
});
test("buildCrankRollDelegated: 33 accounts, keeper is the only signer", () => {
    const ix = buildCrankRollDelegated(makeCrankParams());
    assert.equal(ix.keys.length, 33);
    const signers = ix.keys.filter((k) => k.isSigner);
    assert.equal(signers.length, 1);
    assert.equal(signers[0].pubkey.toBase58(), dummy(0xaa).toBase58());
});
test("buildCrankRollDelegated: delegation account is readonly (not a signer)", () => {
    const ix = buildCrankRollDelegated(makeCrankParams());
    // Delegation is at index 1.
    assert.equal(ix.keys[1].isSigner, false);
    assert.equal(ix.keys[1].isWritable, false);
});
test("buildCrankRollDelegated: writability matches spec §3.5", () => {
    const ix = buildCrankRollDelegated(makeCrankParams());
    // Spot-check a few that must be writable.
    const mustBeWritable = [2, 4, 7, 9, 17, 18, 25, 26]; // vault, base_escrow, adapter_base_vault, from_market, from_vault_pt_ata, from_vault_lp_ata, to_vault_pt_ata, to_vault_lp_ata (approx indices)
    for (const i of mustBeWritable) {
        assert.equal(ix.keys[i].isWritable, true, `account index ${i} (${ix.keys[i].pubkey.toBase58()}) must be writable`);
    }
});
function makeCrankParams() {
    return {
        keeper: dummy(0xaa),
        delegation: dummy(1),
        vault: dummy(2),
        baseMint: dummy(3),
        baseEscrow: dummy(4),
        syMarket: dummy(5),
        syMint: dummy(6),
        adapterBaseVault: dummy(7),
        vaultSyAta: dummy(8),
        fromMarket: dummy(9),
        fromMarketEscrowPt: dummy(10),
        fromMarketEscrowSy: dummy(11),
        fromTokenFeeTreasurySy: dummy(12),
        fromMarketAlt: dummy(13),
        fromMintPt: dummy(14),
        fromMintLp: dummy(15),
        fromVaultPtAta: dummy(16),
        fromVaultLpAta: dummy(17),
        toMarket: dummy(18),
        toMarketEscrowPt: dummy(19),
        toMarketEscrowSy: dummy(20),
        toTokenFeeTreasurySy: dummy(21),
        toMarketAlt: dummy(22),
        toMintPt: dummy(23),
        toMintLp: dummy(24),
        toVaultPtAta: dummy(25),
        toVaultLpAta: dummy(26),
        coreEventAuthority: dummy(27),
        fromIndex: 7,
        toIndex: 2,
        minBaseOut: 1000,
    };
}
// ---------------------------------------------------------------------------
// decodeRollDelegation — parity with Rust layout
// ---------------------------------------------------------------------------
test("decodeRollDelegation: roundtrips a hand-built buffer", () => {
    const buf = new Uint8Array(ROLL_DELEGATION_ACCOUNT_SIZE);
    // Fill discriminator (0..8) with a recognisable pattern.
    for (let i = 0; i < 8; i++)
        buf[i] = 0xaa;
    // vault
    const vaultKey = VAULT.toBuffer();
    buf.set(vaultKey, 8);
    // user
    const userKey = USER.toBuffer();
    buf.set(userKey, 40);
    // max_slippage_bps = 250 (0.025 frac = 2.5%) LE
    const view = new DataView(buf.buffer);
    view.setUint16(72, 250, true);
    // expires_at_slot = 1_000_000
    view.setBigUint64(74, 1000000n, true);
    // allocations_hash: 0x11..
    for (let i = 0; i < 32; i++)
        buf[82 + i] = 0x11;
    // created_at_slot = 500_000
    view.setBigUint64(114, 500000n, true);
    // bump = 255
    buf[122] = 255;
    const decoded = decodeRollDelegation(buf);
    assert.equal(decoded.vault.toBase58(), VAULT.toBase58());
    assert.equal(decoded.user.toBase58(), USER.toBase58());
    assert.equal(decoded.maxSlippageBps, 250);
    assert.equal(decoded.expiresAtSlot, 1000000n);
    assert.equal(decoded.createdAtSlot, 500000n);
    assert.equal(decoded.allocationsHash.length, 32);
    assert.equal(decoded.allocationsHash[0], 0x11);
});
test("decodeRollDelegation: throws on undersized buffer", () => {
    const tooSmall = new Uint8Array(ROLL_DELEGATION_ACCOUNT_SIZE - 1);
    assert.throws(() => decodeRollDelegation(tooSmall), /too small/);
});
// ---------------------------------------------------------------------------
// slippageFloor parity with Rust
// ---------------------------------------------------------------------------
test("slippageFloor: matches Rust math bit-for-bit", () => {
    // Covered in Rust tests — re-run the same vectors here to catch
    // TS/Rust drift (e.g. a change to bigint semantics).
    assert.equal(slippageFloor(1000000n, 0), 1000000n);
    assert.equal(slippageFloor(1000000n, 50), 995000n);
    assert.equal(slippageFloor(1000000n, 1_000), 900000n);
    assert.equal(slippageFloor(10n, 50), 9n);
    assert.equal(slippageFloor(100n, 50), 99n);
    assert.equal(slippageFloor(0n, 500), 0n);
});
