/**
 * list-wsol-depositors.ts — Drain-feasibility report for the v3 wSOL reserve.
 *
 * For an in-use klend reserve, `update_reserve_config(mode=23)` is locked
 * (see the in-use curve lock memory). To swap the IRM in place we'd
 * need to bring the reserve to `available=0 borrowed=0` first. This
 * script enumerates everyone who'd need to act:
 *
 *   1. Reserve state — current available + borrowed + cToken supply +
 *      exchange rate.
 *   2. Raw cToken holders — depositors who minted cTokens but didn't
 *      pledge them into an obligation. Scanned via SPL Token Program
 *      accounts filtered to the wSOL reserve's `reserve_coll_mint` PDA.
 *   3. Obligation depositors — wallets that pledged cTokens as
 *      collateral inside an obligation. Walked by enumerating klend
 *      obligations on the v3 market and checking deposits[] for the
 *      wSOL reserve.
 *   4. Obligation borrowers — the actual debt side. These wallets must
 *      repay (or be liquidated) before the reserve can hit zero.
 *
 * Usage:
 *   npx tsx scripts/list-wsol-depositors.ts                 # uses public devnet RPC
 *   SOLANA_RPC=https://my-rpc.example npx tsx scripts/...  # custom (recommended for getProgramAccounts)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const WSOL_RESERVE = new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8");

// Obligation layout (with 8-byte anchor disc):
//   0..8     disc
//   8..16    tag (u64)
//   16..32   lastUpdate (slot u64 + stale u8 + priceStatus u8 + 6 pad)
//   32..64   lendingMarket (Pubkey)
//   64..96   owner (Pubkey)
//   96..1184 deposits[8] — each 136 bytes:
//             { depositReserve(32), depositedAmount(u64), marketValueSf(u128),
//               borrowedAgainstInEG(u64), padding(9×u64) }
//   1184..1192 lowestReserveDepositLiquidationLtv (u64)
//   1192..1208 depositedValueSf (u128)
//   1208..2208 borrows[5] — each 200 bytes:
//             { borrowReserve(32), cumulativeBorrowRateBsf(BigFractionBytes=48),
//               firstBorrowedAt(u64), borrowedAmountSf(u128 @ +88),
//               marketValueSf(u128), borrowFactorAdjustedMarketValueSf(u128),
//               borrowedAmountOutsideEG(u64), padding... }
//   BigFractionBytes is 6×u64=48 (4 value + 2 padding) — *not* 32. Off-by-16
//   here would read mid-`cumulativeBorrowRateBsf` (rate-adjusted) and inflate
//   debt amounts by orders of magnitude.
const DEPOSITS_OFFSET = 96;
const DEPOSIT_STRIDE = 136;
const BORROWS_OFFSET = 1208;
const BORROW_STRIDE = 200;
const SF_SHIFT = 60n;

function reservePda(seed: string, reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), reserve.toBuffer()], KLEND_PROGRAM_ID)[0];
}

function lendingMarketAuthority(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND_PROGRAM_ID)[0];
}

function fmtSol(lamports: bigint | number): string {
  const n = typeof lamports === "bigint" ? Number(lamports) : lamports;
  return (n / 1e9).toFixed(4);
}

function shortAddr(s: string): string { return s.slice(0, 4) + "…" + s.slice(-4); }

async function main() {
  const conn = new Connection(RPC, "confirmed");

  console.log("Network:        ", RPC);
  console.log("Market:         ", MARKET.toBase58());
  console.log("wSOL reserve:   ", WSOL_RESERVE.toBase58());
  console.log("");

  // ── 1. Reserve state ────────────────────────────────────────────────
  const reserveInfo = await conn.getAccountInfo(WSOL_RESERVE);
  if (!reserveInfo) throw new Error("wSOL reserve not found");
  const rd = reserveInfo.data;
  const available = rd.readBigUInt64LE(224);
  const borrowedSf = rd.readBigUInt64LE(232) | (rd.readBigUInt64LE(240) << 64n);
  const borrowed = borrowedSf >> SF_SHIFT;
  // Read cToken supply from the mint account itself (offset 36 of an
  // SPL Mint) — the offset-2592 field on the reserve account is a
  // klend-internal counter that drifts from the mint's actual supply
  // by ~rounding-residue, e.g. 900,099,937 vs the mint's 899,999,937
  // after a withdraw. The mint is canonical.
  const collMint = reservePda("reserve_coll_mint", WSOL_RESERVE);
  const collMintInfo = await conn.getAccountInfo(collMint);
  const cTokenSupply = collMintInfo
    ? collMintInfo.data.readBigUInt64LE(36)
    : rd.readBigUInt64LE(2592);
  const total = available + borrowed;
  const utilization = total > 0n ? Number(borrowed) / Number(total) : 0;
  const exchangeRate = cTokenSupply > 0n ? Number(total) / Number(cTokenSupply) : 1;

  console.log("=== Reserve state ===");
  console.log(`  available liquidity: ${fmtSol(available)} wSOL  (raw=${available})`);
  console.log(`  borrowed (debt):     ${fmtSol(borrowed)} wSOL  (raw=${borrowed})`);
  console.log(`  total liquidity:     ${fmtSol(total)} wSOL`);
  console.log(`  utilization:         ${(utilization * 100).toFixed(2)}%`);
  console.log(`  cToken supply:       ${cTokenSupply}`);
  console.log(`  exchange rate:       ${exchangeRate.toFixed(6)} wSOL / cToken`);
  console.log("");

  if (borrowed === 0n && available === 0n) {
    console.log("✓ Reserve is empty — IRM swap can run immediately via update-wsol-irm.ts.");
    return;
  }

  // ── 2. Raw cToken holders ────────────────────────────────────────────
  console.log("=== cToken raw holders ===");
  console.log(`  cToken mint: ${collMint.toBase58()}`);
  // Skip the lending_market_authority PDA — it's the owner field of the
  // reserve_coll_supply vault that klend uses to escrow cTokens pledged
  // into obligations. Counting it as a "raw user holder" double-counts
  // the obligation pledged-collateral entries.
  const lmaSkip = lendingMarketAuthority(MARKET);
  const cTokenAccounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: collMint.toBase58() } },
    ],
  });
  const rawHolders: Array<{ owner: string; cTokenAmount: bigint; underlying: number }> = [];
  for (const { account } of cTokenAccounts) {
    const ownerPk = new PublicKey(account.data.subarray(32, 64));
    if (ownerPk.equals(lmaSkip)) continue;
    const amount = account.data.readBigUInt64LE(64);
    if (amount === 0n) continue;
    rawHolders.push({
      owner: ownerPk.toBase58(),
      cTokenAmount: amount,
      underlying: Number(amount) * exchangeRate / 1e9,
    });
  }
  rawHolders.sort((a, b) => Number(b.cTokenAmount - a.cTokenAmount));
  if (rawHolders.length === 0) {
    console.log("  (none)");
  } else {
    for (const h of rawHolders) {
      console.log(`  ${h.owner}  cToken=${h.cTokenAmount}  ≈ ${h.underlying.toFixed(4)} wSOL`);
    }
  }
  console.log("");

  // ── 3+4. Obligation walk ────────────────────────────────────────────
  // Filter klend obligations to the v3 market (lendingMarket at offset 32).
  console.log("=== Obligations on v3 market ===");
  const obligations = await conn.getProgramAccounts(KLEND_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 32, bytes: MARKET.toBase58() } },
    ],
  });
  console.log(`  total obligations on market: ${obligations.length}`);

  type Holder = { obligation: string; owner: string; eg: number; cTokenAmount: bigint; underlying: number };
  type Borrower = { obligation: string; owner: string; eg: number; debtTokens: number };
  const pledged: Holder[] = [];
  const borrowers: Borrower[] = [];

  const wsolReserveBuf = WSOL_RESERVE.toBuffer();
  for (const { pubkey, account } of obligations) {
    const data = account.data;
    if (data.length < 2208) continue;
    const owner = new PublicKey(data.subarray(64, 96)).toBase58();
    const eg = data.length > 2285 ? data[2285] : 0;

    // deposits[]: 8 slots × 136 bytes from offset 96
    for (let i = 0; i < 8; i++) {
      const off = DEPOSITS_OFFSET + i * DEPOSIT_STRIDE;
      if (off + 40 > data.length) break;
      if (data.subarray(off, off + 32).equals(wsolReserveBuf)) {
        const cTokenAmount = data.readBigUInt64LE(off + 32);
        if (cTokenAmount > 0n) {
          pledged.push({
            obligation: pubkey.toBase58(), owner, eg,
            cTokenAmount,
            underlying: Number(cTokenAmount) * exchangeRate / 1e9,
          });
        }
      }
    }

    // borrows[]: 5 slots × 200 bytes from offset 1208
    for (let i = 0; i < 5; i++) {
      const off = BORROWS_OFFSET + i * BORROW_STRIDE;
      if (off + 88 > data.length) break;
      if (data.subarray(off, off + 32).equals(wsolReserveBuf)) {
        // borrowedAmountSf is u128 at offset (32 + 48 + 8) = 88 within
        // the borrow slot (BigFractionBytes is 48, not 32).
        const sfOff = off + 88;
        const sfLo = data.readBigUInt64LE(sfOff);
        const sfHi = data.readBigUInt64LE(sfOff + 8);
        const sf = sfLo | (sfHi << 64n);
        const debt = Number(sf >> SF_SHIFT);
        if (debt > 0) {
          borrowers.push({
            obligation: pubkey.toBase58(), owner, eg,
            debtTokens: debt / 1e9,
          });
        }
      }
    }
  }

  console.log("");
  console.log("=== wSOL pledged-collateral depositors ===");
  if (pledged.length === 0) {
    console.log("  (none)");
  } else {
    for (const h of pledged) {
      console.log(`  obligation=${shortAddr(h.obligation)}  owner=${h.owner}  EG=${h.eg}  ≈ ${h.underlying.toFixed(4)} wSOL`);
    }
  }

  console.log("");
  console.log("=== wSOL borrowers ===");
  if (borrowers.length === 0) {
    console.log("  (none)");
  } else {
    for (const b of borrowers) {
      console.log(`  obligation=${shortAddr(b.obligation)}  owner=${b.owner}  EG=${b.eg}  debt=${b.debtTokens.toFixed(4)} wSOL`);
    }
  }

  // ── 5. Aggregate by wallet ──────────────────────────────────────────
  const aggregate = new Map<string, { rawCToken: bigint; pledgedCToken: bigint; debt: number }>();
  for (const h of rawHolders) {
    const e = aggregate.get(h.owner) ?? { rawCToken: 0n, pledgedCToken: 0n, debt: 0 };
    e.rawCToken += h.cTokenAmount;
    aggregate.set(h.owner, e);
  }
  for (const h of pledged) {
    const e = aggregate.get(h.owner) ?? { rawCToken: 0n, pledgedCToken: 0n, debt: 0 };
    e.pledgedCToken += h.cTokenAmount;
    aggregate.set(h.owner, e);
  }
  for (const b of borrowers) {
    const e = aggregate.get(b.owner) ?? { rawCToken: 0n, pledgedCToken: 0n, debt: 0 };
    e.debt += b.debtTokens;
    aggregate.set(b.owner, e);
  }

  console.log("");
  console.log("=== Per-wallet roll-up ===");
  console.log(`  ${"wallet".padEnd(45)}  ${"raw cToken".padStart(14)}  ${"pledged cToken".padStart(16)}  ${"debt wSOL".padStart(12)}`);
  for (const [wallet, e] of aggregate) {
    console.log(`  ${wallet.padEnd(45)}  ${e.rawCToken.toString().padStart(14)}  ${e.pledgedCToken.toString().padStart(16)}  ${e.debt.toFixed(4).padStart(12)}`);
  }

  // ── 6. Drain assessment ─────────────────────────────────────────────
  const totalDebt = borrowers.reduce((s, b) => s + b.debtTokens, 0);
  const totalDepositors = aggregate.size;
  console.log("");
  console.log("=== Drain assessment ===");
  console.log(`  unique wallets to coordinate: ${totalDepositors}`);
  console.log(`  outstanding debt to clear:    ${totalDebt.toFixed(4)} wSOL`);
  console.log(`  available liquidity (idle):   ${fmtSol(available)} wSOL`);
  console.log(`  ⇒ once borrowers repay, depositors can withdraw, then`);
  console.log(`    the curve update via update-wsol-irm.ts unblocks.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
