/**
 * extend-credit-trade-lut.ts — Append the csSOL-WT side static accounts
 * to the existing credit-trade Address Lookup Table.
 *
 * The original `init-credit-trade-lut.ts` was scoped to the OPEN path
 * (~32 addresses: programs, mints, csSOL/wSOL reserves + PDAs, Jito
 * vault, governor pool). The UNWIND path additionally references the
 * csSOL-WT mint, its klend reserve + reserve PDAs (liq_supply,
 * coll_mint, coll_supply, fee_receiver), the pool's pending-wSOL
 * account, and the governor's withdraw_queue PDA — eight accounts that
 * stay in the v0 message header today, pushing the unwind tx past
 * Solana's 1232-byte packet cap (it sits ~150 bytes over with 22
 * static + 24 LUT keys × 26 ixes).
 *
 * This script appends the missing eight to the live LUT in a single
 * extend_lookup_table tx. Idempotent-ish: if any address is already in
 * the LUT, klend will silently keep both copies (LUTs allow duplicate
 * indices; only the resolution count grows). Re-running is safe but
 * wastes rent — check the on-chain LUT first if unsure.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/extend-credit-trade-lut.ts
 */

import {
  AddressLookupTableProgram, Connection, Keypair,
  PublicKey, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND    = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const GOVERNOR = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");

// csSOL pool + WT-side addresses (v3 devnet — match
// frontend-institutional/src/config/devnet.ts).
const POOL_PDA                  = new PublicKey("QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e");
const CSSOL_WT_MINT             = new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva");
const CSSOL_WT_RESERVE          = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");
const POOL_PENDING_WSOL_ACCOUNT = new PublicKey("5CMXpXEfy8BTe4DzT9xhc36HXYGNf3wDrr5wV5aoJis1");

// csSOL accrual-oracle accounts (program ID + FeedConfig PDA + Pyth
// source feed). The unwind builder now inlines an
// `accrual_oracle::refresh` ix at the top of the tx so klend's
// `refresh_reserve(WT)` actually bumps the WT reserve's slot — adding
// these three pubkeys to the LUT keeps the v0 message header tight.
// The output account (3Sx8WJC7…Pw3P = csSOL oracle) is already in the
// LUT from the original init script.
const ACCRUAL_ORACLE_PROGRAM    = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");
const ACCRUAL_ORACLE_CONFIG     = new PublicKey("6ZhhrkGkN91zz6qPu4n3YmyMCFA7hoPYpj5jtzvkF1JM");
const ACCRUAL_ORACLE_SOURCE     = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// csSOL-WT delta-mint config + authority. The convert/enqueue ix
// references these every tx; without them in the LUT they each
// occupy a 32-byte static-key slot. Adding them recovered ~62 bytes
// of v0 message budget when the inline accrual crank + WT pre-warm
// pushed the convert tx 8 bytes over the 1232-byte raw cap.
const CSSOL_WT_MINT_CONFIG      = new PublicKey("BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4");
const CSSOL_WT_MINT_AUTHORITY   = new PublicKey("FxoXoyK9nMYWXWjrZYLb88jCoYdTPbZBgAA2UQCRTAKe");

// Resolved at runtime from the LUT JSON written by init-credit-trade-lut.
const LUT_JSON = path.join(__dirname, "..", "configs", "devnet", "credit-trade-lut.json");

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  if (!fs.existsSync(LUT_JSON)) {
    throw new Error(`LUT json not found at ${LUT_JSON}; run init-credit-trade-lut.ts first.`);
  }
  const lutMeta = JSON.parse(fs.readFileSync(LUT_JSON, "utf8"));
  const lutAddress = new PublicKey(lutMeta.creditTradeLut);

  // Derived PDAs for the WT reserve + the governor withdraw queue.
  const [wtLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [wtCollMint]  = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"),  CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [wtCollSupply]= PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"),CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [wtFeeRecv]   = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"),       CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [withdrawQueue] = PublicKey.findProgramAddressSync([Buffer.from("withdraw_queue"), POOL_PDA.toBuffer()], GOVERNOR);

  const newAddresses: PublicKey[] = [
    CSSOL_WT_RESERVE,
    CSSOL_WT_MINT,
    wtLiqSupply,
    wtCollMint,
    wtCollSupply,
    wtFeeRecv,
    POOL_PENDING_WSOL_ACCOUNT,
    withdrawQueue,
    // csSOL accrual oracle (inline-cranked at the top of the unwind tx).
    ACCRUAL_ORACLE_PROGRAM,
    ACCRUAL_ORACLE_CONFIG,
    ACCRUAL_ORACLE_SOURCE,
    // csSOL-WT mint config + authority (referenced by every convert /
    // enqueue tx; previously stuck in static keys, costing 64 bytes).
    CSSOL_WT_MINT_CONFIG,
    CSSOL_WT_MINT_AUTHORITY,
  ];

  // Sanity-check: dedupe against current LUT contents so we don't append
  // duplicates if the script is re-run.
  const lutInfo = await conn.getAccountInfo(lutAddress, "confirmed");
  if (!lutInfo) throw new Error(`LUT ${lutAddress.toBase58()} not found on-chain`);

  // AddressLookupTable account layout:
  //   0..4    discriminator
  //   4..12   deactivation_slot (u64)
  //   12..20  last_extended_slot (u64)
  //   20..21  last_extended_slot_start_index (u8)
  //   21      has_authority (u8) — 1 if Some, 0 if None
  //   22..54  authority (Pubkey) — only valid when has_authority == 1
  //   54..56  padding
  //   56..    addresses (32 bytes each)
  const hasAuthority = lutInfo.data[21] === 1;
  const onChainAuthority = hasAuthority
    ? new PublicKey(lutInfo.data.subarray(22, 54))
    : null;

  const existing = new Set<string>();
  for (let off = 56; off + 32 <= lutInfo.data.length; off += 32) {
    existing.add(new PublicKey(lutInfo.data.subarray(off, off + 32)).toBase58());
  }
  const toAdd = newAddresses.filter((a) => !existing.has(a.toBase58()));

  console.log(`payer:    ${payer.publicKey.toBase58()}`);
  console.log(`LUT:      ${lutAddress.toBase58()} (current ${existing.size} entries)`);
  console.log(`authority on-chain: ${onChainAuthority ? onChainAuthority.toBase58() : "<frozen / no authority>"}`);
  console.log(`adding:   ${toAdd.length} of ${newAddresses.length} (skipping duplicates)`);
  for (const a of toAdd) console.log(`  +${a.toBase58()}`);

  if (!onChainAuthority) {
    throw new Error(
      `LUT ${lutAddress.toBase58()} has no authority (frozen) — it can never be extended again. ` +
      `Create a new LUT via init-credit-trade-lut.ts, then update VITE_CREDIT_TRADE_LUT to the new address.`,
    );
  }
  if (!onChainAuthority.equals(payer.publicKey)) {
    throw new Error(
      `Wrong signer: the LUT's authority is ${onChainAuthority.toBase58()} ` +
      `but DEPLOY_KEYPAIR resolves to ${payer.publicKey.toBase58()}. ` +
      `Re-run with DEPLOY_KEYPAIR pointing at the keypair whose pubkey matches the authority above.`,
    );
  }

  if (toAdd.length === 0) {
    console.log("nothing to add — LUT already contains every WT-side address. exiting.");
    return;
  }

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses: toAdd,
  });
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(extendIx),
    [payer],
    { commitment: "confirmed" },
  );
  console.log(`extended (+${toAdd.length}): ${sig}`);

  const finishSlot = await conn.getSlot("confirmed");
  console.log(`extended at slot ${finishSlot} — resolvable at slot ${finishSlot + 1}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
