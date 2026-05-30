/**
 * fix-cssol-wt-oracle.ts — Re-attach the csSOL Pyth oracle to the
 * csSOL-WT klend reserve so `refresh_reserve` actually bumps
 * `last_update.slot`.
 *
 * Why this exists
 * ---------------
 * On-chain inspection (read at slot ~460,280,483) showed both reserves
 * stuck at `last_update.slot = 460267317` (the slot they were init'd).
 * The csSOL reserve gets refreshed during normal user txes — its slot
 * would advance if its oracle config worked end-to-end. The csSOL-WT
 * reserve doesn't: every `refresh_reserve(WT)` we send through the
 * unwind chain succeeds (no error) but never bumps the slot, causing
 * downstream `refresh_obligation` to revert with `ReserveStale (6009)`
 * mid-unwind.
 *
 * Both reserves embed the same Pyth oracle pubkey at the same byte
 * offset, but klend's runtime treats them differently — the WT reserve
 * was almost certainly init'd with `oracle_setup = None` (or the value
 * field was never wired up) so klend's price-update happy-path is
 * skipped. Re-running the `update_reserve_config(mode=20,
 * value=<oracle_pk>)` ix forces klend to re-apply its oracle setup
 * exactly as csSOL has it.
 *
 * Account / args layout (mirrors `replace-reserve-irm.ts`):
 *
 *   data = disc("update_reserve_config")
 *        || mode:u8 (= 20 PythPrice)
 *        || value_len:u32 (= 32)
 *        || value: 32-byte oracle pubkey
 *        || skip_validation:u8 (= 1)
 *
 *   keys = [
 *     signer (RO, lending_market_owner),
 *     klend_global_config (RO),
 *     lending_market (RO),
 *     reserve (W),
 *   ]
 *
 * Usage
 * -----
 *   DEPLOY_KEYPAIR=~/.config/solana/<lending-market-owner>.json \
 *     npx tsx scripts/fix-cssol-wt-oracle.ts
 *
 * The required signer is the v3 market's `lending_market_owner` —
 * NOT the original LUT authority and NOT the deployer keypair. Inspect
 * the lending market account at offset 8 to find it; the script also
 * prints it before attempting the update so you can see whether your
 * loaded keypair matches.
 */

import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// V3 deployment (matches frontend-institutional/src/config/devnet.ts).
const KLEND          = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL   = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const LENDING_MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");

const CSSOL_WT_RESERVE     = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");
const CSSOL_RESERVE        = new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w");
const CSSOL_RESERVE_ORACLE = new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P");

// `update_reserve_config` modes — taken from klend's IDL via
// replace-reserve-irm.ts:
//   17 = priceMaxAgePriceSeconds (u64)
//   18 = priceMaxAgeTwapSeconds  (u64)
//   20 = PythPrice               (Pubkey, 32 bytes)
const MODE_PYTH_PRICE = 20;
const MODE_PRICE_MAX_AGE = 17;
const MODE_TWAP_MAX_AGE = 18;

function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const signer = loadKeypair();

  // Read the lending market to surface the on-chain owner so the user
  // can verify they're signing with the right keypair.
  const marketInfo = await conn.getAccountInfo(LENDING_MARKET, "confirmed");
  if (!marketInfo) throw new Error(`lending market ${LENDING_MARKET.toBase58()} not found`);
  // klend's LendingMarket struct: 8 disc + version u64 (8) + bumpSeed u64 (8) + lendingMarketOwner pubkey (32 at offset 24)
  const owner = new PublicKey(marketInfo.data.subarray(24, 56));
  console.log(`lending market: ${LENDING_MARKET.toBase58()}`);
  console.log(`market owner:   ${owner.toBase58()}`);
  console.log(`signer:         ${signer.publicKey.toBase58()}`);
  if (!owner.equals(signer.publicKey)) {
    throw new Error(
      `Wrong signer: lending_market_owner is ${owner.toBase58()} but DEPLOY_KEYPAIR ` +
      `resolves to ${signer.publicKey.toBase58()}. Re-run with the owner keypair.`,
    );
  }

  // Read the WT reserve before / after so we can verify the oracle
  // config was actually rewritten.
  const before = await conn.getAccountInfo(CSSOL_WT_RESERVE, "confirmed");
  if (!before) throw new Error(`WT reserve ${CSSOL_WT_RESERVE.toBase58()} not found`);
  const beforeSlot = before.data.readBigUInt64LE(16);
  const beforeStale = before.data[24];
  const beforePriceStatus = before.data[25];
  console.log(`\nbefore (WT reserve LastUpdate): slot=${beforeSlot} stale=${beforeStale} priceStatus=${beforePriceStatus}`);

  const cfgDisc = disc("update_reserve_config");

  // value_len is u32 (4 bytes), but the historical script writes 1 byte
  // for value_len in some places. Looking at replace-reserve-irm.ts:
  //   d.writeUInt32LE(value.length, 1);   ← 4-byte u32 length prefix
  //   d.writeUInt8(skip ? 1 : 0, 5 + value.length);
  // So data layout: [mode:u8][len:u32][value:N][skip:u8] = 1+4+N+1 bytes.
  function buildCfgIx(mode: number, value: Buffer, skip = true): Transaction {
    const args = Buffer.alloc(1 + 4 + value.length + 1);
    args.writeUInt8(mode, 0);
    args.writeUInt32LE(value.length, 1);
    value.copy(args, 5);
    args.writeUInt8(skip ? 1 : 0, 5 + value.length);

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 }));
    tx.add({
      programId: KLEND,
      data: Buffer.concat([cfgDisc, args]),
      keys: [
        { pubkey: signer.publicKey,  isSigner: true,  isWritable: false },
        { pubkey: KLEND_GLOBAL,      isSigner: false, isWritable: false },
        { pubkey: LENDING_MARKET,    isSigner: false, isWritable: false },
        { pubkey: CSSOL_WT_RESERVE,  isSigner: false, isWritable: true  },
      ],
    });
    return tx;
  }

  // The previous run learned that `priceMaxAge` is already `u64::MAX`
  // on the WT reserve and that klend's validator rejects no-op updates
  // (`InvalidConfig` 6004 with prv == new in the log). That implies the
  // oracle-related fields all match csSOL already, so refreshing the
  // *config* won't change behavior — the staleness must come from a
  // field we don't yet know how to address.
  //
  // We still attempt `mode=20` (PythPrice) defensively, since it's the
  // only field that *actually* feeds into the refresh price path. If
  // klend accepts it (oracle was different), great. If it rejects with
  // InvalidConfig 6004, the oracle is already wired correctly and the
  // slot-staleness has a different root cause — we then dump a
  // side-by-side of the two reserves' `token_info` region bytes so the
  // operator can see the actual divergent field.
  console.log(`\nattempting PythPrice update on WT reserve…`);
  let updated = false;
  try {
    const sig = await sendAndConfirmTransaction(
      conn,
      buildCfgIx(MODE_PYTH_PRICE, CSSOL_RESERVE_ORACLE.toBuffer()),
      [signer],
      { commitment: "confirmed" },
    );
    console.log(`  ✓ accepted (${sig.slice(0, 16)}…) — oracle was different from csSOL's`);
    updated = true;
  } catch (e: any) {
    const logs: string[] = e.transactionLogs ?? e.logs ?? [];
    const isNoOp = logs.some((l) => l.includes("InvalidConfig") || l.includes("0x1774"));
    if (isNoOp) {
      console.log(`  · rejected as no-op — WT's PythPrice already = ${CSSOL_RESERVE_ORACLE.toBase58()}`);
    } else {
      console.error(`  ✗ unexpected error:`, e.message ?? e);
      throw e;
    }
  }

  if (!updated) {
    console.log(`\noracle config is already aligned with csSOL — staleness must come from another field.`);
    const csReserveInfo = await conn.getAccountInfo(CSSOL_RESERVE, "confirmed");
    if (!csReserveInfo) throw new Error("csSOL reserve not found");
    const cs = csReserveInfo.data;
    const wt = before.data;

    // Explicitly pull a few well-known klend Reserve.config fields by
    // their on-chain offsets (per replace-reserve-irm.ts:225 and the
    // klend SDK). If WT has LTV / liq_thresh / borrow_factor / status
    // set to a "disabled" sentinel, refresh_reserve will silently
    // happy-path.
    const fmtRow = (label: string, off: number, len: number, decode: (b: Buffer) => string) => {
      const sCs = decode(cs.subarray(off, off + len));
      const sWt = decode(wt.subarray(off, off + len));
      const flag = sCs === sWt ? "    " : " ←≠ ";
      console.log(`  ${flag}off=${off.toString().padStart(5)}  ${label.padEnd(28)}  cs=${sCs.padEnd(28)}  wt=${sWt}`);
    };
    const u8  = (b: Buffer) => b[0].toString();
    const u32 = (b: Buffer) => b.readUInt32LE(0).toString();
    const u64 = (b: Buffer) => b.readBigUInt64LE(0).toString();
    const u64hex = (b: Buffer) => "0x" + b.readBigUInt64LE(0).toString(16).padStart(16, "0");

    console.log(`\n── reserve.config key fields (cs vs wt) ──`);
    // klend Reserve.config section starts at offset 4872 (the IRM
    // script reads ltv/liq_thresh from 4872/4873).
    fmtRow("LTV pct (mode 0)",        4872,  1, u8);
    fmtRow("liq threshold pct (m=2)", 4873,  1, u8);
    // Status / fees / various flags follow — print a sweep so we can
    // eyeball anything that differs. The exact field-by-field schema
    // varies between klend versions; print 16-byte windows.
    console.log(`\n── reserve.config window dump (offsets 4872..5040, 16-byte rows) ──`);
    for (let off = 4872; off < 5040; off += 16) {
      const segCs = cs.subarray(off, off + 16);
      const segWt = wt.subarray(off, off + 16);
      const diff = segCs.equals(segWt) ? "    " : " ←≠ ";
      console.log(`  ${diff}off=${off.toString().padStart(5)}  cs=${segCs.toString("hex")}  wt=${segWt.toString("hex")}`);
    }

    console.log(`\n── token_info window dump (offsets 5008..5600, 16-byte rows) ──`);
    for (let off = 5008; off < 5600; off += 16) {
      const segCs = cs.subarray(off, off + 16);
      const segWt = wt.subarray(off, off + 16);
      const diff = segCs.equals(segWt) ? "    " : " ←≠ ";
      console.log(`  ${diff}off=${off.toString().padStart(5)}  cs=${segCs.toString("hex")}  wt=${segWt.toString("hex")}`);
    }

    console.log(`\n── focused decode of the divergent u64 at off=5424 ──`);
    fmtRow("u64 @5424 (raw)",         5424, 8, u64);
    fmtRow("u64 @5424 (hex)",         5424, 8, u64hex);
    // Also try reading the surrounding bytes as candidate fields.
    fmtRow("u64 @5416",               5416, 8, u64hex);
    fmtRow("u64 @5432",               5432, 8, u64hex);
    fmtRow("u64 @5440",               5440, 8, u64hex);

    console.log(`\nNo on-chain mutation attempted. Paste the diff above so we can identify the next mode to target.`);
    return;
  }

  // Send a refresh_reserve to confirm the slot now bumps. We can't
  // sign for the user, but a permissionless refresh_reserve from the
  // signer wallet will do the job.
  console.log(`\nrefreshing WT reserve to verify bump…`);
  const refreshTx = new Transaction();
  refreshTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  refreshTx.add({
    programId: KLEND,
    data: disc("refresh_reserve"),
    keys: [
      { pubkey: CSSOL_WT_RESERVE,        isSigner: false, isWritable: true  },
      { pubkey: LENDING_MARKET,          isSigner: false, isWritable: false },
      { pubkey: CSSOL_RESERVE_ORACLE,    isSigner: false, isWritable: false },
      { pubkey: KLEND,                   isSigner: false, isWritable: false },
      { pubkey: KLEND,                   isSigner: false, isWritable: false },
      { pubkey: KLEND,                   isSigner: false, isWritable: false },
    ],
  });
  const refreshSig = await sendAndConfirmTransaction(conn, refreshTx, [signer], { commitment: "confirmed" });
  console.log(`refresh tx: ${refreshSig}`);

  const after = await conn.getAccountInfo(CSSOL_WT_RESERVE, "confirmed");
  if (!after) throw new Error("WT reserve disappeared after refresh");
  const afterSlot = after.data.readBigUInt64LE(16);
  const afterStale = after.data[24];
  const afterPriceStatus = after.data[25];
  console.log(`\nafter  (WT reserve LastUpdate): slot=${afterSlot} stale=${afterStale} priceStatus=${afterPriceStatus}`);

  if (afterSlot === beforeSlot) {
    console.error(`\n❌ WT reserve slot did not advance — oracle config update did not fix the refresh path. ` +
      `Inspect the reserve config more deeply (token_info.scope_configuration / borrow_factor / status flag).`);
    process.exit(1);
  }
  console.log(`\n✅ WT reserve last_update.slot advanced ${beforeSlot} → ${afterSlot}. Unwind should now succeed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
