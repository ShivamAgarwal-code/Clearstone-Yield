/**
 * rename-wrapper-token.ts — Update the on-chain name/symbol of an
 * already-deployed delta-mint wrapper.
 *
 * Two layers updated per call:
 *
 * 1. **Token-2022 metadata extension**. The mint has a metadata-pointer
 *    extension and either an embedded TokenMetadata extension or an
 *    external metadata account. We use SPL token-metadata-interface's
 *    `UpdateField` ix (discriminator
 *    `sha256("spl_token_metadata_interface:updating_field")[..8]`) to
 *    set `name` and `symbol`. Signed by the metadata `update_authority`.
 *
 * 2. **klend reserve.config.tokenInfo.name**. The 32-byte symbol the
 *    Lending tab and klend SDK display. Updated via
 *    `update_reserve_config` mode 16 (`UpdateTokenInfoName`). Signed
 *    by the lending-market owner.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/rename-wrapper-token.ts \
 *       --mint <wrapper_mint_pubkey> \
 *       --name "Clearstone-wrapped eUSX" \
 *       --symbol ceUSX \
 *       [--market <klend_market_pubkey>] \
 *       [--reserve <klend_reserve_pubkey>]
 *
 * If `--market` and `--reserve` are passed, both layers are updated;
 * otherwise only the Token-2022 metadata is touched.
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC = "https://api.devnet.solana.com";
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

const CFG_MODE_UPDATE_TOKEN_INFO_NAME = 16;

const updateReserveConfigDisc = crypto
  .createHash("sha256")
  .update("global:update_reserve_config")
  .digest()
  .subarray(0, 8);

// Token Metadata Interface discriminators — these are the
// hash-prefixed namespace identifiers that SPL token-metadata-interface
// uses (NOT global anchor-style). See
// https://docs.rs/spl-token-metadata-interface for the source of truth.
function tokenMetaDisc(name: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`spl_token_metadata_interface:${name}`)
    .digest()
    .subarray(0, 8);
}

function loadKp(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function parseArgs(): {
  mint: PublicKey;
  name?: string;
  symbol?: string;
  uri?: string;
  market?: PublicKey;
  reserve?: PublicKey;
} {
  const args: any = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, "");
    const v = process.argv[i + 1];
    args[k] = v;
  }
  if (!args.mint) {
    console.error("usage: rename-wrapper-token.ts --mint <pubkey> --name <str> --symbol <str> [--uri <str>] [--market <pubkey> --reserve <pubkey>]");
    process.exit(1);
  }
  return {
    mint: new PublicKey(args.mint),
    name: args.name,
    symbol: args.symbol,
    uri: args.uri,
    market: args.market ? new PublicKey(args.market) : undefined,
    reserve: args.reserve ? new PublicKey(args.reserve) : undefined,
  };
}

/** Build the SPL token-metadata-interface `UpdateField` ix. The
 *  metadata account on a Token-2022 mint with a self-pointer is the
 *  mint itself; we still pass `mint` separately because the field-
 *  level layout has the metadata-account = mint pubkey. */
function buildTokenMetadataUpdateFieldIx(
  metadata: PublicKey,
  updateAuthority: PublicKey,
  field: "Name" | "Symbol" | "Uri",
  value: string,
): TransactionInstruction {
  // Discriminator + Field enum (variants Name=0, Symbol=1, Uri=2 — but
  // the official ABI tags by name as a Vec<u8>, so we encode by name).
  // Layout: disc(8) + field_tag(u8) + field_str_if_key(...) + value(string)
  // Where Field = enum { Name, Symbol, Uri, Key(String) }
  // For named variants (Name/Symbol/Uri) the variant tag is 0/1/2 with no payload.
  const disc = tokenMetaDisc("updating_field");
  const fieldTag = field === "Name" ? 0 : field === "Symbol" ? 1 : 2;
  const valueBuf = Buffer.from(value, "utf8");
  const data = Buffer.alloc(8 + 1 + 4 + valueBuf.length);
  let o = 0;
  disc.copy(data, o); o += 8;
  data.writeUInt8(fieldTag, o); o += 1;
  data.writeUInt32LE(valueBuf.length, o); o += 4;
  valueBuf.copy(data, o);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: updateAuthority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

function buildUpdateReserveConfigIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  mode: number, value: Buffer, skipValidation = true,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 1 + 4 + value.length + 1);
  let o = 0;
  updateReserveConfigDisc.copy(data, o); o += 8;
  data.writeUInt8(mode, o); o += 1;
  data.writeUInt32LE(value.length, o); o += 4;
  value.copy(data, o); o += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, o);
  return new TransactionInstruction({
    programId: KLEND,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: GLOBAL, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
    ],
    data,
  });
}

async function main() {
  const args = parseArgs();
  const conn = new Connection(RPC, "confirmed");
  const auth = loadKp();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Wrapper token rename                         ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Authority: ${auth.publicKey.toBase58()}`);
  console.log(`  Mint:      ${args.mint.toBase58()}`);
  if (args.name)   console.log(`  New name:   ${args.name}`);
  if (args.symbol) console.log(`  New symbol: ${args.symbol}`);
  if (args.uri)    console.log(`  New URI:    ${args.uri}`);
  if (args.market && args.reserve) {
    console.log(`  Market:    ${args.market.toBase58()}`);
    console.log(`  Reserve:   ${args.reserve.toBase58()}`);
  }
  console.log("");

  // 1) Token-2022 metadata fields (only attempted if --metadata is
  //    explicitly passed; not all wrappers have a metadata extension
  //    on the mint, in which case there's nothing to rename at this
  //    layer and only klend's tokenInfo.name matters).
  if (process.env.SKIP_METADATA !== "1" && process.argv.includes("--metadata")) {
    const metaIxs: TransactionInstruction[] = [];
    if (args.name)   metaIxs.push(buildTokenMetadataUpdateFieldIx(args.mint, auth.publicKey, "Name",   args.name));
    if (args.symbol) metaIxs.push(buildTokenMetadataUpdateFieldIx(args.mint, auth.publicKey, "Symbol", args.symbol));
    if (args.uri)    metaIxs.push(buildTokenMetadataUpdateFieldIx(args.mint, auth.publicKey, "Uri",    args.uri));
    if (metaIxs.length > 0) {
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      metaIxs.forEach((ix) => tx.add(ix));
      const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
      console.log(`  ✓ Token-2022 metadata updated (sig: ${sig.slice(0, 16)}…)`);
    }
  } else {
    console.log("  (skipping Token-2022 metadata — mint has no metadata extension or --metadata flag not set)");
  }

  // 2) klend reserve's config.tokenInfo.name (only `Symbol` is encoded
  //    in klend's 32-byte field — klend doesn't have a separate "name"
  //    column. Use whatever short label is most user-facing).
  if (args.market && args.reserve && args.symbol) {
    const nameBuf = Buffer.alloc(32);
    Buffer.from(args.symbol, "utf8").copy(nameBuf);
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(buildUpdateReserveConfigIx(auth.publicKey, args.market, args.reserve, CFG_MODE_UPDATE_TOKEN_INFO_NAME, nameBuf, true));
    const sig = await sendAndConfirmTransaction(conn, tx, [auth]);
    console.log(`  ✓ klend reserve.tokenInfo.name updated (sig: ${sig.slice(0, 16)}…)`);
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
