/**
 * poc-shredstream-liquidator.ts — Step 6 (stretch).
 *
 * The detection half of a liquidator that watches klend obligations in
 * elevation group 2 (csSOL collateral, wSOL debt) and fires liquidation
 * Bundles when health factor drops below 1.0.
 *
 * On MAINNET this would subscribe to Jito ShredStream's gRPC service and
 * receive raw shreds ~150ms ahead of confirmed-slot polling — by the time
 * a competing liquidator's RPC sees an underwater obligation, our keeper
 * has already submitted a liquidation Bundle racing for the same block.
 * That's the full Jito-stack execution-quality story.
 *
 * On DEVNET, no ShredStream relay exists publicly, so this POC uses
 * `Connection.onLogs(klend, processed)` as a stand-in. Same handler
 * interface, same downstream logic — only the wire differs. Swapping in
 * ShredStream is one constructor change in `subscribeKlendActivity()`.
 *
 * Detection scope (this POC): subscribe to klend, demux by ix
 * discriminator, log activity touching our market and reserves. Building
 * the full health-factor sim + liquidation-Bundle path is a follow-up;
 * this script proves the streaming path is wired correctly.
 *
 * Usage:
 *   npx tsx scripts/poc-shredstream-liquidator.ts
 *   (Ctrl-C to exit; prints klend ix activity touching our market.)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const RPC_WS = (process.env.SOLANA_WS_URL ?? RPC).replace(/^http/, "ws");
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

// Klend ix discriminators (sha256("global:<ix>")[0..8]). Pre-computed.
const IX_NAMES: Record<string, string> = {
  "797f12cc49f5e141": "borrowObligationLiquidity",
  "81c70402de271a2e": "depositReserveLiquidityAndObligationCollateral",
  "b1479abce2854a37": "liquidateObligationAndRedeemReserveCollateral",
  "218493e497c04859": "refreshObligation",
  "91b20de14cf09348": "repayObligationLiquidity",
  "4b5d5ddc2296dac4": "withdrawObligationCollateralAndRedeemReserveCollateral",
};

// Ixs that move an obligation's health factor in a direction that matters
// to liquidators. We re-simulate the obligation when these fire.
const HEALTH_AFFECTING_IXS = new Set([
  "borrowObligationLiquidity",
  "depositReserveLiquidityAndObligationCollateral",
  "withdrawObligationCollateralAndRedeemReserveCollateral",
  "repayObligationLiquidity",
  "refreshObligation",
]);

interface SubscribeConfig {
  market: PublicKey;
  csSolReserve: PublicKey;
  wSolReserve: PublicKey;
  onActivity: (e: KlendEvent) => void;
}

interface KlendEvent {
  signature: string;
  slot: number;
  ixName: string | null;        // null if we don't recognize the discriminator
  touchesMarket: boolean;
  touchesGroup2Reserve: boolean;
}

/**
 * Subscribe to klend program activity. Devnet uses RPC `onLogs` (commitment
 * = processed for sub-200ms latency). Mainnet would replace this with a
 * ShredStream gRPC subscription:
 *
 *   const channel = grpc.credentials.createSsl();
 *   const client  = new ShredstreamProxyClient(SHREDSTREAM_URL, channel);
 *   const stream  = client.subscribe({ /* heartbeats / regions * / });
 *   stream.on("data", (e: Entry) => {
 *     for (const txBytes of e.transactions) {
 *       const tx = VersionedTransaction.deserialize(txBytes);
 *       handleTx(tx, currentSlot);
 *     }
 *   });
 *
 * The downstream `onActivity` handler takes the same KlendEvent shape in
 * both modes — switching wires doesn't touch any business logic.
 */
function subscribeKlendActivity(conn: Connection, cfg: SubscribeConfig): number {
  return conn.onLogs(
    KLEND,
    (logs, ctx) => {
      if (logs.err) return;
      const sig = logs.signature;
      // Heuristic disc match from log content. Production would decode the
      // full tx via getTransaction, but we want zero RPC fan-out per event;
      // the log content + 'Program log: Instruction: <Name>' strings are
      // enough to identify the ix.
      let ixName: string | null = null;
      for (const line of logs.logs) {
        const m = line.match(/Program log: Instruction: ([A-Za-z]+)/);
        if (m) {
          // Convert PascalCase from logs to camelCase to match IX_NAMES
          // values (which we store in camelCase).
          ixName = m[1].charAt(0).toLowerCase() + m[1].slice(1);
          break;
        }
      }
      const lowered = logs.logs.join("\n");
      const touchesMarket = lowered.includes(cfg.market.toBase58());
      const touchesGroup2Reserve =
        lowered.includes(cfg.csSolReserve.toBase58()) ||
        lowered.includes(cfg.wSolReserve.toBase58());

      if (!touchesMarket && !touchesGroup2Reserve && !ixName) return;

      cfg.onActivity({
        signature: sig,
        slot: ctx.slot,
        ixName,
        touchesMarket,
        touchesGroup2Reserve,
      });
    },
    "processed",
  );
}

async function main() {
  const conn = new Connection(RPC, { commitment: "processed", wsEndpoint: RPC_WS });

  const deployedPath = path.join(__dirname, "..", "configs", "devnet", "cssol-deployed.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error(`run setup-cssol-market.ts first — ${deployedPath} missing`);
  }
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const market = new PublicKey(deployed.market);
  const csSolReserve = new PublicKey(deployed.reserves.csSOL.address);
  const wSolReserve = new PublicKey(deployed.reserves.wSOL.address);

  console.log("=== klend monitor (devnet stand-in for Jito ShredStream) ===");
  console.log("RPC:                   ", RPC);
  console.log("klend program:         ", KLEND.toBase58());
  console.log("watching market:       ", market.toBase58());
  console.log("  csSOL reserve:       ", csSolReserve.toBase58());
  console.log("  wSOL reserve:        ", wSolReserve.toBase58());
  console.log("commitment:            processed (~150ms latency)");
  console.log("  → mainnet upgrade: replace conn.onLogs with Jito ShredStream gRPC");
  console.log("    subscription, drops latency to ~0ms (shreds arrive before slot finalization).");
  console.log("\nListening for klend activity... (Ctrl-C to exit)\n");

  // Optional: self-trigger a klend `refresh_reserve` after a 5s warm-up so
  // the monitor sees verifiable activity even on a quiet devnet market.
  // Off by default; set SELF_TRIGGER=1 to enable.
  if (process.env.SELF_TRIGGER === "1") {
    setTimeout(async () => {
      const kpPath = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/clearstone-devnet.json");
      const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
      const refreshDisc = crypto.createHash("sha256").update("global:refresh_reserve").digest().subarray(0, 8);
      const csSolOracle = new PublicKey(deployed.reserves.csSOL.oracle);
      const ix = new TransactionInstruction({
        programId: KLEND, data: Buffer.from(refreshDisc),
        keys: [
          { pubkey: csSolReserve, isSigner: false, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: csSolOracle, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
        ],
      });
      try {
        const sig = await sendAndConfirmTransaction(conn, new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(ix), [payer]);
        console.log(`\n[self-trigger] sent refresh_reserve  sig=${sig.slice(0, 12)}…\n`);
      } catch (e) {
        console.log(`\n[self-trigger] failed: ${(e as Error).message}\n`);
      }
    }, 5000);
  }

  let count = 0;
  const startedAt = Date.now();
  const subId = subscribeKlendActivity(conn, {
    market, csSolReserve, wSolReserve,
    onActivity: (e) => {
      count++;
      const tags: string[] = [];
      if (e.touchesMarket) tags.push("MARKET");
      if (e.touchesGroup2Reserve) tags.push("GROUP-2-RESERVE");
      const ix = e.ixName ?? "?";
      const liquidationCandidate = HEALTH_AFFECTING_IXS.has(ix) && e.touchesGroup2Reserve;
      const flag = liquidationCandidate ? "★" : " ";
      console.log(
        `[slot ${e.slot}] ${flag} ${ix.padEnd(50)} ${tags.join(",").padEnd(28)} sig=${e.signature.slice(0, 12)}…`,
      );
      if (liquidationCandidate) {
        console.log("        ↳ would re-simulate health factor on touched obligation;");
        console.log("          if HF<1.0 → build liquidation Bundle and submit via Block Engine.");
      }
    },
  });

  // Print throughput every 30s so we know it's alive.
  const ticker = setInterval(() => {
    const dur = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`-- ${count} klend events in ${dur}s (${(count / Math.max(1, +dur)).toFixed(2)}/s)`);
  }, 30_000);

  process.on("SIGINT", async () => {
    console.log("\nstopping...");
    clearInterval(ticker);
    await conn.removeOnLogsListener(subId).catch(() => {});
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
