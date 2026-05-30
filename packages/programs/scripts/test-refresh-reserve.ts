/**
 * Test if klend's RefreshReserve works with our mock oracle
 */
import { Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const kpRaw = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(kpRaw));

  const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const market = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
  const usdcReserve = new PublicKey("D4qXufDqBjU5iTbVMHfdxDrpYnz31sed1oQCJbWoVGmH");
  const dUsdyReserve = new PublicKey("HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw");

  // Load oracles from config
  const oracleConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "oracles-deployed.json"), "utf8")
  );
  const marketConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "market-deployed.json"), "utf8")
  );

  // Check what oracle the reserve currently points to
  const reserveInfo = await conn.getAccountInfo(usdcReserve);
  if (!reserveInfo) { console.log("Reserve not found"); return; }

  // Find the oracle addresses
  const usdcOracle = new PublicKey(marketConfig.reserves?.USDC?.oracle || oracleConfig.mockUsdcOracle);
  const dUsdyOracle = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

  // Check oracle states
  for (const [name, addr] of [["USDC", usdcOracle], ["cUSDY", dUsdyOracle]] as const) {
    const info = await conn.getAccountInfo(addr);
    console.log(`${name} oracle: ${addr.toBase58()}`);
    console.log(`  Owner: ${info?.owner.toBase58()}`);
    console.log(`  Size: ${info?.data.length}`);
    if (info) {
      console.log(`  Magic: 0x${info.data.readUInt32LE(0).toString(16)}`);
      console.log(`  Price: ${info.data.readBigInt64LE(208)}`);
      console.log(`  Slot: ${info.data.readBigUInt64LE(232)}`);
    }
    console.log();
  }

  // Build RefreshReserve discriminator
  const disc = crypto.createHash("sha256").update("global:refresh_reserve").digest().subarray(0, 8);

  // Test RefreshReserve for USDC
  for (const [name, reserve, oracle] of [
    ["USDC", usdcReserve, usdcOracle],
    ["cUSDY", dUsdyReserve, dUsdyOracle],
  ] as const) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    tx.add({
      programId: KLEND,
      keys: [
        { pubkey: reserve, isSigner: false, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // switchboard
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // switchboard twap
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // scope
      ],
      data: Buffer.from(disc),
    });

    const sim = await conn.simulateTransaction(tx, [authority]);
    console.log(`RefreshReserve(${name}):`);
    for (const log of (sim.value.logs || []).slice(-5)) {
      console.log("  ", log);
    }
    if (sim.value.err) {
      console.log("  ERROR:", JSON.stringify(sim.value.err));
    } else {
      console.log("  SUCCESS!");
    }
    console.log();
  }
}

main().catch(console.error);
