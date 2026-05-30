/**
 * Devnet faucet server — mints test USDC to any wallet.
 * Run: npx tsx faucet-server.ts
 * Listens on port 3099.
 */

import http from "http";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const PORT = parseInt(process.env.FAUCET_PORT || "3099");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const MAX_AMOUNT = 10_000; // max 10k USDC per request
const COOLDOWN_MS = 10_000; // 10s between requests per wallet

// Load deploy keypair (mint authority)
const kpPath = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME || "~", ".config/solana/id.json");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));

// Load test USDC mint from deployment config
const configPath = path.join(
  process.env.HOME || "~",
  "delta-stablehacks/packages/programs/configs/devnet/market-deployed.json"
);
let usdcMint: PublicKey;
try {
  const mc = JSON.parse(fs.readFileSync(configPath, "utf8"));
  usdcMint = new PublicKey(mc.testUsdcMint || mc.reserves?.USDC?.mint || "2tboZ672zptawbXLUrcqfF7YkkS1kzDS4ewwxtjuog1G");
} catch {
  usdcMint = new PublicKey("2tboZ672zptawbXLUrcqfF7YkkS1kzDS4ewwxtjuog1G");
}

const conn = new Connection(RPC_URL, "confirmed");
const cooldowns = new Map<string, number>();

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/faucet") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const { wallet, amount: rawAmount } = JSON.parse(body);
    if (!wallet) throw new Error("Missing wallet");

    const dest = new PublicKey(wallet);
    const amount = Math.min(Math.max(parseFloat(rawAmount) || 1000, 1), MAX_AMOUNT);

    // Rate limit
    const lastReq = cooldowns.get(wallet) || 0;
    if (Date.now() - lastReq < COOLDOWN_MS) {
      res.writeHead(429);
      res.end("Rate limited — wait 10 seconds");
      return;
    }
    cooldowns.set(wallet, Date.now());

    console.log(`Minting ${amount} USDC → ${wallet}`);

    const ata = await getOrCreateAssociatedTokenAccount(
      conn, authority, usdcMint, dest, false, undefined, undefined, TOKEN_PROGRAM_ID
    );

    const lamports = BigInt(Math.round(amount * 1e6));
    const sig = await mintTo(conn, authority, usdcMint, ata.address, authority, lamports);

    console.log(`  Done: ${sig.slice(0, 30)}...`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, signature: sig, amount }));
  } catch (e: any) {
    console.error("Faucet error:", e.message);
    res.writeHead(400);
    res.end(e.message);
  }
});

server.listen(PORT, () => {
  console.log(`Test USDC faucet running on http://localhost:${PORT}`);
  console.log(`  Mint: ${usdcMint.toBase58()}`);
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log(`  Max: ${MAX_AMOUNT} USDC/request, ${COOLDOWN_MS / 1000}s cooldown`);
});
