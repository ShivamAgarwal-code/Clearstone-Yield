/**
 * fix-cusdc-max-age.ts — bump cUSDC reserve's max_age_price_seconds and
 * max_age_twap_seconds to u64::MAX so klend's `check_borrow_possible`
 * stops trippling ReserveStale (6009) on the institutional borrow flow.
 *
 * Background: the deployed cUSDC reserve was set up with 120s / 240s
 * max-age (mainnet-realistic), but the devnet Pyth USDC feed gets
 * pushed sporadically (~7 days between updates). The handler returns
 * `PriceTooOld 6039` from `get_price`, which klend's lending_operations
 * silently demotes to `Some(PriceStatusFlags::empty())` — so the
 * reserve's price_status stays 0b0 and ALL_CHECKS-gated reads (borrow,
 * deposit collateral) all fail with ReserveStale.
 *
 * Mirrors sUSDC's config (which has max_age_price = u64::MAX) so the
 * cUSDC reserve behaves identically on devnet.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/fix-cusdc-max-age.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const CUSDC_RESERVE = new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe");

const MODE_UPDATE_PRICE_MAX_AGE = 17;
const MODE_UPDATE_TWAP_MAX_AGE = 18;
const U64_MAX = (1n << 64n) - 1n;

const UPDATE_DISC = crypto
  .createHash("sha256")
  .update("global:update_reserve_config")
  .digest()
  .subarray(0, 8);

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildIx(owner: PublicKey, mode: number, value: Buffer, skipValidation: boolean): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let off = 0;
  UPDATE_DISC.copy(data, off); off += 8;
  data.writeUInt8(mode, off); off += 1;
  data.writeUInt32LE(value.length, off); off += 4;
  value.copy(data, off); off += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, off);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: CUSDC_RESERVE, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp();
  console.log("Network:", RPC);
  console.log("Signer: ", auth.publicKey.toBase58());

  const u64Max = Buffer.alloc(8);
  u64Max.writeBigUInt64LE(U64_MAX);

  // skipValidation=false because the reserve is "used" (has live
  // deposits) — klend's `is_predeposit` branch rejects skipValidation=true
  // post-first-deposit. The integrity-validator branch accepts max-age
  // edits without further constraint. Memory: klend skip-validation
  // flag inverted.
  for (const [mode, label] of [
    [MODE_UPDATE_PRICE_MAX_AGE, "max_age_price_seconds"],
    [MODE_UPDATE_TWAP_MAX_AGE, "max_age_twap_seconds"],
  ] as const) {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(buildIx(auth.publicKey, mode, u64Max, false));
    const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
    console.log(`✓ ${label} → u64::MAX  (mode=${mode})  tx=${sig}`);
  }

  // Verify.
  const after = await conn.getAccountInfo(CUSDC_RESERVE);
  if (after) {
    console.log("\nVerified on-chain:");
    console.log("  max_age_price_seconds =", after.data.readBigUInt64LE(5096).toString());
    console.log("  max_age_twap_seconds  =", after.data.readBigUInt64LE(5104).toString());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
