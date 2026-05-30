/**
 * Create a Pyth push oracle price feed on devnet using Hermes VAA.
 *
 * Pyth push oracle (pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT) creates price
 * accounts that are owned by itself — klend may or may not accept this owner.
 *
 * Alternative: fetch a real VAA from Hermes and post it.
 */
import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PYTH_V2 = new PublicKey("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");
const PYTH_PUSH = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

// Pyth feed IDs (hex, from pyth.network)
const FEED_IDS = {
  "USDC/USD": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "USDY/USD": "e393449f6aff8a4b6d3e1165a7c9ebec103685571b7f4d786f4bbd1d18d1599e",
};

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const kpRaw = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(kpRaw));

  console.log("Fetching price updates from Pyth Hermes...\n");

  // Fetch latest VAA from Hermes for USDC/USD
  for (const [name, feedId] of Object.entries(FEED_IDS)) {
    console.log(`=== ${name} ===`);
    console.log(`Feed ID: 0x${feedId}`);

    try {
      const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}&encoding=base64`;
      const resp = await fetch(url);
      const data = await resp.json() as any;

      if (data.parsed?.[0]) {
        const parsed = data.parsed[0];
        console.log(`  Price: ${parsed.price.price} (expo: ${parsed.price.expo})`);
        console.log(`  Conf: ${parsed.price.conf}`);
        console.log(`  Publish time: ${new Date(parsed.price.publish_time * 1000).toISOString()}`);
      }

      // Derive the push oracle PDA for this feed
      // Seeds: ["price_feed", shard_id(u16), feed_id(32)]
      // Shard 0 is typical
      const feedIdBytes = Buffer.from(feedId, "hex");
      const shardBuf = Buffer.alloc(2);
      shardBuf.writeUInt16LE(0);

      const [pushPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("price_feed"), shardBuf, feedIdBytes],
        PYTH_PUSH
      );
      console.log(`  Push oracle PDA (shard 0): ${pushPda.toBase58()}`);

      const pushInfo = await conn.getAccountInfo(pushPda);
      if (pushInfo) {
        console.log(`  EXISTS on devnet! Owner: ${pushInfo.owner.toBase58()}, size: ${pushInfo.data.length}`);
      } else {
        console.log(`  Not found on devnet`);
      }

      // Also check V2 derivation
      // V2 price accounts: seeds differ, checking common patterns
      const [v2Pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("price_feed"), feedIdBytes],
        PYTH_PUSH
      );
      console.log(`  Push oracle PDA (no shard): ${v2Pda.toBase58()}`);
      const v2Info = await conn.getAccountInfo(v2Pda);
      if (v2Info) {
        console.log(`  EXISTS! Owner: ${v2Info.owner.toBase58()}`);
      }

    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
    console.log();
  }

  // Check if there's a Pyth receiver/poster program that can create V2-compatible accounts
  // Let's also check the wormhole bridge on devnet
  const WORMHOLE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
  const whInfo = await conn.getAccountInfo(WORMHOLE);
  console.log(`Wormhole bridge on devnet: ${whInfo ? "EXISTS" : "NOT FOUND"}`);
}

main().catch(console.error);
