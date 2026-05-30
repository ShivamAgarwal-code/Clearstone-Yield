import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  ELEVATION_GROUP_LST_SOL,
  KLEND_MARKET,
  KLEND_PROGRAM,
  WSOL_RESERVE,
} from "./addresses";

// Anchor-style discriminators for the klend ixs we use. Computed
// off-thread (see comment block below) and pinned here so the tab can
// run synchronously.
//   sha256("global:init_user_metadata")[0..8]   = 75a9b8413294f604
//   sha256("global:init_obligation")[0..8]      = fb20c0bbcf0c14fb
//   sha256("global:request_elevation_group")[0..8] = 4d2bb70d8ddff5d6
//   sha256("global:refresh_reserve")[0..8]      = 02da8aeb4fc91966
//   sha256("global:refresh_obligation")[0..8]   = 218493e497c04859
//   sha256("global:deposit_reserve_liquidity_and_obligation_collateral")[0..8]
//                                              = 81c70402de271a2e
async function sha256_8(input: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(h).slice(0, 8);
}

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT = PublicKey.default;
const enc = new TextEncoder();

function lendingMarketAuthority(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("lma"), market.toBuffer()], KLEND_PROGRAM)[0];
}
export function reserveLiqSupply(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("reserve_liq_supply"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}
function reserveCollMint(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("reserve_coll_mint"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}
function reserveCollSupply(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("reserve_coll_supply"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}

export function userMetadataPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("user_meta"), owner.toBuffer()], KLEND_PROGRAM)[0];
}

/**
 * Obligation PDA — for default obligations the seeds are:
 *   [tag(=0), id(=0), owner, market, default_pubkey, default_pubkey]
 */
export function obligationPda(owner: PublicKey, tag = 0, id = 0, market: PublicKey = KLEND_MARKET): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Uint8Array.from([tag]),
      Uint8Array.from([id]),
      owner.toBuffer(),
      market.toBuffer(),
      DEFAULT.toBuffer(),
      DEFAULT.toBuffer(),
    ],
    KLEND_PROGRAM,
  )[0];
}

// ── ix builders ────────────────────────────────────────────────────────

export async function buildInitUserMetadataIx(owner: PublicKey, feePayer: PublicKey): Promise<TransactionInstruction> {
  const userMeta = userMetadataPda(owner);
  // Args: userLookupTable (Pubkey, default = no LUT)
  const data = new Uint8Array(8 + 32);
  data.set(await sha256_8("global:init_user_metadata"), 0);
  data.set(DEFAULT.toBuffer(), 8);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: userMeta, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },  // referrerUserMetadata = klend program id sentinel = no referrer
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildInitObligationIx(owner: PublicKey, feePayer: PublicKey, tag = 0, id = 0): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner, tag, id);
  const userMeta = userMetadataPda(owner);
  // Args: InitObligationArgs { tag: u8, id: u8 }
  const data = new Uint8Array(8 + 1 + 1);
  data.set(await sha256_8("global:init_obligation"), 0);
  data[8] = tag; data[9] = id;
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: DEFAULT, isSigner: false, isWritable: false },        // seed1Account
      { pubkey: DEFAULT, isSigner: false, isWritable: false },        // seed2Account
      { pubkey: userMeta, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildRequestElevationGroupIx(
  owner: PublicKey,
  group = ELEVATION_GROUP_LST_SOL,
  depositReserves: PublicKey[] = [],
  borrowReserves: PublicKey[] = [],
): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner);
  const data = new Uint8Array(8 + 1);
  data.set(await sha256_8("global:request_elevation_group"), 0);
  data[8] = group;
  // remaining_accounts: each obligation deposit reserve (writable),
  // then each borrow reserve. Klend SDK addRequestElevationIx
  // (action.ts:2826) sets role=AccountRole.WRITABLE on each.
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      ...depositReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
      ...borrowReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

export async function buildRefreshReserveIx(reserve: PublicKey, oracle: PublicKey): Promise<TransactionInstruction> {
  const data = await sha256_8("global:refresh_reserve");
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },          // pythOracle
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },   // switchboardPriceOracle = default → using program id as None sentinel per klend convention
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },   // switchboardTwapOracle
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },   // scopePrices
    ],
    data: Buffer.from(data),
  });
}

export async function buildRefreshObligationIx(
  owner: PublicKey,
  depositReserves: PublicKey[],
  borrowReserves: PublicKey[] = [],
): Promise<TransactionInstruction> {
  const data = await sha256_8("global:refresh_obligation");
  const obligation = obligationPda(owner);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      // klend's handler_refresh_obligation expects every non-default
      // reserve referenced by the obligation as remaining_accounts —
      // deposits AND borrows. Mismatching the count surfaces as
      // InvalidAccountInput (6006). Both must be writable.
      ...depositReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
      ...borrowReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

/** csSOL deposit + obligation collateral — Token-2022 liquidity path. */
export async function buildDepositCsSolIx(owner: PublicKey, amount: bigint): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner);
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const liquiditySupply = reserveLiqSupply(CSSOL_RESERVE);
  const collMint = reserveCollMint(CSSOL_RESERVE);
  const collDest = reserveCollSupply(CSSOL_RESERVE);
  const userSource = getAssociatedTokenAddressSync(
    CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:deposit_reserve_liquidity_and_obligation_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: CSSOL_RESERVE, isSigner: false, isWritable: true },
      { pubkey: CSSOL_MINT, isSigner: false, isWritable: true },          // reserveLiquidityMint (Token-2022 → mut for transfer fee accounting)
      { pubkey: liquiditySupply, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collDest, isSigner: false, isWritable: true },
      { pubkey: userSource, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },      // placeholderUserDestinationCollateral = None
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // collateralTokenProgram (cTokens are SPL Token)
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // liquidityTokenProgram (csSOL is Token-2022)
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export const KLEND_RESERVES = { csSOL: CSSOL_RESERVE, wSOL: WSOL_RESERVE };

// klend global config (fee-receiver-of-fee-receivers, etc.). Same on
// devnet + mainnet for the canonical klend deployment.
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

export function feeReceiverPda(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("fee_receiver"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}

/**
 * Build klend `flash_borrow_reserve_liquidity`. The flash loan must be
 * paired with a matching `flash_repay_reserve_liquidity` later in the
 * same tx; klend uses sysvar-instructions to verify the pair.
 *
 * Account layout matches the SDK at @kamino-finance/klend-sdk
 * @codegen/instructions/flashBorrowReserveLiquidity.ts (12 keys).
 *
 * @param liquidityMint The reserve's liquidity mint (csSOL_WT for the
 *                      leveraged-unwind path). Token program is inferred
 *                      from the mint owner — caller passes it directly.
 */
export async function buildFlashBorrowIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  reserveSourceLiquidity: PublicKey;
  userDestinationLiquidity: PublicKey;
  liquidityTokenProgram: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:flash_borrow_reserve_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: false },             // user_transfer_authority
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: args.reserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
      { pubkey: args.reserveSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: args.userDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: feeReceiverPda(args.reserve), isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },        // referrer_token_state = None sentinel
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },        // referrer_account = None sentinel
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * Build klend `flash_repay_reserve_liquidity`. `borrowInstructionIndex`
 * is the position of the matching flash_borrow ix in the outer tx
 * (zero-indexed from the start of the tx, NOT including the
 * sysvar-instructions header). klend reads sysvar-instructions to
 * locate the borrow and verify the amount matches.
 */
export async function buildFlashRepayIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  reserveDestinationLiquidity: PublicKey;
  userSourceLiquidity: PublicKey;
  liquidityTokenProgram: PublicKey;
  amount: bigint;
  borrowInstructionIndex: number;
}): Promise<TransactionInstruction> {
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const data = new Uint8Array(8 + 8 + 1);
  data.set(await sha256_8("global:flash_repay_reserve_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);
  data[16] = args.borrowInstructionIndex;

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: false },             // user_transfer_authority
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: args.reserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
      { pubkey: args.reserveDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: args.userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: feeReceiverPda(args.reserve), isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },        // referrer_token_state = None
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },        // referrer_account = None
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * Build `deposit_reserve_liquidity_and_obligation_collateral` for
 * csSOL-WT (the inverse of `buildDepositCsSolIx`). Mirrors the same
 * 14-account layout but parameterized for any reserve.
 */
export async function buildDepositLiquidityAndCollateralIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user);
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const liqSupply = reserveLiqSupply(args.reserve);
  const collMint = reserveCollMint(args.reserve);
  const collDest = reserveCollSupply(args.reserve);

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:deposit_reserve_liquidity_and_obligation_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: args.reserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: true },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collDest, isSigner: false, isWritable: true },
      { pubkey: args.userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },          // placeholderUserDestinationCollateral
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },       // collateralTokenProgram
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * Build `withdraw_obligation_collateral_and_redeem_reserve_collateral` —
 * the inverse of `deposit_reserve_liquidity_and_obligation_collateral`.
 * Withdraws `amount` cTokens from the obligation, redeems them for the
 * underlying liquidity, and credits the user's liquidity ATA.
 */
export async function buildWithdrawCollateralAndRedeemIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userDestinationLiquidity: PublicKey;
  collateralAmount: bigint;
  refreshObligationDeposits: PublicKey[]; // already-fresh deposit reserves to pass to klend's check_refresh
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user);
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const liqSupply = reserveLiqSupply(args.reserve);
  const collMint = reserveCollMint(args.reserve);
  const collSrc = reserveCollSupply(args.reserve);

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:withdraw_obligation_collateral_and_redeem_reserve_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, args.collateralAmount, true);

  // Account ordering per @kamino-finance/klend-sdk (verified):
  //  0 owner (W, signer)
  //  1 obligation (W)
  //  2 lending_market (RO)
  //  3 lending_market_authority (RO)
  //  4 withdraw_reserve (W)
  //  5 reserve_liquidity_mint (RO)               ← read-only!
  //  6 reserve_source_collateral (= reserve_coll_supply PDA) (W)
  //  7 reserve_collateral_mint (W)
  //  8 reserve_liquidity_supply (W)
  //  9 user_destination_liquidity (W)
  // 10 placeholder_user_destination_collateral (RO, None sentinel = klend program id)
  // 11 collateral_token_program (RO)
  // 12 liquidity_token_program (RO)
  // 13 instruction_sysvar_account (RO)
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: args.reserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
      { pubkey: collSrc, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: args.userDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      // remaining: deposit reserves passed to refresh_obligation logic
      ...args.refreshObligationDeposits.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

void KLEND_GLOBAL_CONFIG;

/** Build klend `borrow_obligation_liquidity`. Caller must precede with
 *  refresh_reserve(borrowReserve) at N-2 and refresh_obligation at N-1. */
export async function buildBorrowObligationLiquidityIx(args: {
  user: PublicKey;
  borrowReserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userDestinationLiquidity: PublicKey;
  amount: bigint;
  /** Every non-zero deposit reserve in the obligation. klend
   *  iterates these as remaining_accounts to compute max borrow
   *  value and verify the new LTV — missing them surfaces as
   *  InvalidAccountInput (6006) at lending_operations.rs:2760. */
  obligationDepositReserves?: PublicKey[];
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user);
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const liqSupply = reserveLiqSupply(args.borrowReserve);
  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:borrow_obligation_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  const keys = [
    { pubkey: args.user, isSigner: true, isWritable: true },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
    { pubkey: lma, isSigner: false, isWritable: false },
    { pubkey: args.borrowReserve, isSigner: false, isWritable: true },
    { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
    { pubkey: liqSupply, isSigner: false, isWritable: true },
    { pubkey: feeReceiverPda(args.borrowReserve), isSigner: false, isWritable: true },
    { pubkey: args.userDestinationLiquidity, isSigner: false, isWritable: true },
    { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false }, // referrer_token_state = None
    { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    // Remaining accounts: obligation's deposit reserves (writable per
    // klend SDK addBorrowObligationLiquidityIx convention).
    ...(args.obligationDepositReserves ?? []).map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
  ];

  return new TransactionInstruction({ programId: KLEND_PROGRAM, keys, data: Buffer.from(data) });
}

/** Build klend `repay_obligation_liquidity`. Caller must precede with
 *  refresh_reserve(repayReserve) at N-2 and refresh_obligation at N-1.
 *
 *  When the obligation is in an elevation group (EG > 0), klend's repay
 *  handler requires every obligation deposit reserve appended as
 *  remaining_accounts (writable) — same rule as `borrow_obligation_liquidity`.
 *  Mirrors klend SDK addRepayIx (action.ts:1577). Pass `obligationDepositReserves`
 *  for EG positions; omit for non-EG. */
export async function buildRepayObligationLiquidityIx(args: {
  user: PublicKey;
  repayReserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
  obligationDepositReserves?: PublicKey[];
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user);
  const liqSupply = reserveLiqSupply(args.repayReserve);
  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:repay_obligation_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: args.repayReserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: args.userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ...(args.obligationDepositReserves ?? []).map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}
