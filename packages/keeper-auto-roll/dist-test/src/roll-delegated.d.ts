/**
 * Delegated (user-signed, permissionless) roll execution.
 *
 * This path is the v2 permissioning — a keeper with no curator key
 * cranks a user's roll under bounds the user signed at deposit time.
 * See KEEPER_PERMISSIONS.md §4C + CURATOR_ROLL_DELEGATION.md.
 *
 * Semantics vs. the curator-signed path (`roll.ts`):
 *   - one delegated ix rebalances ONE user's position, not the whole
 *     vault — `crank_roll_delegated` operates on the allocation-slot
 *     level, not per-user share accounting (the vault still aggregates
 *     via total_shares/total_assets post-roll).
 *   - the keeper can be any wallet; `keeper: Signer` has zero privilege.
 *   - slippage floor is enforced on-chain against the user's delegation.
 *
 * v1 limitation: the curator's `allocations` are vault-level, so one
 * delegated crank effectively rolls the whole position on that
 * allocation slot — not just the delegating user's share. That's fine
 * for single-user vaults and for vaults where all users have delegated.
 * Mixed (some delegated, some not) requires per-user accounting; it
 * falls back to the curator-signed path for now.
 */
import { Connection, Keypair } from "@solana/web3.js";
import type { CuratorVaultSnapshot } from "./edge.js";
import type { KeeperConfig } from "./config.js";
import type { LiveDelegation } from "./delegations.js";
export type DelegatedRollDecision = {
    reason: "no-matured-allocation";
} | {
    reason: "no-next-allocation";
} | {
    reason: "delegation-expired";
} | {
    reason: "hash-mismatch";
} | {
    reason: "ready";
    fromIndex: number;
    toIndex: number;
    fromMarket: string;
    toMarket: string;
    deployedBase: bigint;
    minBaseOut: bigint;
};
export declare function decideDelegatedRoll(vault: CuratorVaultSnapshot, delegation: LiveDelegation, nowTs: number, nowSlot: bigint, graceSec: number): DelegatedRollDecision;
export declare function executeDelegatedRoll(conn: Connection, cfg: KeeperConfig, vault: CuratorVaultSnapshot, delegation: LiveDelegation, decision: Extract<DelegatedRollDecision, {
    reason: "ready";
}>): Promise<string | null>;
export type _KeeperKeypair = Keypair;
//# sourceMappingURL=roll-delegated.d.ts.map