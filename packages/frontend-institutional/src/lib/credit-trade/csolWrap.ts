/**
 * csolWrap.ts — Pure ix builders for the cSOL native-wrap pool's
 * `wrap_native` and `unwrap_native` governor instructions. Used by the
 * credit-trade open / close bundles to bridge between the EG-2 debt
 * asset (cSOL — Token-2022, KYC-gated) and the Jito vault's input
 * (wSOL — Token-classic).
 *
 * Why these are needed: after the 2026-05-06 wSOL → cSOL migration,
 * the EG-2 debt reserve holds cSOL liquidity. The credit-trade open
 * path flash-borrows cSOL but the Jito vault wrap step requires wSOL
 * input, so we unwrap_native(cSOL → wSOL) inside the same tx. The
 * close path mirrors: redeem csSOL → wSOL via Jito, then wrap_native
 * (wSOL → cSOL) before flash-repay.
 *
 * Whitelist semantics:
 *   * `wrap_native`   — KYC-gated. delta-mint's `mint_to` checks the
 *     user's `whitelist_entry` PDA on the cSOL pool. Bundle assumes the
 *     KycGate has already verified the entry; without it, the wrap
 *     reverts with delta-mint AccountNotInitialized (3012).
 *   * `unwrap_native` — explicitly unconditional per the IDL ("the
 *     borrower path of the credit trade depends on this being
 *     unconditionally callable"). No whitelist check on burn.
 *
 * Seed shape: cSOL's pool_config PDA is derived from
 * `["native_pool", wrapped_mint]` (NOT `["pool", underlying_mint]` like
 * csSOL/ceUSX) — handled internally by the pool_config arg.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  CSOL_DM_MINT_CONFIG,
  CSOL_MINT,
  CSOL_POOL_PDA,
  CSOL_POOL_WSOL_VAULT,
} from "./addresses";
import { DEVNET_CONFIG } from "../../config/devnet";

const GOVERNOR_PROGRAM_ID = DEVNET_CONFIG.programs.governor;
const DELTA_MINT_PROGRAM_ID = DEVNET_CONFIG.programs.deltaMint;

// IDL discriminators — cross-checked against
// packages/programs/target/idl/governor.json
const DISC_WRAP_NATIVE   = Buffer.from([115, 7, 172, 233, 184, 33, 244, 46]);
const DISC_UNWRAP_NATIVE = Buffer.from([26, 68, 51, 112, 162, 105, 110, 231]);

/**
 * The cSOL pool's dm_mint_authority. delta-mint derives this PDA from
 * `["mint_authority", wrapped_mint]` (seed prefix is just
 * "mint_authority", and the pubkey is the WRAPPED MINT — not the
 * MintConfig). The original implementation here used
 * `["dm_mint_authority", dm_mint_config]` and failed the wrap with
 * ConstraintSeeds (Anchor 2006); fixed 2026-05-06 after running the
 * retail wrap simulator surfaced the exact mismatch on chain.
 */
function csolDmMintAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), CSOL_MINT.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  )[0];
}

function whitelistEntryPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), CSOL_DM_MINT_CONFIG.toBuffer(), user.toBuffer()],
    DELTA_MINT_PROGRAM_ID,
  )[0];
}

interface WrapArgs {
  user: PublicKey;
  amount: bigint;
  /** User's wSOL ATA — source for wrap_native, destination for unwrap_native. */
  userUnderlyingAta: PublicKey;
  /** User's cSOL ATA — destination for wrap_native, source for unwrap_native. */
  userWrappedAta: PublicKey;
  /** SPL token program for the underlying (wSOL → TOKEN_PROGRAM_ID). */
  underlyingTokenProgram: PublicKey;
  /** SPL token program for the wrapper (cSOL → TOKEN_2022_PROGRAM_ID). */
  wrappedTokenProgram: PublicKey;
  /** Native mint for wSOL. */
  underlyingMint: PublicKey;
}

/**
 * Build `governor.wrap_native(amount)` — wSOL → cSOL 1:1 (KYC-gated).
 * Caller must have a whitelist entry on the cSOL pool's MintConfig
 * (the bundle's KycGate precheck enforces this).
 */
export function buildWrapNativeIx(args: WrapArgs): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  DISC_WRAP_NATIVE.copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: args.user,                   isSigner: true,  isWritable: true  },
      { pubkey: CSOL_POOL_PDA,               isSigner: false, isWritable: true  },
      { pubkey: args.underlyingMint,         isSigner: false, isWritable: false },
      { pubkey: args.userUnderlyingAta,      isSigner: false, isWritable: true  },
      { pubkey: CSOL_POOL_WSOL_VAULT,        isSigner: false, isWritable: true  },
      { pubkey: CSOL_MINT,                   isSigner: false, isWritable: true  },
      { pubkey: CSOL_DM_MINT_CONFIG,         isSigner: false, isWritable: false },
      { pubkey: csolDmMintAuthority(),       isSigner: false, isWritable: false },
      { pubkey: whitelistEntryPda(args.user), isSigner: false, isWritable: false },
      { pubkey: args.userWrappedAta,         isSigner: false, isWritable: true  },
      { pubkey: DELTA_MINT_PROGRAM_ID,       isSigner: false, isWritable: false },
      { pubkey: args.underlyingTokenProgram, isSigner: false, isWritable: false },
      { pubkey: args.wrappedTokenProgram,    isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build `governor.unwrap_native(amount)` — cSOL → wSOL 1:1
 * (unconditional; no whitelist check, by design — the credit-trade
 * borrower path needs to auto-unwrap klend-borrowed cSOL inside the
 * same tx without requiring extra plumbing).
 */
export function buildUnwrapNativeIx(args: WrapArgs): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  DISC_UNWRAP_NATIVE.copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: args.user,                   isSigner: true,  isWritable: true  },
      { pubkey: CSOL_POOL_PDA,               isSigner: false, isWritable: true  },
      { pubkey: args.underlyingMint,         isSigner: false, isWritable: false },
      { pubkey: CSOL_MINT,                   isSigner: false, isWritable: true  },
      { pubkey: args.userWrappedAta,         isSigner: false, isWritable: true  },
      { pubkey: CSOL_POOL_WSOL_VAULT,        isSigner: false, isWritable: true  },
      { pubkey: args.userUnderlyingAta,      isSigner: false, isWritable: true  },
      { pubkey: args.underlyingTokenProgram, isSigner: false, isWritable: false },
      { pubkey: args.wrappedTokenProgram,    isSigner: false, isWritable: false },
    ],
    data,
  });
}
