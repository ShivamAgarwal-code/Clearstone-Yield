/**
 * Curator-admin instruction builders — for the **keeper service**.
 *
 * All ixs here require the curator wallet as signer (see
 * KEEPER_PERMISSIONS.md). The retail SDK surfaces are in `curator.ts`;
 * keep these separate so a compromised frontend can't accidentally
 * expose them.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  CLEARSTONE_CURATOR_PROGRAM_ID,
  CLEARSTONE_CORE_PROGRAM_ID,
  GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "../common/constants.js";
import { CURATOR_ADMIN_DISC } from "./constants.js";

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
function i64le(n: BN | bigint | number): Buffer {
  const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
  return v.toTwos(64).toArrayLike(Buffer, "le", 8);
}
function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

// ---------------------------------------------------------------------------
// Shared accounts for reallocate_*
// ---------------------------------------------------------------------------

interface ReallocateCommon {
  /** Curator wallet — signer. Also `mut` because init_if_needed ATAs pay rent. */
  curator: PublicKey;
  vault: PublicKey;
  baseMint: PublicKey;
  /** Vault's base escrow. */
  baseEscrow: PublicKey;

  // adapter
  syMarket: PublicKey;
  syMint: PublicKey;
  /** Adapter-owned base pool. */
  adapterBaseVault: PublicKey;
  /** Vault-PDA-owned SY ATA. */
  vaultSyAta: PublicKey;

  // target market
  market: PublicKey;
  marketEscrowPt: PublicKey;
  marketEscrowSy: PublicKey;
  tokenFeeTreasurySy: PublicKey;
  marketAlt: PublicKey;
  mintPt: PublicKey;
  mintLp: PublicKey;
  vaultPtAta: PublicKey;
  vaultLpAta: PublicKey;

  coreEventAuthority: PublicKey;

  // program overrides
  tokenProgram?: PublicKey;
  syProgram?: PublicKey;
  coreProgram?: PublicKey;
  associatedTokenProgram?: PublicKey;
  programId?: PublicKey;
}

function reallocateKeys(p: ReallocateCommon, includeSystem: boolean): AccountMeta[] {
  const keys: AccountMeta[] = [
    signer(p.curator),
    rw(p.vault),
    ro(p.baseMint),
    rw(p.baseEscrow),
    ro(p.syMarket),
    rw(p.syMint),
    rw(p.adapterBaseVault),
    rw(p.vaultSyAta),
    rw(p.market),
    rw(p.marketEscrowPt),
    rw(p.marketEscrowSy),
    rw(p.tokenFeeTreasurySy),
    ro(p.marketAlt),
    ro(p.mintPt),
    rw(p.mintLp),
    rw(p.vaultPtAta),
    rw(p.vaultLpAta),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    ro(p.coreEventAuthority),
  ];
  if (includeSystem) {
    // reallocate_to_market has `init_if_needed` ATAs → needs ATA + System program.
    keys.push(
      ro(p.associatedTokenProgram ?? ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SystemProgram.programId)
    );
  }
  return keys;
}

// ---------------------------------------------------------------------------
// reallocate_to_market
// ---------------------------------------------------------------------------

export interface ReallocateToMarketParams extends ReallocateCommon {
  allocationIndex: number;
  baseIn: BN | bigint | number;
  ptBuyAmount: BN | bigint | number;
  maxSyIn: BN | bigint | number;
  ptIntent: BN | bigint | number;
  syIntent: BN | bigint | number;
  minLpOut: BN | bigint | number;
}

export function buildReallocateToMarket(
  p: ReallocateToMarketParams
): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
    keys: reallocateKeys(p, true),
    data: Buffer.concat([
      CURATOR_ADMIN_DISC.reallocateToMarket,
      u16le(p.allocationIndex),
      u64le(p.baseIn),
      u64le(p.ptBuyAmount),
      i64le(p.maxSyIn),
      u64le(p.ptIntent),
      u64le(p.syIntent),
      u64le(p.minLpOut),
    ]),
  });
}

// ---------------------------------------------------------------------------
// reallocate_from_market
// ---------------------------------------------------------------------------

export interface ReallocateFromMarketParams extends ReallocateCommon {
  allocationIndex: number;
  lpIn: BN | bigint | number;
  minPtOut: BN | bigint | number;
  minSyOut: BN | bigint | number;
  ptSellAmount: BN | bigint | number;
  minSyForPt: BN | bigint | number;
  syRedeemAmount: BN | bigint | number;
  baseOutExpected: BN | bigint | number;
}

export function buildReallocateFromMarket(
  p: ReallocateFromMarketParams
): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
    // reallocate_from does not have init_if_needed ATAs, so no ATA/System.
    keys: reallocateKeys(p, false),
    data: Buffer.concat([
      CURATOR_ADMIN_DISC.reallocateFromMarket,
      u16le(p.allocationIndex),
      u64le(p.lpIn),
      u64le(p.minPtOut),
      u64le(p.minSyOut),
      u64le(p.ptSellAmount),
      i64le(p.minSyForPt),
      u64le(p.syRedeemAmount),
      u64le(p.baseOutExpected),
    ]),
  });
}

// ---------------------------------------------------------------------------
// mark_to_market — permissionless (no signer). Used by the keeper to
// refresh NAV reporting between rolls.
// ---------------------------------------------------------------------------

export interface MarkToMarketParams {
  vault: PublicKey;
  /** Core-program Vault account for the target market. */
  coreVault: PublicKey;
  market: PublicKey;
  allocationIndex: number;
  programId?: PublicKey;
}

export function buildMarkToMarket(
  p: MarkToMarketParams
): TransactionInstruction {
  return new TransactionInstruction({
    programId: p.programId ?? CLEARSTONE_CURATOR_PROGRAM_ID,
    keys: [rw(p.vault), ro(p.coreVault), ro(p.market)],
    data: Buffer.concat([CURATOR_ADMIN_DISC.markToMarket, u16le(p.allocationIndex)]),
  });
}
