/**
 * setup-cssol-wt-mint.ts — One-shot bring-up of the csSOL-WT (withdraw
 * ticket) Token-2022 mint + delta-mint MintConfig.
 *
 * Reuses the existing csSOL pool's PDA as the MintConfig authority — the
 * pool PDA already controls csSOL via the same delta-mint pattern; we
 * register a *second* MintConfig keyed by the new csSOL-WT mint, then
 * transfer authority to the pool PDA so the governor::enqueue_withdraw_via_pool
 * ix can CPI delta_mint::mint_to with PDA-signer seeds.
 *
 * Steps (idempotent — re-running picks up where the last run left off):
 *   1. delta_mint::initialize_mint — creates new Token-2022 csSOL-WT mint
 *      with confidential-transfer extension; deployer is initial MintConfig
 *      authority.
 *   2. delta_mint::add_to_whitelist (deployer as Holder) — needed for the
 *      seed mint in bootstrap-cssol-wt-seed.ts.
 *   3. delta_mint::transfer_authority(new_authority = pool_pda) — pool PDA
 *      becomes the MintConfig authority, locking in the gated-CPI path.
 *
 * Output: configs/devnet/cssol-wt.json with mint, mintConfig, mintAuthority.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/setup-cssol-wt-mint.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const DELTA_MINT_PROGRAM_ID = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
const CSSOL_WT_DECIMALS = 9;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  if (!fs.existsSync(idlPath)) throw new Error(`IDL missing: ${idlPath}. Run anchor build first.`);
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  const deltaMint = new Program(loadIdl("delta_mint"), provider);

  const poolCfgPath = path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  const poolCfg = JSON.parse(fs.readFileSync(poolCfgPath, "utf8"));
  const poolPda = new PublicKey(poolCfg.pool.poolConfig);

  const outPath = path.join(__dirname, "..", "configs", "devnet", "cssol-wt.json");
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null;

  console.log("=== csSOL-WT mint setup ===");
  console.log("RPC:        ", RPC_URL);
  console.log("Authority:  ", authority.publicKey.toBase58());
  console.log("Pool PDA:   ", poolPda.toBase58(), "(authority-target after step 3)");

  // -- Step 1: initialize_mint --
  let cssolWtMint: PublicKey;
  let dmMintConfig: PublicKey;
  let dmMintAuthority: PublicKey;

  if (existing?.mint) {
    cssolWtMint = new PublicKey(existing.mint);
    [dmMintConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), cssolWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    [dmMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), cssolWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    console.log("Step 1: csSOL-WT mint already exists — reusing", cssolWtMint.toBase58());
  } else {
    const mintKp = Keypair.generate();
    cssolWtMint = mintKp.publicKey;
    [dmMintConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), cssolWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    [dmMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), cssolWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );

    console.log("Step 1: delta_mint.initialize_mint");
    const sig = await (deltaMint.methods as any)
      .initializeMint(CSSOL_WT_DECIMALS)
      .accounts({
        authority: authority.publicKey,
        mint: cssolWtMint,
        mintConfig: dmMintConfig,
        mintAuthority: dmMintAuthority,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintKp])
      .rpc();
    console.log(`  csSOL-WT mint: ${cssolWtMint.toBase58()}`);
    console.log(`  Tx: ${sig}`);
  }

  // -- Step 2: whitelist deployer --
  const [deployerWhitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), authority.publicKey.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  );
  if (await conn.getAccountInfo(deployerWhitelistEntry)) {
    console.log("Step 2: deployer already whitelisted — skipping.");
  } else {
    console.log("Step 2: delta_mint.add_to_whitelist (deployer)");
    const sig = await (deltaMint.methods as any)
      .addToWhitelist()
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
        wallet: authority.publicKey,
        whitelistEntry: deployerWhitelistEntry,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  // -- Step 3: transfer authority pool→pool_pda --
  // Read MintConfig.authority from on-chain to decide if rotation is needed.
  // Layout: disc(8) + authority(32) → byte 8..40.
  const cfgInfo = await conn.getAccountInfo(dmMintConfig);
  if (!cfgInfo) throw new Error("MintConfig not found — step 1 must have failed");
  const currentAuth = new PublicKey(cfgInfo.data.subarray(8, 40));
  if (currentAuth.equals(poolPda)) {
    console.log("Step 3: authority already = pool PDA — skipping rotation.");
  } else if (!currentAuth.equals(authority.publicKey)) {
    throw new Error(
      `MintConfig.authority is ${currentAuth.toBase58()}, expected deployer or pool PDA. Aborting.`,
    );
  } else {
    console.log("Step 3: delta_mint.transfer_authority → pool PDA");
    const sig = await (deltaMint.methods as any)
      .transferAuthority(poolPda)
      .accounts({
        authority: authority.publicKey,
        mintConfig: dmMintConfig,
      })
      .rpc();
    console.log(`  Tx: ${sig}`);
  }

  const out = {
    cluster: "devnet",
    rpc: RPC_URL,
    mint: cssolWtMint.toBase58(),
    decimals: CSSOL_WT_DECIMALS,
    dmMintConfig: dmMintConfig.toBase58(),
    dmMintAuthority: dmMintAuthority.toBase58(),
    mintConfigAuthority: poolPda.toBase58(),
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== done ===");
  console.log(`csSOL-WT mint:      ${cssolWtMint.toBase58()}`);
  console.log(`MintConfig PDA:     ${dmMintConfig.toBase58()}`);
  console.log(`MintAuthority PDA:  ${dmMintAuthority.toBase58()}`);
  console.log(`Saved → ${path.relative(process.cwd(), outPath)}`);
  console.log("\nNext: run scripts/init-withdraw-queue.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
