/**
 * Single-vault roll execution.
 *
 * Flow:
 *   1. Decide whether any allocation has matured.
 *   2. If yes: build reallocate_from_market(matured) → reallocate_to_market(next).
 *   3. Sign with curator keypair. Send. Confirm.
 *
 * Slippage + amount sizing: this keeper uses minimal safe defaults.
 * Operators needing tighter economic parameters should fork this
 * module, or wait for the on-chain `RollDelegation` upgrade
 * (KEEPER_PERMISSIONS.md §4C) which moves per-user bounds to
 * on-chain state.
 */
import { Connection } from "@solana/web3.js";
import type { CuratorVaultSnapshot } from "./edge.js";
import type { KeeperConfig } from "./config.js";
export type RollDecision = {
    reason: "no-matured-allocation";
} | {
    reason: "no-next-allocation";
} | {
    reason: "curator-mismatch";
} | {
    reason: "ready";
    maturedIndex: number;
    nextIndex: number;
    maturedMarket: string;
    nextMarket: string;
};
export type ReadyRoll = Extract<RollDecision, {
    reason: "ready";
}>;
export declare function decideRoll(vault: CuratorVaultSnapshot, curatorPk: string, nowTs: number, graceSec: number): RollDecision;
export declare function executeRoll(conn: Connection, cfg: KeeperConfig, vault: CuratorVaultSnapshot, decision: ReadyRoll): Promise<string | null>;
//# sourceMappingURL=roll.d.ts.map