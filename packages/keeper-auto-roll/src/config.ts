/**
 * Config loader for the auto-roll keeper.
 *
 * All knobs come from environment variables. Missing required vars
 * fail-fast at boot rather than silently at first roll.
 */

import { readFileSync } from "node:fs";
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

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array keypair format at ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

export function loadConfig(): KeeperConfig {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    edgeUrl: requireEnv("EDGE_URL"),
    curatorKeypair: loadKeypair(requireEnv("CURATOR_KEYPAIR")),
    pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC ?? "60"),
    maturityGraceSec: Number(process.env.MATURITY_GRACE_SEC ?? "30"),
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? "50"), // 0.5%
    oneShot: process.env.ONE_SHOT === "1",
    dryRun: process.env.DRY_RUN === "1",
  };
}
