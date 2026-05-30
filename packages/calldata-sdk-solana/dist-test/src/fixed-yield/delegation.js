/**
 * Roll-delegation builders — the v2 permissioning path (see
 * clearstone-finance/CURATOR_ROLL_DELEGATION.md).
 *
 * User signs a `RollDelegation` PDA at deposit time with bounded
 * slippage + expiry. Any keeper can then crank the auto-roll against
 * that delegation without holding the curator key.
 *
 * Shipping here:
 *   - `rollDelegationPda` — (vault, user) → PDA.
 *   - `buildCreateDelegation` — user-signed ix that creates/refreshes.
 *   - `buildCloseDelegation` — user-signed ix that revokes + reclaims rent.
 *
 * The permissionless crank (`buildCrankRollDelegated`) is a keeper-side
 * concern and lives in the keeper service, not the retail SDK.
 *
 * All discriminators are verified against the Rust program with the
 * regeneration one-liner in `constants.ts`.
 */
import { PublicKey, TransactionInstruction, SystemProgram, } from "@solana/web3.js";
import BN from "bn.js";
import { CLEARSTONE_CURATOR_PROGRAM_ID, CLEARSTONE_CORE_PROGRAM_ID, GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, } from "../common/constants.js";
import { CURATOR_DISC } from "./constants.js";
const ROLL_DELEGATION_SEED = Buffer.from("roll_deleg");
// Bounds — mirror constants in
//   clearstone-fixed-yield/periphery/clearstone_curator/src/roll_delegation.rs
export const MAX_DELEGATION_SLIPPAGE_BPS = 1_000; // 10%
export const MIN_DELEGATION_TTL_SLOTS = 216_000; // ~1 day
export const MAX_DELEGATION_TTL_SLOTS = 21_600_000; // ~100 days
const ro = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
});
const rw = (pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
});
const signer = (pubkey, writable = true) => ({
    pubkey,
    isSigner: true,
    isWritable: writable,
});
function u16le(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
}
function u64le(n) {
    const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
    return v.toArrayLike(Buffer, "le", 8);
}
/**
 * Derive the `RollDelegation` PDA. One delegation per (vault, user).
 * Matches the seeds in `roll_delegation.rs`.
 */
export function rollDelegationPda(vault, user, programId = CLEARSTONE_CURATOR_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync([ROLL_DELEGATION_SEED, vault.toBuffer(), user.toBuffer()], programId)[0];
}
/**
 * Build a `create_delegation` ix. Caller must sign with `user`.
 *
 * The handler is `init_if_needed` — calling again with new bounds
 * re-writes the existing PDA (e.g. after the curator runs
 * `set_allocations`, users refresh to re-bind the hash).
 */
export function buildCreateDelegation(p) {
    if (p.maxSlippageBps < 0 || p.maxSlippageBps > MAX_DELEGATION_SLIPPAGE_BPS) {
        throw new Error(`maxSlippageBps out of range [0, ${MAX_DELEGATION_SLIPPAGE_BPS}]`);
    }
    const ttlBn = typeof p.ttlSlots === "bigint"
        ? new BN(p.ttlSlots.toString())
        : new BN(p.ttlSlots);
    if (ttlBn.ltn(MIN_DELEGATION_TTL_SLOTS) || ttlBn.gtn(MAX_DELEGATION_TTL_SLOTS)) {
        throw new Error(`ttlSlots out of range [${MIN_DELEGATION_TTL_SLOTS}, ${MAX_DELEGATION_TTL_SLOTS}]`);
    }
    const programId = p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID;
    const delegation = rollDelegationPda(p.vault, p.user, programId);
    const keys = [
        signer(p.user),
        ro(p.vault),
        rw(delegation),
        ro(SystemProgram.programId),
    ];
    return new TransactionInstruction({
        programId,
        keys,
        data: Buffer.concat([
            CURATOR_DISC.createDelegation,
            u16le(p.maxSlippageBps),
            u64le(ttlBn),
        ]),
    });
}
/**
 * Build a `close_delegation` ix. Reclaims rent to the user + revokes
 * the delegation on-chain. After this lands, the keeper sees the
 * account as missing and stops rolling for this user.
 */
export function buildCloseDelegation(p) {
    const programId = p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID;
    const delegation = rollDelegationPda(p.vault, p.user, programId);
    const keys = [signer(p.user), rw(delegation)];
    return new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(CURATOR_DISC.closeDelegation),
    });
}
// ---------------------------------------------------------------------------
// Defaults exported for the retail UI
// ---------------------------------------------------------------------------
/** Retail-reasonable defaults for a "set and forget" delegation. */
export const RETAIL_DELEGATION_DEFAULTS = {
    maxSlippageBps: 50, // 0.5%
    ttlSlots: 1_512_000, // ~7 days at 0.4s/slot
};
/**
 * Permissionless keeper crank. Any wallet can sign as `keeper`; the
 * ix validates the user-signed delegation + allocation hash + market
 * maturity + slippage floor before touching state.
 *
 * See KEEPER_PERMISSIONS.md §4C + CURATOR_ROLL_DELEGATION.md §3.4 for
 * the permissioning model.
 */
export function buildCrankRollDelegated(p) {
    const keys = [
        { pubkey: p.keeper, isSigner: true, isWritable: true },
        ro(p.delegation),
        rw(p.vault),
        ro(p.baseMint),
        rw(p.baseEscrow),
        ro(p.syMarket),
        rw(p.syMint),
        rw(p.adapterBaseVault),
        rw(p.vaultSyAta),
        rw(p.fromMarket),
        rw(p.fromMarketEscrowPt),
        rw(p.fromMarketEscrowSy),
        rw(p.fromTokenFeeTreasurySy),
        ro(p.fromMarketAlt),
        ro(p.fromMintPt),
        rw(p.fromMintLp),
        rw(p.fromVaultPtAta),
        rw(p.fromVaultLpAta),
        rw(p.toMarket),
        rw(p.toMarketEscrowPt),
        rw(p.toMarketEscrowSy),
        rw(p.toTokenFeeTreasurySy),
        ro(p.toMarketAlt),
        ro(p.toMintPt),
        rw(p.toMintLp),
        rw(p.toVaultPtAta),
        rw(p.toVaultLpAta),
        ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
        ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
        ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
        ro(p.coreEventAuthority),
        ro(p.associatedTokenProgram ?? ASSOCIATED_TOKEN_PROGRAM_ID),
        ro(SystemProgram.programId),
    ];
    return new TransactionInstruction({
        programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
        keys,
        data: Buffer.concat([
            CURATOR_DISC.crankRollDelegated,
            u16le(p.fromIndex),
            u16le(p.toIndex),
            u64le(p.minBaseOut),
        ]),
    });
}
// ---------------------------------------------------------------------------
// Decoder — for keepers scanning delegations via getProgramAccounts
// ---------------------------------------------------------------------------
/**
 * `RollDelegation` layout (from
 * clearstone_curator/src/roll_delegation.rs):
 *
 *   0     8  discriminator
 *   8    32  vault
 *  40    32  user
 *  72     2  max_slippage_bps
 *  74     8  expires_at_slot
 *  82    32  allocations_hash
 * 114     8  created_at_slot
 * 122     1  bump
 * Total: 123 bytes.
 */
export const ROLL_DELEGATION_ACCOUNT_SIZE = 123;
export function decodeRollDelegation(data) {
    if (data.length < ROLL_DELEGATION_ACCOUNT_SIZE) {
        throw new Error(`RollDelegation too small: ${data.length} < ${ROLL_DELEGATION_ACCOUNT_SIZE}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
        vault: new PublicKey(data.slice(8, 40)),
        user: new PublicKey(data.slice(40, 72)),
        maxSlippageBps: view.getUint16(72, true),
        expiresAtSlot: view.getBigUint64(74, true),
        allocationsHash: new Uint8Array(data.slice(82, 114)),
        createdAtSlot: view.getBigUint64(114, true),
    };
}
/**
 * Compute the slippage floor a keeper must meet under a given
 * delegation for a position of `deployedBase` base units.
 *
 *   floor = deployedBase × (10_000 − maxSlippageBps) ÷ 10_000
 *
 * Pure function, same math as `slippage_floor` in the Rust module.
 * Used by keeper-side quoting.
 */
export function slippageFloor(deployedBase, maxSlippageBps) {
    return (deployedBase * BigInt(10_000 - maxSlippageBps)) / 10000n;
}
