/**
 * inspect-tx.ts — Fetch a confirmed tx by signature and dump its
 * top-level instruction list (program IDs + first 16 bytes of data so
 * Anchor discriminators are recognizable). Useful for verifying that a
 * client-side ix really made it into the on-chain tx instead of trusting
 * what the dev server thinks it built.
 *
 * Usage:
 *   npx tsx scripts/inspect-tx.ts <signature>
 */

import { Connection } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Known program IDs we care about for the credit-trade flow.
const KNOWN: Record<string, string> = {
  "ComputeBudget111111111111111111111111111111": "ComputeBudget",
  "11111111111111111111111111111111":            "System",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA":  "SPL Token",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb":  "SPL Token-2022",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL":  "ATA",
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD":   "klend",
  "8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec":  "accrual_oracle",
  "6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi":  "governor",
  "BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy":  "delta_mint",
  "Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8":   "Jito Vault",
};

// Known Anchor discriminators (sha256("global:<name>")[0..8]) so we can
// give a friendlier name when the program is one we recognize.
const DISCS: Record<string, string> = {
  "02da8aeb4fc91966": "klend::refresh_reserve",
  "218493e497c04859": "klend::refresh_obligation",
  "81c70402de271a2e": "klend::deposit_reserve_liquidity_and_obligation_collateral",
  "4b5d5ddc2296dac4": "klend::withdraw_obligation_collateral_and_redeem_reserve_collateral",
  "917f12cc49f5e141": "klend::borrow_obligation_liquidity",
  "91b20de14cf09348": "klend::repay_obligation_liquidity",
  "87f4d9b6c1eaa2b9": "klend::flash_borrow_reserve_liquidity",
  "b908b9018c000bc4": "klend::flash_repay_reserve_liquidity",
  "75a9b8413294f604": "klend::init_user_metadata",
  "fb20e74c1b0b5f60": "klend::init_obligation",
  "4d2bb70d8ddff5d6": "klend::request_elevation_group",
  "aa9b16fe93b531a1": "accrual_oracle::refresh",
};

async function main() {
  const sig = process.argv[2];
  if (!sig) { console.error("usage: npx tsx scripts/inspect-tx.ts <signature>"); process.exit(1); }
  const conn = new Connection(RPC, "confirmed");

  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) { console.error(`tx ${sig} not found at confirmed`); process.exit(1); }

  const msg = tx.transaction.message;
  // For v0 messages the static + LUT keys are flattened by getAccountKeys.
  // Pass the loadedAddresses from meta so LUT-resolved keys are included.
  const loaded = tx.meta?.loadedAddresses ?? { writable: [], readonly: [] };
  const keys = msg.getAccountKeys({
    accountKeysFromLookups: { writable: loaded.writable ?? [], readonly: loaded.readonly ?? [] },
  });
  const all = keys.staticAccountKeys.concat(loaded.writable ?? [], loaded.readonly ?? []);

  const ixs = (msg as any).compiledInstructions ?? msg.instructions;

  console.log(`tx: ${sig}`);
  console.log(`slot: ${tx.slot}, err: ${JSON.stringify(tx.meta?.err) ?? "none"}`);
  console.log(`static keys: ${msg.staticAccountKeys.length}, lut keys: ${(loaded.writable ?? []).length + (loaded.readonly ?? []).length}, total: ${all.length}`);

  console.log(`\n── static keys (in message header — each costs 32B; movable to LUT unless per-tx unique) ──`);
  for (let i = 0; i < msg.staticAccountKeys.length; i++) {
    const k = msg.staticAccountKeys[i];
    const name = KNOWN[k.toBase58()] ?? "";
    console.log(`  ${String(i).padStart(2)}. ${k.toBase58()}  ${name}`);
  }
  console.log(`\ntop-level instructions: ${ixs.length}\n`);

  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i] as any;
    const programIdx: number = ix.programIdIndex;
    const programId = all[programIdx]?.toBase58() ?? "?";
    const programName = KNOWN[programId] ?? programId.slice(0, 8) + "…";
    const dataBuf = Buffer.from(ix.data);
    const disc = dataBuf.subarray(0, 8).toString("hex");
    const discName = DISCS[disc];
    const accCount = (ix.accountKeyIndexes ?? ix.accounts ?? []).length;
    console.log(`  ${String(i).padStart(2)}. ${programName.padEnd(15)}  ${discName ?? `disc=${disc}`}  (${accCount} accounts, ${dataBuf.length}B data)`);
  }

  if (tx.meta?.err) {
    const errIx = (tx.meta.err as any).InstructionError?.[0];
    if (errIx !== undefined) console.log(`\nfailed at instruction index ${errIx}.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
