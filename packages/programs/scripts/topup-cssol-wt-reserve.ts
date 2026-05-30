/**
 * topup-cssol-wt-reserve.ts — Deposits the deployer's free csSOL-WT
 * into the klend WT reserve to grow flash-borrowable liquidity.
 *
 * The institutional unwind path needs `reserve.liquidity.available_amount`
 * ≥ the user's desired flash-borrow size. klend's `init_reserve` only
 * exposed ~100k of the 1M seed (the rest is a protocol-locked floor),
 * so for any meaningful unwind size we need to deposit more.
 *
 * Account layout matches @kamino-finance/klend-sdk's
 * depositReserveLiquidity ix exactly (12 keys, in order:
 * owner, reserve, market, lma, liq_mint, liq_supply, coll_mint,
 * user_src_liq, user_dst_coll, coll_token_prog, liq_token_prog,
 * sysvar_instructions).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     AMOUNT=9000000 npx tsx scripts/topup-cssol-wt-reserve.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://devnet.helius-rpc.com/?api-key=b4b7a200-6ff5-41ec-80ef-d7e7163d06ec";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const RESERVE = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");
const WT_MINT = new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva");
const WT_ORACLE = new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P");

const AMOUNT = BigInt(process.env.AMOUNT ?? "9000000"); // default 9M = 0.009 csSOL-WT

function disc(s: string): Buffer { return crypto.createHash("sha256").update(`global:${s}`).digest().subarray(0, 8); }
function pda(seed: string, addr: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), addr.toBuffer()], KLEND)[0];
}
function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const userSrc = getAssociatedTokenAddressSync(WT_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const collMint = pda("reserve_coll_mint", RESERVE);
  const userDstColl = getAssociatedTokenAddressSync(collMint, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const lma = pda("lma", MARKET);
  const liqSupply = pda("reserve_liq_supply", RESERVE);

  const balInfo = await conn.getTokenAccountBalance(userSrc).catch(() => null);
  const bal = balInfo ? BigInt(balInfo.value.amount) : 0n;
  console.log(`payer:        ${payer.publicKey.toBase58()}`);
  console.log(`csSOL-WT bal: ${bal} (need ${AMOUNT})`);
  if (bal < AMOUNT) {
    throw new Error(`insufficient csSOL-WT (have ${bal}, need ${AMOUNT}). Transfer some in or run an enqueue.`);
  }

  const data = Buffer.alloc(16);
  disc("deposit_reserve_liquidity").copy(data, 0);
  data.writeBigUInt64LE(AMOUNT, 8);

  // refresh_reserve immediately before so reserve state isn't stale.
  // 6 keys: reserve(W), market(RO), pyth(RO), switchboard(RO=program-id sentinel),
  // switchboard_twap(RO=sentinel), scope(RO=sentinel).
  const refreshIx = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: RESERVE, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: WT_ORACLE, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
    ],
    data: disc("refresh_reserve"),
  });

  // Account ordering verified against SDK (depositReserveLiquidity.ts).
  const depositIx = new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: RESERVE, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: WT_MINT, isSigner: false, isWritable: false },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: userSrc, isSigner: false, isWritable: true },
      { pubkey: userDstColl, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },     // collateral_token_program
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // liquidity_token_program (csSOL-WT is Token-2022)
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, userDstColl, payer.publicKey, collMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(refreshIx)
    .add(depositIx);

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { skipPreflight: true, commitment: "confirmed" });
  console.log("tx:", sig);

  // Read the reserve's current available_amount post-deposit.
  // klend Reserve struct has `liquidity.available_amount` u64 — but we
  // skip the manual decode here and just print the new payer balance.
  const bal2 = await conn.getTokenAccountBalance(userSrc).catch(() => null);
  console.log(`payer csSOL-WT after: ${bal2 ? bal2.value.amount : "?"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
