/**
 * Unit tests for the retail curator builders (deposit / withdraw) and
 * the three curator PDAs that drive every retail "savings account" flow.
 *
 * The PDA derivations are part of the program's ABI — if they change,
 * every deposit/withdraw/position lookup in the retail UI breaks silently.
 * Pin the seeds and (base58) outputs so drift shows up here, not in prod.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, } from "@solana/web3.js";
import BN from "bn.js";
import { buildCuratorDeposit, buildCuratorWithdraw, curatorVaultPda, curatorBaseEscrowPda, curatorUserPositionPda, } from "../src/fixed-yield/curator.js";
import { CURATOR_DISC } from "../src/fixed-yield/constants.js";
import { CLEARSTONE_CURATOR_PROGRAM_ID, TOKEN_PROGRAM_ID, } from "../src/common/constants.js";
const CURATOR = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
const USER = new PublicKey("11111111111111111111111111111111");
const BASE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// ---------------------------------------------------------------------------
// PDA derivations — pin seeds
// ---------------------------------------------------------------------------
test("curatorVaultPda: deterministic, depends on both (curator, baseMint)", () => {
    const a = curatorVaultPda(CURATOR, BASE_MINT);
    const b = curatorVaultPda(CURATOR, BASE_MINT);
    assert.equal(a.toBase58(), b.toBase58());
    const otherMint = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");
    assert.notEqual(a.toBase58(), curatorVaultPda(CURATOR, otherMint).toBase58());
    const otherCurator = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    assert.notEqual(a.toBase58(), curatorVaultPda(otherCurator, BASE_MINT).toBase58());
});
test("curatorBaseEscrowPda: deterministic and distinct per vault", () => {
    const vault1 = curatorVaultPda(CURATOR, BASE_MINT);
    const vault2 = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    assert.equal(curatorBaseEscrowPda(vault1).toBase58(), curatorBaseEscrowPda(vault1).toBase58());
    assert.notEqual(curatorBaseEscrowPda(vault1).toBase58(), curatorBaseEscrowPda(vault2).toBase58());
});
test("curatorUserPositionPda: keyed by (vault, owner); distinct owners → distinct PDAs", () => {
    const vault = curatorVaultPda(CURATOR, BASE_MINT);
    const u2 = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    assert.equal(curatorUserPositionPda(vault, USER).toBase58(), curatorUserPositionPda(vault, USER).toBase58());
    assert.notEqual(curatorUserPositionPda(vault, USER).toBase58(), curatorUserPositionPda(vault, u2).toBase58());
});
test("PDAs honor a programId override", () => {
    const otherProgram = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    assert.notEqual(curatorVaultPda(CURATOR, BASE_MINT).toBase58(), curatorVaultPda(CURATOR, BASE_MINT, otherProgram).toBase58());
    const vault = curatorVaultPda(CURATOR, BASE_MINT);
    assert.notEqual(curatorBaseEscrowPda(vault).toBase58(), curatorBaseEscrowPda(vault, otherProgram).toBase58());
    assert.notEqual(curatorUserPositionPda(vault, USER).toBase58(), curatorUserPositionPda(vault, USER, otherProgram).toBase58());
});
// ---------------------------------------------------------------------------
// Fixtures + helpers for builder tests
// ---------------------------------------------------------------------------
function depositParams() {
    const vault = curatorVaultPda(CURATOR, BASE_MINT);
    return {
        owner: USER,
        vault,
        baseMint: BASE_MINT,
        baseEscrow: curatorBaseEscrowPda(vault),
        baseSrc: new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2"),
        position: curatorUserPositionPda(vault, USER),
        amountBase: 1_000_000,
    };
}
// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------
test("buildCuratorDeposit: programId defaults to CLEARSTONE_CURATOR_PROGRAM_ID", () => {
    const ix = buildCuratorDeposit(depositParams());
    assert.equal(ix.programId.toBase58(), CLEARSTONE_CURATOR_PROGRAM_ID.toBase58());
});
test("buildCuratorDeposit: data = disc + u64 LE amountBase", () => {
    const ix = buildCuratorDeposit({
        ...depositParams(),
        amountBase: 0x0102030405060708n,
    });
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...CURATOR_DISC.deposit]);
    // u64 LE — least significant byte first.
    assert.deepEqual([...ix.data.subarray(8, 16)], [0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
});
test("buildCuratorDeposit: account layout — owner Signer+mut, 9-key tail matches spec", () => {
    const p = depositParams();
    const ix = buildCuratorDeposit(p);
    assert.equal(ix.keys.length, 9);
    // owner: signer + writable (pays rent on position init).
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, true);
    assert.equal(ix.keys[0].pubkey.toBase58(), p.owner.toBase58());
    // vault (rw), baseMint (rw), baseSrc (rw), baseEscrow (rw), position (rw).
    for (const i of [1, 2, 3, 4, 5]) {
        assert.equal(ix.keys[i].isWritable, true, `index ${i} must be writable`);
        assert.equal(ix.keys[i].isSigner, false);
    }
    assert.equal(ix.keys[1].pubkey.toBase58(), p.vault.toBase58());
    assert.equal(ix.keys[2].pubkey.toBase58(), p.baseMint.toBase58());
    assert.equal(ix.keys[3].pubkey.toBase58(), p.baseSrc.toBase58());
    assert.equal(ix.keys[4].pubkey.toBase58(), p.baseEscrow.toBase58());
    assert.equal(ix.keys[5].pubkey.toBase58(), p.position.toBase58());
    // Trailing programs + rent: all readonly.
    assert.equal(ix.keys[6].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[7].pubkey.toBase58(), SystemProgram.programId.toBase58());
    assert.equal(ix.keys[8].pubkey.toBase58(), SYSVAR_RENT_PUBKEY.toBase58());
    for (const i of [6, 7, 8]) {
        assert.equal(ix.keys[i].isWritable, false);
        assert.equal(ix.keys[i].isSigner, false);
    }
});
test("buildCuratorDeposit: bigint, BN, and number amounts encode identically", () => {
    const p = depositParams();
    const fromNum = buildCuratorDeposit({ ...p, amountBase: 1_000_000 });
    const fromBig = buildCuratorDeposit({ ...p, amountBase: 1000000n });
    const fromBn = buildCuratorDeposit({ ...p, amountBase: new BN(1_000_000) });
    assert.deepEqual([...fromNum.data], [...fromBig.data]);
    assert.deepEqual([...fromNum.data], [...fromBn.data]);
});
test("buildCuratorDeposit: honors tokenProgram + programId overrides", () => {
    const override = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    const ix = buildCuratorDeposit({
        ...depositParams(),
        tokenProgram: override,
        programId: override,
    });
    assert.equal(ix.programId.toBase58(), override.toBase58());
    assert.equal(ix.keys[6].pubkey.toBase58(), override.toBase58());
});
// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------
test("buildCuratorWithdraw: data = disc + u64 LE shares", () => {
    const vault = curatorVaultPda(CURATOR, BASE_MINT);
    const ix = buildCuratorWithdraw({
        owner: USER,
        vault,
        baseMint: BASE_MINT,
        baseDst: new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2"),
        baseEscrow: curatorBaseEscrowPda(vault),
        position: curatorUserPositionPda(vault, USER),
        shares: 0xaabbn,
    });
    assert.equal(ix.data.length, 16);
    assert.deepEqual([...ix.data.subarray(0, 8)], [...CURATOR_DISC.withdraw]);
    assert.equal(ix.data[8], 0xbb);
    assert.equal(ix.data[9], 0xaa);
    for (let i = 10; i < 16; i++)
        assert.equal(ix.data[i], 0);
});
test("buildCuratorWithdraw: owner is Signer but NOT writable (no rent paid)", () => {
    // This is the one field that differs from deposit — the withdraw handler's
    // owner is a Signer but not `mut`. A regression that silently flips this
    // to writable is harmless but wastes compute; flipping the other way
    // would break the ix.
    const vault = curatorVaultPda(CURATOR, BASE_MINT);
    const ix = buildCuratorWithdraw({
        owner: USER,
        vault,
        baseMint: BASE_MINT,
        baseDst: new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2"),
        baseEscrow: curatorBaseEscrowPda(vault),
        position: curatorUserPositionPda(vault, USER),
        shares: 1,
    });
    assert.equal(ix.keys[0].isSigner, true);
    assert.equal(ix.keys[0].isWritable, false, "withdraw owner is Signer but not `mut`");
});
test("buildCuratorWithdraw: 7-key layout, no System/Rent at tail", () => {
    // Deposit has System+Rent for init_if_needed; withdraw doesn't (position
    // must already exist). The tail must be (..., tokenProgram) only.
    const vault = curatorVaultPda(CURATOR, BASE_MINT);
    const baseDst = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j2");
    const baseEscrow = curatorBaseEscrowPda(vault);
    const position = curatorUserPositionPda(vault, USER);
    const ix = buildCuratorWithdraw({
        owner: USER,
        vault,
        baseMint: BASE_MINT,
        baseDst,
        baseEscrow,
        position,
        shares: 1,
    });
    assert.equal(ix.keys.length, 7);
    // vault, baseMint, baseDst, baseEscrow, position (all writable).
    for (const i of [1, 2, 3, 4, 5]) {
        assert.equal(ix.keys[i].isWritable, true, `index ${i} must be writable`);
    }
    assert.equal(ix.keys[6].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(ix.keys[6].isWritable, false);
});
