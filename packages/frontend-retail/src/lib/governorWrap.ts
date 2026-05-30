/**
 * governor `wrap_native` / `unwrap_native` ix builders — shared between
 * the SOL track (wSOL ↔ cSOL) and the USDC track (sUSDC ↔ cUSDC).
 *
 * The two pool kinds are structurally identical: the governor's
 * `initialize_native_pool` ix takes any SPL-Token underlying and mints a
 * Token-2022 wrapper through delta-mint. `wrap_native` / `unwrap_native`
 * are pool-agnostic — they read every mint / vault / authority from the
 * pool config, so the same ix builder serves both tracks.
 *
 * Mirrors the institutional builder at
 * `packages/frontend-institutional/src/lib/credit-trade/csolWrap.ts`.
 */
import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Anchor discriminators: sha256("global:wrap_native")[..8] and
// sha256("global:unwrap_native")[..8]. Cross-checked against the
// institutional builder; do not change without re-deriving from the
// governor IDL.
const DISC_WRAP_NATIVE = Buffer.from([115, 7, 172, 233, 184, 33, 244, 46]);
const DISC_UNWRAP_NATIVE = Buffer.from([26, 68, 51, 112, 162, 105, 110, 231]);

/**
 * Underlying token program — either SPL-Token (legacy) or Token-2022.
 * sUSDC is legacy SPL; wSOL is legacy SPL. The wrapped (cUSDC / cSOL)
 * mint is always Token-2022 since delta-mint emits Token-2022 mints.
 */
type TokenProgram = typeof TOKEN_PROGRAM_ID | typeof TOKEN_2022_PROGRAM_ID;

export interface WrapNativeArgs {
  /** governor program id (e.g. `DEVNET_CONFIG.programs.governor`). */
  governor: PublicKey;
  /** delta-mint program id. */
  deltaMint: PublicKey;
  user: PublicKey;
  /** Amount of underlying to wrap, in raw token units. */
  amount: bigint;
  /** Pool config PDA — `[b"native_pool", wrappedMint]`. */
  poolConfig: PublicKey;
  /** Pool-owned ATA holding the underlying. */
  poolUnderlyingVault: PublicKey;
  /** delta-mint MintConfig PDA for `wrappedMint`. */
  dmMintConfig: PublicKey;
  /** Wrapper mint (cSOL / cUSDC) — Token-2022. */
  wrappedMint: PublicKey;
  /** Underlying mint (wSOL / sUSDC). */
  underlyingMint: PublicKey;
  /** Source ATA — user's underlying token account. */
  userUnderlyingAta: PublicKey;
  /** Destination ATA — user's wrapper token account (Token-2022). */
  userWrappedAta: PublicKey;
  /** Token program of the underlying mint. Defaults to legacy SPL. */
  underlyingTokenProgram?: TokenProgram;
}

/**
 * Build governor.wrap_native(amount).
 *
 * KYC-gated: caller MUST have a `whitelist_entry` PDA on the pool's
 * MintConfig (precheck before signing — delta-mint will otherwise
 * revert with AccountNotInitialized / Custom 3012).
 */
export function buildWrapNativeIx(args: WrapNativeArgs): TransactionInstruction {
  const underlyingTokenProgram = args.underlyingTokenProgram ?? TOKEN_PROGRAM_ID;

  // delta-mint mint_authority PDA seeds = [b"mint_authority", wrappedMint]
  // (NOT [b"dm_mint_authority", mint_config]) — getting this wrong fails
  // wrap with ConstraintSeeds (Anchor 2006). See delta-mint `lib.rs`.
  const [dmAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), args.wrappedMint.toBuffer()],
    args.deltaMint,
  );
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), args.dmMintConfig.toBuffer(), args.user.toBuffer()],
    args.deltaMint,
  );
  const data = Buffer.alloc(16);
  DISC_WRAP_NATIVE.copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: args.governor,
    keys: [
      { pubkey: args.user,                isSigner: true,  isWritable: true  },
      { pubkey: args.poolConfig,          isSigner: false, isWritable: true  },
      { pubkey: args.underlyingMint,      isSigner: false, isWritable: false },
      { pubkey: args.userUnderlyingAta,   isSigner: false, isWritable: true  },
      { pubkey: args.poolUnderlyingVault, isSigner: false, isWritable: true  },
      { pubkey: args.wrappedMint,         isSigner: false, isWritable: true  },
      { pubkey: args.dmMintConfig,        isSigner: false, isWritable: false },
      { pubkey: dmAuthority,              isSigner: false, isWritable: false },
      { pubkey: whitelistEntry,           isSigner: false, isWritable: false },
      { pubkey: args.userWrappedAta,      isSigner: false, isWritable: true  },
      { pubkey: args.deltaMint,           isSigner: false, isWritable: false },
      { pubkey: underlyingTokenProgram,   isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,    isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface UnwrapNativeArgs {
  governor: PublicKey;
  user: PublicKey;
  /** Amount of WRAPPED tokens to burn, in raw token units. The pool
   *  releases the same number of underlying units 1:1. */
  amount: bigint;
  poolConfig: PublicKey;
  poolUnderlyingVault: PublicKey;
  wrappedMint: PublicKey;
  underlyingMint: PublicKey;
  userUnderlyingAta: PublicKey;
  userWrappedAta: PublicKey;
  underlyingTokenProgram?: TokenProgram;
}

/**
 * Build governor.unwrap_native(amount).
 *
 * Unconditional — no whitelist check. The burn-side of the pool only
 * validates supply accounting, not gating, so a user whose whitelist
 * was revoked can still exit.
 */
export function buildUnwrapNativeIx(args: UnwrapNativeArgs): TransactionInstruction {
  const underlyingTokenProgram = args.underlyingTokenProgram ?? TOKEN_PROGRAM_ID;
  const data = Buffer.alloc(16);
  DISC_UNWRAP_NATIVE.copy(data, 0);
  data.writeBigUInt64LE(args.amount, 8);
  return new TransactionInstruction({
    programId: args.governor,
    keys: [
      { pubkey: args.user,                isSigner: true,  isWritable: true  },
      { pubkey: args.poolConfig,          isSigner: false, isWritable: true  },
      { pubkey: args.underlyingMint,      isSigner: false, isWritable: false },
      { pubkey: args.wrappedMint,         isSigner: false, isWritable: true  },
      { pubkey: args.userWrappedAta,      isSigner: false, isWritable: true  },
      { pubkey: args.poolUnderlyingVault, isSigner: false, isWritable: true  },
      { pubkey: args.userUnderlyingAta,   isSigner: false, isWritable: true  },
      { pubkey: underlyingTokenProgram,   isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,    isSigner: false, isWritable: false },
    ],
    data,
  });
}
