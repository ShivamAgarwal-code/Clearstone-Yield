/**
 * init-deposit-lut.ts — One-shot creation of the Address Lookup Table that
 * compresses the SOL → csSOL → klend collateral deposit tx.
 *
 * The merged deposit tx (init_user_metadata + init_obligation + ATAs +
 * SystemTransfer + sync_native + wrap_with_jito_vault + refresh_reserve +
 * refresh_obligation + deposit + refresh_obligation + request_elevation_group)
 * references ~37 unique pubkeys. At 32 bytes/each that's already past the
 * 1232-byte tx limit before any ix data. A LUT collapses the static set
 * (programs / market / reserve PDAs / pool / vault / mints / sysvars) to
 * 1-byte indices, leaving only the user's per-tx accounts in the message
 * header.
 *
 * Run once per cluster, write the LUT address to configs/devnet/cssol-pool.json,
 * and feed it to the playground via VITE_DEPOSIT_LUT.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/init-deposit-lut.ts
 */
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const poolCfgPath = path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  const poolCfg = JSON.parse(fs.readFileSync(poolCfgPath, "utf8"));
  const vaultCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8"));
  const oracleCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "cssol-oracle.json"), "utf8"));

  // Klend market + reserve are pinned — no separate deploy state file. If
  // these change, update both this script and packages/frontend-playground/src/lib/addresses.ts.
  const KLEND_PROGRAM = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const KLEND_MARKET = new PublicKey("2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW");
  const CSSOL_RESERVE = new PublicKey("Ez1axBhD6M6t1Zmzfz8MQ95Kmuc48BuoYhQEEHEhT4U1");
  const CSSOL_RESERVE_ORACLE = new PublicKey(oracleCfg.accrualOutput);
  const GOVERNOR_PROGRAM = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
  const POOL_PDA = new PublicKey(poolCfg.pool.poolConfig);
  const POOL_VRT_ATA = new PublicKey(poolCfg.poolVrtAta);
  const JITO_VAULT_PROGRAM = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");
  const CSSOL_VAULT = new PublicKey(poolCfg.vault);
  const CSSOL_VRT_MINT = new PublicKey(vaultCfg.vrtMint);
  const CSSOL_VAULT_ST_TOKEN_ACCOUNT = new PublicKey(vaultCfg.vaultStTokenAccount);
  const CSSOL_MINT = new PublicKey(poolCfg.cssolMint);
  const DM_MINT_CONFIG = new PublicKey(poolCfg.dmMintConfig);
  const DM_MINT_AUTHORITY = new PublicKey(poolCfg.dmMintAuthority);
  const DELTA_MINT_PROGRAM = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");

  const [jitoVaultConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], JITO_VAULT_PROGRAM);
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), KLEND_MARKET.toBuffer()], KLEND_PROGRAM);
  const [reserveLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), CSSOL_RESERVE.toBuffer()], KLEND_PROGRAM);
  const [reserveCollMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), CSSOL_RESERVE.toBuffer()], KLEND_PROGRAM);
  const [reserveCollSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), CSSOL_RESERVE.toBuffer()], KLEND_PROGRAM);

  const addresses: PublicKey[] = [
    KLEND_PROGRAM,
    KLEND_MARKET,
    lma,
    CSSOL_RESERVE,
    CSSOL_RESERVE_ORACLE,
    reserveLiqSupply,
    reserveCollMint,
    reserveCollSupply,
    GOVERNOR_PROGRAM,
    POOL_PDA,
    POOL_VRT_ATA,
    JITO_VAULT_PROGRAM,
    jitoVaultConfig,
    CSSOL_VAULT,
    CSSOL_VRT_MINT,
    CSSOL_VAULT_ST_TOKEN_ACCOUNT,
    CSSOL_MINT,
    DM_MINT_CONFIG,
    DM_MINT_AUTHORITY,
    DELTA_MINT_PROGRAM,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RENT_PUBKEY,
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

  const createTx = new Transaction().add(createIx);
  const createSig = await sendAndConfirmTransaction(conn, createTx, [payer], { commitment: "confirmed" });
  console.log(`create sig: ${createSig}`);

  // Extend ix can carry up to ~30 addresses per tx. Single batch is enough
  // for our 27-entry list.
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses,
  });
  const extendTx = new Transaction().add(extendIx);
  const extendSig = await sendAndConfirmTransaction(conn, extendTx, [payer], { commitment: "confirmed" });
  console.log(`extend sig: ${extendSig}`);

  // LUTs become resolvable starting one slot AFTER the slot in which the
  // last extend lands ("warmup"). Print the current slot so the operator
  // knows when it's safe to use.
  const finishSlot = await conn.getSlot("confirmed");
  console.log(`extended at slot ${finishSlot} — LUT becomes resolvable at slot ${finishSlot + 1}.`);

  const updated = { ...poolCfg, depositLut: lutAddress.toBase58() };
  fs.writeFileSync(poolCfgPath, JSON.stringify(updated, null, 2) + "\n");
  console.log(`wrote depositLut to ${path.relative(process.cwd(), poolCfgPath)}`);

  console.log("\nNext: set the env var for the playground build:");
  console.log(`  VITE_DEPOSIT_LUT=${lutAddress.toBase58()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
