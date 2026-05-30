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
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
export declare const MAX_DELEGATION_SLIPPAGE_BPS = 1000;
export declare const MIN_DELEGATION_TTL_SLOTS = 216000;
export declare const MAX_DELEGATION_TTL_SLOTS = 21600000;
/**
 * Derive the `RollDelegation` PDA. One delegation per (vault, user).
 * Matches the seeds in `roll_delegation.rs`.
 */
export declare function rollDelegationPda(vault: PublicKey, user: PublicKey, programId?: PublicKey): PublicKey;
export interface CreateDelegationParams {
    user: PublicKey;
    /** Curator-vault account the delegation authorizes rolls for. */
    vault: PublicKey;
    /**
     * Max per-roll slippage in bps. Range [0, 1000].
     * Lower is tighter; 50 = 0.5% is a sensible retail default.
     */
    maxSlippageBps: number;
    /**
     * Delegation lifetime in slots. Range [216_000, 21_600_000].
     * At ~0.4 s/slot, 216_000 ≈ 1 day and 21_600_000 ≈ 100 days. Retail
     * default 7 d = 1_512_000 slots.
     */
    ttlSlots: BN | bigint | number;
    programId?: PublicKey;
}
/**
 * Build a `create_delegation` ix. Caller must sign with `user`.
 *
 * The handler is `init_if_needed` — calling again with new bounds
 * re-writes the existing PDA (e.g. after the curator runs
 * `set_allocations`, users refresh to re-bind the hash).
 */
export declare function buildCreateDelegation(p: CreateDelegationParams): TransactionInstruction;
export interface CloseDelegationParams {
    user: PublicKey;
    /** Curator-vault pubkey (only used to derive the delegation PDA). */
    vault: PublicKey;
    programId?: PublicKey;
}
/**
 * Build a `close_delegation` ix. Reclaims rent to the user + revokes
 * the delegation on-chain. After this lands, the keeper sees the
 * account as missing and stops rolling for this user.
 */
export declare function buildCloseDelegation(p: CloseDelegationParams): TransactionInstruction;
/** Retail-reasonable defaults for a "set and forget" delegation. */
export declare const RETAIL_DELEGATION_DEFAULTS: {
    readonly maxSlippageBps: 50;
    readonly ttlSlots: 1512000;
};
export interface CrankRollDelegatedParams {
    /** Keeper wallet — signs the outer tx, no custody requirement. */
    keeper: PublicKey;
    /** User's `RollDelegation` PDA. */
    delegation: PublicKey;
    vault: PublicKey;
    baseMint: PublicKey;
    baseEscrow: PublicKey;
    syMarket: PublicKey;
    syMint: PublicKey;
    adapterBaseVault: PublicKey;
    /** Vault-PDA-owned SY ATA. */
    vaultSyAta: PublicKey;
    fromMarket: PublicKey;
    fromMarketEscrowPt: PublicKey;
    fromMarketEscrowSy: PublicKey;
    fromTokenFeeTreasurySy: PublicKey;
    fromMarketAlt: PublicKey;
    fromMintPt: PublicKey;
    fromMintLp: PublicKey;
    fromVaultPtAta: PublicKey;
    fromVaultLpAta: PublicKey;
    toMarket: PublicKey;
    toMarketEscrowPt: PublicKey;
    toMarketEscrowSy: PublicKey;
    toTokenFeeTreasurySy: PublicKey;
    toMarketAlt: PublicKey;
    toMintPt: PublicKey;
    toMintLp: PublicKey;
    toVaultPtAta: PublicKey;
    toVaultLpAta: PublicKey;
    coreEventAuthority: PublicKey;
    fromIndex: number;
    toIndex: number;
    /** Slippage floor — must be ≥ delegation's derived floor. */
    minBaseOut: BN | bigint | number;
    coreProgram?: PublicKey;
    syProgram?: PublicKey;
    tokenProgram?: PublicKey;
    associatedTokenProgram?: PublicKey;
    programId?: PublicKey;
}
/**
 * Permissionless keeper crank. Any wallet can sign as `keeper`; the
 * ix validates the user-signed delegation + allocation hash + market
 * maturity + slippage floor before touching state.
 *
 * See KEEPER_PERMISSIONS.md §4C + CURATOR_ROLL_DELEGATION.md §3.4 for
 * the permissioning model.
 */
export declare function buildCrankRollDelegated(p: CrankRollDelegatedParams): TransactionInstruction;
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
export declare const ROLL_DELEGATION_ACCOUNT_SIZE = 123;
export interface DecodedRollDelegation {
    vault: PublicKey;
    user: PublicKey;
    maxSlippageBps: number;
    expiresAtSlot: bigint;
    allocationsHash: Uint8Array;
    createdAtSlot: bigint;
}
export declare function decodeRollDelegation(data: Uint8Array): DecodedRollDelegation;
/**
 * Compute the slippage floor a keeper must meet under a given
 * delegation for a position of `deployedBase` base units.
 *
 *   floor = deployedBase × (10_000 − maxSlippageBps) ÷ 10_000
 *
 * Pure function, same math as `slippage_floor` in the Rust module.
 * Used by keeper-side quoting.
 */
export declare function slippageFloor(deployedBase: bigint, maxSlippageBps: number): bigint;
