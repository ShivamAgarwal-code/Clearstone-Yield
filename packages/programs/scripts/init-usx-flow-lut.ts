/**
 * init-usx-flow-lut.ts — Address Lookup Table for the bundled
 * USDC↔ceUSX flows in the playground (CreditTradeEusxPanel).
 *
 * The bundle concatenates 4 ixes (RequestMint + ConfirmMint + Lock +
 * governor.wrap, or unwrap + Unlock + RequestRedeem + ConfirmRedeem)
 * referencing ~30 unique pubkeys. Without an ALT the v0-tx static keys
 * table overflows ~1232 bytes (web3.js: "encoding overruns Uint8Array"),
 * so we capture every static / cross-user pubkey here. Per-user pubkeys
 * (user signer, ATAs, request_mint PDA) are NOT included — they live in
 * the message's static keys section.
 *
 * Discovery strategy: probe Solstice API twice with two different user
 * pubkeys, diff the returned account lists, anything that's the same in
 * both runs is static (program / mint / shared-state PDA / sysvar) and
 * belongs in the LUT. We additionally fold in the known clearstone-side
 * static set (legacy governor, delta-mint, eUSX pool, dm_mint_config,
 * known mints, token programs, system program, etc.) so the LUT is
 * comprehensive even if the API ever omits some constant.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     SOLSTICE_API_KEY=... \
 *     npx tsx scripts/init-usx-flow-lut.ts
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

const SOLSTICE_API = "https://instructions.solstice.finance/v1/instructions";

// Known static set on the clearstone side. Mostly mirrors what the
// playground's addresses.ts has, plus the program IDs we CPI through.
const LEGACY_GOVERNOR    = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const LEGACY_DELTA_MINT  = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const USX_PROGRAM        = new PublicKey("usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD");
const YIELD_VAULT        = new PublicKey("euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr");

const USDC_MINT          = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const USX_MINT           = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const EUSX_MINT          = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const CEUSX_MINT         = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

const EUSX_POOL_PDA      = new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");
const EUSX_DM_CONFIG     = new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD");

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function callSolstice(apiKey: string, body: object): Promise<{ accounts: PublicKey[] }> {
  const resp = await fetch(SOLSTICE_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Solstice API ${resp.status}: ${await resp.text()}`);
  const result = await resp.json() as { instruction: { accounts: { pubkey: number[] }[] } };
  if (!result.instruction) throw new Error(`Unexpected response: ${JSON.stringify(result).slice(0, 250)}`);
  return {
    accounts: result.instruction.accounts.map((a) => new PublicKey(Buffer.from(a.pubkey))),
  };
}

async function probeStaticAccountsForType(
  apiKey: string,
  type: string,
  data1: object,
  data2: object,
): Promise<Set<string>> {
  const [run1, run2] = await Promise.all([
    callSolstice(apiKey, { type, data: data1 }),
    callSolstice(apiKey, { type, data: data2 }),
  ]);
  // An account is "static" iff it appears at the SAME index with the
  // SAME pubkey in both probes — so swapping the user has no effect on
  // it. Per-user accounts (user signer, ATAs, request_mint PDA) differ.
  const out = new Set<string>();
  const len = Math.min(run1.accounts.length, run2.accounts.length);
  for (let i = 0; i < len; i++) {
    if (run1.accounts[i].equals(run2.accounts[i])) {
      out.add(run1.accounts[i].toBase58());
    }
  }
  return out;
}

async function main() {
  const apiKey = process.env.SOLSTICE_API_KEY;
  if (!apiKey) throw new Error("SOLSTICE_API_KEY env var required");

  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  // Two distinct users for the static-accounts diff probe. We use the
  // payer's pubkey for one and a deterministic synthetic pubkey for the
  // other — actual whitelisting / balance state doesn't matter, the API
  // just templates the ix layout.
  const userA = payer.publicKey.toBase58();
  const userB = Keypair.generate().publicKey.toBase58();

  console.log("probing Solstice API for static accounts...");
  const probes: Promise<Set<string>>[] = [
    probeStaticAccountsForType(apiKey, "RequestMint", { amount: 1_000_000, collateral: "usdc", user: userA },
                                                     { amount: 1_000_000, collateral: "usdc", user: userB }),
    probeStaticAccountsForType(apiKey, "ConfirmMint", { user: userA, collateral: "usdc" },
                                                     { user: userB, collateral: "usdc" }),
    probeStaticAccountsForType(apiKey, "Lock",        { amount: 1_000_000, user: userA },
                                                     { amount: 1_000_000, user: userB }),
    probeStaticAccountsForType(apiKey, "Unlock",      { amount: 1_000_000, user: userA },
                                                     { amount: 1_000_000, user: userB }),
    probeStaticAccountsForType(apiKey, "RequestRedeem", { amount: 1_000_000, collateral: "usdc", user: userA },
                                                       { amount: 1_000_000, collateral: "usdc", user: userB }),
    probeStaticAccountsForType(apiKey, "ConfirmRedeem", { user: userA, collateral: "usdc" },
                                                       { user: userB, collateral: "usdc" }),
  ];
  const sets = await Promise.all(probes);
  const apiStatic = new Set<string>();
  for (const s of sets) for (const k of s) apiStatic.add(k);

  console.log(`api-discovered static set: ${apiStatic.size} accounts`);

  // Fold in known clearstone-side static accounts so the LUT is robust
  // even if Solstice ever omits a constant from the response.
  const knownStatic: PublicKey[] = [
    LEGACY_GOVERNOR, LEGACY_DELTA_MINT, USX_PROGRAM, YIELD_VAULT,
    USDC_MINT, USX_MINT, EUSX_MINT, CEUSX_MINT, NATIVE_MINT,
    EUSX_POOL_PDA, EUSX_DM_CONFIG,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY,
    ComputeBudgetProgram.programId,
  ];
  for (const k of knownStatic) apiStatic.add(k.toBase58());

  // Also derive the legacy delta-mint authority for ceUSX. The wrap ix
  // includes it in its accounts list — discovered via probe above for
  // governor.wrap shape mirrors PreparePage.
  const [dmAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), CEUSX_MINT.toBuffer()],
    LEGACY_DELTA_MINT,
  );
  apiStatic.add(dmAuthority.toBase58());

  // Convert to PublicKey array, deduped.
  const addresses: PublicKey[] = Array.from(apiStatic).map((s) => new PublicKey(s));
  console.log(`final static set: ${addresses.length} accounts`);
  for (const a of addresses) console.log(`  ${a.toBase58()}`);

  console.log(`\npayer: ${payer.publicKey.toBase58()}`);

  const slot = await conn.getSlot("finalized");
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  console.log(`LUT: ${lutAddress.toBase58()} (recentSlot=${slot})`);

  await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [payer], { commitment: "confirmed" });
  console.log(`created`);

  // Extend in chunks of ~25 to stay under the per-tx limit.
  const CHUNK = 25;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey, authority: payer.publicKey,
      lookupTable: lutAddress, addresses: chunk,
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(extendIx), [payer], { commitment: "confirmed" });
    console.log(`extend (+${chunk.length}): ${sig.slice(0, 16)}…`);
  }

  const finishSlot = await conn.getSlot("confirmed");
  console.log(`extended at slot ${finishSlot} — resolvable at slot ${finishSlot + 1}`);

  const out = {
    cluster: "devnet",
    usxFlowLut: lutAddress.toBase58(),
    addrCount: addresses.length,
    addresses: addresses.map((a) => a.toBase58()),
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", "configs/devnet/usx-flow-lut.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`saved → ${outPath}`);
  console.log(`\nNext: set in packages/frontend-playground/.env.local:`);
  console.log(`  VITE_USX_FLOW_LUT=${lutAddress.toBase58()}`);
  console.log(`Then restart pnpm dev.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
