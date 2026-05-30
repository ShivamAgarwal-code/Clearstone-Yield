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
import { fileURLToPath } from "node:url";
import { loadConfig, type KeeperConfig } from "./config.js";
import { fetchCuratorVaults } from "./edge.js";
import { decideRoll, executeRoll } from "./roll.js";
import {
  decideDelegatedRoll,
  executeDelegatedRoll,
} from "./roll-delegated.js";
import { scanDelegations, filterLive } from "./delegations.js";

/**
 * Run a single tick with injected dependencies. Extracted from `tick()`
 * so tests can supply their own Connection + config without hitting the
 * env-var config loader or a real RPC.
 */
export async function runTick(
  conn: Connection,
  cfg: KeeperConfig
): Promise<void> {
  const keeperPk = cfg.curatorKeypair.publicKey.toBase58();
  const nowTs = Math.floor(Date.now() / 1000);
  const nowSlot = BigInt(await conn.getSlot("confirmed"));

  const [vaults, delegationsByVault] = await Promise.all([
    fetchCuratorVaults(cfg.edgeUrl),
    scanDelegations(conn).catch((err) => {
      log({
        event: "scan_delegations.error",
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map<string, ReturnType<typeof filterLive>>();
    }),
  ]);

  const skipCuratorFallback =
    process.env.SKIP_CURATOR_FALLBACK === "1";

  log({
    event: "tick.start",
    vaults: vaults.length,
    delegations: countDelegations(delegationsByVault),
    keeper: keeperPk,
    nowTs,
    nowSlot: nowSlot.toString(),
  });

  for (const v of vaults) {
    let cranked = false;

    // --- Path 1: delegated (permissionless) ---
    const delegations = filterLive(
      delegationsByVault.get(v.vault) ?? [],
      nowSlot
    );
    for (const d of delegations) {
      const decision = decideDelegatedRoll(
        v,
        d,
        nowTs,
        nowSlot,
        cfg.maturityGraceSec
      );
      if (decision.reason !== "ready") {
        log({
          event: "delegated.skip",
          vault: v.id,
          user: d.user.toBase58(),
          reason: decision.reason,
        });
        continue;
      }

      try {
        const sig = await executeDelegatedRoll(conn, cfg, v, d, decision);
        log({
          event: "delegated_roll.completed",
          vault: v.id,
          user: d.user.toBase58(),
          fromMarket: decision.fromMarket,
          toMarket: decision.toMarket,
          minBaseOut: decision.minBaseOut.toString(),
          signature: sig,
        });
        cranked = true;
        // One crank per vault per tick — avoids double-firing while
        // the next `fetchCuratorVaults` refresh lags the chain.
        break;
      } catch (err) {
        log({
          event: "delegated_roll.failed",
          vault: v.id,
          user: d.user.toBase58(),
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue to try other delegations / fallback.
      }
    }

    if (cranked) continue;

    // --- Path 2: curator-signed fallback ---
    if (skipCuratorFallback) {
      log({ event: "tick.skip", vault: v.id, reason: "no-delegated-crank" });
      continue;
    }

    const decision = decideRoll(v, keeperPk, nowTs, cfg.maturityGraceSec);
    if (decision.reason !== "ready") {
      log({ event: "tick.skip", vault: v.id, reason: decision.reason });
      continue;
    }

    try {
      const sig = await executeRoll(conn, cfg, v, decision);
      log({
        event: "auto_roll.completed",
        vault: v.id,
        path: "curator-signed",
        maturedMarket: decision.maturedMarket,
        nextMarket: decision.nextMarket,
        signature: sig,
      });
    } catch (err) {
      log({
        event: "auto_roll.failed",
        vault: v.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({ event: "tick.end" });
}

async function tick(): Promise<void> {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  return runTick(conn, cfg);
}

function countDelegations(
  byVault: Map<string, ReturnType<typeof filterLive>>
): number {
  let n = 0;
  for (const list of byVault.values()) n += list.length;
  return n;
}

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log({
    event: "keeper.boot",
    oneShot: cfg.oneShot,
    dryRun: cfg.dryRun,
    intervalSec: cfg.pollIntervalSec,
    skipCuratorFallback: process.env.SKIP_CURATOR_FALLBACK === "1",
  });

  if (cfg.oneShot) {
    await tick();
    return;
  }

  while (true) {
    try {
      await tick();
    } catch (err) {
      log({
        event: "tick.error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(cfg.pollIntervalSec * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Only auto-run when invoked as a CLI. Importing the module for tests
// should be side-effect-free — previously `main()` fired on import,
// which calls `loadConfig()` and throws on missing env vars.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}

export { main, tick };
