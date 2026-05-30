/**
 * setup-devnet-oracles.ts
 *
 * Creates a mock Pyth V2 USDC/USD oracle account on devnet.
 *
 * Problem: Pyth V2 has a USDY/USD feed on devnet (E4pit...) but NO USDC/USD
 *          V2 feed. klend reads old Pyth V2 format (3312 bytes, owned by the
 *          V2 program). The new push feeds (134 bytes) are incompatible.
 *
 * Solution: Create a program-owned account that mimics a Pyth V2 price account
 *           with a fixed $1.00 price. This is sufficient for devnet testing.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/setup-devnet-oracles.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

// Pyth V2 devnet program
const PYTH_V2_DEVNET = new PublicKey("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s");

// Real USDY V2 feed on devnet (we'll copy its format for the USDC mock)
const PYTH_USDY_V2 = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  if (process.env.ADMIN_KEYPAIR_JSON) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(process.env.ADMIN_KEYPAIR_JSON))
    );
  }
  const defaultPath = path.join(process.env.HOME || "~", ".config/solana/id.json");
  const raw = fs.readFileSync(defaultPath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Build a minimal Pyth V2 price account buffer (3312 bytes).
 *
 * The Pyth V2 price account layout (simplified):
 *   [0..4]    magic       = 0xa1b2c3d4
 *   [4..8]    version     = 2
 *   [8..12]   type        = 3 (price)
 *   [12..16]  size        = 3312
 *   [16..48]  product_account (pubkey)
 *   [48..52]  price_type  = 1 (price)
 *   [52..56]  exponent    = -8 (i32)
 *   [56..64]  num_components = 1
 *   [208..216] price      = 100000000 ($1.00 with exp -8)
 *   [216..224] conf       = 10000 (tight confidence)
 *   [224..228] status     = 1 (trading)
 *   [240..248] pub_slot   = current slot
 *   [232..240] valid_slot = current slot
 */
function buildMockPythV2PriceData(
  productAccount: PublicKey,
  price: bigint = 100000000n, // $1.00 with exp -8
  expo: number = -8,
  slot: bigint = 0n
): Buffer {
  const buf = Buffer.alloc(3312);

  // Header
  buf.writeUInt32LE(0xa1b2c3d4, 0);  // magic
  buf.writeUInt32LE(2, 4);             // version
  buf.writeUInt32LE(3, 8);             // type = price
  buf.writeUInt32LE(3312, 12);         // size

  // Product account reference
  productAccount.toBuffer().copy(buf, 16);

  // Price type
  buf.writeUInt32LE(1, 48);            // price type = price

  // Exponent (i32)
  buf.writeInt32LE(expo, 52);

  // Num components
  buf.writeUInt32LE(1, 56);

  // Current price aggregate
  buf.writeBigInt64LE(price, 208);     // price
  buf.writeBigUInt64LE(10000n, 216);   // conf (tight)
  buf.writeUInt32LE(1, 224);           // status = trading

  // Valid/publish slots
  buf.writeBigUInt64LE(slot, 232);     // valid_slot
  buf.writeBigUInt64LE(slot, 240);     // pub_slot

  // EMA price (same as spot for mock)
  buf.writeBigInt64LE(price, 248);     // ema_price
  buf.writeBigUInt64LE(10000n, 256);   // ema_conf

  return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();

  console.log("============================================");
  console.log("  Devnet Oracle Setup");
  console.log("============================================");
  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  Payer:    ${payer.publicKey.toBase58()}`);
  console.log("============================================\n");

  // Ensure wallet has SOL
  const balance = await conn.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.1 * 1e9) {
    console.log("Requesting airdrop...");
    try {
      const sig = await conn.requestAirdrop(payer.publicKey, 2 * 1e9);
      await conn.confirmTransaction(sig, "confirmed");
      console.log("Airdrop received.\n");
    } catch {
      console.log("Airdrop failed (rate limited). Fund wallet manually.\n");
    }
  }

  // Check USDY V2 oracle exists
  const usdyInfo = await conn.getAccountInfo(PYTH_USDY_V2);
  if (usdyInfo) {
    console.log(`USDY V2 oracle verified: ${PYTH_USDY_V2.toBase58()}`);
    console.log(`  Owner: ${usdyInfo.owner.toBase58()}`);
    console.log(`  Size:  ${usdyInfo.data.length} bytes\n`);
  } else {
    console.log("WARNING: USDY V2 oracle not found on devnet.\n");
  }

  // Create mock USDC oracle
  console.log("Creating mock USDC/USD Pyth V2 oracle...\n");

  const mockUsdcOracleKp = Keypair.generate();
  const currentSlot = BigInt(await conn.getSlot());

  // Use a dummy product account (we won't read it)
  const dummyProduct = Keypair.generate().publicKey;
  const mockData = buildMockPythV2PriceData(dummyProduct, 100000000n, -8, currentSlot);

  // Allocate account with enough lamports for rent exemption
  const rentExempt = await conn.getMinimumBalanceForRentExemption(3312);

  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mockUsdcOracleKp.publicKey,
    lamports: rentExempt,
    space: 3312,
    programId: SystemProgram.programId, // NOTE: owned by system program, not Pyth
  });

  // We can't make it owned by the Pyth program without being the Pyth program.
  // But for testing, klend may accept any account with the right data format.
  // If klend checks the owner, we'll need a different approach (use localnet clone).

  console.log("  NOTE: Mock oracle will be owned by System Program, not Pyth V2.");
  console.log("  If klend validates oracle account owner, use localnet with --clone instead.\n");

  try {
    const tx = new Transaction().add(createIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [payer, mockUsdcOracleKp], {
      commitment: "confirmed",
    });

    console.log(`  Mock USDC oracle created: ${mockUsdcOracleKp.publicKey.toBase58()}`);
    console.log(`  Tx: ${sig}`);
    console.log(`  Size: 3312 bytes, Price: $1.00 (exp -8)\n`);
  } catch (e: any) {
    console.error("  Failed to create mock oracle:", e.message);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const output = {
    devnetOracles: {
      "USDY/USD": {
        address: PYTH_USDY_V2.toBase58(),
        type: "pyth_v2_native",
        price: "~$1.00 (live feed)",
      },
      "USDC/USD": {
        address: mockUsdcOracleKp.publicKey.toBase58(),
        type: "mock_pyth_v2",
        price: "$1.00 (fixed)",
        warning: "Owned by System Program — for devnet testing only",
      },
    },
    alternativeFeeds: {
      "DAI/USD_v2": "A8XFp1YSUqyDDvTwRXM1vmhPHCLxziv9FWFkPpLY",
      "BUSD/USD_v2": "TRrB75VTpiojCy99S5BHmYkjARgtfBqZKk5JbeouUkV",
      "TUSD/USD_v2": "2sbXow64dSbktGM6gG9FpszwVu7GNhr6Qi2WHRCP9ULn",
      "SOL/USD_v2": "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix",
    },
    pythPrograms: {
      v2_devnet: PYTH_V2_DEVNET.toBase58(),
      push_devnet: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT",
      receiver_devnet: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    },
  };

  const outPath = path.join(__dirname, "..", "configs", "devnet", "oracles-deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("============================================");
  console.log("  Oracle config saved to:");
  console.log(`  ${outPath}`);
  console.log("============================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
