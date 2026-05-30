/**
 * poc-refresh-with-vault.ts — Step 4 verification.
 *
 * Calls accrual_oracle::refresh_with_vault, deriving index_e9 from our
 * gated Jito Vault state instead of the authority-set rate. Reads:
 *   vault.tokensDeposited / vault.vrtSupply * 1e9
 * and writes source_price * index_e9 / 1e9 into the accrual output that
 * klend's csSOL reserve points at.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const ACCRUAL_PROG = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const oracleCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-oracle.json"), "utf8"));
  const vaultCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8"));

  const feedConfig = new PublicKey(oracleCfg.accrualConfig);
  const output = new PublicKey(oracleCfg.accrualOutput);
  const vault = new PublicKey(vaultCfg.vault);

  const disc = crypto.createHash("sha256").update("global:refresh_with_vault").digest().subarray(0, 8);
  const ix = new TransactionInstruction({
    programId: ACCRUAL_PROG,
    keys: [
      { pubkey: feedConfig, isSigner: false, isWritable: false },
      { pubkey: PYTH_SOL_USD, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: output, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(disc),
  });

  console.log("=== refresh_with_vault POC ===");
  console.log("feedConfig:    ", feedConfig.toBase58());
  console.log("source (Pyth): ", PYTH_SOL_USD.toBase58());
  console.log("vault (Jito):  ", vault.toBase58());
  console.log("output:        ", output.toBase58());

  // Read pre-state
  const vaultBefore = await conn.getAccountInfo(vault);
  if (!vaultBefore) throw new Error("vault not found");
  const td = vaultBefore.data.readBigUInt64LE(112);
  const vs = vaultBefore.data.readBigUInt64LE(104);
  console.log(`\nVault state: tokensDeposited=${td}  vrtSupply=${vs}  ratio=${Number(td) / Number(vs)}`);

  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer]);
  console.log("\nrefresh sig:", sig);

  // Read output post-state
  const outInfo = await conn.getAccountInfo(output);
  if (!outInfo) throw new Error("output not found");
  const outPrice = outInfo.data.readBigInt64LE(73);
  const outExpo = outInfo.data.readInt32LE(89);
  console.log(`accrual output price: ${Number(outPrice) * Math.pow(10, outExpo)} (raw=${outPrice}, expo=${outExpo})`);
}

main().catch((e) => {
  if (e?.transactionLogs) for (const l of e.transactionLogs.slice(-12)) console.error(" ", l);
  console.error(e);
  process.exit(1);
});
