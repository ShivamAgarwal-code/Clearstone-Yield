/**
 * crank-cssol-accrual-oracle.ts — One-shot manual crank of the csSOL
 * accrual oracle so klend's `refresh_reserve(csSOL)` and
 * `refresh_reserve(csSOL-WT)` actually bump the reserves'
 * `last_update.slot`.
 *
 * Why this is needed
 * ------------------
 * Both the csSOL and csSOL-WT klend reserves point at the SAME accrual
 * oracle output account (`3Sx8WJC7…Pw3P`). On-chain inspection showed
 * both reserves stuck at `last_update.slot = 460267317` for ~13K slots
 * (~1.5h on devnet). The reason: nobody has cranked the accrual oracle
 * — it has stale `posted_slot`, so klend's `refresh_reserve` happy-paths
 * through without bumping the reserve's own slot. csSOL escapes by
 * being touched by other users' txes; csSOL-WT (rarely used) does not,
 * which makes the credit-trade unwind revert with `ReserveStale (6009)`
 * mid-flow.
 *
 * The keeper-cloud Cloudflare Worker (packages/keeper-cloud) does this
 * crank every 5 min in steady-state. This script is a manual one-shot
 * for unblocking `dev` work without waiting for the Worker fire — same
 * exact ix layout, just signed locally.
 *
 * What it does
 * ------------
 *   1. Reads the WT reserve's current `LastUpdate { slot, stale }`.
 *   2. Sends a single tx containing one ix:
 *        accrual_oracle::refresh
 *        accounts = [feed_config, source=Pyth_SOL_USD, output=klend_oracle]
 *      The output account's `posted_slot` is rewritten to the current slot.
 *   3. Sends a second tx with one `klend::refresh_reserve(WT)` ix to
 *      verify the reserve's own slot now advances.
 *
 * Usage
 * -----
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/crank-cssol-accrual-oracle.ts
 *
 * Any keypair with > 0.0001 SOL works — the accrual_oracle::refresh ix
 * is permissionless. Authority is only needed for `propose_rate` /
 * `set_authority`, which we don't touch.
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Accrual oracle program (declare_id! in
// packages/programs/programs/accrual-oracle/src/lib.rs).
const ACCRUAL_ORACLE_PROGRAM = new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec");

// FeedConfig PDA + output (= klend oracle pubkey) for csSOL — pinned
// in packages/programs/configs/devnet/cssol-oracle.json. The csSOL-WT
// reserve points at the same output; cranking once refreshes both.
const ACCRUAL_CONFIG = new PublicKey("6ZhhrkGkN91zz6qPu4n3YmyMCFA7hoPYpj5jtzvkF1JM");
const ACCRUAL_OUTPUT = new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P");

// Pyth-sponsored SOL/USD push feed on devnet. Updated by Pyth's
// permissionless updater every ~30s, so when we run this script the
// source feed is essentially always fresh.
const PYTH_SOL_USD_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// V3 klend (matches frontend-institutional/src/config/devnet.ts).
const KLEND          = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const LENDING_MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const CSSOL_WT_RESERVE = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");
const CSSOL_RESERVE    = new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w");

// First 8 bytes of sha256("global:refresh"), pre-computed in
// keeper-cloud/src/index.ts:49 (cross-checked).
const DISC_REFRESH        = Buffer.from([0xaa, 0x9b, 0x16, 0xfe, 0x93, 0xb5, 0x31, 0xa1]);
// First 8 bytes of sha256("global:refresh_reserve") = 02da8aeb4fc91966.
const DISC_REFRESH_RESERVE = Buffer.from([0x02, 0xda, 0x8a, 0xeb, 0x4f, 0xc9, 0x19, 0x66]);

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function buildAccrualRefreshIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: ACCRUAL_ORACLE_PROGRAM,
    keys: [
      { pubkey: ACCRUAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: PYTH_SOL_USD_FEED, isSigner: false, isWritable: false },
      { pubkey: ACCRUAL_OUTPUT, isSigner: false, isWritable: true  },
    ],
    data: DISC_REFRESH,
  });
}

function buildKlendRefreshReserveIx(reserve: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: reserve,         isSigner: false, isWritable: true  },
      { pubkey: LENDING_MARKET,  isSigner: false, isWritable: false },
      { pubkey: ACCRUAL_OUTPUT,  isSigner: false, isWritable: false },
      { pubkey: KLEND,           isSigner: false, isWritable: false }, // scope = None
      { pubkey: KLEND,           isSigner: false, isWritable: false }, // switchboard_twap = None
      { pubkey: KLEND,           isSigner: false, isWritable: false }, // switchboard_price = None
    ],
    data: DISC_REFRESH_RESERVE,
  });
}

function readLastUpdate(data: Buffer): { slot: bigint; stale: number; priceStatus: number } {
  return {
    slot: data.readBigUInt64LE(16),
    stale: data[24],
    priceStatus: data[25],
  };
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const signer = loadKeypair();
  console.log(`signer:        ${signer.publicKey.toBase58()}`);

  const beforeOutput = await conn.getAccountInfo(ACCRUAL_OUTPUT, "confirmed");
  if (!beforeOutput) throw new Error(`accrual output ${ACCRUAL_OUTPUT.toBase58()} not found`);
  const beforeOutputSlot = beforeOutput.data.readBigUInt64LE(125);
  console.log(`accrual output posted_slot before: ${beforeOutputSlot}`);

  const beforeWt = await conn.getAccountInfo(CSSOL_WT_RESERVE, "confirmed");
  if (!beforeWt) throw new Error("WT reserve not found");
  const wtBefore = readLastUpdate(beforeWt.data);
  console.log(`WT reserve LastUpdate before:     slot=${wtBefore.slot} stale=${wtBefore.stale} priceStatus=${wtBefore.priceStatus}`);

  // Step 1 — crank the accrual oracle.
  console.log(`\nstep 1: cranking accrual_oracle::refresh …`);
  const tx1 = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
    .add(buildAccrualRefreshIx());
  const sig1 = await sendAndConfirmTransaction(conn, tx1, [signer], { commitment: "confirmed" });
  console.log(`  ✓ ${sig1}`);

  const afterOutput = await conn.getAccountInfo(ACCRUAL_OUTPUT, "confirmed");
  if (!afterOutput) throw new Error("accrual output disappeared");
  const afterOutputSlot = afterOutput.data.readBigUInt64LE(125);
  console.log(`accrual output posted_slot after:  ${afterOutputSlot}  (Δ=${afterOutputSlot - beforeOutputSlot})`);
  if (afterOutputSlot === beforeOutputSlot) {
    throw new Error("accrual output posted_slot did not change — refresh appears to have no-op'd");
  }

  // Step 2 — refresh the WT reserve and read its slot back.
  console.log(`\nstep 2: cranking klend::refresh_reserve(csSOL-WT) …`);
  const tx2 = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    .add(buildKlendRefreshReserveIx(CSSOL_WT_RESERVE));
  const sig2 = await sendAndConfirmTransaction(conn, tx2, [signer], { commitment: "confirmed" });
  console.log(`  ✓ ${sig2}`);

  const afterWt = await conn.getAccountInfo(CSSOL_WT_RESERVE, "confirmed");
  if (!afterWt) throw new Error("WT reserve disappeared");
  const wtAfter = readLastUpdate(afterWt.data);
  console.log(`WT reserve LastUpdate after:      slot=${wtAfter.slot} stale=${wtAfter.stale} priceStatus=${wtAfter.priceStatus}`);

  if (wtAfter.slot === wtBefore.slot) {
    console.error(`\n❌ WT reserve slot did NOT advance even after the accrual oracle was cranked.`);
    console.error(`   The oracle is fresh now (posted_slot=${afterOutputSlot}) but klend still no-ops the reserve refresh.`);
    console.error(`   Next step: inspect the WT reserve's token_info.scope_configuration or block_price_usage flag.`);
    process.exit(1);
  }
  console.log(`\n✅ WT reserve slot advanced ${wtBefore.slot} → ${wtAfter.slot}.`);

  // Bonus: refresh csSOL too while we're here so the unwind chain
  // doesn't trip over it either.
  console.log(`\nstep 3 (bonus): cranking klend::refresh_reserve(csSOL) for symmetry …`);
  const tx3 = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    .add(buildKlendRefreshReserveIx(CSSOL_RESERVE));
  const sig3 = await sendAndConfirmTransaction(conn, tx3, [signer], { commitment: "confirmed" });
  console.log(`  ✓ ${sig3}`);

  console.log(`\nDone — retry the unwind in the UI within the next ~few seconds (any tx in the same block window is fine; the reserve will be re-stale by the next on-chain idle period until the keeper Worker fires again).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
