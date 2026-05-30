/**
 * extend-lut-cssol-wt.ts — Extends the existing deposit LUT with the
 * csSOL-WT addresses needed for the leveraged-unwind flash-loan path
 * (flashBorrow → deposit_collateral → withdraw_collateral → enqueue →
 * flashRepay) so that single-tx fits under Solana's 1232-byte limit.
 *
 * Idempotent: skips entries that are already in the LUT.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/extend-lut-cssol-wt.ts
 */
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://devnet.helius-rpc.com/?api-key=b4b7a200-6ff5-41ec-80ef-d7e7163d06ec";

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const cfgs = path.join(__dirname, "..", "configs", "devnet");
  const poolCfg = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-pool.json"), "utf8"));
  const wtCfg = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-wt.json"), "utf8"));
  const wtDeploy = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-wt-deployed.json"), "utf8"));
  const v3 = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-market-v3.json"), "utf8"));

  const lut = new PublicKey(poolCfg.depositLut);

  // The deposit LUT was originally built for the v1 csSOL market
  // (`2gRy7f…heyejW`). The leveraged-unwind tab now targets the v3 market
  // (`EVw8B9…iz2E`), so every reserve / market / sub-PDA used by the
  // unwind ix chain has to be added — otherwise the v0 message blows
  // past 1232 bytes ("encoding overruns Uint8Array").
  const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const reservePda = (seed: string, reserve: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), reserve.toBuffer()], KLEND)[0];

  const v3Market = new PublicKey(v3.market);
  const v3Lma = PublicKey.findProgramAddressSync([Buffer.from("lma"), v3Market.toBuffer()], KLEND)[0];
  const v3CssolReserve = new PublicKey(v3.reserves.csSOL);
  const v3WsolReserve = new PublicKey(v3.reserves.wSOL);
  const v3WsolOracle = new PublicKey(v3.oracles.wSOL);

  // Static-only — per-user addresses (ATAs, obligation, userMetadata) stay
  // out of the LUT since they vary by caller.
  const newAddresses: PublicKey[] = [
    // v3 market + reserves
    v3Market,
    v3Lma,
    v3CssolReserve,
    reservePda("reserve_liq_supply", v3CssolReserve),
    reservePda("reserve_coll_mint", v3CssolReserve),
    reservePda("reserve_coll_supply", v3CssolReserve),
    v3WsolReserve,
    reservePda("reserve_liq_supply", v3WsolReserve),
    reservePda("reserve_coll_mint", v3WsolReserve),
    reservePda("reserve_coll_supply", v3WsolReserve),
    reservePda("fee_receiver", v3WsolReserve),
    reservePda("fee_receiver", v3CssolReserve),
    v3WsolOracle,
    // csSOL-WT (v3) reserve + governor mint/auth
    new PublicKey(wtDeploy.cssolWtReserve),
    new PublicKey(wtDeploy.cssolWtCollMint),
    new PublicKey(wtDeploy.cssolWtCollSupply),
    new PublicKey(wtDeploy.cssolWtLiqSupply),
    new PublicKey(wtCfg.mint),
    new PublicKey(wtCfg.dmMintConfig),
    new PublicKey(wtCfg.dmMintAuthority),
    new PublicKey(poolCfg.poolPendingWsolAccount),
  ];

  const lutAccount = await conn.getAddressLookupTable(lut, { commitment: "confirmed" });
  if (!lutAccount.value) throw new Error(`LUT not found: ${lut.toBase58()}`);

  const existing = new Set(lutAccount.value.state.addresses.map((a) => a.toBase58()));
  const toAdd = newAddresses.filter((a) => !existing.has(a.toBase58()));

  console.log("LUT:           ", lut.toBase58());
  console.log("existing size: ", lutAccount.value.state.addresses.length);
  console.log("to add:        ", toAdd.length, "/", newAddresses.length);
  for (const a of toAdd) console.log("  +", a.toBase58());

  if (toAdd.length === 0) {
    console.log("\nNothing to add — LUT already has all csSOL-WT entries.");
    return;
  }

  const ix = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lut,
    addresses: toAdd,
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log("\ntx:", sig);

  const finishSlot = await conn.getSlot("confirmed");
  console.log(`extended at slot ${finishSlot}; resolvable from slot ${finishSlot + 1}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
