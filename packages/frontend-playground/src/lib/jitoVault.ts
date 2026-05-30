import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Connection,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  CSSOL_MINT,
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
const ADMIN_OFFSET = ADMIN_BLOCK_START + 32 * 0;          // 440
const FEE_WALLET_OFFSET = ADMIN_BLOCK_START + 32 * 8;     // 696
const MINT_BURN_ADMIN_OFFSET = ADMIN_BLOCK_START + 32 * 9; // 728

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

// Anchor discriminator for governor::wrap_with_jito_vault.
// = sha256("global:wrap_with_jito_vault")[0..8]; precomputed.
const WRAP_WITH_JITO_VAULT_DISC = new Uint8Array([
  0x6a, 0xc8, 0x32, 0xee, 0x68, 0x9e, 0x21, 0x36,
]);

async function disc(name: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(hash).slice(0, 8);
}

/**
 * Build the governor::wrap_with_jito_vault ix. The pool PDA signs the
 * Jito Vault MintTo via CPI (it holds mintBurnAdmin), so any KYC-whitelisted
 * user can call this without needing admin / mintBurnAdmin themselves.
 *
 * Account ordering matches the program's WrapWithJitoVault accounts struct
 * declaration in programs/governor/src/lib.rs.
 */
async function buildWrapWithJitoVaultIx(args: {
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

/**
 * Compose the SOL → csSOL deposit transaction using the gated-CPI path.
 * No more rotate-mint-restore — the governor program signs as
 * mintBurnAdmin during the CPI internally. KYC enforcement happens via
 * the delta-mint whitelist check. Any whitelisted user can call this.
 */
export async function buildDepositTx(
  conn: Connection,
  user: PublicKey,
  amountLamports: bigint,
): Promise<Transaction> {
  const state = await readVaultState(conn, CSSOL_VAULT);
  const [jitoConfig] = PublicKey.findProgramAddressSync([new TextEncoder().encode("config")], JITO_VAULT_PROGRAM);

  const userWsol = getAssociatedTokenAddressSync(state.supportedMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt = getAssociatedTokenAddressSync(state.vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCssol = getAssociatedTokenAddressSync(CSSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const feeVrt = getAssociatedTokenAddressSync(state.vrtMint, state.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const wrapIx = await buildWrapWithJitoVaultIx({
    user, amount: amountLamports,
    vrtMint: state.vrtMint, feeWallet: state.feeWallet,
    jitoVaultConfig: jitoConfig, vaultStTokenAccount: CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, userWsol, user, state.supportedMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, userVrt, user, state.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, userCssol, user, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, feeVrt, state.feeWallet, state.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: Number(amountLamports) }))
    .add(createSyncNativeInstruction(userWsol))
    .add(wrapIx);

  return tx;
}

export async function getVrtBalance(conn: Connection, user: PublicKey, vrtMint: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

export async function getCssolBalance(conn: Connection, user: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(CSSOL_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Returns true iff the user is on the delta-mint whitelist for the csSOL
 * mint config (i.e., KYC-approved). The whitelist PDA is created by the
 * governor's add_to_whitelist ix during onboarding.
 */
export async function isWhitelisted(conn: Connection, user: PublicKey): Promise<boolean> {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("whitelist"), DM_MINT_CONFIG.toBuffer(), user.toBuffer()],
    DELTA_MINT_PROGRAM,
  );
  return !!(await conn.getAccountInfo(pda, "confirmed"));
}

export { buildWrapWithJitoVaultIx };
