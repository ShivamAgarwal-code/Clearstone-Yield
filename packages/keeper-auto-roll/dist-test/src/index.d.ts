#!/usr/bin/env node
/**
 * Auto-roll keeper — entry point.
 *
 * Dispatch order per vault:
 *   1. Fetch live `RollDelegation`s for this vault.
 *   2. For each live delegation: attempt `crank_roll_delegated`
 *      (permissionless, no curator custody needed).
 *   3. If nothing delegated fired and `SKIP_CURATOR_FALLBACK=0`:
 *      fall back to curator-signed `reallocate_from/to_market`
 *      (requires the curator keypair to be the configured signer).
 *
 * Permissioning: any wallet can run the delegated path (Pass B/C/D).
 * Legacy curator-signed cranks require the curator key — see
 * /KEEPER_PERMISSIONS.md.
 */
import { Connection } from "@solana/web3.js";
import { type KeeperConfig } from "./config.js";
/**
 * Run a single tick with injected dependencies. Extracted from `tick()`
 * so tests can supply their own Connection + config without hitting the
 * env-var config loader or a real RPC.
 */
export declare function runTick(conn: Connection, cfg: KeeperConfig): Promise<void>;
declare function tick(): Promise<void>;
declare function main(): Promise<void>;
export { main, tick };
//# sourceMappingURL=index.d.ts.map