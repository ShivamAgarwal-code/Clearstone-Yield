/**
 * create-switchboard-feed.mjs — Create Switchboard V2 static feeds for klend.
 *
 * Uses createStaticFeed from @switchboard-xyz/solana.js.
 * Run as: node --experimental-specifier-resolution=node scripts/create-switchboard-feed.mjs
 */

import { SwitchboardProgram, createStaticFeed } from "@switchboard-xyz/solana.js";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const kpRaw = JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".config/solana/id.json"), "utf8")
  );
  const payer = Keypair.fromSecretKey(Uint8Array.from(kpRaw));

  console.log("Payer:", payer.publicKey.toBase58());
  const bal = await conn.getBalance(payer.publicKey);
  console.log("Balance:", (bal / 1e9).toFixed(4), "SOL");

  console.log("\nLoading Switchboard program...");
  const sbProgram = await SwitchboardProgram.load("devnet", conn, payer);
  console.log("Loaded!");

  // USDC/USD at $1.00
  console.log("\nCreating USDC/USD static feed ($1.00)...");
  const [usdcAgg] = await createStaticFeed(sbProgram, 1.0);
  console.log("USDC/USD:", usdcAgg.publicKey.toBase58());

  // dUSDY/USD at $1.08
  console.log("\nCreating dUSDY/USD static feed ($1.08)...");
  const [dusdyAgg] = await createStaticFeed(sbProgram, 1.08);
  console.log("dUSDY/USD:", dusdyAgg.publicKey.toBase58());

  const config = {
    usdc: usdcAgg.publicKey.toBase58(),
    dusdy: dusdyAgg.publicKey.toBase58(),
    program: "SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f",
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs", "devnet", "switchboard-feeds.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log("\nSaved:", outPath);
}

main().catch((e) => {
  console.error("Error:", e.message);
  if (e.logs) console.error("Logs:", e.logs.slice(-3));
  process.exit(1);
});
