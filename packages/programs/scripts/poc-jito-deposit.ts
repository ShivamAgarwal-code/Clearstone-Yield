/**
 * poc-jito-deposit.ts — Devnet POC: deposit native SOL into a real
 * SPL Stake Pool, receive LST tokens.
 *
 * Why "Jito" in the name: JitoSOL is built on the standard SPL Stake Pool
 * program (`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`), so the deposit
 * SDK and ix flow are identical to any other pool. We test against a
 * community-operated pool on devnet to prove the path works; on mainnet
 * point STAKE_POOL at JitoSOL's pool address and the same code runs.
 *
 * **Jito has NO stake-pool deployment on devnet.** The mainnet pool address
 * `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb` exists as a non-executable
 * placeholder on devnet but isn't a real stake pool. This is separate from:
 *   - Jito Restaking (`RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q`)
 *   - Jito Vault     (`Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8`)
 * which ARE on devnet but are a different product (restaking framework,
 * not an LST).
 *
 * Default target: a working community SPL Stake Pool on devnet
 * (override with STAKE_POOL=<pubkey>).
 *
 *   pool                : DAJ8shhDnb7K9hwW2cdZNTuYJkVREZAXrZbPfrTeQRyA
 *
 * Usage (devnet POC):
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *   AMOUNT=10000000 \                        # 0.01 SOL
 *   npx tsx scripts/poc-jito-deposit.ts
 *
 * Usage (mainnet against real JitoSOL):
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   STAKE_POOL=Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb \
 *   AMOUNT=10000000 npx tsx scripts/poc-jito-deposit.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { depositSol, getStakePoolAccount, STAKE_POOL_PROGRAM_ID, updateStakePool } from "@solana/spl-stake-pool";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DEFAULT_POOL = "DAJ8shhDnb7K9hwW2cdZNTuYJkVREZAXrZbPfrTeQRyA";

function loadKp(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const user = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));
  const stakePool = new PublicKey(process.env.STAKE_POOL || DEFAULT_POOL);
  const lamports = Number(process.env.AMOUNT || "10000000");

  console.log("=== SPL Stake Pool deposit POC (devnet) ===");
  console.log("user:        ", user.publicKey.toBase58());
  console.log("stake pool:  ", stakePool.toBase58());
  console.log("amount:      ", lamports, "lamports");
  console.log("program:     ", STAKE_POOL_PROGRAM_ID.toBase58());

  const pool = await getStakePoolAccount(conn, stakePool);
  const lstMint = pool.account.data.poolMint;
  console.log("LST mint:    ", lstMint.toBase58());
  console.log("pool total stake (lamports):    ", pool.account.data.totalLamports.toString());
  console.log("pool LST supply:                ", pool.account.data.poolTokenSupply.toString());
  const exchangeRate = pool.account.data.totalLamports.toNumber() / pool.account.data.poolTokenSupply.toNumber();
  console.log("exchange rate (SOL per LST):    ", exchangeRate.toFixed(8));

  const userLstAta = getAssociatedTokenAddressSync(lstMint, user.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  console.log("user LST ATA:", userLstAta.toBase58());

  const beforeLst = (await conn.getTokenAccountBalance(userLstAta).catch(() => null))?.value.amount ?? "0";

  // 0. Refresh pool epoch state (validator list + pool balance). Required if
  //    the pool wasn't touched yet this epoch — DepositSol errors with 0x11
  //    ("First update old validator stake account balances and then pool
  //    stake balance") otherwise.
  console.log("\nRefreshing pool epoch state...");
  const update = await updateStakePool(conn, pool, false);
  if (update.updateListInstructions.length > 0 || update.finalInstructions.length > 0) {
    for (const ixs of update.updateListInstructions) {
      const tx = new Transaction().add(...ixs);
      const sig = await sendAndConfirmTransaction(conn, tx, [user]);
      console.log("  updateValidatorList:", sig);
    }
    if (update.finalInstructions.length > 0) {
      const tx = new Transaction().add(...update.finalInstructions);
      const sig = await sendAndConfirmTransaction(conn, tx, [user]);
      console.log("  updatePoolBalance:  ", sig);
    }
  } else {
    console.log("  pool already up to date");
  }

  // 1. Idempotently create user's LST ATA
  const setupTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userLstAta, user.publicKey, lstMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(conn, setupTx, [user]);

  // 2. Deposit. SDK builds the full ix list (deposit_sol with all required PDAs).
  const { instructions, signers } = await depositSol(
    conn,
    stakePool,
    user.publicKey,
    lamports,
    userLstAta,
  );
  const depositTx = new Transaction().add(...instructions);
  const sig = await sendAndConfirmTransaction(conn, depositTx, [user, ...signers]);
  console.log("\ndeposit sig:", sig);

  const afterLst = (await conn.getTokenAccountBalance(userLstAta).catch(() => null))?.value.amount ?? "0";
  const minted = BigInt(afterLst) - BigInt(beforeLst);
  console.log(`LST balance: ${beforeLst} → ${afterLst} (Δ ${minted})`);
  console.log(`SOL→LST ratio observed: ${(Number(minted) / lamports).toFixed(6)}  (~ inverse of pool exchange rate)`);
}

main().catch((e) => {
  if (e?.transactionLogs) console.error("logs:\n  " + e.transactionLogs.slice(-8).join("\n  "));
  console.error(e);
  process.exit(1);
});
