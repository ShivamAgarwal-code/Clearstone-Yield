/**
 * repay-susdc-dust.ts — Repay the residual sUSDC dust on obligation
 * `H6wzks5j…WhRyP` so the cUSDC migration scripts can flip EG-1 cleanly
 * (klend's `migrate-eg-debt-to-cusdc` won't move an EG that still has
 * outstanding debt on the legacy reserve).
 *
 * The signer doesn't have to own the obligation — klend's
 * `repay_obligation_liquidity` accepts any wallet as the source of
 * funds. The deployer keypair is fine.
 *
 * Steps:
 *   1. Load the deployer keypair (DEPLOY_KEYPAIR env or ~/.config/solana/id.json).
 *   2. Print the deployer pubkey + their sUSDC ATA balance.
 *   3. Bail out with a clear hint if the ATA balance is below the dust
 *      threshold (it should be ≥1 raw unit; we'll send U64_MAX so klend
 *      caps to actual debt).
 *   4. Build refresh_reserve(ceUSX) + refresh_reserve(sUSDC) +
 *      refresh_obligation + repay_obligation_liquidity (U64_MAX).
 *   5. Simulate first; only broadcast on `--send`.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/repay-susdc-dust.ts             # dry-run
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/repay-susdc-dust.ts --send      # broadcast
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
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");

// Target obligation — the dev wallet's institutional position with
// 0.000012 sUSDC borrowed against ceUSX collateral.
const TARGET_OBLIGATION = new PublicKey("H6wzks5jUJ5cXmuJc469Avv9iLy7LAkVcvEVus8WhRyP");

// Reserves involved.
const SUSDC_RESERVE = new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9");
const SUSDC_MINT    = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const SUSDC_ORACLE  = new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD");

const CEUSX_RESERVE = new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU");
const CEUSX_ORACLE  = new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW");

// klend ix discriminators (anchor sha256 of `global:<name>`, first 8 bytes).
function disc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
const DISC = {
  refreshReserve: disc("refresh_reserve"),
  refreshObligation: disc("refresh_obligation"),
  repayObligationLiquidity: disc("repay_obligation_liquidity"),
};

// U64_MAX — klend's repay handler treats this as "all outstanding debt".
const U64_MAX = (1n << 64n) - 1n;

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR ?? path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function lmaPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND)[0];
}
function reservePda(seed: string, reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), reserve.toBuffer()], KLEND)[0];
}

function buildRefreshReserveIx(reserve: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: MARKET,  isSigner: false, isWritable: false },
      { pubkey: oracle,  isSigner: false, isWritable: false },
      // Optional oracle slots: pass programId as None-marker.
      { pubkey: KLEND,   isSigner: false, isWritable: false },
      { pubkey: KLEND,   isSigner: false, isWritable: false },
      { pubkey: KLEND,   isSigner: false, isWritable: false },
    ],
    data: DISC.refreshReserve,
  });
}

function buildRefreshObligationIx(
  obligation: PublicKey,
  remainingAccounts: PublicKey[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: MARKET,     isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true  },
      // Pass deposit + borrow reserves as writable remaining_accounts —
      // klend's handler load_muts them via FatAccountLoader.
      ...remainingAccounts.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: DISC.refreshObligation,
  });
}

function buildRepayIx(
  signer: PublicKey,
  obligation: PublicKey,
  repayReserve: PublicKey,
  repayMint: PublicKey,
  userSourceAta: PublicKey,
  amount: bigint,
  egDepositReserves: PublicKey[],
): TransactionInstruction {
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(amount);
  const data = Buffer.concat([DISC.repayObligationLiquidity, amtBuf]);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: signer,                                       isSigner: true,  isWritable: false },
      { pubkey: obligation,                                   isSigner: false, isWritable: true  },
      { pubkey: MARKET,                                       isSigner: false, isWritable: false },
      { pubkey: repayReserve,                                 isSigner: false, isWritable: true  },
      { pubkey: repayMint,                                    isSigner: false, isWritable: false },
      { pubkey: reservePda("reserve_liq_supply", repayReserve), isSigner: false, isWritable: true },
      { pubkey: userSourceAta,                                isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,                             isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,                   isSigner: false, isWritable: false },
      // EG > 0 → klend.update_elevation_group_debt_trackers walks the
      // obligation's deposits and pulls one Reserve per slot from
      // remaining_accounts. Without these, InvalidAccountInput 6006.
      ...egDepositReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  const conn = new Connection(RPC, "confirmed");
  const signer = loadKp();

  console.log("Network:    ", RPC);
  console.log("Signer:     ", signer.publicKey.toBase58());
  console.log("Obligation: ", TARGET_OBLIGATION.toBase58(), "(dust borrow target)");
  console.log("");

  // 0. Sanity-check the obligation exists.
  const obInfo = await conn.getAccountInfo(TARGET_OBLIGATION);
  if (!obInfo) {
    console.log("Obligation does not exist on-chain — nothing to repay.");
    return;
  }
  // elevation_group is a single u8 at offset 2285 in the obligation
  // account data — pinned by the existing PositionsPage decoder + the
  // `klend repay/borrow ix accounts` memory note (the actual offset is
  // 8 bytes later than a naive struct sum because ObligationLiquidity
  // is 200 bytes, not the 200-rounded 1000 I'd guessed). Verified by
  // brute-force scan against H6wzks5j…WhRyP on 2026-05-07.
  const ELEVATION_GROUP_OFFSET = 2285;
  const elevationGroup = obInfo.data[ELEVATION_GROUP_OFFSET];
  console.log("Obligation elevation_group:", elevationGroup);

  // 1. Deployer's sUSDC ATA + balance.
  const sourceAta = getAssociatedTokenAddressSync(SUSDC_MINT, signer.publicKey, false, TOKEN_PROGRAM_ID);
  const ataInfo = await conn.getAccountInfo(sourceAta);
  let ataBalance = 0n;
  if (ataInfo) {
    ataBalance = ataInfo.data.readBigUInt64LE(64);
  }
  console.log("Deployer sUSDC ATA:    ", sourceAta.toBase58());
  console.log("Deployer sUSDC balance:", ataBalance, "raw");
  if (ataBalance < 100n) {
    console.error("\n✗ Deployer sUSDC balance is below 100 raw units. The dust borrow is");
    console.error("  ~12 units, but we'd want a slightly larger cushion in case interest");
    console.error("  has accrued since the borrow. Top up via:");
    console.error("    npx tsx scripts/mint-test-usdc.ts " + signer.publicKey.toBase58() + " 1");
    console.error("  (Note: that script targets the legacy test-USDC mint, NOT sUSDC at");
    console.error("  8iBux…D5g. If the deployer isn't the sUSDC mint authority, transfer");
    console.error("  some sUSDC from another wallet instead.)");
    process.exit(1);
  }

  // 2. Build the tx.
  // Deposit reserves first, then borrows — order matters for refresh_obligation.
  const obligationReserves = [CEUSX_RESERVE, SUSDC_RESERVE];

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    // Create the source ATA if missing — defensive, the balance check
    // above should have caught a missing ATA but cheap to be sure.
    .add(createAssociatedTokenAccountIdempotentInstruction(
      signer.publicKey, sourceAta, signer.publicKey, SUSDC_MINT, TOKEN_PROGRAM_ID,
    ))
    .add(buildRefreshReserveIx(CEUSX_RESERVE, CEUSX_ORACLE))
    .add(buildRefreshReserveIx(SUSDC_RESERVE, SUSDC_ORACLE))
    .add(buildRefreshObligationIx(TARGET_OBLIGATION, obligationReserves))
    .add(buildRepayIx(
      signer.publicKey,
      TARGET_OBLIGATION,
      SUSDC_RESERVE,
      SUSDC_MINT,
      sourceAta,
      U64_MAX,
      // EG > 0 → append deposit reserves (just ceUSX here).
      elevationGroup > 0 ? [CEUSX_RESERVE] : [],
    ));

  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;

  // 3. Simulate.
  const sim = await conn.simulateTransaction(tx, [signer]);
  if (sim.value.err) {
    console.error("\n✗ Simulation REJECTED:", JSON.stringify(sim.value.err));
    if (sim.value.logs) console.error("Logs:\n  " + sim.value.logs.slice(-20).join("\n  "));
    process.exit(1);
  }
  console.log("\n✓ Simulation OK. Last 10 logs:");
  for (const l of (sim.value.logs ?? []).slice(-10)) console.log("  " + l);

  if (!send) {
    console.log("\nDry-run only. Re-run with --send to broadcast.");
    return;
  }

  // 4. Broadcast.
  console.log("\nSending …");
  const sig = await sendAndConfirmTransaction(conn, tx, [signer]);
  console.log("Confirmed:", sig);
  console.log("https://explorer.solana.com/tx/" + sig + "?cluster=devnet");
}

main().catch((e) => { console.error(e); process.exit(1); });
