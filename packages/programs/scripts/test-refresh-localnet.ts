import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
const ORACLE = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

async function main() {
  const conn = new Connection("http://localhost:8899", "confirmed");
  const auth = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8")))
  );

  const disc = crypto.createHash("sha256").update("global:refresh_reserve").digest().subarray(0, 8);

  for (const [name, addr] of [
    ["cUSDY", "HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw"],
    ["USDC", "D4qXufDqBjU5iTbVMHfdxDrpYnz31sed1oQCJbWoVGmH"],
  ] as const) {
    const reserve = new PublicKey(addr);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    tx.add({
      programId: KLEND,
      data: Buffer.from(disc),
      keys: [
        { pubkey: reserve, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false },
        { pubkey: ORACLE, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
      ],
    });

    const sim = await conn.simulateTransaction(tx, [auth]);
    if (sim.value.err) {
      const errLogs = (sim.value.logs || [])
        .filter((l) => l.includes("Error") || l.includes("log:"))
        .slice(-3);
      console.log(`${name}: FAIL`);
      for (const log of errLogs) console.log("  " + log.replace("Program log: ", ""));
    } else {
      console.log(`${name}: SUCCESS!`);
      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
        console.log(`  Tx: ${sig.slice(0, 40)}...`);
      } catch (e: any) {
        console.log(`  Execute failed: ${e.message?.slice(0, 80)}`);
      }
    }
  }
}

main().catch(console.error);
