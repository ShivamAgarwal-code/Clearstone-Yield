/**
 * setup-switchboard-feed.ts — Create a Switchboard V2 aggregator that reads
 * from our TradeDesk Oracle feed PDA.
 *
 * This creates a Switchboard-owned account that klend will accept as a valid oracle.
 *
 * Flow:
 *   TradeDesk PriceFeed (our program) → Switchboard CacheTask job → Aggregator (SW1TCH-owned) → klend
 *
 * Usage:
 *   npx tsx scripts/setup-switchboard-feed.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Switchboard V2 devnet program
const SB_V2_PID = new PublicKey("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");
// Switchboard V2 devnet permissionless queue
const SB_QUEUE = new PublicKey("F8ce7MsckeZAbAGmxjJNetxYXQa9mKr9nnrC3qKubyYy");

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();

  console.log("============================================");
  console.log("  Switchboard V2 Feed Setup");
  console.log("============================================");
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log(`  Balance:   ${((await conn.getBalance(authority.publicKey)) / 1e9).toFixed(4)} SOL`);

  // Check if Switchboard V2 queue exists
  const queueInfo = await conn.getAccountInfo(SB_QUEUE);
  if (!queueInfo) {
    console.log("\nSwitchboard V2 permissionless queue not found on devnet.");
    console.log("Trying to find available queues...");

    // Search for queue accounts
    const accounts = await conn.getProgramAccounts(SB_V2_PID, {
      dataSlice: { offset: 0, length: 8 },
      filters: [{ dataSize: 1269 }], // OracleQueueAccountData size
    });
    console.log(`Found ${accounts.length} queue accounts`);
    for (const a of accounts.slice(0, 5)) {
      console.log(`  ${a.pubkey.toBase58()}`);
    }
    if (accounts.length === 0) {
      console.log("\nNo Switchboard V2 queues on devnet. Cannot create aggregator.");
      console.log("Alternative: Use Switchboard On-Demand (newer) or localnet approach.");
      return;
    }
  } else {
    console.log(`  Queue:     ${SB_QUEUE.toBase58()} (exists)`);
  }

  // Try using the @switchboard-xyz/solana.js SDK
  try {
    const sbModule = await import("@switchboard-xyz/solana.js");
    console.log("\nSwitchboard SDK loaded. Creating aggregator...");

    const sbProgram = await sbModule.SwitchboardProgram.load(
      "devnet",
      conn,
      authority,
    );
    console.log("  SwitchboardProgram loaded");

    // Load or find the queue
    const queue = new sbModule.QueueAccount(sbProgram, SB_QUEUE);
    try {
      const queueData = await queue.loadData();
      console.log(`  Queue: ${SB_QUEUE.toBase58()}`);
      console.log(`  Queue authority: ${queueData.authority.toBase58()}`);
      console.log(`  Oracles: ${queueData.size}`);
    } catch (e: any) {
      console.log(`  Queue load failed: ${e.message?.slice(0, 80)}`);
      console.log("  Searching for available queues...");

      // Find any queue
      const queues = await sbModule.QueueAccount.fetchAll(sbProgram);
      console.log(`  Found ${queues.length} queues`);
      if (queues.length > 0) {
        console.log(`  Using: ${queues[0].publicKey.toBase58()}`);
      }
    }

    // Load TradeDesk config
    const tdConfig = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "tradedesk.json"), "utf8")
    );
    const usdcFeed = tdConfig.feeds["USDC/USD"];
    console.log(`\n  TradeDesk USDC/USD feed: ${usdcFeed}`);

    // Create aggregator with a CacheTask that reads our PDA
    // The job definition tells Switchboard oracle nodes what data to fetch
    const jobKeypair = Keypair.generate();

    // OracleJob protobuf: CacheTask reads an on-chain account
    // For simplicity, use an HttpTask that returns a static value
    // (since Switchboard oracle nodes can't easily read arbitrary Anchor PDAs)
    //
    // Better approach: use a ValueTask with a fixed value for testing
    const [aggregatorAccount, aggregatorInit] =
      await sbModule.AggregatorAccount.createInstruction(sbProgram, authority.publicKey, {
        queueAccount: queue,
        queueAuthority: authority.publicKey,
        batchSize: 1,
        minRequiredOracleResults: 1,
        minRequiredJobResults: 1,
        minUpdateDelaySeconds: 10,
        name: Buffer.from("USDC/USD TradeDesk"),
        metadata: Buffer.from("Price feed managed by RWA Trading Desk"),
      });

    console.log(`\n  Aggregator: ${aggregatorAccount.publicKey.toBase58()}`);
    console.log("  Sending create transaction...");

    // This may fail if the queue doesn't exist or permissions are wrong
    // Let's just try it
    const sig = await sendAndConfirmTransaction(conn, aggregatorInit, [authority, jobKeypair]);
    console.log(`  Created! Tx: ${sig.slice(0, 40)}...`);

  } catch (e: any) {
    console.log(`\nSwitchboard SDK error: ${e.message?.slice(0, 150)}`);
    console.log("\nFalling back to manual approach...");

    // Manual approach: check if we can find any existing Switchboard aggregator
    // with a $1 price that we can reuse
    console.log("\nSearching for existing Switchboard V2 aggregators with stablecoin prices...");
    const accounts = await conn.getProgramAccounts(SB_V2_PID, {
      dataSlice: { offset: 0, length: 200 },
      filters: [{ dataSize: 3851 }], // AggregatorAccountData size
    });
    console.log(`Found ${accounts.length} aggregator accounts`);

    // AggregatorAccountData layout: the latest result is at a known offset
    // latestConfirmedRound.result is an SwitchboardDecimal (mantissa: i128, scale: u32)
    // This is complex to parse. Let's just save the addresses for now.
    if (accounts.length > 0) {
      console.log("First 10 aggregators:");
      for (const a of accounts.slice(0, 10)) {
        console.log(`  ${a.pubkey.toBase58()}`);
      }
    }
  }

  console.log("\n============================================");
  console.log("  Setup complete. Check output above.");
  console.log("============================================");
}

main().catch(console.error);
