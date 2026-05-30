/**
 * seed-ceusx-wt.ts — One-shot bootstrap to mint SEED_AMOUNT ceUSX-WT
 * to the deployer's ATA via the new governor.admin_mint_wt ix. Run
 * once before scripts/setup-ceusx-wt-reserve.ts to satisfy klend's
 * non-zero seed requirement at init_reserve.
 *
 * The governor.admin_mint_wt ix takes the cSOL pool as the host pool
 * (its PDA is the ceUSX-WT MintConfig.authority — set by step 3 of
 * setup-ceusx-wt-mint.ts). It validates at runtime that the supplied
 * MintConfig.authority equals the host pool's PDA, then signs the
 * delta_mint::mint_to CPI with the pool's seeds.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/seed-ceusx-wt.ts
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GOVERNOR_PROGRAM_ID = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT_PROGRAM_ID = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
const CSOL_POOL_PDA = new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ");

const SEED_AMOUNT = 10_000_000n; // 10 ceUSX-WT — gives ~10× headroom over the 1M init_reserve seed

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  if (!fs.existsSync(idlPath)) throw new Error(`IDL missing: ${idlPath}. Run anchor build first.`);
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const auth = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));
  const provider = new AnchorProvider(conn, new Wallet(auth), { commitment: "confirmed" });

  const wtCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "ceusx-wt.json"), "utf8"));
  const wtMint = new PublicKey(wtCfg.mint);
  const dmMintConfig = new PublicKey(wtCfg.dmMintConfig);
  const dmMintAuthority = new PublicKey(wtCfg.dmMintAuthority);

  console.log("=== seed ceUSX-WT (admin_mint_wt) ===");
  console.log("Deployer:    ", auth.publicKey.toBase58());
  console.log("Host pool:   ", CSOL_POOL_PDA.toBase58());
  console.log("ceUSX-WT mint:", wtMint.toBase58());
  console.log("Seed amount: ", SEED_AMOUNT, "(10 ceUSX-WT)");

  // Whitelist + ATA on the deployer
  const [deployerWhitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), auth.publicKey.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(deployerWhitelistEntry))) {
    throw new Error(`Deployer whitelist_entry missing at ${deployerWhitelistEntry.toBase58()} — run setup-ceusx-wt-mint.ts first.`);
  }

  const destAta = getAssociatedTokenAddressSync(wtMint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const governor = new Program(loadIdl("governor"), provider);

  console.log("\nInvoking governor.admin_mint_wt …");
  const sig = await sendAndConfirmTransaction(conn, new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      auth.publicKey, destAta, auth.publicKey, wtMint,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(await (governor.methods as any)
      .adminMintWt(new (await import("@coral-xyz/anchor")).BN(SEED_AMOUNT.toString()))
      .accounts({
        authority: auth.publicKey,
        poolConfig: CSOL_POOL_PDA,
        adminEntry: null,
        dmMintConfig,
        wtMint,
        dmMintAuthority,
        whitelistEntry: deployerWhitelistEntry,
        destination: destAta,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction()),
    [auth]);
  console.log(`  Tx: ${sig}`);

  const balInfo = await conn.getTokenAccountBalance(destAta);
  console.log(`\nDone. Deployer ceUSX-WT balance: ${balInfo.value.uiAmount} (${balInfo.value.amount} base)`);
  console.log(`Destination ATA: ${destAta.toBase58()}`);
  console.log(`\nNext: scripts/setup-ceusx-wt-reserve.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
