/**
 * debug-refresh-cusdc.ts — sim a refresh_reserve(cUSDC) tx and dump the
 * full Solana logs + post-state price_status, so we can see exactly why
 * the institutional borrow flow trips ReserveStale (6009) at
 * `check_borrow_possible`.
 *
 *   * If `get_price` fails inside the handler, the whole tx errors here
 *     with a klend error code we can read from logs.
 *   * If it succeeds but writes price_status=0, then we know the
 *     handler's price-status path is hitting the empty branch — likely
 *     a token_info-config mismatch vs the accounts being passed.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/debug-refresh-cusdc.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");

const CUSDC_RESERVE = new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe");
const USDC_PYTH_ORACLE = new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD");

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp();
  console.log("Network:", RPC);
  console.log("Signer: ", auth.publicKey.toBase58());

  const ix = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: CUSDC_RESERVE,    isSigner: false, isWritable: true  },
      { pubkey: MARKET,           isSigner: false, isWritable: false },
      { pubkey: USDC_PYTH_ORACLE, isSigner: false, isWritable: false },
      // None for switchboard / scope — pass program id as the marker.
      { pubkey: KLEND,            isSigner: false, isWritable: false },
      { pubkey: KLEND,            isSigner: false, isWritable: false },
      { pubkey: KLEND,            isSigner: false, isWritable: false },
    ],
    data: disc("refresh_reserve"),
  });
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = auth.publicKey;

  const sim = await conn.simulateTransaction(tx, [auth]);
  console.log("\nSimulation err:", sim.value.err);
  console.log("\nLogs:");
  for (const l of sim.value.logs ?? []) console.log("  " + l);

  if (sim.value.err) return;

  // Broadcast so on-chain price_status persists.
  const before = await conn.getAccountInfo(CUSDC_RESERVE);
  console.log("\nBEFORE: price_status =", before!.data[25].toString(2).padStart(8, "0"));

  const { sendAndConfirmTransaction } = await import("@solana/web3.js");
  const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
  console.log("Sent:", sig);

  const after = await conn.getAccountInfo(CUSDC_RESERVE);
  console.log("AFTER:  price_status =", after!.data[25].toString(2).padStart(8, "0"));
}

main().catch((e) => { console.error(e); process.exit(1); });
