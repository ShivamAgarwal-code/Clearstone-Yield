/**
 * init-credit-trade-lut.ts — Address Lookup Table for the credit-trade
 * open AND unwind paths. The combined ix sequence runs ~26 ixes
 * referencing ~46 unique pubkeys; without an ALT the legacy 1232-byte
 * tx limit blows.
 *
 * Static set captured here (everything that isn't per-user):
 *
 *   - klend program / market / lma
 *   - csSOL reserve + PDAs (liq_supply / coll_mint / coll_supply /
 *     fee_receiver) + oracle
 *   - csSOL-WT reserve + PDAs (liq_supply / coll_mint / coll_supply /
 *     fee_receiver) — needed for the unwind path's withdraw +
 *     redeem_cssol_wt
 *   - wSOL reserve + PDAs (liq_supply / fee_receiver) + oracle
 *   - SPL Token + Token-2022 + ATA programs
 *   - System / sysvars / compute-budget program
 *   - Jito vault: program / config PDA / vault / VRT mint /
 *     vault_st_token_account / fee_wallet
 *   - Governor: program / pool / dm_mint_config / dm_mint_authority /
 *     pool_vrt_ata / withdraw_queue PDA / pending_wsol account
 *   - delta-mint program
 *   - csSOL mint / csSOL-WT mint / NATIVE_MINT
 *
 * The user's per-tx accounts (signer, csSOL/csSOL-WT/wSOL/VRT/fee-VRT
 * ATAs, obligation PDA, user_metadata PDA, whitelist_entry PDA) live
 * in the VersionedMessage's static keys section.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-credit-trade-lut.ts
 *
 * If a LUT already exists and you only need to add the WT-side
 * addresses, run `extend-credit-trade-lut.ts` instead — it appends
 * the missing entries without recreating the LUT.
 */

import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair,
  PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const GOVERNOR = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
const JITO_VAULT_PROGRAM = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");

// v3 market (from configs/devnet/cssol-market-v3.json)
const KLEND_MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");
const CSSOL_RESERVE = new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w");
const CSSOL_WT_RESERVE = new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw");
const WSOL_RESERVE  = new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8");
const CSSOL_RESERVE_ORACLE = new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P");
const WSOL_RESERVE_ORACLE  = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// csSOL pool / Jito vault config (from configs/devnet/cssol-pool.json + cssol-jito-vault.json)
const CSSOL_MINT = new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt");
const CSSOL_WT_MINT = new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva");
const POOL_PDA = new PublicKey("QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e");
const POOL_VRT_ATA = new PublicKey("BvBy8orQZPXFwR6fgyCkLoyZfK1TBRteG5g4ipuqrEZp");
const DM_MINT_CONFIG = new PublicKey("FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2");
const DM_MINT_AUTHORITY = new PublicKey("Gyv1o28H98zZYnREBmaKq1pJJ5eHqd1wouJ6Km5fCTsT");
const POOL_PENDING_WSOL_ACCOUNT = new PublicKey("5CMXpXEfy8BTe4DzT9xhc36HXYGNf3wDrr5wV5aoJis1");

// Compute Budget program (deterministic constant)
const COMPUTE_BUDGET = ComputeBudgetProgram.programId;

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const vaultCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8"));
  const CSSOL_VAULT = new PublicKey(vaultCfg.vault);
  const CSSOL_VRT_MINT = new PublicKey(vaultCfg.vrtMint);
  const CSSOL_VAULT_ST_TOKEN_ACCOUNT = new PublicKey(vaultCfg.vaultStTokenAccount);
  // fee_wallet isn't pinned in the json; read it directly from the
  // vault account (Jito Vault state has it at offset 696 — see
  // packages/frontend-playground/src/lib/jitoVault.ts).
  const vaultInfo = await conn.getAccountInfo(CSSOL_VAULT, "confirmed");
  if (!vaultInfo) throw new Error("vault account not found");
  const FEE_WALLET = new PublicKey(vaultInfo.data.subarray(696, 696 + 32));
  console.log(`fee wallet: ${FEE_WALLET.toBase58()}`);

  // Derived PDAs
  const [jitoVaultConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], JITO_VAULT_PROGRAM);
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), KLEND_MARKET.toBuffer()], KLEND);
  const [csSolLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), CSSOL_RESERVE.toBuffer()], KLEND);
  const [csSolCollMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), CSSOL_RESERVE.toBuffer()], KLEND);
  const [csSolCollSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), CSSOL_RESERVE.toBuffer()], KLEND);
  const [csSolFeeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), CSSOL_RESERVE.toBuffer()], KLEND);
  const [csSolWtLiqSupply]  = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"),  CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [csSolWtCollMint]   = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"),   CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [csSolWtCollSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [csSolWtFeeRecv]    = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"),        CSSOL_WT_RESERVE.toBuffer()], KLEND);
  const [wSolLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), WSOL_RESERVE.toBuffer()], KLEND);
  const [wSolFeeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), WSOL_RESERVE.toBuffer()], KLEND);
  const [withdrawQueue] = PublicKey.findProgramAddressSync([Buffer.from("withdraw_queue"), POOL_PDA.toBuffer()], GOVERNOR);

  const addresses: PublicKey[] = [
    // Programs + sysvars + system
    KLEND, GOVERNOR, DELTA_MINT, JITO_VAULT_PROGRAM,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
    COMPUTE_BUDGET,
    // Mints
    NATIVE_MINT, CSSOL_MINT, CSSOL_WT_MINT, CSSOL_VRT_MINT,
    // klend market + lma
    KLEND_MARKET, lma,
    // csSOL reserve + PDAs + oracle
    CSSOL_RESERVE, csSolLiqSupply, csSolCollMint, csSolCollSupply, csSolFeeRecv, CSSOL_RESERVE_ORACLE,
    // csSOL-WT reserve + PDAs (oracle is shared with csSOL on devnet)
    CSSOL_WT_RESERVE, csSolWtLiqSupply, csSolWtCollMint, csSolWtCollSupply, csSolWtFeeRecv,
    // wSOL reserve + PDAs + oracle
    WSOL_RESERVE, wSolLiqSupply, wSolFeeRecv, WSOL_RESERVE_ORACLE,
    // Jito vault
    jitoVaultConfig, CSSOL_VAULT, CSSOL_VAULT_ST_TOKEN_ACCOUNT, FEE_WALLET,
    // Governor pool + WT-side accounts (withdraw queue PDA + pending wSOL)
    POOL_PDA, POOL_VRT_ATA, DM_MINT_CONFIG, DM_MINT_AUTHORITY,
    withdrawQueue, POOL_PENDING_WSOL_ACCOUNT,
  ];

  console.log(`payer:    ${payer.publicKey.toBase58()}`);
  console.log(`addrs:    ${addresses.length}`);

  const slot = await conn.getSlot("finalized");
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  console.log(`LUT:      ${lutAddress.toBase58()} (recentSlot=${slot})`);

  await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [payer], { commitment: "confirmed" });

  // Single extend call — we have ~32 entries, well under the per-tx
  // limit (~30 ATM but 1 tx fits 30+ if no other ixes).
  const half = Math.ceil(addresses.length / 2);
  for (const chunk of [addresses.slice(0, half), addresses.slice(half)]) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey, authority: payer.publicKey,
      lookupTable: lutAddress, addresses: chunk,
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(extendIx), [payer], { commitment: "confirmed" });
    console.log(`extend (+${chunk.length}): ${sig.slice(0, 16)}…`);
  }

  // LUTs become resolvable starting one slot AFTER the slot where the
  // last extend lands. Print so the operator knows when it's safe.
  const finishSlot = await conn.getSlot("confirmed");
  console.log(`extended at slot ${finishSlot} — resolvable at slot ${finishSlot + 1}`);

  const out = {
    cluster: "devnet",
    creditTradeLut: lutAddress.toBase58(),
    market: KLEND_MARKET.toBase58(),
    addrCount: addresses.length,
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs/devnet/credit-trade-lut.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`saved → ${outPath}`);
  console.log(`\nNext: set in packages/frontend-playground/.env:`);
  console.log(`  VITE_CREDIT_TRADE_LUT=${lutAddress.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
