/**
 * poc-jito-vault-discover.ts — Devnet reconnaissance for Jito Vault.
 *
 * Uses @jito-foundation/vault-sdk to:
 *   1. Verify the Vault Config singleton exists and decode its state.
 *   2. Enumerate every Vault account and decode `(supportedMint, vrtMint,
 *      tokensDeposited, depositCapacity, isPaused)`.
 *   3. Highlight any Vault whose supportedMint matches a token we hold
 *      (wSOL by default; pass MINT=<pubkey> to override).
 *
 * Intended as the prereq for a deposit POC: if a compatible vault exists,
 * we can deposit into it directly. If not, the next script has to call
 * InitializeVault first to mint our own wSOL-supporting vault.
 *
 * Usage:
 *   npx tsx scripts/poc-jito-vault-discover.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  JITO_VAULT_PROGRAM_ADDRESS,
  getConfigDecoder,
} from "@jito-foundation/vault-sdk";

// NOTE: vault-sdk 1.0.0's `getVaultDecoder` is out of sync with the current
// devnet program (the on-chain Vault struct has additional fields the SDK
// doesn't know about, so the kit decoder errors with "Codec [u8] cannot
// decode empty byte arrays"). We fall back to raw byte decoding for the
// fields we actually care about. The Config decoder still works.
function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}
function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const TARGET_MINT = new PublicKey(process.env.MINT || "So11111111111111111111111111111111111111112"); // wSOL

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const programId = new PublicKey(JITO_VAULT_PROGRAM_ADDRESS.toString());

  console.log("=== Jito Vault devnet reconnaissance ===");
  console.log("RPC:        ", RPC);
  console.log("Vault prog: ", programId.toBase58());
  console.log("Target mint:", TARGET_MINT.toBase58(), "(filter for matching vaults)");

  // --- Config singleton --------------------------------------------------
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const configInfo = await conn.getAccountInfo(configPda);
  if (!configInfo) throw new Error(`Config PDA ${configPda.toBase58()} not found — Jito Vault not initialized on this cluster.`);
  const cfg = getConfigDecoder().decode(configInfo.data);
  console.log("\nConfig PDA:        ", configPda.toBase58());
  console.log("  admin:           ", cfg.admin.toString());
  console.log("  restakingProgram:", cfg.restakingProgram.toString());
  console.log("  numVaults:       ", cfg.numVaults.toString());
  console.log("  epochLength:     ", cfg.epochLength.toString(), "slots");
  console.log("  programFeeWallet:", cfg.programFeeWallet.toString());

  // --- Enumerate Vaults ---------------------------------------------------
  // Vault account discriminator on-chain is u64 LE = 2 (NOT 1 as
  // @jito-foundation/vault-sdk@1.0.0's `JitoVaultAccount` enum suggests
  // — Config=1, Vault=2 on the deployed program). base58 of 8-byte LE 2.
  const accounts = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: "LQM2cdzDY3" } }],
  });
  console.log(`\nFound ${accounts.length} Vault account(s) (raw-decoded — SDK decoder is out of sync):`);
  // Raw layout per vault-sdk's source struct:
  //   [0..8]   discriminator (u64=1)
  //   [8..40]  base
  //   [40..72] vrtMint
  //   [72..104] supportedMint
  //   [104..112] vrtSupply
  //   [112..120] tokensDeposited
  //   [120..128] depositCapacity
  let compatible = 0;
  for (const { pubkey, account } of accounts) {
    const data = account.data;
    const supported = readPubkey(data, 72);
    const isMatch = supported === TARGET_MINT.toBase58();
    if (isMatch) compatible++;
    const head = isMatch ? "★" : " ";
    console.log(
      `  ${head} ${pubkey.toBase58()}\n` +
      `      supportedMint:   ${supported}${isMatch ? "  ← matches target" : ""}\n` +
      `      vrtMint:         ${readPubkey(data, 40)}\n` +
      `      vrtSupply:       ${readU64LE(data, 104)}\n` +
      `      tokensDeposited: ${readU64LE(data, 112)}\n` +
      `      depositCapacity: ${readU64LE(data, 120)}`,
    );
  }
  console.log(`\n${compatible} vault(s) accept ${TARGET_MINT.toBase58()} as supportedMint.`);
  if (compatible === 0) {
    console.log(
      "\nNo vault on this cluster supports the target mint.\n" +
      "Next step: run a script that calls `InitializeVault` to create one\n" +
      "with `stMint = " + TARGET_MINT.toBase58() + "`. The SDK helper is\n" +
      "`getInitializeVaultInstruction` from @jito-foundation/vault-sdk; it\n" +
      "needs `base` (fresh keypair), `vrtMint` (fresh keypair), `admin`\n" +
      "(payer), 5 ATAs, and the standard Vault PDA at\n" +
      "`findProgramAddress([\"vault\", base.publicKey], program)`.",
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
