/**
 * Low-level instruction builders for `clearstone_curator`.
 *
 * The curator vault is the "savings account / auto-roll" surface: users
 * deposit base tokens and hold shares; the curator rebalances shares
 * across PT markets so rollovers happen at each market's maturity
 * without user involvement.
 *
 * Shipping in v1:
 *   - buildCuratorDeposit   — user deposits base → mints shares
 *   - buildCuratorWithdraw  — user burns shares → receives base (idle portion)
 *
 * Out of scope here (curator/keeper operations):
 *   - initialize_vault, set_allocations, reallocate_to/from_market,
 *     mark_to_market, harvest_fees. These have distinct auth (curator
 *     signer, not user) and are exposed separately via the curator
 *     frontend, not the retail SDK.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  CLEARSTONE_CURATOR_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../common/constants.js";
import { CURATOR_DISC } from "./constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ro = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const rw = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});
const signer = (pubkey: PublicKey, writable = true): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: writable,
});

function u64le(n: BN | bigint | number): Buffer {
  const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
  return v.toArrayLike(Buffer, "le", 8);
}

// ---------------------------------------------------------------------------
// PDA derivations for the curator program
// ---------------------------------------------------------------------------

const SEED = {
  curatorVault: Buffer.from("curator_vault"),
  baseEscrow: Buffer.from("base_escrow"),
  userPos: Buffer.from("user_pos"),
} as const;

/** `curator_vault` PDA keyed by (curator, base_mint). */
export function curatorVaultPda(
  curator: PublicKey,
  baseMint: PublicKey,
  programId = CLEARSTONE_CURATOR_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED.curatorVault, curator.toBuffer(), baseMint.toBuffer()],
    programId
  )[0];
}

/** Vault-owned base token escrow. */
export function curatorBaseEscrowPda(
  vault: PublicKey,
  programId = CLEARSTONE_CURATOR_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED.baseEscrow, vault.toBuffer()],
    programId
  )[0];
}

/** Per-user position PDA keyed by (vault, owner). */
export function curatorUserPositionPda(
  vault: PublicKey,
  owner: PublicKey,
  programId = CLEARSTONE_CURATOR_PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED.userPos, vault.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

// ---------------------------------------------------------------------------
// deposit — base → shares (auto-roll opt-in)
// ---------------------------------------------------------------------------

export interface CuratorDepositParams {
  owner: PublicKey;
  vault: PublicKey;
  baseMint: PublicKey;
  baseEscrow: PublicKey;
  baseSrc: PublicKey;
  position: PublicKey;
  amountBase: BN | bigint | number;
  tokenProgram?: PublicKey;
  programId?: PublicKey;
}

export function buildCuratorDeposit(
  p: CuratorDepositParams
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.owner),
    rw(p.vault),
    rw(p.baseMint),
    rw(p.baseSrc),
    rw(p.baseEscrow),
    rw(p.position),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(SystemProgram.programId),
    ro(SYSVAR_RENT_PUBKEY),
  ];
  return new TransactionInstruction({
    programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
    keys,
    data: Buffer.concat([CURATOR_DISC.deposit, u64le(p.amountBase)]),
  });
}

// ---------------------------------------------------------------------------
// withdraw — shares → base (from idle escrow only; deployed portion
// requires prior curator rebalance).
// ---------------------------------------------------------------------------

export interface CuratorWithdrawParams {
  owner: PublicKey;
  vault: PublicKey;
  baseMint: PublicKey;
  baseDst: PublicKey;
  baseEscrow: PublicKey;
  position: PublicKey;
  /** Shares to burn. */
  shares: BN | bigint | number;
  tokenProgram?: PublicKey;
  programId?: PublicKey;
}

export function buildCuratorWithdraw(
  p: CuratorWithdrawParams
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.owner, false), // withdraw's owner is signer, not `mut`
    rw(p.vault),
    rw(p.baseMint),
    rw(p.baseDst),
    rw(p.baseEscrow),
    rw(p.position),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
  ];
  return new TransactionInstruction({
    programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
    keys,
    data: Buffer.concat([CURATOR_DISC.withdraw, u64le(p.shares)]),
  });
}
