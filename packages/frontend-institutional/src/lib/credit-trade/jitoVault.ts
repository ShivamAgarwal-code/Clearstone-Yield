/**
 * jitoVault.ts — Jito Vault state read + governor::wrap_with_jito_vault
 * CPI builder. Verbatim port from
 * `frontend-playground/src/lib/jitoVault.ts`.
 */
import {
  PublicKey,
  TransactionInstruction,
  Connection,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_VAULT,
  DELTA_MINT_PROGRAM,
  DM_MINT_AUTHORITY,
  DM_MINT_CONFIG,
  GOVERNOR_PROGRAM,
  JITO_VAULT_PROGRAM,
  POOL_PDA,
  POOL_VRT_ATA,
} from "./addresses";

export interface VaultState {
  base: PublicKey;
  vrtMint: PublicKey;
  supportedMint: PublicKey;
  vrtSupply: bigint;
  tokensDeposited: bigint;
  admin: PublicKey;
  feeWallet: PublicKey;
  mintBurnAdmin: PublicKey;
}

const ADMIN_BLOCK_START = 440;
const ADMIN_OFFSET = ADMIN_BLOCK_START + 32 * 0;
const FEE_WALLET_OFFSET = ADMIN_BLOCK_START + 32 * 8;
const MINT_BURN_ADMIN_OFFSET = ADMIN_BLOCK_START + 32 * 9;

export async function readVaultState(conn: Connection, vault: PublicKey): Promise<VaultState> {
  const info = await conn.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error(`vault ${vault.toBase58()} not found`);
  const d = info.data;
  return {
    base: new PublicKey(d.subarray(8, 40)),
    vrtMint: new PublicKey(d.subarray(40, 72)),
    supportedMint: new PublicKey(d.subarray(72, 104)),
    vrtSupply: d.readBigUInt64LE(104),
    tokensDeposited: d.readBigUInt64LE(112),
    admin: new PublicKey(d.subarray(ADMIN_OFFSET, ADMIN_OFFSET + 32)),
    feeWallet: new PublicKey(d.subarray(FEE_WALLET_OFFSET, FEE_WALLET_OFFSET + 32)),
    mintBurnAdmin: new PublicKey(d.subarray(MINT_BURN_ADMIN_OFFSET, MINT_BURN_ADMIN_OFFSET + 32)),
  };
}

async function disc(name: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(hash).slice(0, 8);
}

export async function buildWrapWithJitoVaultIx(args: {
  user: PublicKey;
  amount: bigint;
  vrtMint: PublicKey;
  feeWallet: PublicKey;
  jitoVaultConfig: PublicKey;
  vaultStTokenAccount: PublicKey;
}): Promise<TransactionInstruction> {
  const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt = getAssociatedTokenAddressSync(args.vrtMint, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCssol = getAssociatedTokenAddressSync(CSSOL_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultFeeAta = getAssociatedTokenAddressSync(args.vrtMint, args.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("whitelist"), DM_MINT_CONFIG.toBuffer(), args.user.toBuffer()],
    DELTA_MINT_PROGRAM,
  );

  const data = new Uint8Array(8 + 8);
  data.set(await disc("wrap_with_jito_vault"), 0);
  const dv = new DataView(data.buffer);
  dv.setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: userWsol, isSigner: false, isWritable: true },
      { pubkey: JITO_VAULT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: args.jitoVaultConfig, isSigner: false, isWritable: false },
      { pubkey: CSSOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: args.vrtMint, isSigner: false, isWritable: true },
      { pubkey: args.vaultStTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userVrt, isSigner: false, isWritable: true },
      { pubkey: POOL_VRT_ATA, isSigner: false, isWritable: true },
      { pubkey: vaultFeeAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DM_MINT_CONFIG, isSigner: false, isWritable: false },
      { pubkey: CSSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: DM_MINT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: whitelistEntry, isSigner: false, isWritable: false },
      { pubkey: userCssol, isSigner: false, isWritable: true },
      { pubkey: DELTA_MINT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function isWhitelisted(conn: Connection, user: PublicKey): Promise<boolean> {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("whitelist"), DM_MINT_CONFIG.toBuffer(), user.toBuffer()],
    DELTA_MINT_PROGRAM,
  );
  return !!(await conn.getAccountInfo(pda, "confirmed"));
}
