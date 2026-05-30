/**
 * crank-vault-update.ts — Initialize + Close the per-epoch
 * VaultUpdateStateTracker for our Jito csSOL vault.
 *
 * Jito vaults must be "updated" each epoch before EnqueueWithdrawal /
 * BurnWithdrawalTicket will accept new operations. The flow is:
 *   1. InitializeVaultUpdateStateTracker(vault, ncn_epoch) — creates a
 *      tracker PDA scoped to the current epoch.
 *   2. (Optional) CrankVaultUpdateStateTracker for each operator the
 *      vault has delegated to. Our test vault has no operators → skip.
 *   3. CloseVaultUpdateStateTracker(vault, ncn_epoch) — closes the
 *      tracker, marking the vault updated for the epoch.
 *
 * Devnet epochs are ~75 s, so this needs to run periodically (the
 * keeper-cloud cron should be extended to do this every 5 min, but for
 * now run manually before each enqueue test).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
 *     npx tsx scripts/crank-vault-update.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.SOLANA_RPC_URL || "https://devnet.helius-rpc.com/?api-key=b4b7a200-6ff5-41ec-80ef-d7e7163d06ec";

const JITO_VAULT_PROGRAM = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");
const JITO_INIT_VUST_DISC = 26;
const JITO_CLOSE_VUST_DISC = 28;
const WITHDRAWAL_ALLOCATION_METHOD_GREEDY = 0;

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();

  const vaultCfg = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "configs", "devnet", "cssol-jito-vault.json"), "utf8",
  ));
  const vault = new PublicKey(vaultCfg.vault);
  const config = new PublicKey(vaultCfg.config);

  // Read Config.epoch_length to compute current ncn_epoch from slot.
  // Layout (per @jito-foundation/vault-sdk Config struct):
  //   disc(8) + admin(32) + restakingProgram(32) + epochLength(u64)
  //   + numVaults(u64) + ...
  const cfgInfo = await conn.getAccountInfo(config, "confirmed");
  if (!cfgInfo) throw new Error(`Jito Config ${config.toBase58()} not found`);
  const epochLength = cfgInfo.data.readBigUInt64LE(8 + 32 + 32);

  const slot = await conn.getSlot("confirmed");
  const ncnEpoch = BigInt(slot) / epochLength;

  console.log("=== Vault update crank ===");
  console.log(`payer:        ${payer.publicKey.toBase58()}`);
  console.log(`vault:        ${vault.toBase58()}`);
  console.log(`config:       ${config.toBase58()}`);
  console.log(`epoch_length: ${epochLength} slots`);
  console.log(`current slot: ${slot}`);
  console.log(`ncn_epoch:    ${ncnEpoch}`);

  // VaultUpdateStateTracker PDA = ["vault_update_state_tracker", vault, ncn_epoch_le].
  const ncnEpochBytes = Buffer.alloc(8);
  ncnEpochBytes.writeBigUInt64LE(ncnEpoch);
  const [tracker] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_update_state_tracker"), vault.toBuffer(), ncnEpochBytes],
    JITO_VAULT_PROGRAM,
  );
  console.log(`tracker PDA:  ${tracker.toBase58()}`);

  const trackerExists = await conn.getAccountInfo(tracker, "confirmed");
  if (trackerExists) {
    console.log("\nTracker already initialized for this epoch — skipping init.");
  } else {
    console.log("\nStep 1: InitializeVaultUpdateStateTracker");
    const initIx = new TransactionInstruction({
      programId: JITO_VAULT_PROGRAM,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: tracker, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([JITO_INIT_VUST_DISC, WITHDRAWAL_ALLOCATION_METHOD_GREEDY]),
    });
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
      .add(initIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed", skipPreflight: true });
    console.log(`  Tx: ${sig}`);
  }

  // Skipping step 2 (CrankVaultUpdateStateTracker) — vault has no
  // operators delegated to in our test setup.

  console.log("\nStep 3: CloseVaultUpdateStateTracker");
  const closeData = Buffer.alloc(1 + 8);
  closeData[0] = JITO_CLOSE_VUST_DISC;
  closeData.writeBigUInt64LE(ncnEpoch, 1);
  const closeIx = new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tracker, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ],
    data: closeData,
  });
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
    .add(closeIx);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed", skipPreflight: true });
  console.log(`  Tx: ${sig}`);

  console.log("\n=== done ===");
  console.log("Vault is now updated for epoch", ncnEpoch.toString());
  console.log("EnqueueWithdrawal / BurnWithdrawalTicket should accept until the next epoch flips.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
