/**
 * klendIx.ts — Kamino Lend ix builders for the credit-trade flows.
 * Renamed from playground's `klend.ts` to avoid clash with the existing
 * `src/lib/lib/klend.ts` (which has a narrower deposit/redeem-only API).
 * Verbatim port; do not refactor without re-checking the load-bearing
 * `check_refresh` ordering and `borrowInstructionIndex` invariants.
 */
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

async function sha256_8(input: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(h).slice(0, 8);
}

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

export async function buildInitUserMetadataIx(owner: PublicKey, feePayer: PublicKey): Promise<TransactionInstruction> {
  const userMeta = userMetadataPda(owner);
  const data = new Uint8Array(8 + 32);
  data.set(await sha256_8("global:init_user_metadata"), 0);
  data.set(DEFAULT.toBuffer(), 8);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: userMeta, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildInitObligationIx(owner: PublicKey, feePayer: PublicKey, tag = 0, id = 0): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner, tag, id);
  const userMeta = userMetadataPda(owner);
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
      { pubkey: DEFAULT, isSigner: false, isWritable: false },
      { pubkey: DEFAULT, isSigner: false, isWritable: false },
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
  id = 0,
): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner, 0, id);
  const data = new Uint8Array(8 + 1);
  data.set(await sha256_8("global:request_elevation_group"), 0);
  data[8] = group;
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
      { pubkey: oracle, isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildRefreshObligationIx(
  owner: PublicKey,
  depositReserves: PublicKey[],
  borrowReserves: PublicKey[] = [],
  id = 0,
): Promise<TransactionInstruction> {
  const data = await sha256_8("global:refresh_obligation");
  const obligation = obligationPda(owner, 0, id);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      ...depositReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
      ...borrowReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

export async function buildDepositCsSolIx(owner: PublicKey, amount: bigint, id = 0): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner, 0, id);
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
      { pubkey: CSSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: liquiditySupply, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collDest, isSigner: false, isWritable: true },
      { pubkey: userSource, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export const KLEND_RESERVES = { csSOL: CSSOL_RESERVE, wSOL: WSOL_RESERVE };

export function feeReceiverPda(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("fee_receiver"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}

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
      { pubkey: args.user, isSigner: true, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: args.reserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
      { pubkey: args.reserveSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: args.userDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: feeReceiverPda(args.reserve), isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

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
      { pubkey: args.user, isSigner: true, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: args.reserve, isSigner: false, isWritable: true },
      { pubkey: args.liquidityMint, isSigner: false, isWritable: false },
      { pubkey: args.reserveDestinationLiquidity, isSigner: false, isWritable: true },
      { pubkey: args.userSourceLiquidity, isSigner: false, isWritable: true },
      { pubkey: feeReceiverPda(args.reserve), isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildDepositLiquidityAndCollateralIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
  /** Klend obligation seed-id (0..255). Defaults to 0 — the credit-trade
   *  panel's traditional obligation. Pass a non-zero id when targeting
   *  a sibling obligation (multi-position-per-wallet). */
  obligationId?: number;
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user, 0, args.obligationId ?? 0);
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
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildWithdrawCollateralAndRedeemIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userDestinationLiquidity: PublicKey;
  collateralAmount: bigint;
  refreshObligationDeposits: PublicKey[];
  obligationId?: number;
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user, 0, args.obligationId ?? 0);
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const liqSupply = reserveLiqSupply(args.reserve);
  const collMint = reserveCollMint(args.reserve);
  const collSrc = reserveCollSupply(args.reserve);

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:withdraw_obligation_collateral_and_redeem_reserve_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, args.collateralAmount, true);

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
      ...args.refreshObligationDeposits.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

export async function buildBorrowObligationLiquidityIx(args: {
  user: PublicKey;
  borrowReserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userDestinationLiquidity: PublicKey;
  amount: bigint;
  obligationDepositReserves?: PublicKey[];
  obligationId?: number;
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user, 0, args.obligationId ?? 0);
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
    { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: args.liquidityTokenProgram, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...(args.obligationDepositReserves ?? []).map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
  ];

  return new TransactionInstruction({ programId: KLEND_PROGRAM, keys, data: Buffer.from(data) });
}

export async function buildRepayObligationLiquidityIx(args: {
  user: PublicKey;
  repayReserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
  obligationDepositReserves?: PublicKey[];
  obligationId?: number;
}): Promise<TransactionInstruction> {
  const obligation = obligationPda(args.user, 0, args.obligationId ?? 0);
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
