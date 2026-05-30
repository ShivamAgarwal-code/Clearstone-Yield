/**
 * redeemCeusx.ts — Builders for the leveraged ceUSX redemption flow:
 *
 *   1. **Convert** (atomic, single tx): swap the user's ceUSX collateral
 *      for ceUSX-WT collateral by flash-borrowing WT, depositing it,
 *      withdrawing ceUSX, unwrapping ceUSX → eUSX, calling Solstice's
 *      `Unlock` (which queues a per-user pending-unlock PDA), then
 *      flash-repaying the WT — all inside a single tx.
 *   2. **Wait**: the Solstice pending-unlock PDA matures off-chain
 *      (epoch-style timer; not modelled in this UI — the user retries
 *      the unwind step until it succeeds).
 *   3. **Unwind** (atomic, single tx): once mature, flash-borrow sUSDC,
 *      repay the obligation's USDC debt, withdraw the WT collateral,
 *      run governor::redeem_ceusx_wt (burns WT, CPIs Solstice.Withdraw
 *      → fills the user's USX ATA), call Solstice
 *      RequestRedeem + ConfirmRedeem (USX → USDC), then flash-repay the
 *      sUSDC.
 *
 * Mirrors `frontend-playground/src/lib/eusxConvertWt.ts`. See
 * `packages/programs/CEUSX_WITHDRAWAL.md` for the full architecture.
 *
 * Per-user PDA discovery: Solstice's Unlock and Withdraw ixes reference
 * per-user PDAs whose seeds we don't have an IDL for. We recover them by
 * calling Solstice's REST API with the user pubkey — the API returns a
 * fully-templated ix whose accounts include the derived per-user PDAs at
 * known indices. We extract those and pass them through to the
 * governor's CPI accounts list.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { DEVNET_CONFIG } from "../../config/devnet";
import { getObligationPda } from "../obligation";
import { callSolsticeRaw } from "./solsticeApi";

// ── address constants ─────────────────────────────────────────────────
//
// `DEVNET_CONFIG` covers everything the institutional v3 stack needs,
// but the ceUSX→eUSX `unwrap` ix is still hosted by the *legacy*
// governor program (the ceUSX MintConfig was never re-issued under the
// v3 governor). Same for the legacy delta-mint program that owns the
// ceUSX whitelist PDA. Both are intentionally absent from
// `DEVNET_CONFIG` (which states "v3 only"); we pin them here so the
// redemption flow is self-contained.

const LEGACY_GOVERNOR_PROGRAM   = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const LEGACY_DELTA_MINT_PROGRAM = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

// The ceUSX-WT MintConfig was minted under the *new* delta-mint program
// (`DEVNET_CONFIG.programs.deltaMint`) but its mint authority isn't
// surfaced in DEVNET_CONFIG.tokens — pinning it here.
const CEUSX_WT_DM_MINT_AUTHORITY = new PublicKey("6DBg4SjWuf2FYwvuTUuzv8JaHvdcD1TwwBRuSsj3Yjbv");

const KLEND_PROGRAM     = DEVNET_CONFIG.programs.klend;
const KLEND_MARKET      = DEVNET_CONFIG.market.lendingMarket;
const GOVERNOR_PROGRAM  = DEVNET_CONFIG.programs.governor;
const NEW_DELTA_MINT    = DEVNET_CONFIG.programs.deltaMint;
const YIELD_VAULT_PROG  = DEVNET_CONFIG.solstice.yieldVaultProgram;

const CEUSX_MINT          = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");
const CEUSX_WT_MINT       = new PublicKey("DoHMuKFU4b2co2CBBcNjVzWf6yL3KG5H2N9FxkfFFN6A");
const EUSX_MINT           = DEVNET_CONFIG.solstice.eusx;
const USX_MINT            = DEVNET_CONFIG.solstice.usx;
const SUSDC_MINT          = DEVNET_CONFIG.market.sUsdcMint;

const CEUSX_RESERVE       = DEVNET_CONFIG.market.ceUsxReserve;
const CEUSX_WT_RESERVE    = new PublicKey("GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq");
const SUSDC_RESERVE       = DEVNET_CONFIG.market.sUsdcReserve;

const CEUSX_ORACLE        = DEVNET_CONFIG.oracles.ceUsxOracle;
const SUSDC_ORACLE        = DEVNET_CONFIG.oracles.sUsdcOracle;

const CEUSX_WT_DM_MINT_CONFIG = new PublicKey("852Tq2XMRxkNPGQ7sEQoi2dWZrK3sHmbLZ3QDapEEYng");
// The ceUSX-WT MintConfig.authority on-chain is the *cSOL* host pool —
// see the ceUSX-WT entry in DEVNET_CONFIG.tokens (.pool). The cSOL pool
// owns multiple WT MintConfigs (cSOL-WT and ceUSX-WT) by design.
const CEUSX_WT_HOST_POOL  = DEVNET_CONFIG.csolPool.poolConfig;

// The ceUSX/eUSX wrap/unwrap ixes target the *ceUSX* pool (legacy
// governor). DEVNET_CONFIG.tokens entry for ceUSX has this address.
const EUSX_POOL_PDA       = new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");

// ── helpers ───────────────────────────────────────────────────────────

const enc = new TextEncoder();
async function sha256_8(input: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return new Uint8Array(h, 0, 8);
}
function pda(seeds: (Uint8Array | Buffer)[], program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}
function lendingMarketAuthority(): PublicKey {
  return pda([enc.encode("lma"), KLEND_MARKET.toBuffer()], KLEND_PROGRAM);
}
function reserveLiqSupply(reserve: PublicKey): PublicKey {
  return pda([enc.encode("reserve_liq_supply"), reserve.toBuffer()], KLEND_PROGRAM);
}
function reserveCollMint(reserve: PublicKey): PublicKey {
  return pda([enc.encode("reserve_coll_mint"), reserve.toBuffer()], KLEND_PROGRAM);
}
function reserveCollSupply(reserve: PublicKey): PublicKey {
  return pda([enc.encode("reserve_coll_supply"), reserve.toBuffer()], KLEND_PROGRAM);
}
function feeReceiverPda(reserve: PublicKey): PublicKey {
  return pda([enc.encode("fee_receiver"), reserve.toBuffer()], KLEND_PROGRAM);
}
function newGovernorWhitelistPda(mintConfig: PublicKey, user: PublicKey): PublicKey {
  return pda([enc.encode("whitelist"), mintConfig.toBuffer(), user.toBuffer()], NEW_DELTA_MINT);
}

// ── klend ix builders (subset needed for this flow) ────────────────────

async function buildRefreshReserveIx(reserve: PublicKey, oracle: PublicKey): Promise<TransactionInstruction> {
  const data = new Uint8Array(8);
  data.set(await sha256_8("global:refresh_reserve"), 0);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: reserve,        isSigner: false, isWritable: true  },
      { pubkey: KLEND_MARKET,   isSigner: false, isWritable: false },
      { pubkey: oracle,         isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM,  isSigner: false, isWritable: false }, // oracle.scope = None
      { pubkey: KLEND_PROGRAM,  isSigner: false, isWritable: false }, // oracle.switchboardTwap = None
      { pubkey: KLEND_PROGRAM,  isSigner: false, isWritable: false }, // oracle.switchboardPrice = None
    ],
    data: Buffer.from(data),
  });
}

async function buildRefreshObligationIx(user: PublicKey, depositReserves: PublicKey[]): Promise<TransactionInstruction> {
  const obligation = getObligationPda(user);
  const data = new Uint8Array(8);
  data.set(await sha256_8("global:refresh_obligation"), 0);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: obligation,   isSigner: false, isWritable: true  },
      ...depositReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from(data),
  });
}

async function buildFlashBorrowIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  reserveSourceLiquidity: PublicKey;
  userDestinationLiquidity: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const data = new Uint8Array(16);
  data.set(await sha256_8("global:flash_borrow_reserve_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user,                       isSigner: true,  isWritable: false },
      { pubkey: lendingMarketAuthority(),        isSigner: false, isWritable: false },
      { pubkey: KLEND_MARKET,                    isSigner: false, isWritable: false },
      { pubkey: args.reserve,                    isSigner: false, isWritable: true  },
      { pubkey: args.liquidityMint,              isSigner: false, isWritable: false },
      { pubkey: args.reserveSourceLiquidity,     isSigner: false, isWritable: true  },
      { pubkey: args.userDestinationLiquidity,   isSigner: false, isWritable: true  },
      { pubkey: feeReceiverPda(args.reserve),    isSigner: false, isWritable: true  },
      { pubkey: KLEND_PROGRAM,                   isSigner: false, isWritable: false }, // referrer_token_state = None
      { pubkey: KLEND_PROGRAM,                   isSigner: false, isWritable: false }, // referrer_account = None
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,      isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram,      isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

async function buildFlashRepayIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  reserveDestinationLiquidity: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
  borrowInstructionIndex: number;
}): Promise<TransactionInstruction> {
  const data = new Uint8Array(8 + 8 + 1);
  data.set(await sha256_8("global:flash_repay_reserve_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);
  data[16] = args.borrowInstructionIndex;
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user,                          isSigner: true,  isWritable: false },
      { pubkey: lendingMarketAuthority(),           isSigner: false, isWritable: false },
      { pubkey: KLEND_MARKET,                       isSigner: false, isWritable: false },
      { pubkey: args.reserve,                       isSigner: false, isWritable: true  },
      { pubkey: args.liquidityMint,                 isSigner: false, isWritable: false },
      { pubkey: args.reserveDestinationLiquidity,   isSigner: false, isWritable: true  },
      { pubkey: args.userSourceLiquidity,           isSigner: false, isWritable: true  },
      { pubkey: feeReceiverPda(args.reserve),       isSigner: false, isWritable: true  },
      { pubkey: KLEND_PROGRAM,                      isSigner: false, isWritable: false },
      { pubkey: KLEND_PROGRAM,                      isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,         isSigner: false, isWritable: false },
      { pubkey: args.liquidityTokenProgram,         isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

async function buildDepositLiquidityAndCollateralIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const data = new Uint8Array(16);
  data.set(await sha256_8("global:deposit_reserve_liquidity_and_obligation_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user,                                isSigner: true,  isWritable: true  },
      { pubkey: getObligationPda(args.user),              isSigner: false, isWritable: true  },
      { pubkey: KLEND_MARKET,                             isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority(),                 isSigner: false, isWritable: false },
      { pubkey: args.reserve,                             isSigner: false, isWritable: true  },
      { pubkey: args.liquidityMint,                       isSigner: false, isWritable: true  },
      { pubkey: reserveLiqSupply(args.reserve),           isSigner: false, isWritable: true  },
      { pubkey: reserveCollMint(args.reserve),            isSigner: false, isWritable: true  },
      { pubkey: reserveCollSupply(args.reserve),          isSigner: false, isWritable: true  },
      { pubkey: args.userSourceLiquidity,                 isSigner: false, isWritable: true  },
      { pubkey: KLEND_PROGRAM,                            isSigner: false, isWritable: false }, // placeholder user dest collateral
      { pubkey: TOKEN_PROGRAM_ID,                         isSigner: false, isWritable: false }, // collateral token program
      { pubkey: args.liquidityTokenProgram,               isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,               isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

async function buildWithdrawCollateralAndRedeemIx(args: {
  user: PublicKey;
  reserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userDestinationLiquidity: PublicKey;
  collateralAmount: bigint;
  refreshObligationDeposits: PublicKey[];
}): Promise<TransactionInstruction> {
  const data = new Uint8Array(16);
  data.set(await sha256_8("global:withdraw_obligation_collateral_and_redeem_reserve_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, args.collateralAmount, true);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user,                              isSigner: true,  isWritable: true  },
      { pubkey: getObligationPda(args.user),            isSigner: false, isWritable: true  },
      { pubkey: KLEND_MARKET,                           isSigner: false, isWritable: false },
      { pubkey: lendingMarketAuthority(),               isSigner: false, isWritable: false },
      { pubkey: args.reserve,                           isSigner: false, isWritable: true  },
      { pubkey: args.liquidityMint,                     isSigner: false, isWritable: false },
      { pubkey: reserveCollSupply(args.reserve),        isSigner: false, isWritable: true  },
      { pubkey: reserveCollMint(args.reserve),          isSigner: false, isWritable: true  },
      { pubkey: reserveLiqSupply(args.reserve),         isSigner: false, isWritable: true  },
      { pubkey: args.userDestinationLiquidity,          isSigner: false, isWritable: true  },
      { pubkey: KLEND_PROGRAM,                          isSigner: false, isWritable: false }, // placeholder
      { pubkey: TOKEN_PROGRAM_ID,                       isSigner: false, isWritable: false }, // coll token program
      { pubkey: args.liquidityTokenProgram,             isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,             isSigner: false, isWritable: false },
      ...args.refreshObligationDeposits.map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

async function buildRepayObligationLiquidityIx(args: {
  user: PublicKey;
  repayReserve: PublicKey;
  liquidityMint: PublicKey;
  liquidityTokenProgram: PublicKey;
  userSourceLiquidity: PublicKey;
  amount: bigint;
  obligationDepositReserves?: PublicKey[];
}): Promise<TransactionInstruction> {
  const data = new Uint8Array(16);
  data.set(await sha256_8("global:repay_obligation_liquidity"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: args.user,                              isSigner: true,  isWritable: true  },
      { pubkey: getObligationPda(args.user),            isSigner: false, isWritable: true  },
      { pubkey: KLEND_MARKET,                           isSigner: false, isWritable: false },
      { pubkey: args.repayReserve,                      isSigner: false, isWritable: true  },
      { pubkey: args.liquidityMint,                     isSigner: false, isWritable: false },
      { pubkey: reserveLiqSupply(args.repayReserve),    isSigner: false, isWritable: true  },
      { pubkey: args.userSourceLiquidity,               isSigner: false, isWritable: true  },
      { pubkey: args.liquidityTokenProgram,             isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,             isSigner: false, isWritable: false },
      ...(args.obligationDepositReserves ?? []).map((r) => ({ pubkey: r, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from(data),
  });
}

// ── governor / Solstice ix builders ────────────────────────────────────

async function buildLegacyUnwrapCeusxIx(user: PublicKey, amount: bigint): Promise<TransactionInstruction> {
  const userEusxAta  = getAssociatedTokenAddressSync(EUSX_MINT,  user, false, TOKEN_PROGRAM_ID,    ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultEusxAta = getAssociatedTokenAddressSync(EUSX_MINT,  EUSX_POOL_PDA, true,  TOKEN_PROGRAM_ID,    ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCeusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:unwrap"), 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);

  return new TransactionInstruction({
    programId: LEGACY_GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: user,                  isSigner: true,  isWritable: true  },
      { pubkey: EUSX_POOL_PDA,         isSigner: false, isWritable: false },
      { pubkey: EUSX_MINT,             isSigner: false, isWritable: false },
      { pubkey: userEusxAta,           isSigner: false, isWritable: true  },
      { pubkey: vaultEusxAta,          isSigner: false, isWritable: true  },
      { pubkey: CEUSX_MINT,            isSigner: false, isWritable: true  },
      { pubkey: userCeusxAta,          isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

async function buildEnqueueEusxUnlockViaPoolIx(args: {
  user: PublicKey;
  amount: bigint;
  apiKey: string;
}): Promise<TransactionInstruction> {
  // Solstice probe: extract the per-user PDAs + vault state from a real
  // `Unlock` ix. Discovered indices match the playground's eusxConvertWt.
  const probeIxes = await callSolsticeRaw(args.apiKey, {
    type: "Unlock",
    data: { amount: Number(args.amount), user: args.user.toBase58() },
  });
  if (probeIxes.length !== 1) throw new Error("Solstice Unlock probe returned unexpected ix count");
  const probeAccs = probeIxes[0].keys;
  if (probeAccs.length < 13) throw new Error(`Solstice Unlock probe returned ${probeAccs.length} accs, expected 13`);

  const solsticeVaultState        = probeAccs[2].pubkey;
  const solsticeVaultEusxAccount  = probeAccs[3].pubkey;
  const solsticeConfigA           = probeAccs[7].pubkey;
  const solsticeConfigB           = probeAccs[8].pubkey;
  const userPendingUnlockPda      = probeAccs[9].pubkey;
  const userPendingUnlockPdaB     = probeAccs[10].pubkey;
  const solsticeTokenProgram      = probeAccs[11].pubkey;

  const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT,     args.user, false, TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtAta   = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtWhitelist = newGovernorWhitelistPda(CEUSX_WT_DM_MINT_CONFIG, args.user);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:enqueue_eusx_unlock_via_pool"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user,                    isSigner: true,  isWritable: true  },
      { pubkey: CEUSX_WT_HOST_POOL,           isSigner: false, isWritable: true  },

      // ceUSX-WT mint side
      { pubkey: CEUSX_WT_DM_MINT_CONFIG,      isSigner: false, isWritable: true  },
      { pubkey: CEUSX_WT_MINT,                isSigner: false, isWritable: true  },
      { pubkey: CEUSX_WT_DM_MINT_AUTHORITY,   isSigner: false, isWritable: false },
      { pubkey: userWtWhitelist,              isSigner: false, isWritable: false },
      { pubkey: userWtAta,                    isSigner: false, isWritable: true  },
      { pubkey: NEW_DELTA_MINT,               isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,        isSigner: false, isWritable: false },

      // Solstice Unlock side
      { pubkey: YIELD_VAULT_PROG,             isSigner: false, isWritable: false },
      { pubkey: solsticeVaultState,           isSigner: false, isWritable: true  },
      { pubkey: solsticeVaultEusxAccount,     isSigner: false, isWritable: true  },
      { pubkey: EUSX_MINT,                    isSigner: false, isWritable: true  },
      { pubkey: userEusxAta,                  isSigner: false, isWritable: true  },
      { pubkey: USX_MINT,                     isSigner: false, isWritable: true  },
      { pubkey: solsticeConfigA,              isSigner: false, isWritable: true  },
      { pubkey: solsticeConfigB,              isSigner: false, isWritable: true  },
      { pubkey: userPendingUnlockPda,         isSigner: false, isWritable: true  },
      { pubkey: userPendingUnlockPdaB,        isSigner: false, isWritable: true  },
      { pubkey: solsticeTokenProgram,         isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,      isSigner: false, isWritable: false },
    ],
  });
}

async function buildRedeemCeusxWtIx(args: {
  user: PublicKey;
  amount: bigint;
  apiKey: string;
}): Promise<TransactionInstruction> {
  const probeIxes = await callSolsticeRaw(args.apiKey, {
    type: "Withdraw",
    data: { amount: 1, user: args.user.toBase58() },
  });
  if (probeIxes.length !== 1) throw new Error("Solstice Withdraw probe returned unexpected ix count");
  const probeAccs = probeIxes[0].keys;
  if (probeAccs.length < 8) throw new Error(`Solstice Withdraw probe returned ${probeAccs.length} accs, expected 8`);

  const solsticeVaultState      = probeAccs[2].pubkey;
  const userPendingUnlockPda    = probeAccs[4].pubkey;
  const solsticeVaultUsxAccount = probeAccs[6].pubkey;
  const solsticeTokenProgram    = probeAccs[7].pubkey;

  const userWtAta  = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userUsxAta = getAssociatedTokenAddressSync(USX_MINT,      args.user, false, TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:redeem_ceusx_wt"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user,                isSigner: true,  isWritable: true  },
      { pubkey: CEUSX_WT_HOST_POOL,       isSigner: false, isWritable: false },

      { pubkey: CEUSX_WT_MINT,            isSigner: false, isWritable: true  },
      { pubkey: userWtAta,                isSigner: false, isWritable: true  },
      { pubkey: TOKEN_2022_PROGRAM_ID,    isSigner: false, isWritable: false },

      { pubkey: YIELD_VAULT_PROG,         isSigner: false, isWritable: false },
      { pubkey: solsticeVaultState,       isSigner: false, isWritable: true  },
      { pubkey: USX_MINT,                 isSigner: false, isWritable: true  },
      { pubkey: userPendingUnlockPda,     isSigner: false, isWritable: true  },
      { pubkey: userUsxAta,               isSigner: false, isWritable: true  },
      { pubkey: solsticeVaultUsxAccount,  isSigner: false, isWritable: true  },
      { pubkey: solsticeTokenProgram,     isSigner: false, isWritable: false },
    ],
  });
}

// ── public API ────────────────────────────────────────────────────────

export interface ConvertCeusxArgs {
  user: PublicKey;
  /** Amount of ceUSX (and ceUSX-WT) to swap. Same value flows through:
   *  flash-borrow X WT → deposit X WT → withdraw X ceUSX → unwrap →
   *  Solstice.Unlock(X) → mint X WT → flash-repay X WT. */
  amount: bigint;
  apiKey: string;
  /** Klend obligation deposit reserves at tx start — these go into the
   *  refresh chain. Pass the output of `findObligationReserves`. */
  obligationDeposits: PublicKey[];
}

/** Build the **convert** tx (Stage 1 of redemption): atomically swaps
 *  the user's ceUSX collateral for ceUSX-WT collateral and queues the
 *  Solstice unlock. After this confirms the user must wait for the
 *  pending-unlock PDA to mature, then call `buildUnwindCeusxWtIxes`. */
export async function buildConvertCeusxIxes(args: ConvertCeusxArgs): Promise<TransactionInstruction[]> {
  const userCeusxAta = getAssociatedTokenAddressSync(CEUSX_MINT,    args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userEusxAta  = getAssociatedTokenAddressSync(EUSX_MINT,     args.user, false, TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID);
  const userUsxAta   = getAssociatedTokenAddressSync(USX_MINT,      args.user, false, TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtAta    = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const refreshReserves = new Set<string>();
  for (const r of args.obligationDeposits) refreshReserves.add(r.toBase58());
  refreshReserves.add(CEUSX_WT_RESERVE.toBase58());
  refreshReserves.add(CEUSX_RESERVE.toBase58());
  refreshReserves.add(SUSDC_RESERVE.toBase58());

  const oracleByReserve: Record<string, PublicKey> = {
    [CEUSX_WT_RESERVE.toBase58()]: CEUSX_ORACLE, // shares ceUSX oracle on devnet (1:1)
    [CEUSX_RESERVE.toBase58()]:    CEUSX_ORACLE,
    [SUSDC_RESERVE.toBase58()]:    SUSDC_ORACLE,
  };

  const refreshIxes: TransactionInstruction[] = [];
  for (const r of refreshReserves) {
    refreshIxes.push(await buildRefreshReserveIx(new PublicKey(r), oracleByReserve[r] ?? CEUSX_ORACLE));
  }
  // Re-push the action targets so they land at N-2 of the next ix
  // (klend's check_refresh constraint).
  refreshIxes.push(await buildRefreshReserveIx(CEUSX_WT_RESERVE, CEUSX_ORACLE));
  refreshIxes.push(await buildRefreshObligationIx(args.user, [...args.obligationDeposits]));

  const enqueueIx     = await buildEnqueueEusxUnlockViaPoolIx({ user: args.user, amount: args.amount, apiKey: args.apiKey });
  const unwrapCeusxIx = await buildLegacyUnwrapCeusxIx(args.user, args.amount);

  const flashBorrowIx = await buildFlashBorrowIx({
    user: args.user,
    reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    reserveSourceLiquidity: reserveLiqSupply(CEUSX_WT_RESERVE),
    userDestinationLiquidity: userWtAta,
    amount: args.amount,
  });
  const depositWtIx = await buildDepositLiquidityAndCollateralIx({
    user: args.user, reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userSourceLiquidity: userWtAta, amount: args.amount,
  });
  const withdrawCeusxIx = await buildWithdrawCollateralAndRedeemIx({
    user: args.user, reserve: CEUSX_RESERVE,
    liquidityMint: CEUSX_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userCeusxAta, collateralAmount: args.amount,
    refreshObligationDeposits: args.obligationDeposits,
  });

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userCeusxAta, args.user, CEUSX_MINT,    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userEusxAta,  args.user, EUSX_MINT,     TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userUsxAta,   args.user, USX_MINT,      TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userWtAta,    args.user, CEUSX_WT_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    flashBorrowIx,
    depositWtIx,
    ...refreshIxes,
    withdrawCeusxIx,
    unwrapCeusxIx,
    enqueueIx,
    // flashRepayIx is appended below once we know flash_borrow's index.
  ];

  const flashBorrowPosition = ixes.indexOf(flashBorrowIx);
  const flashRepayIx = await buildFlashRepayIx({
    user: args.user,
    reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT,
    liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    reserveDestinationLiquidity: reserveLiqSupply(CEUSX_WT_RESERVE),
    userSourceLiquidity: userWtAta,
    amount: args.amount,
    borrowInstructionIndex: flashBorrowPosition,
  });
  ixes.push(flashRepayIx);
  return ixes;
}

export interface UnwindCeusxWtArgs {
  user: PublicKey;
  /** Amount of ceUSX-WT to redeem (also amount of sUSDC to flash-borrow,
   *  repay, and final-redeem; assumes 1:1 USX:USDC on devnet). */
  amount: bigint;
  apiKey: string;
  obligationDeposits: PublicKey[];
}

/** Build the **unwind** tx (Stage 3 of redemption): atomically repays
 *  the obligation's USDC debt with a flash-borrow, withdraws ceUSX-WT,
 *  redeems it through Solstice (USX → USDC) and flash-repays the
 *  borrow. Will fail if the user's pending-unlock PDA hasn't matured. */
export async function buildUnwindCeusxWtIxes(args: UnwindCeusxWtArgs): Promise<TransactionInstruction[]> {
  const userUsdcAta = getAssociatedTokenAddressSync(SUSDC_MINT,    args.user, false, TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID);
  const userUsxAta  = getAssociatedTokenAddressSync(USX_MINT,      args.user, false, TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID);
  const userWtAta   = getAssociatedTokenAddressSync(CEUSX_WT_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const refreshReserves = new Set<string>();
  for (const r of args.obligationDeposits) refreshReserves.add(r.toBase58());
  refreshReserves.add(CEUSX_WT_RESERVE.toBase58());
  refreshReserves.add(SUSDC_RESERVE.toBase58());
  const oracleByReserve: Record<string, PublicKey> = {
    [CEUSX_WT_RESERVE.toBase58()]: CEUSX_ORACLE,
    [SUSDC_RESERVE.toBase58()]:    SUSDC_ORACLE,
  };
  const refreshIxes: TransactionInstruction[] = [];
  for (const r of refreshReserves) {
    refreshIxes.push(await buildRefreshReserveIx(new PublicKey(r), oracleByReserve[r] ?? CEUSX_ORACLE));
  }
  refreshIxes.push(await buildRefreshReserveIx(SUSDC_RESERVE, SUSDC_ORACLE));
  refreshIxes.push(await buildRefreshObligationIx(args.user, [...args.obligationDeposits]));

  const [reqRedeemIxes, confRedeemIxes] = await Promise.all([
    callSolsticeRaw(args.apiKey, { type: "RequestRedeem", data: { amount: Number(args.amount), collateral: "usdc", user: args.user.toBase58() } }),
    callSolsticeRaw(args.apiKey, { type: "ConfirmRedeem", data: { user: args.user.toBase58(), collateral: "usdc" } }),
  ]);

  const flashBorrowIx = await buildFlashBorrowIx({
    user: args.user,
    reserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    reserveSourceLiquidity: reserveLiqSupply(SUSDC_RESERVE),
    userDestinationLiquidity: userUsdcAta,
    amount: args.amount,
  });
  const repayIx = await buildRepayObligationLiquidityIx({
    user: args.user, repayReserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
    userSourceLiquidity: userUsdcAta, amount: args.amount,
    obligationDepositReserves: args.obligationDeposits,
  });
  const withdrawWtIx = await buildWithdrawCollateralAndRedeemIx({
    user: args.user, reserve: CEUSX_WT_RESERVE,
    liquidityMint: CEUSX_WT_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
    userDestinationLiquidity: userWtAta, collateralAmount: args.amount,
    refreshObligationDeposits: args.obligationDeposits,
  });
  const redeemWtIx = await buildRedeemCeusxWtIx({ user: args.user, amount: args.amount, apiKey: args.apiKey });

  const ixes: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userUsdcAta, args.user, SUSDC_MINT,    TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userUsxAta,  args.user, USX_MINT,      TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(args.user, userWtAta,   args.user, CEUSX_WT_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    flashBorrowIx,
    ...refreshIxes,
    repayIx,
    withdrawWtIx,
    redeemWtIx,
    ...reqRedeemIxes,
    ...confRedeemIxes,
    // flashRepayIx appended below.
  ];

  const flashBorrowPosition = ixes.indexOf(flashBorrowIx);
  const flashRepayIx = await buildFlashRepayIx({
    user: args.user,
    reserve: SUSDC_RESERVE,
    liquidityMint: SUSDC_MINT,
    liquidityTokenProgram: TOKEN_PROGRAM_ID,
    reserveDestinationLiquidity: reserveLiqSupply(SUSDC_RESERVE),
    userSourceLiquidity: userUsdcAta,
    amount: args.amount,
    borrowInstructionIndex: flashBorrowPosition,
  });
  ixes.push(flashRepayIx);
  return ixes;
}
