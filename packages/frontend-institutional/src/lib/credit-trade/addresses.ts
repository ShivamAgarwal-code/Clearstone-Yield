/**
 * addresses.ts — re-export shim over `config/devnet.ts` so the ported
 * playground libs (`creditTrade.ts`, `jitoVault.ts`, `cssolWt.ts`,
 * `klendIx.ts`, `obligationView.ts`) keep their original import shape
 * without duplicating env-driven pubkey definitions. The playground
 * exposes Vite env overrides for every constant; we mirror that pattern
 * so a devnet redeploy can be patched via .env without code edits.
 *
 * One source of truth = `DEVNET_CONFIG`. Anything not in that config is
 * pinned inline (LUTs, legacy programs).
 */

import { PublicKey } from "@solana/web3.js";
import { DEVNET_CONFIG } from "../../config/devnet";

const env = (k: string): string | undefined =>
  (import.meta.env as Record<string, string | undefined>)[k];

export const RPC_URL = env("VITE_RPC_URL") ?? DEVNET_CONFIG.rpc;

// ── Programs ─────────────────────────────────────────────────────────
export const JITO_VAULT_PROGRAM = new PublicKey(env("VITE_JITO_VAULT_PROGRAM") ?? DEVNET_CONFIG.programs.jitoVault.toBase58());
export const GOVERNOR_PROGRAM   = new PublicKey(env("VITE_GOVERNOR_PROGRAM")   ?? DEVNET_CONFIG.programs.governor.toBase58());
export const DELTA_MINT_PROGRAM = new PublicKey(env("VITE_DELTA_MINT_PROGRAM") ?? DEVNET_CONFIG.programs.deltaMint.toBase58());
export const KLEND_PROGRAM      = new PublicKey(env("VITE_KLEND_PROGRAM")      ?? DEVNET_CONFIG.programs.klend.toBase58());

// ── csSOL host pool ──────────────────────────────────────────────────
export const CSSOL_VAULT                  = new PublicKey(env("VITE_CSSOL_VAULT")                  ?? DEVNET_CONFIG.pool.jitoVault.toBase58());
export const CSSOL_VRT_MINT               = new PublicKey(env("VITE_CSSOL_VRT_MINT")               ?? DEVNET_CONFIG.pool.vrtMint.toBase58());
export const CSSOL_VAULT_ST_TOKEN_ACCOUNT = new PublicKey(env("VITE_CSSOL_VAULT_ST_TOKEN_ACCOUNT") ?? DEVNET_CONFIG.pool.vaultStTokenAccount.toBase58());
export const POOL_PDA          = new PublicKey(env("VITE_POOL_PDA")          ?? DEVNET_CONFIG.pool.poolConfig.toBase58());
export const CSSOL_MINT        = new PublicKey(env("VITE_CSSOL_MINT")        ?? DEVNET_CONFIG.pool.wrappedMint.toBase58());
export const DM_MINT_CONFIG    = new PublicKey(env("VITE_DM_MINT_CONFIG")    ?? DEVNET_CONFIG.pool.dmMintConfig.toBase58());
export const DM_MINT_AUTHORITY = new PublicKey(env("VITE_DM_MINT_AUTHORITY") ?? DEVNET_CONFIG.pool.dmMintAuthority.toBase58());
export const POOL_VRT_ATA      = new PublicKey(env("VITE_POOL_VRT_ATA")      ?? DEVNET_CONFIG.pool.poolVrtAta.toBase58());

// ── cSOL pool (margin host) ──────────────────────────────────────────
export const CSOL_MINT             = new PublicKey(env("VITE_CSOL_MINT")             ?? DEVNET_CONFIG.csolPool.wrappedMint.toBase58());
export const CSOL_POOL_PDA         = new PublicKey(env("VITE_CSOL_POOL_PDA")         ?? DEVNET_CONFIG.csolPool.poolConfig.toBase58());
export const CSOL_POOL_WSOL_VAULT  = new PublicKey(env("VITE_CSOL_POOL_WSOL_VAULT")  ?? DEVNET_CONFIG.csolPool.poolWsolVault.toBase58());
export const CSOL_DM_MINT_CONFIG   = new PublicKey(env("VITE_CSOL_DM_MINT_CONFIG")   ?? DEVNET_CONFIG.csolPool.dmMintConfig.toBase58());

// ── klend market + reserves ──────────────────────────────────────────
export const KLEND_MARKET = new PublicKey(env("VITE_KLEND_MARKET") ?? DEVNET_CONFIG.market.lendingMarket.toBase58());
export const CSSOL_RESERVE = new PublicKey(env("VITE_CSSOL_RESERVE") ?? DEVNET_CONFIG.market.csSolReserve.toBase58());
export const WSOL_RESERVE  = new PublicKey(env("VITE_WSOL_RESERVE")  ?? DEVNET_CONFIG.market.wsolReserve.toBase58());
export const CSSOL_RESERVE_ORACLE = new PublicKey(env("VITE_CSSOL_RESERVE_ORACLE") ?? DEVNET_CONFIG.oracles.csSolOracle.toBase58());
export const WSOL_RESERVE_ORACLE  = new PublicKey(env("VITE_WSOL_RESERVE_ORACLE")  ?? DEVNET_CONFIG.oracles.wsolOracle.toBase58());

export const ELEVATION_GROUP_LST_SOL       = DEVNET_CONFIG.elevationGroups.lstSol;
export const ELEVATION_GROUP_MARGIN_LONG   = DEVNET_CONFIG.elevationGroups.marginLongSol;
export const ELEVATION_GROUP_MARGIN_SHORT  = DEVNET_CONFIG.elevationGroups.marginShortSol;
export const MARGIN_PAIR_LTV_PCT           = 65;
export const MARGIN_PAIR_LIQ_THRESHOLD_PCT = 85;

// ── Stables (EG-1) ───────────────────────────────────────────────────
// ceUSX mint isn't a direct DEVNET_CONFIG.market field — pinned inline
// (also matches DEVNET_CONFIG.tokens[ceUSX].wrappedMint).
export const CEUSX_MINT  = new PublicKey(env("VITE_CEUSX_MINT")  ?? "8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");
export const CEUSX_RESERVE = new PublicKey(env("VITE_CEUSX_RESERVE") ?? DEVNET_CONFIG.market.ceUsxReserve.toBase58());
export const CEUSX_RESERVE_ORACLE = new PublicKey(env("VITE_CEUSX_RESERVE_ORACLE") ?? DEVNET_CONFIG.oracles.ceUsxOracle.toBase58());
export const SUSDC_MINT    = new PublicKey(env("VITE_SUSDC_MINT")    ?? DEVNET_CONFIG.market.sUsdcMint.toBase58());
export const SUSDC_RESERVE = new PublicKey(env("VITE_SUSDC_RESERVE") ?? DEVNET_CONFIG.market.sUsdcReserve.toBase58());
export const SUSDC_RESERVE_ORACLE = new PublicKey(env("VITE_SUSDC_RESERVE_ORACLE") ?? DEVNET_CONFIG.oracles.sUsdcOracle.toBase58());
export const ELEVATION_GROUP_STABLES = DEVNET_CONFIG.elevationGroups.stables;

// ── Legacy governor / delta-mint (eUSX pool) ─────────────────────────
export const LEGACY_GOVERNOR_PROGRAM   = new PublicKey(env("VITE_LEGACY_GOVERNOR_PROGRAM")   ?? "BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
export const LEGACY_DELTA_MINT_PROGRAM = new PublicKey(env("VITE_LEGACY_DELTA_MINT_PROGRAM") ?? "13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

// ── Solstice ─────────────────────────────────────────────────────────
export const USX_PROGRAM         = new PublicKey(env("VITE_USX_PROGRAM")         ?? "usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD");
export const YIELD_VAULT_PROGRAM = new PublicKey(env("VITE_YIELD_VAULT_PROGRAM") ?? DEVNET_CONFIG.solstice.yieldVaultProgram.toBase58());
export const USX_MINT  = new PublicKey(env("VITE_USX_MINT")  ?? DEVNET_CONFIG.solstice.usx.toBase58());
export const EUSX_MINT = new PublicKey(env("VITE_EUSX_MINT") ?? DEVNET_CONFIG.solstice.eusx.toBase58());

// Legacy governor pool config + delta-mint config for the eUSX → ceUSX wrap.
export const EUSX_POOL_PDA       = new PublicKey(env("VITE_EUSX_POOL_PDA")       ?? "5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");
export const EUSX_DM_MINT_CONFIG = new PublicKey(env("VITE_EUSX_DM_MINT_CONFIG") ?? "JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD");

export const SOLSTICE_API_URL = env("VITE_SOLSTICE_API") ?? "/api/solstice";

// ── ceUSX-WT ─────────────────────────────────────────────────────────
export const CEUSX_WT_MINT             = new PublicKey(env("VITE_CEUSX_WT_MINT")             ?? "DoHMuKFU4b2co2CBBcNjVzWf6yL3KG5H2N9FxkfFFN6A");
export const CEUSX_WT_DM_MINT_CONFIG   = new PublicKey(env("VITE_CEUSX_WT_DM_MINT_CONFIG")   ?? "852Tq2XMRxkNPGQ7sEQoi2dWZrK3sHmbLZ3QDapEEYng");
export const CEUSX_WT_DM_MINT_AUTHORITY = new PublicKey(env("VITE_CEUSX_WT_DM_MINT_AUTHORITY") ?? "6DBg4SjWuf2FYwvuTUuzv8JaHvdcD1TwwBRuSsj3Yjbv");
export const CEUSX_WT_RESERVE          = new PublicKey(env("VITE_CEUSX_WT_RESERVE")          ?? "GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq");
export const CEUSX_WT_HOST_POOL        = new PublicKey(env("VITE_CEUSX_WT_HOST_POOL")        ?? "7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ");

// ── LUTs ─────────────────────────────────────────────────────────────
// CREDIT_TRADE_LUT compresses the ~34 static pubkeys used by the open
// path; without it the 19-ix open tx overruns the 1232-byte legacy limit.
// The devnet LUT is shared with the playground deployment.
export const CREDIT_TRADE_LUT = new PublicKey(
  env("VITE_CREDIT_TRADE_LUT") ?? "GsQd5QNJUoSgxeUYKiyciiyoXNo4ozNJsxN1Fp1rXG9y",
);
const _usxFlowLut  = env("VITE_USX_FLOW_LUT");
const _depositLut  = env("VITE_DEPOSIT_LUT");
export const USX_FLOW_LUT: PublicKey | null = _usxFlowLut  ? new PublicKey(_usxFlowLut)  : null;
export const DEPOSIT_LUT:  PublicKey | null = _depositLut  ? new PublicKey(_depositLut)  : null;

// ── csSOL-WT (open + close-mechanic plumbing) ────────────────────────
const _cssolWtMint        = env("VITE_CSSOL_WT_MINT")              ?? DEVNET_CONFIG.pool.wtMint.toBase58();
const _poolPendingWsol    = env("VITE_POOL_PENDING_WSOL_ACCOUNT")  ?? DEVNET_CONFIG.pool.poolPendingWsolAccount.toBase58();
const _cssolWtReserve     = env("VITE_CSSOL_WT_RESERVE")           ?? DEVNET_CONFIG.market.csSolWtReserve.toBase58();
export const CSSOL_WT_MINT:             PublicKey | null = _cssolWtMint     ? new PublicKey(_cssolWtMint)     : null;
export const POOL_PENDING_WSOL_ACCOUNT: PublicKey | null = _poolPendingWsol ? new PublicKey(_poolPendingWsol) : null;
export const CSSOL_WT_RESERVE:          PublicKey | null = _cssolWtReserve  ? new PublicKey(_cssolWtReserve)  : null;

/**
 * cSOL klend reserve. Now the EG-2 debt asset (replaced wSOL on
 * 2026-05-06). Same Pyth oracle as wSOL (cSOL is a 1:1 KYC wrapper).
 * The credit-trade open / close bundles flash-borrow + flash-repay
 * against this reserve and add a delta-mint redeem CPI to convert
 * cSOL → wSOL inside the bundle for the Jito wrap step.
 */
export const CSOL_RESERVE        = new PublicKey(env("VITE_CSOL_RESERVE")        ?? DEVNET_CONFIG.market.cSolReserve.toBase58());
export const CSOL_RESERVE_ORACLE = new PublicKey(env("VITE_CSOL_RESERVE_ORACLE") ?? DEVNET_CONFIG.oracles.wsolOracle.toBase58());

// ── Whitelist bundle ─────────────────────────────────────────────────
export interface WhitelistBundleEntry {
  label: string;
  mintConfig: PublicKey;
}
export const CSSOL_WHITELIST_BUNDLE: WhitelistBundleEntry[] = [
  { label: "csSOL",    mintConfig: DM_MINT_CONFIG },
  { label: "csSOL-WT", mintConfig: new PublicKey(DEVNET_CONFIG.pool.wtMintConfig.toBase58()) },
  { label: "cSOL",     mintConfig: CSOL_DM_MINT_CONFIG },
];
