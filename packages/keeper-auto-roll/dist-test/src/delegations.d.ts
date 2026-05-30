/**
 * Delegation scanning.
 *
 * For the permissionless (user-signed) roll path, the keeper needs to
 * know which users have live `RollDelegation` PDAs. We use a single
 * `getProgramAccounts` call with a `dataSize: 123` filter — cheap
 * and O(N) in active delegations, not in total program accounts.
 *
 * Grouped by vault pubkey for O(1) lookup inside the tick loop.
 */
import { Connection, PublicKey } from "@solana/web3.js";
/** Fully-decoded delegation + PDA address. Mirrors the SDK's decoder. */
export interface LiveDelegation {
    pda: PublicKey;
    vault: PublicKey;
    user: PublicKey;
    maxSlippageBps: number;
    expiresAtSlot: bigint;
    allocationsHash: Uint8Array;
    createdAtSlot: bigint;
}
/**
 * Fetch every live `RollDelegation` across all vaults the curator
 * program knows about.
 *
 * Returns a `Map<vault_pubkey_base58, LiveDelegation[]>` — grouping
 * at fetch time saves repeated filtering inside the tick loop.
 */
export declare function scanDelegations(conn: Connection, programId?: PublicKey): Promise<Map<string, LiveDelegation[]>>;
/**
 * Filter delegations by the current slot — keepers only crank live
 * ones. Expired delegations need to be revoked by the user (or left
 * to decay; the PDA just sits unused).
 */
export declare function filterLive(delegations: LiveDelegation[], nowSlot: bigint): LiveDelegation[];
//# sourceMappingURL=delegations.d.ts.map