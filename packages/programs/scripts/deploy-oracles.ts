/**
 * deploy-oracles.ts — Deploy FixedPriceOracle feeds for devnet.
 *
 * Creates:
 *   1. PDA feeds (for our own use, updatable)
 *   2. Pyth V2-format accounts owned by our program (for klend)
 *
 * Usage: npx tsx scripts/deploy-oracles.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction,
  SystemProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");
const CONFIG_DIR = path.join(__dirname, "..", "configs", "devnet");

const FEEDS = [
  { label: "USDC/USD", price: 100000000, expo: -8 },   // $1.00
  { label: "USDY/USD", price: 105000000, expo: -8 },   // $1.05
  { label: "cUSDY/USD", price: 105000000, expo: -8 },  // $1.05
];

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR
    || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "mock_oracle.json"), "utf8"));
  const program = new Program(idl, provider);

  console.log("============================================");
  console.log("  FixedPriceOracle — Deploy Feeds");
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log("============================================\n");

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const result: Record<string, any> = { program: MOCK_ORACLE.toBase58(), feeds: {} };

  for (const feed of FEEDS) {
    const tag = feed.label.replace("/", "_");
    console.log(`--- ${feed.label} ($${(feed.price / 10 ** Math.abs(feed.expo)).toFixed(2)}) ---`);

    // 1. PDA feed
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("feed"), Buffer.from(feed.label)], MOCK_ORACLE
    );
    const pdaInfo = await conn.getAccountInfo(pda);
    if (pdaInfo) {
      console.log(`  PDA: ${pda.toBase58()} (exists)`);
      await (program.methods as any).setPrice(new BN(feed.price))
        .accounts({ authority: authority.publicKey, priceFeed: pda }).rpc();
      console.log(`  Price updated.`);
    } else {
      await (program.methods as any).createFeed(feed.label, new BN(feed.price), feed.expo)
        .accounts({ authority: authority.publicKey, priceFeed: pda, systemProgram: SystemProgram.programId }).rpc();
      console.log(`  PDA created: ${pda.toBase58()}`);
    }

    // 2. Pyth V2-format raw account (owned by our program)
    const kpFile = path.join(CONFIG_DIR, `pyth-${tag}-keypair.json`);
    let rawAddr: PublicKey;

    if (fs.existsSync(kpFile)) {
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpFile, "utf8"))));
      rawAddr = kp.publicKey;
      const info = await conn.getAccountInfo(rawAddr);
      if (info && info.owner.equals(MOCK_ORACLE)) {
        // Update price
        await (program.methods as any).writePythV2(new BN(feed.price), feed.expo)
          .accounts({ authority: authority.publicKey, rawFeed: rawAddr }).rpc();
        console.log(`  Pyth V2: ${rawAddr.toBase58()} (updated)`);
      } else {
        console.log(`  Pyth V2: ${rawAddr.toBase58()} (stale/wrong owner, recreating)`);
        fs.unlinkSync(kpFile);
        // fall through to create
        rawAddr = await createPythAccount(conn, authority, program, feed, kpFile);
      }
    } else {
      rawAddr = await createPythAccount(conn, authority, program, feed, kpFile);
    }

    result.feeds[feed.label] = {
      pda: pda.toBase58(),
      pythV2: rawAddr.toBase58(),
      price: feed.price,
      expo: feed.expo,
    };
    console.log("");
  }

  const outPath = path.join(CONFIG_DIR, "oracles-deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Saved: ${outPath}`);
  console.log(JSON.stringify(result, null, 2));
}

async function createPythAccount(
  conn: Connection, authority: Keypair, program: Program,
  feed: { label: string; price: number; expo: number },
  kpFile: string,
): Promise<PublicKey> {
  const kp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(3312);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: kp.publicKey,
      lamports: rent,
      space: 3312,
      programId: MOCK_ORACLE,
    })
  );
  await sendAndConfirmTransaction(conn, tx, [authority, kp]);

  await (program.methods as any).writePythV2(new BN(feed.price), feed.expo)
    .accounts({ authority: authority.publicKey, rawFeed: kp.publicKey }).rpc();

  console.log(`  Pyth V2: ${kp.publicKey.toBase58()} (created)`);
  fs.writeFileSync(kpFile, JSON.stringify(Array.from(kp.secretKey)));
  return kp.publicKey;
}

main().catch(console.error);
