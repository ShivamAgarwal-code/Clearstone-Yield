/**
 * seed-csol-bootstrap-keypair.ts
 *
 * Whitelists a target wallet on the cSOL pool and mints a small cSOL
 * seed to its ATA. Used so bootstrap-cssol-market-v2.ts (running under
 * `id.json` for token-balance reasons) can satisfy klend's
 * `init_reserve` initial-deposit requirement on the v4 market.
 *
 * The cSOL pool authority (`clearstone-devnet.json`, `DiDbnkw…`) signs
 * via co-authority on the activated pool. Run with that keypair.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/seed-csol-bootstrap-keypair.ts <TARGET_WALLET>
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = "https://api.devnet.solana.com";
const GOVERNOR = new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
const SEED_AMOUNT = 1_000_000n;

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function loadIdl(name: string, addr: PublicKey) {
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", `${name}.json`), "utf8"));
  idl.address = addr.toBase58();
  if (idl.metadata) idl.metadata.address = addr.toBase58();
  return idl;
}

async function main() {
  const target = new PublicKey(process.argv[2] ?? (() => { throw new Error("pass target wallet pubkey"); })());
  const auth = loadKp();
  const conn = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(conn, new Wallet(auth), { commitment: "confirmed" });
  const governor = new Program(loadIdl("governor", GOVERNOR), provider);
  const deltaMint = new Program(loadIdl("delta_mint", DELTA_MINT), provider);

  const csolPool = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs/devnet/csol-pool.json"), "utf8"));
  const cSolMint = new PublicKey(csolPool.csolMint);
  const poolConfig = new PublicKey(csolPool.pool.poolConfig);
  const dmMintConfig = new PublicKey(csolPool.dmMintConfig);
  const dmMintAuthority = new PublicKey(csolPool.dmMintAuthority);

  console.log(`Pool authority: ${auth.publicKey.toBase58()}`);
  console.log(`Target wallet:  ${target.toBase58()}`);
  console.log(`cSOL mint:      ${cSolMint.toBase58()}`);

  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), target.toBuffer()],
    DELTA_MINT,
  );

  // 1. Whitelist target via governor.add_participant_native_via_pool
  //    (the native_pool variant — different seeds from the staker pool).
  if (!(await conn.getAccountInfo(whitelistEntry))) {
    console.log(`\nStep 1: governor.add_participant_native_via_pool (target as Holder)`);
    const sig = await (governor.methods as any)
      .addParticipantNativeViaPool({ holder: {} })
      .accounts({
        authority: auth.publicKey,
        poolConfig,
        adminEntry: null,
        dmMintConfig,
        wallet: target,
        whitelistEntry,
        deltaMintProgram: DELTA_MINT,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  } else {
    console.log(`\nStep 1: target already whitelisted — skipping`);
  }

  // 2. Mint cSOL seed to target's ATA (target pays for ATA, we pay for mint).
  const targetAta = getAssociatedTokenAddressSync(
    cSolMint, target, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(targetAta))) {
    console.log(`\nStep 2a: create cSOL ATA for target`);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        auth.publicKey, targetAta, target, cSolMint,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(conn, tx, [auth]);
  }
  const bal = BigInt((await conn.getTokenAccountBalance(targetAta).catch(() => null))?.value.amount ?? "0");
  if (bal >= SEED_AMOUNT) {
    console.log(`\nStep 2b: target ATA already has ${bal} cSOL units — skipping mint`);
  } else {
    console.log(`\nStep 2b: governor.mint_wrapped_native ${SEED_AMOUNT} cSOL units → target`);
    const sig = await (governor.methods as any)
      .mintWrappedNative(new BN(SEED_AMOUNT.toString()))
      .accounts({
        authority: auth.publicKey,
        poolConfig,
        adminEntry: null,
        dmMintConfig,
        wrappedMint: cSolMint,
        dmMintAuthority,
        whitelistEntry,
        destination: targetAta,
        deltaMintProgram: DELTA_MINT,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  console.log(`\n✓ Target ${target.toBase58()} ready for v4 bootstrap`);
  console.log(`  cSOL ATA: ${targetAta.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
