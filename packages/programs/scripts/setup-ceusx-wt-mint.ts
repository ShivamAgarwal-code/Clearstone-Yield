/**
 * setup-ceusx-wt-mint.ts — One-shot bring-up of the ceUSX-WT (withdraw
 * ticket) Token-2022 mint + delta-mint MintConfig. ceUSX-WT represents
 * a queued eUSX→USX unlock on the Solstice YieldVault — burning 1
 * ceUSX-WT after the Solstice unlock period entitles the holder to
 * ~1 USX (and via subsequent RequestRedeem+ConfirmRedeem, ~1 USDC).
 *
 * Mirrors `setup-cssol-wt-mint.ts` exactly: a NEW MintConfig under the
 * NEW delta-mint, hosted by an EXISTING new-governor pool PDA. The
 * cSOL pool's PDA is the natural host (cSOL is the stables-side wrapper
 * already on the new governor; reusing its PDA as the ceUSX-WT
 * MintConfig authority keeps all stables-side WT logic on a single
 * authority chain). No new governor pool is created — the ceUSX-WT
 * mint is purely additive infrastructure under an existing PDA.
 *
 * Steps (idempotent):
 *   1. delta_mint::initialize_mint — create new Token-2022 ceUSX-WT
 *      mint with the same confidential-transfer extension as the other
 *      WT mints; deployer is initial MintConfig authority.
 *   2. delta_mint::add_to_whitelist — deployer needs Holder role for
 *      the seed mint in the (later) bootstrap script.
 *   3. delta_mint::transfer_authority(new_authority = CSOL_POOL_PDA)
 *      — host pool PDA becomes the MintConfig authority. The new
 *      governor's `enqueue_eusx_unlock_via_pool` and `redeem_ceusx_wt`
 *      ixes will CPI delta_mint::mint_to / burn with this PDA as
 *      signer.
 *
 * Output: configs/devnet/ceusx-wt.json with mint, mintConfig,
 * mintAuthority, hostPool.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/setup-ceusx-wt-mint.ts
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

// New delta-mint (the one used by csSOL/csSOL-WT/cSOL/cUSDC) — keeps
// ceUSX-WT on the same KYC + program-version surface as the rest of
// the new governor's wrappers, so future generic helpers can target a
// single delta-mint program.
const DELTA_MINT_PROGRAM_ID = new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");

// Host pool — the new governor pool whose PDA will own the ceUSX-WT
// MintConfig. cSOL pool is the natural host: cSOL is the stables-side
// wrapper already on the new governor, and the eventual leveraged
// unwind ixes will live next to its other stables flows.
const CSOL_POOL_PDA = new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ");

const CEUSX_WT_DECIMALS = 6; // matches USX / eUSX / ceUSX

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

  const outPath = path.join(__dirname, "..", "configs", "devnet", "ceusx-wt.json");
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null;

  console.log("=== ceUSX-WT mint setup ===");
  console.log("RPC:        ", RPC_URL);
  console.log("Authority:  ", authority.publicKey.toBase58());
  console.log("Host pool:  ", CSOL_POOL_PDA.toBase58(), "(authority-target after step 3)");
  console.log("Delta-mint: ", DELTA_MINT_PROGRAM_ID.toBase58());

  // -- Step 1: initialize_mint --
  let ceusxWtMint: PublicKey;
  let dmMintConfig: PublicKey;
  let dmMintAuthority: PublicKey;

  if (existing?.mint) {
    ceusxWtMint = new PublicKey(existing.mint);
    [dmMintConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), ceusxWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    [dmMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), ceusxWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    console.log("Step 1: ceUSX-WT mint already exists — reusing", ceusxWtMint.toBase58());
  } else {
    const mintKp = Keypair.generate();
    ceusxWtMint = mintKp.publicKey;
    [dmMintConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), ceusxWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );
    [dmMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), ceusxWtMint.toBuffer()], DELTA_MINT_PROGRAM_ID,
    );

    console.log("Step 1: delta_mint.initialize_mint");
    const sig = await (deltaMint.methods as any)
      .initializeMint(CEUSX_WT_DECIMALS)
      .accounts({
        authority: authority.publicKey,
        mint: ceusxWtMint,
        mintConfig: dmMintConfig,
        mintAuthority: dmMintAuthority,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintKp])
      .rpc();
    console.log(`  ceUSX-WT mint: ${ceusxWtMint.toBase58()}`);
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

  // -- Step 3: transfer authority deployer → cSOL pool PDA --
  const cfgInfo = await conn.getAccountInfo(dmMintConfig);
  if (!cfgInfo) throw new Error("MintConfig not found — step 1 must have failed");
  const currentAuth = new PublicKey(cfgInfo.data.subarray(8, 40));
  if (currentAuth.equals(CSOL_POOL_PDA)) {
    console.log("Step 3: authority already = host pool PDA — skipping rotation.");
  } else if (!currentAuth.equals(authority.publicKey)) {
    throw new Error(
      `MintConfig.authority is ${currentAuth.toBase58()}, expected deployer or host pool PDA. Aborting.`,
    );
  } else {
    console.log("Step 3: delta_mint.transfer_authority → cSOL pool PDA");
    const sig = await (deltaMint.methods as any)
      .transferAuthority(CSOL_POOL_PDA)
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
    mint: ceusxWtMint.toBase58(),
    decimals: CEUSX_WT_DECIMALS,
    dmMintConfig: dmMintConfig.toBase58(),
    dmMintAuthority: dmMintAuthority.toBase58(),
    mintConfigAuthority: CSOL_POOL_PDA.toBase58(),
    deltaMintProgram: DELTA_MINT_PROGRAM_ID.toBase58(),
    hostPool: CSOL_POOL_PDA.toBase58(),
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log("\n=== done ===");
  console.log(`ceUSX-WT mint:      ${ceusxWtMint.toBase58()}`);
  console.log(`MintConfig PDA:     ${dmMintConfig.toBase58()}`);
  console.log(`MintAuthority PDA:  ${dmMintAuthority.toBase58()}`);
  console.log(`Saved → ${path.relative(process.cwd(), outPath)}`);
  console.log("\nNext:");
  console.log("  1. scripts/setup-ceusx-wt-reserve.ts (klend reserve in v3 market, EG-1)");
  console.log("  2. governor program upgrade adding `enqueue_eusx_unlock_via_pool`");
  console.log("     and `redeem_ceusx_wt` (mirror enqueue_withdraw_via_pool +");
  console.log("     redeem_cssol_wt; CPI Solstice Unlock/Withdraw/Redeem in place");
  console.log("     of jito_vault.enqueue_withdrawal/burn_withdrawal_ticket).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
