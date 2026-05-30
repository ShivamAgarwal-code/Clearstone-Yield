/**
 * deploy-governor-devnet.ts
 *
 * Initializes a governor pool on Solana devnet using the Anchor IDL.
 * Programs must already be deployed (run `pnpm deploy:devnet` first).
 *
 * Usage:
 *   npx tsx scripts/deploy-governor-devnet.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GOVERNOR_PROGRAM_ID = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT_PROGRAM_ID = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

// Devnet mints
const USDY_MINT = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");
const DEVNET_USDC_MINT = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const DEVNET_USDT_MINT = new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft");
const DEVNET_USX_MINT = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const DEVNET_EUSX_MINT = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");

// Devnet programs
const DEVNET_USX_PROGRAM = new PublicKey("usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD");
const DEVNET_YIELD_VAULT_PROGRAM = new PublicKey("euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr");

// Pyth V2 devnet oracle feeds
const PYTH_USDY_DEVNET = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  if (process.env.ADMIN_KEYPAIR_JSON) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ADMIN_KEYPAIR_JSON)));
  }
  const defaultPath = path.join(process.env.HOME || "~", ".config/solana/id.json");
  if (fs.existsSync(defaultPath)) {
    const raw = fs.readFileSync(defaultPath, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  throw new Error("No keypair found. Set DEPLOY_KEYPAIR, ADMIN_KEYPAIR_JSON, or have ~/.config/solana/id.json");
}

function loadIdl(name: string) {
  const idlPath = path.join(__dirname, "..", "target", "idl", `${name}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf8"));
}

function loadOracleConfig(): { usdyOracle: string; usdcOracle: string } | null {
  const configPath = path.join(__dirname, "..", "configs", "devnet", "oracles-deployed.json");
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    usdyOracle: raw.devnetOracles?.["USDY/USD"]?.address,
    usdcOracle: raw.devnetOracles?.["USDC/USD"]?.address,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const wallet = new Wallet(authority);
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

  // Load IDL and create program instance
  const governorIdl = loadIdl("governor");
  const governorProgram = new Program(governorIdl, provider);

  let wrappedMintKp = Keypair.generate();

  // Load oracle config from previous step
  const oracleConfig = loadOracleConfig();

  console.log("============================================");
  console.log("  Governor Devnet Deployment");
  console.log("============================================");
  console.log(`  RPC:            ${RPC_URL}`);
  console.log(`  Authority:      ${authority.publicKey.toBase58()}`);
  console.log(`  Underlying:     ${USDY_MINT.toBase58()} (USDY)`);
  console.log(`  Oracle (USDY):  ${PYTH_USDY_DEVNET.toBase58()}`);
  if (oracleConfig) {
    console.log(`  Oracle (USDC):  ${oracleConfig.usdcOracle} (mock)`);
  }
  console.log("============================================\n");

  // Check balance
  const balance = await conn.getBalance(authority.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.5 * 1e9) {
    console.log("Requesting airdrop...");
    try {
      const sig = await conn.requestAirdrop(authority.publicKey, 2 * 1e9);
      await conn.confirmTransaction(sig, "confirmed");
      console.log("Airdrop received.");
    } catch {
      console.log("Airdrop failed (rate limited). Fund wallet manually.");
    }
  }

  // Check programs are deployed
  const govInfo = await conn.getAccountInfo(GOVERNOR_PROGRAM_ID);
  const dmInfo = await conn.getAccountInfo(DELTA_MINT_PROGRAM_ID);

  if (!govInfo?.executable) {
    console.error("ERROR: Governor program not deployed. Run: pnpm deploy:devnet");
    process.exit(1);
  }
  if (!dmInfo?.executable) {
    console.error("ERROR: Delta-mint program not deployed. Run: pnpm deploy:devnet");
    process.exit(1);
  }
  console.log("All programs verified on devnet.\n");

  // ---------------------------------------------------------------------------
  // Step 1: Initialize Governor Pool via Anchor
  // ---------------------------------------------------------------------------
  console.log("Step 1: Initializing governor pool...");

  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), USDY_MINT.toBuffer()],
    GOVERNOR_PROGRAM_ID
  );

  // Use USDC oracle from config, or placeholder
  const usdcOracle = oracleConfig
    ? new PublicKey(oracleConfig.usdcOracle)
    : PublicKey.default;

  // Check if pool already exists — if so, read wrapped_mint from on-chain
  let wrappedMintPubkey: PublicKey;
  const poolExists = await conn.getAccountInfo(poolConfig);
  if (poolExists) {
    // PoolConfig layout: disc(8) + authority(32) + underlying_mint(32) + underlying_oracle(32)
    //   + borrow_mint(32) + borrow_oracle(32) + wrapped_mint(32) at offset 168
    const data = poolExists.data;
    wrappedMintPubkey = new PublicKey(data.subarray(8 + 32 + 32 + 32 + 32 + 32, 8 + 32 + 32 + 32 + 32 + 32 + 32));
    console.log(`  Pool already exists: ${poolConfig.toBase58()}`);
    console.log(`  Existing wrapped mint: ${wrappedMintPubkey.toBase58()}`);
    console.log("  Skipping pool initialization.\n");
  } else {
    wrappedMintPubkey = wrappedMintKp.publicKey;
    console.log(`  New wrapped mint: ${wrappedMintPubkey.toBase58()}`);

    const initDmMintConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), wrappedMintKp.publicKey.toBuffer()], DELTA_MINT_PROGRAM_ID
    )[0];
    const initDmMintAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), wrappedMintKp.publicKey.toBuffer()], DELTA_MINT_PROGRAM_ID
    )[0];

    try {
      const sig = await (governorProgram.methods as any)
        .initializePool({
          underlyingOracle: PYTH_USDY_DEVNET,
          borrowMint: DEVNET_USDC_MINT,
          borrowOracle: usdcOracle,
          decimals: 6,
          ltvPct: 75,
          liquidationThresholdPct: 82,
          elevationGroup: 1,
        })
        .accounts({
          authority: authority.publicKey,
          poolConfig,
          underlyingMint: USDY_MINT,
          wrappedMint: wrappedMintKp.publicKey,
          dmMintConfig: initDmMintConfig,
          dmMintAuthority: initDmMintAuthority,
          deltaMintProgram: DELTA_MINT_PROGRAM_ID,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([wrappedMintKp])
        .rpc();

      console.log(`  Pool created: ${poolConfig.toBase58()}`);
      console.log(`  cUSDY mint:   ${wrappedMintPubkey.toBase58()}`);
      console.log(`  Tx: ${sig}\n`);
    } catch (e: any) {
      console.error("  Pool creation failed:", e.message);
      if (e.logs) {
        console.error("  Logs:", e.logs.join("\n    "));
      }
      console.error("  This may indicate a program version mismatch or missing accounts.\n");
    }
  }

  // Derive PDAs from the actual wrapped mint (existing or new)
  const [dmMintConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), wrappedMintPubkey.toBuffer()], DELTA_MINT_PROGRAM_ID
  );
  const [dmMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), wrappedMintPubkey.toBuffer()], DELTA_MINT_PROGRAM_ID
  );

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  const output = {
    cluster: "devnet",
    rpc: RPC_URL,
    authority: authority.publicKey.toBase58(),
    programs: {
      governor: GOVERNOR_PROGRAM_ID.toBase58(),
      deltaMint: DELTA_MINT_PROGRAM_ID.toBase58(),
      usxProgram: DEVNET_USX_PROGRAM.toBase58(),
      yieldVault: DEVNET_YIELD_VAULT_PROGRAM.toBase58(),
    },
    pool: {
      poolConfig: poolConfig.toBase58(),
      underlyingMint: USDY_MINT.toBase58(),
      wrappedMint: wrappedMintPubkey.toBase58(),
      borrowMint: DEVNET_USDC_MINT.toBase58(),
      dmMintConfig: dmMintConfig.toBase58(),
      dmMintAuthority: dmMintAuthority.toBase58(),
    },
    devnetMints: {
      USDC: DEVNET_USDC_MINT.toBase58(),
      USDT: DEVNET_USDT_MINT.toBase58(),
      USX: DEVNET_USX_MINT.toBase58(),
      eUSX: DEVNET_EUSX_MINT.toBase58(),
      USDY: USDY_MINT.toBase58(),
    },
    oracles: {
      usdyPythV2: PYTH_USDY_DEVNET.toBase58(),
      usdcPythV2: oracleConfig?.usdcOracle ?? "MOCK — run setup-devnet-oracles.ts",
    },
    _nextSteps: [
      "1. Create klend market + reserves (setup-devnet-market.ts)",
      "2. Register lending market with governor (register_lending_market)",
      "3. Add participants and start minting",
    ],
  };

  const outDir = path.join(__dirname, "..", "configs", "devnet");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("============================================");
  console.log("  Deployment output saved to:");
  console.log(`  ${outPath}`);
  console.log("============================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
