/**
 * Config loader for the auto-roll keeper.
 *
 * All knobs come from environment variables. Missing required vars
 * fail-fast at boot rather than silently at first roll.
 */
import { Keypair } from "@solana/web3.js";
export interface KeeperConfig {
    rpcUrl: string;
    edgeUrl: string;
    curatorKeypair: Keypair;
    /** Seconds between polls. Default 60s. */
    pollIntervalSec: number;
    /**
     * Skip-ahead buffer. Only treat a market as "matured and ready to
     * roll" if `now >= maturityTs + MATURITY_GRACE_SEC`. Gives the
     * core program's `mark_to_market` cranks time to land first.
     */
    maturityGraceSec: number;
    /**
     * Slippage ceiling passed into reallocate_from_market / _to_market.
     * Expressed in bps of the notional.
     */
    slippageBps: number;
    /** One-shot: if true, do a single pass and exit. */
    oneShot: boolean;
    /** Dry-run: build + log txs, skip `sendTransaction`. */
    dryRun: boolean;
}
export declare function loadConfig(): KeeperConfig;
//# sourceMappingURL=config.d.ts.map