/**
 * migrate-wt-reserve-to-new-oracle.ts — Final step in the WT-oracle
 * migration. Appends the new oracle accounts to the credit-trade LUT
 * AND flips the csSOL-WT klend reserve's `pyth_configuration.price`
 * field to point at the new output.
 *
 * ⚠ KNOWN LIMITATION (devnet, 2026-05-05)
 * --------------------------------------
 * Klend's `handler_update_reserve_config.rs:49` rejects oracle-pubkey
 * changes (mode=20 PythPrice) on reserves that are already in use
 * (have at least one open collateral / borrow slot), regardless of
 * `skip_validation`. The error is `InvalidConfig (6004)`.
 *
 * This script will run the LUT extend and the second refresh_with_vault
 * fine, but the `update_reserve_config` step will revert with
 * InvalidConfig. The pre-condition log line `"Reserve is used: true"`
 * is what triggers the rejection.
 *
 * Workaround: leave WT pointing at the shared csSOL accrual oracle
 * (`3Sx8WJC7…Pw3P`). The new WT-specific oracle exists on-chain and
 * is callable, but the WT klend reserve cannot be re-pointed at it
 * until either (a) the reserve is fully drained and re-flipped during
 * a maintenance window, or (b) a klend version that allows oracle
 * changes on in-use reserves ships.
 *
 * If you re-run this script after option (a) above, it should succeed.
 *
 * Pre-conditions (this script ASSERTS them; will exit non-zero if any
 * fail):
 *   - configs/devnet/cssol-wt-oracle.json exists (set by
 *     setup-cssol-wt-oracle.ts)
 *   - The new oracle's output account has a non-zero `posted_slot`
 *     (i.e. setup ran and ran the seed refresh)
 *   - DEPLOY_KEYPAIR resolves to the v3 lending_market_owner
 *
 * Strict ordering: this script does NOT update keeper-cloud env vars
 * or frontend env vars — those are manual edits documented in
 * setup-cssol-wt-oracle.ts's footer. They MUST be deployed BEFORE
 * running this script, otherwise the WT reserve will start pointing
 * at an oracle that no one is cranking and refresh_reserve(WT) will
 * silently no-op again.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/migrate-wt-reserve-to-new-oracle.ts
 */

import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair,
  PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND          = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL   = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const LENDING_MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const CSSOL_WT_RESERVE = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");

const WT_ORACLE_JSON = path.join(__dirname, "..", "configs", "devnet", "cssol-wt-oracle.json");
const LUT_JSON       = path.join(__dirname, "..", "configs", "devnet", "credit-trade-lut.json");

const MODE_PYTH_PRICE = 20;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  if (!fs.existsSync(WT_ORACLE_JSON)) {
    throw new Error(`${WT_ORACLE_JSON} not found — run setup-cssol-wt-oracle.ts first.`);
  }
  if (!fs.existsSync(LUT_JSON)) {
    throw new Error(`${LUT_JSON} not found — run init-credit-trade-lut.ts first.`);
  }
  const wtCfg = JSON.parse(fs.readFileSync(WT_ORACLE_JSON, "utf8"));
  const lutCfg = JSON.parse(fs.readFileSync(LUT_JSON, "utf8"));

  const conn = new Connection(RPC, "confirmed");
  const signer = loadKeypair();

  const accrualConfig = new PublicKey(wtCfg.accrualConfig);
  const accrualOutput = new PublicKey(wtCfg.accrualOutput);
  const boundVault    = new PublicKey(wtCfg.boundVault);
  const lutAddress    = new PublicKey(lutCfg.creditTradeLut);

  console.log(`signer:           ${signer.publicKey.toBase58()}`);
  console.log(`new accrual cfg:  ${accrualConfig.toBase58()}`);
  console.log(`new accrual out:  ${accrualOutput.toBase58()}`);
  console.log(`bound vault:      ${boundVault.toBase58()}`);
  console.log(`LUT:              ${lutAddress.toBase58()}`);

  // 1. Verify lending_market_owner matches signer.
  const marketInfo = await conn.getAccountInfo(LENDING_MARKET, "confirmed");
  if (!marketInfo) throw new Error("lending market not found");
  const owner = new PublicKey(marketInfo.data.subarray(24, 56));
  if (!owner.equals(signer.publicKey)) {
    throw new Error(`Wrong signer: lending_market_owner is ${owner.toBase58()} but DEPLOY_KEYPAIR is ${signer.publicKey.toBase58()}`);
  }

  // 2. Verify the new oracle output has been seeded (posted_slot > 0).
  const outputInfo = await conn.getAccountInfo(accrualOutput, "confirmed");
  if (!outputInfo) throw new Error("new accrual output account not found on-chain");
  const outputPostedSlot = outputInfo.data.readBigUInt64LE(125);
  if (outputPostedSlot === 0n) {
    throw new Error("new accrual output's posted_slot is 0 — re-run setup-cssol-wt-oracle.ts so the seed refresh fires");
  }
  console.log(`new output posted_slot: ${outputPostedSlot}`);

  // 2b. If the oracle has only been refreshed once (prev_pub_time = 0)
  // klend's update_reserve_config validator rejects with
  // InvalidConfig (6004) — it wants a non-zero prev_pub_time to cross-
  // check pub_time freshness. One extra refresh shifts the current
  // pub_time into prev_pub_time; refresh_with_vault is permissionless
  // so we just fire it directly.
  const outputPrevPubTime = outputInfo.data.readBigInt64LE(101);
  if (outputPrevPubTime === 0n) {
    console.log(`new output prev_pub_time = 0 — running an extra refresh_with_vault to populate it…`);
    const PYTH_SOL_USD_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    const refreshIx = new TransactionInstruction({
      programId: new PublicKey("8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec"),
      keys: [
        { pubkey: accrualConfig,    isSigner: false, isWritable: false },
        { pubkey: PYTH_SOL_USD_FEED, isSigner: false, isWritable: false },
        { pubkey: boundVault,       isSigner: false, isWritable: false },
        { pubkey: accrualOutput,    isSigner: false, isWritable: true  },
      ],
      data: disc("refresh_with_vault"),
    });
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(refreshIx), [signer], { commitment: "confirmed" },
    );
    console.log(`  ✓ ${sig}`);
  }

  // 3. Extend the LUT with the three new accounts (idempotent).
  console.log(`\nstep 1: extending LUT with new oracle accounts…`);
  const lutInfo = await conn.getAccountInfo(lutAddress, "confirmed");
  if (!lutInfo) throw new Error(`LUT ${lutAddress.toBase58()} not found`);
  const existing = new Set<string>();
  for (let off = 56; off + 32 <= lutInfo.data.length; off += 32) {
    existing.add(new PublicKey(lutInfo.data.subarray(off, off + 32)).toBase58());
  }
  const candidates = [accrualConfig, accrualOutput, boundVault];
  const toAdd = candidates.filter((a) => !existing.has(a.toBase58()));
  if (toAdd.length > 0) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: signer.publicKey,
      authority: signer.publicKey,
      lookupTable: lutAddress,
      addresses: toAdd,
    });
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(extendIx), [signer], { commitment: "confirmed" },
    );
    console.log(`  extended (+${toAdd.length}): ${sig}`);
  } else {
    console.log(`  nothing to add — all 3 accounts already in LUT`);
  }

  // 4. Read WT reserve's pyth_configuration.price BEFORE flipping.
  const wtBefore = await conn.getAccountInfo(CSSOL_WT_RESERVE, "confirmed");
  if (!wtBefore) throw new Error("WT reserve not found");
  // pyth_configuration.price lives at offset 5224 in the v3 reserve
  // layout (verified empirically by inspect-wt-reserve.ts in this
  // session — the csSOL Pyth oracle pubkey appears there in both
  // reserves before the flip).
  const oraclePubkeyOffset = 5224;
  const oldOracle = new PublicKey(wtBefore.data.subarray(oraclePubkeyOffset, oraclePubkeyOffset + 32));
  console.log(`\nWT reserve pyth_configuration.price before: ${oldOracle.toBase58()}`);
  if (oldOracle.equals(accrualOutput)) {
    console.log(`  already pointing at the new output — no flip needed.`);
  } else {
    // 5. Flip WT.pyth_configuration.price to the new output via
    //    update_reserve_config(mode=20).
    console.log(`\nstep 2: update_reserve_config(WT, mode=20, value=${accrualOutput.toBase58()})…`);
    const cfgDisc = disc("update_reserve_config");
    // [mode:u8][len:u32][value:N][skip_validation:u8]
    const data = Buffer.alloc(1 + 4 + 32 + 1);
    data.writeUInt8(MODE_PYTH_PRICE, 0);
    data.writeUInt32LE(32, 1);
    accrualOutput.toBuffer().copy(data, 5);
    data.writeUInt8(1, 5 + 32); // skip_validation = true
    // Pass the new oracle account AS A REMAINING_ACCOUNT — klend's
    // post-update validator (handler_update_reserve_config.rs:49)
    // dereferences the new pubkey to verify the price/feed_id. Without
    // it the validator reads zero data and rejects with InvalidConfig
    // (6004), even with skip_validation=1. The IRM script worked
    // historically because the oracle was already set during
    // init_reserve (no validator path); changing an oracle on an
    // in-use reserve takes the validator path.
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 }))
      .add({
        programId: KLEND,
        data: Buffer.concat([cfgDisc, data]),
        keys: [
          { pubkey: signer.publicKey, isSigner: true,  isWritable: false },
          { pubkey: KLEND_GLOBAL,     isSigner: false, isWritable: false },
          { pubkey: LENDING_MARKET,   isSigner: false, isWritable: false },
          { pubkey: CSSOL_WT_RESERVE, isSigner: false, isWritable: true  },
          // remaining: new oracle account (read-only) so klend can
          // validate its data shape.
          { pubkey: accrualOutput,    isSigner: false, isWritable: false },
        ],
      });
    const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
    console.log(`  ✓ ${sig}`);
  }

  // 6. Validate: send a klend refresh_reserve(WT) and verify slot bumps.
  console.log(`\nstep 3: validating with klend refresh_reserve(WT)…`);
  const wtBeforeSlot = wtBefore.data.readBigUInt64LE(16);
  const refreshTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(new TransactionInstruction({
      programId: KLEND,
      keys: [
        { pubkey: CSSOL_WT_RESERVE, isSigner: false, isWritable: true  },
        { pubkey: LENDING_MARKET,   isSigner: false, isWritable: false },
        { pubkey: accrualOutput,    isSigner: false, isWritable: false },
        { pubkey: KLEND,            isSigner: false, isWritable: false },
        { pubkey: KLEND,            isSigner: false, isWritable: false },
        { pubkey: KLEND,            isSigner: false, isWritable: false },
      ],
      data: disc("refresh_reserve"),
    }));
  await sendAndConfirmTransaction(conn, refreshTx, [signer], { commitment: "confirmed" });

  const wtAfter = await conn.getAccountInfo(CSSOL_WT_RESERVE, "confirmed");
  if (!wtAfter) throw new Error("WT reserve disappeared");
  const wtAfterSlot = wtAfter.data.readBigUInt64LE(16);
  console.log(`WT reserve last_update.slot: ${wtBeforeSlot} → ${wtAfterSlot}`);
  if (wtAfterSlot <= wtBeforeSlot) {
    console.error(`\n❌ WT reserve slot did not advance after refresh_reserve. Migration is incomplete.`);
    process.exit(1);
  }
  console.log(`\n✅ Migration complete. WT reserve now reads from the dedicated vault-backed oracle.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
