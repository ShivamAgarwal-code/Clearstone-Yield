/**
 * poc-jito-vault-deposit.ts — Deposit wSOL into a real Jito Vault on devnet
 * and receive VRT (Vault Receipt Token). **IN PROGRESS — see notes below.**
 *
 * Status (2026-04-27):
 *   - SDK installed and partially usable (`getConfigDecoder` works,
 *     `getVaultDecoder` is out of sync with the deployed program).
 *   - Discovery confirmed 7 wSOL-supporting vaults exist on devnet (see
 *     `poc-jito-vault-discover.ts`).
 *   - This script gets as far as the `MintTo` ix being dispatched on-chain
 *     (correct discriminator = 11) but fails with `Invalid account owner
 *     — Account is not owned by the spl token program`. The likely culprit
 *     is `vaultFeeTokenAccount`: the live vault's `feeWallet` field offset
 *     can't be raw-decoded reliably (DelegationState field has variable
 *     padding), so the ATA derivation falls back to an account that doesn't
 *     exist as a token account.
 *   - Remaining work: either bridge to `@solana/kit` and call
 *     `getMintToInstruction` from `@jito-foundation/vault-sdk` (the SDK
 *     accepts whichever Address you pass — we still have to know the right
 *     fee_token_account, but the SDK will at least generate the correct
 *     account ordering), or pull the Jito Vault Rust source to read the
 *     exact `feeWallet` offset.
 *
 * Found via `poc-jito-vault-discover.ts`: 7 vaults on devnet support wSOL
 * as their `supportedMint`. We default to one that already has deposits
 * (`CSLdXAxizcHzEGDTfGWrfYoUQ8wpr4uN4nCLX1qjiNr5`, ~0.05 SOL staked) so
 * the path is proven; override with VAULT=<pubkey>.
 *
 * Flow per ix:
 *   1. Native SOL → wSOL ATA (transfer + sync_native).
 *   2. Idempotent ATA creation for the user's VRT receipt.
 *   3. `MintTo` ix on the Jito Vault program (the deposit-equivalent in
 *      Jito Vault's vocabulary — it pulls supportedMint from the depositor
 *      and mints VRT to them).
 *
 * The vault may require its `update_state_tracker` to be cranked once per
 * epoch before MintTo will accept; we surface a clear error if that's the
 * case rather than auto-cranking (cranking is a separate POC).
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/clearstone-devnet.json AMOUNT=1000000 \
 *     npx tsx scripts/poc-jito-vault-deposit.ts
 *   (AMOUNT = lamports of wSOL to deposit; default 0.001 SOL.)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  AccountMeta,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const JITO_VAULT_PROGRAM = new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8");
const DEFAULT_VAULT = "CSLdXAxizcHzEGDTfGWrfYoUQ8wpr4uN4nCLX1qjiNr5";

// Jito Vault `MintTo` ix discriminator: u8 = 11 per
// MINT_TO_DISCRIMINATOR exported by @jito-foundation/vault-sdk@1.0.0.
// (Note: the JitoVaultInstruction enum in TypeScript ≠ the on-chain
// dispatcher; the canonical values are the *_DISCRIMINATOR constants.)
const MINT_TO_DISCRIMINATOR = 11;

function loadKp(p: string) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, JITO_VAULT_PROGRAM)[0];
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const user = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));
  const vault = new PublicKey(process.env.VAULT || DEFAULT_VAULT);
  const amount = BigInt(process.env.AMOUNT || "1000000"); // 0.001 SOL default

  console.log("=== Jito Vault deposit POC (devnet) ===");
  console.log("user:    ", user.publicKey.toBase58());
  console.log("vault:   ", vault.toBase58());
  console.log("amount:  ", amount.toString(), "lamports");

  // Read the vault state to extract config + supported_mint + vrt_mint + fee_wallet
  const vaultInfo = await conn.getAccountInfo(vault, "confirmed");
  if (!vaultInfo) throw new Error("vault not found");
  const data = vaultInfo.data;
  // Vault layout (raw):
  //   0..8   discriminator (u64=2)
  //   8..40  base
  //   40..72 vrtMint
  //   72..104 supportedMint
  //   104..112 vrtSupply
  //   112..120 tokensDeposited
  //   ... admin, fee_wallet etc. follow.
  const vrtMint = new PublicKey(data.subarray(40, 72));
  const supportedMint = new PublicKey(data.subarray(72, 104));
  if (!supportedMint.equals(NATIVE_MINT)) {
    throw new Error(`vault supports ${supportedMint.toBase58()}, not wSOL — pass VAULT=<wsol-supporting>`);
  }
  // feeWallet field is at offset 8+32*9+8*5+...; rather than decode the full
  // struct, derive the vault's fee token account ATA the same way the
  // program does. The fee account is held in the vault state but for an
  // initialized vault we can just look it up by structural rules below.

  // PDAs / accounts:
  //   config:                             findProgramAddress(["config"], program)
  //   vault_token_account (vault holds wSOL): ATA(supportedMint, vault, allowOwnerOffCurve=true)
  //   depositor_token_account (user wSOL):    ATA(supportedMint, user)
  //   depositor_vrt_token_account:            ATA(vrtMint, user)
  //   vault_fee_token_account:                ATA(vrtMint, fee_wallet, allowOwnerOffCurve=true)
  //
  // The fee_wallet field is somewhere in the Vault struct beyond what we
  // raw-decode above. Read it from a known offset: per the published Jito
  // Vault Rust struct, fee_wallet sits at offset ~360. We do a wider raw
  // read to grab it.
  // Layout per vault-sdk Vault type — 8 (disc) +
  //   base(32) + vrtMint(32) + supportedMint(32) + vrtSupply(8) +
  //   tokensDeposited(8) + depositCapacity(8) + delegationState(72) +
  //   additionalAssetsNeedUnstaking(8) + vrtEnqueuedForCooldownAmount(8) +
  //   vrtCoolingDownAmount(8) + vrtReadyToClaimAmount(8) + admin(32) +
  //   delegationAdmin(32) + operatorAdmin(32) + ncnAdmin(32) + slasherAdmin(32) +
  //   capacityAdmin(32) + feeAdmin(32) + delegateAssetAdmin(32) + feeWallet(32)
  // Offset of feeWallet:
  //   8 + 32*3 + 8*4 + 72 + 8*4 + 32*8 = 8 + 96 + 32 + 72 + 32 + 256 = 496
  const feeWallet = new PublicKey(data.subarray(496, 528));
  console.log("vrtMint:       ", vrtMint.toBase58());
  console.log("supportedMint: ", supportedMint.toBase58(), "(wSOL)");
  console.log("feeWallet:     ", feeWallet.toBase58());

  const config = pda([Buffer.from("config")]);
  const vaultTokenAccount = getAssociatedTokenAddressSync(supportedMint, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWsolAta = getAssociatedTokenAddressSync(supportedMint, user.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrtAta = getAssociatedTokenAddressSync(vrtMint, user.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  // Try the simplest derivation first: ATA(vrtMint, vault) — Jito Vault's
  // pattern for the vault-owned fee receipt account. If that fails the
  // program will reject; uncomment the override below to try ATA(vrtMint,
  // feeWallet) instead.
  const vaultFeeTokenAccount = getAssociatedTokenAddressSync(vrtMint, vault, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  // const vaultFeeTokenAccount = getAssociatedTokenAddressSync(vrtMint, feeWallet, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  console.log("config PDA:    ", config.toBase58());
  console.log("vault wsol ATA:", vaultTokenAccount.toBase58());
  console.log("user wsol ATA: ", userWsolAta.toBase58());
  console.log("user VRT ATA:  ", userVrtAta.toBase58());
  console.log("vault fee ATA: ", vaultFeeTokenAccount.toBase58());

  const vrtBefore = (await conn.getTokenAccountBalance(userVrtAta).catch(() => null))?.value.amount ?? "0";

  // MintTo ix data: u8 disc + u64 amountIn + u64 minAmountOut
  const ixData = Buffer.alloc(1 + 8 + 8);
  ixData.writeUInt8(MINT_TO_DISCRIMINATOR, 0);
  ixData.writeBigUInt64LE(amount, 1);
  ixData.writeBigUInt64LE(0n, 9); // minAmountOut = 0 for permissive POC

  // Account ordering per vault-sdk MintToInput:
  //   config (R)
  //   vault (W)
  //   vrtMint (W)
  //   depositor (W, signer)
  //   depositorTokenAccount (W)
  //   vaultTokenAccount (W)
  //   depositorVrtTokenAccount (W)
  //   vaultFeeTokenAccount (W)
  //   tokenProgram (R)
  //   mintSigner (signer; optional but mint_burn_admin path requires it —
  //     we omit and let the program use the default path).
  const keys: AccountMeta[] = [
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: vrtMint, isSigner: false, isWritable: true },
    { pubkey: user.publicKey, isSigner: true, isWritable: true },
    { pubkey: userWsolAta, isSigner: false, isWritable: true },
    { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userVrtAta, isSigner: false, isWritable: true },
    { pubkey: vaultFeeTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const mintToIx = new TransactionInstruction({ programId: JITO_VAULT_PROGRAM, keys, data: ixData });

  const tx = new Transaction()
    // Ensure user wSOL ATA + fund it with `amount` lamports of native SOL
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userWsolAta, user.publicKey, supportedMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: userWsolAta, lamports: Number(amount) }))
    .add(createSyncNativeInstruction(userWsolAta))
    // Ensure user VRT ATA
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey, userVrtAta, user.publicKey, vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    // Deposit
    .add(mintToIx);

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [user]);
    console.log("\nMintTo sig:", sig);
    const vrtAfter = (await conn.getTokenAccountBalance(userVrtAta).catch(() => null))?.value.amount ?? "0";
    console.log(`VRT balance: ${vrtBefore} → ${vrtAfter} (Δ ${BigInt(vrtAfter) - BigInt(vrtBefore)})`);
  } catch (e: any) {
    if (e?.transactionLogs) {
      console.error("\nlogs:");
      for (const l of e.transactionLogs.slice(-12)) console.error(" ", l);
    }
    throw e;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
