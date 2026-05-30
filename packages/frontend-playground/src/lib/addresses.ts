import { PublicKey } from "@solana/web3.js";

// Centralized addresses. Override any via Vite env vars (VITE_*).
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

export const JITO_VAULT_PROGRAM = new PublicKey(
  import.meta.env.VITE_JITO_VAULT_PROGRAM ?? "Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8",
);

// csSOL deploy state on devnet (output of init-cssol-jito-vault.ts).
export const CSSOL_VAULT = new PublicKey(
  import.meta.env.VITE_CSSOL_VAULT ?? "EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W",
);
export const CSSOL_VRT_MINT = new PublicKey(
  import.meta.env.VITE_CSSOL_VRT_MINT ?? "6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8",
);
export const CSSOL_VAULT_ST_TOKEN_ACCOUNT = new PublicKey(
  import.meta.env.VITE_CSSOL_VAULT_ST_TOKEN_ACCOUNT ?? "25YAVwucokaFEPRNGapx3iBybQpkTN31cDfc9aU3RF3Z",
);

// Governor + delta-mint program IDs and pool-state addresses, used by the
// new wrap_with_jito_vault flow.
export const GOVERNOR_PROGRAM = new PublicKey(
  import.meta.env.VITE_GOVERNOR_PROGRAM ?? "6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi",
);
export const DELTA_MINT_PROGRAM = new PublicKey(
  import.meta.env.VITE_DELTA_MINT_PROGRAM ?? "BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy",
);

/**
 * Unified whitelist bundle for the csSOL pool — kept in lockstep with
 * `packages/programs/configs/devnet/whitelist-bundle.json`. A wallet
 * needs a Holder entry on every MintConfig in this list to use the full
 * deposit / wrap / unwind flow. The retail, institutional, and
 * playground frontends all pre-flight against this same set so the UX
 * is consistent across surfaces.
 */
export interface WhitelistBundleEntry {
  label: string;
  mintConfig: PublicKey;
}
// Bundle is populated at the bottom of this module (after all
// env-driven addresses are resolved) so the static order doesn't
// constrain insertion. Static for the lifetime of the process.
export const CSSOL_WHITELIST_BUNDLE: WhitelistBundleEntry[] = [];
export const POOL_PDA = new PublicKey(
  import.meta.env.VITE_POOL_PDA ?? "QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e",
);
export const CSSOL_MINT = new PublicKey(
  import.meta.env.VITE_CSSOL_MINT ?? "6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt",
);
export const DM_MINT_CONFIG = new PublicKey(
  import.meta.env.VITE_DM_MINT_CONFIG ?? "FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2",
);
export const DM_MINT_AUTHORITY = new PublicKey(
  import.meta.env.VITE_DM_MINT_AUTHORITY ?? "Gyv1o28H98zZYnREBmaKq1pJJ5eHqd1wouJ6Km5fCTsT",
);
export const POOL_VRT_ATA = new PublicKey(
  import.meta.env.VITE_POOL_VRT_ATA ?? "BvBy8orQZPXFwR6fgyCkLoyZfK1TBRteG5g4ipuqrEZp",
);

// cSOL — KYC-wrapped wSOL, the loan-asset side of the credit trade.
// Pool deployed via scripts/deploy-csol-pool-devnet.ts. Same delta-mint
// gate as csSOL (separate MintConfig). Not yet wired into a klend
// reserve — see CREDIT_TRADE_PLAN.md §5.5 for the v4 lockout.
export const CSOL_MINT = new PublicKey(
  import.meta.env.VITE_CSOL_MINT ?? "AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf",
);
export const CSOL_POOL_PDA = new PublicKey(
  import.meta.env.VITE_CSOL_POOL_PDA ?? "7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ",
);
export const CSOL_POOL_WSOL_VAULT = new PublicKey(
  import.meta.env.VITE_CSOL_POOL_WSOL_VAULT ?? "6fH4CVZ6m9mUBRBdbFT6Tqu4bGr29eC5cvybuA2tYQ3o",
);
export const CSOL_DM_MINT_CONFIG = new PublicKey(
  import.meta.env.VITE_CSOL_DM_MINT_CONFIG ??
    "GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B", // PDA(["mint_config", CSOL_MINT], delta-mint)
);

// Klend market + reserves for csSOL elevation group 2.
export const KLEND_PROGRAM = new PublicKey(
  import.meta.env.VITE_KLEND_PROGRAM ?? "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);
// v3 unified market — bootstrapped via scripts/bootstrap-cssol-market-v2.ts
// (the v2 market `En6zW…iDSi` and the v1 market `2gRy7f…heyejW` are both
// permanently locked: klend's reserve_config_check rejects every
// update once an elevation group references unconfigured per-collateral
// borrow caps. v3 sets `borrow_limit_against_this_collateral_in_elevation_group[i]`
// during bootstrap, so eMode borrows actually work).
export const KLEND_MARKET = new PublicKey(
  import.meta.env.VITE_KLEND_MARKET ?? "EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E",
);
export const CSSOL_RESERVE = new PublicKey(
  import.meta.env.VITE_CSSOL_RESERVE ?? "eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w",
);
export const WSOL_RESERVE = new PublicKey(
  import.meta.env.VITE_WSOL_RESERVE ?? "CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8",
);
// Oracle accounts read by klend's RefreshReserve. The csSOL oracle is the
// accrual-oracle output account (pythConfiguration.price), which itself is
// driven by the keeper-cloud worker that reads the Pyth SOL/USD pull oracle
// and the Jito Vault's tokensDeposited / vrtSupply ratio. The wSOL oracle
// is a real Pyth Receiver SOL/USD push account.
export const CSSOL_RESERVE_ORACLE = new PublicKey(
  import.meta.env.VITE_CSSOL_RESERVE_ORACLE ?? "3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P",
);
export const WSOL_RESERVE_ORACLE = new PublicKey(
  import.meta.env.VITE_WSOL_RESERVE_ORACLE ?? "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);
export const ELEVATION_GROUP_LST_SOL = 2;
// Margin-pair elevation groups — see docs/operations/MARGIN_PAIR.md.
// EG-3 = long SOL (cSOL collateral, sUSDC debt, 65/85).
// EG-4 = short SOL (sUSDC collateral, cSOL debt, 65/85).
// Asymmetric like EG-1 / EG-2: only the *collateral* side is
// delta-mint-wrapped (cSOL); the USD side stays plain SPL sUSDC and
// reuses the existing v3 reserve. Both EGs are design locked, deploy
// pending until the cSOL klend reserve registration (Stage D') and
// the EG-3/EG-4 setup (Stage E) land. The margin-trade tab reads
// these constants to drive UI gating.
export const ELEVATION_GROUP_MARGIN_LONG = 3;
export const ELEVATION_GROUP_MARGIN_SHORT = 4;
export const MARGIN_PAIR_LTV_PCT = 65;
export const MARGIN_PAIR_LIQ_THRESHOLD_PCT = 85;

// Stables eMode (group 1): ceUSX collateral, sUSDC debt. The atomic
// flash-loan loop is blocked by Solstice's Squads-gated USX RequestMint /
// RequestRedeem — every USX-program ix requires the operator's multisig
// as signer, so user-signed CPIs into `usxTTTg…uwBD` mid-tx are
// impossible. This pair is exposed as a manual deposit + borrow flow on
// the credit-trade tab; users mint USX via the institutional portal once,
// wrap to ceUSX, then leverage by repeating deposit / borrow / repay /
// withdraw against the v3 market.
export const CEUSX_MINT = new PublicKey(
  import.meta.env.VITE_CEUSX_MINT ?? "8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT",
);
export const CEUSX_RESERVE = new PublicKey(
  import.meta.env.VITE_CEUSX_RESERVE ?? "88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU",
);
export const CEUSX_RESERVE_ORACLE = new PublicKey(
  import.meta.env.VITE_CEUSX_RESERVE_ORACLE ?? "3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW",
);
export const SUSDC_MINT = new PublicKey(
  import.meta.env.VITE_SUSDC_MINT ?? "8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g",
);
export const SUSDC_RESERVE = new PublicKey(
  import.meta.env.VITE_SUSDC_RESERVE ?? "78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9",
);
export const SUSDC_RESERVE_ORACLE = new PublicKey(
  import.meta.env.VITE_SUSDC_RESERVE_ORACLE ?? "ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD",
);
export const ELEVATION_GROUP_STABLES = 1;

// Legacy governor + delta-mint deployment that owns the eUSX/USX pools.
// The csSOL stack uses the newer GOVERNOR_PROGRAM / DELTA_MINT_PROGRAM
// (`6xqW3D…ZtJi` / `BKprvL…X1xy`); the eUSX pool was deployed earlier
// against `BrZYcb…3KJh` / `13Su8n…QkEn` and never migrated. Both are
// deployed simultaneously on devnet — pool ownership pins which one a
// given mint must use, so we keep both wired and switch by pool config.
export const LEGACY_GOVERNOR_PROGRAM = new PublicKey(
  import.meta.env.VITE_LEGACY_GOVERNOR_PROGRAM ?? "BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh",
);
export const LEGACY_DELTA_MINT_PROGRAM = new PublicKey(
  import.meta.env.VITE_LEGACY_DELTA_MINT_PROGRAM ?? "13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn",
);

// Solstice USX-program + YieldVault program IDs. Mint/redeem flows are
// wrapped in Solstice's operator multisig (every user-facing op goes
// through Squads `SQDS4ep…pCf`), so the playground does not call USX
// directly — instead it posts `{type:"RequestMint"|"ConfirmMint"|
// "RequestRedeem"|"ConfirmRedeem"|"Lock"|"Unlock"}` to Solstice's REST
// API, receives a user-signable instruction, and submits it. See
// `src/lib/eusxConversions.ts` for the helper.
export const USX_PROGRAM = new PublicKey(
  import.meta.env.VITE_USX_PROGRAM ?? "usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD",
);
export const YIELD_VAULT_PROGRAM = new PublicKey(
  import.meta.env.VITE_YIELD_VAULT_PROGRAM ?? "euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr",
);

// USX + eUSX mints (Solstice). USX is the unbacked stable; eUSX is the
// yield-bearing wrapper minted by the YieldVault when USX is `Lock`-ed.
export const USX_MINT = new PublicKey(
  import.meta.env.VITE_USX_MINT ?? "7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS",
);
export const EUSX_MINT = new PublicKey(
  import.meta.env.VITE_EUSX_MINT ?? "Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt",
);

// Legacy governor pool config + delta-mint config for the eUSX → ceUSX
// wrap. Pool seeds: [b"pool", eUSX_mint] under LEGACY_GOVERNOR_PROGRAM.
export const EUSX_POOL_PDA = new PublicKey(
  import.meta.env.VITE_EUSX_POOL_PDA ?? "5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj",
);
export const EUSX_DM_MINT_CONFIG = new PublicKey(
  import.meta.env.VITE_EUSX_DM_MINT_CONFIG ?? "JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD",
);

// Solstice REST API endpoint. Default to the Vite-proxied path
// (`/api/solstice`) so dev-mode requests dodge CORS — vite.config.ts
// rewrites it to `https://instructions.solstice.finance/v1/instructions`.
// For non-dev builds (preview / static hosting) you'll need to either
// set up your own proxy or override this with the direct URL via env.
export const SOLSTICE_API_URL =
  import.meta.env.VITE_SOLSTICE_API ?? "/api/solstice";

// ceUSX-WT (withdraw ticket) — Token-2022 mint that represents a queued
// Solstice eUSX→USX unlock. Lives on the new governor + new delta-mint;
// MintConfig.authority is the cSOL pool PDA. See CEUSX_WITHDRAWAL.md.
export const CEUSX_WT_MINT = new PublicKey(
  import.meta.env.VITE_CEUSX_WT_MINT ?? "DoHMuKFU4b2co2CBBcNjVzWf6yL3KG5H2N9FxkfFFN6A",
);
export const CEUSX_WT_DM_MINT_CONFIG = new PublicKey(
  import.meta.env.VITE_CEUSX_WT_DM_MINT_CONFIG ?? "852Tq2XMRxkNPGQ7sEQoi2dWZrK3sHmbLZ3QDapEEYng",
);
export const CEUSX_WT_DM_MINT_AUTHORITY = new PublicKey(
  import.meta.env.VITE_CEUSX_WT_DM_MINT_AUTHORITY ?? "6DBg4SjWuf2FYwvuTUuzv8JaHvdcD1TwwBRuSsj3Yjbv",
);
export const CEUSX_WT_RESERVE = new PublicKey(
  import.meta.env.VITE_CEUSX_WT_RESERVE ?? "GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq",
);
// Host pool for the ceUSX-WT MintConfig (cSOL pool PDA). Re-exported
// from POOL_PDA conceptually but pinned here so the WT setup stays
// independent of any cSOL-pool address changes in the future.
export const CEUSX_WT_HOST_POOL = new PublicKey(
  import.meta.env.VITE_CEUSX_WT_HOST_POOL ?? "7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ",
);

// Address Lookup Table for the bundled USDC↔ceUSX flows. Captures every
// static pubkey across RequestMint / ConfirmMint / Lock / Unlock /
// RequestRedeem / ConfirmRedeem / governor.wrap / governor.unwrap so the
// 4-ix bundle fits under the 1232-byte v0-tx limit. Built once via
// `packages/programs/scripts/init-usx-flow-lut.ts`. If the env var is
// unset, the bundle handlers fall back to compiling without an ALT —
// expect "encoding overruns Uint8Array" on user wallets that don't have
// pre-existing ATAs.
const _usxFlowLut = import.meta.env.VITE_USX_FLOW_LUT;
export const USX_FLOW_LUT: PublicKey | null = _usxFlowLut ? new PublicKey(_usxFlowLut) : null;

// Address Lookup Table that compresses the static account set used by the
// merged 1-signature deposit flow (init+ATAs+wrap+klend+elevation). Created
// once via packages/programs/scripts/init-deposit-lut.ts. Allow `null` so
// the playground gracefully falls back to the multi-tx flow if the env var
// isn't set yet.
const _depositLut = import.meta.env.VITE_DEPOSIT_LUT;
export const DEPOSIT_LUT: PublicKey | null = _depositLut ? new PublicKey(_depositLut) : null;

// Credit-trade LUT (init-credit-trade-lut.ts). Compresses ~34 static
// pubkeys (klend market+reserves+PDAs, Jito vault, governor pool,
// programs, sysvars) so the 19-ix open path fits a versioned tx.
export const CREDIT_TRADE_LUT = new PublicKey(
  import.meta.env.VITE_CREDIT_TRADE_LUT ?? "GsQd5QNJUoSgxeUYKiyciiyoXNo4ozNJsxN1Fp1rXG9y",
);

// csSOL-WT (withdraw ticket) addresses — populated by
// scripts/setup-cssol-wt-mint.ts and scripts/init-pool-pending-wsol.ts.
// Optional: the unwind tab disables itself if either is missing.
const _cssolWtMint = import.meta.env.VITE_CSSOL_WT_MINT;
export const CSSOL_WT_MINT: PublicKey | null = _cssolWtMint ? new PublicKey(_cssolWtMint) : null;

const _poolPendingWsol = import.meta.env.VITE_POOL_PENDING_WSOL_ACCOUNT;
export const POOL_PENDING_WSOL_ACCOUNT: PublicKey | null = _poolPendingWsol ? new PublicKey(_poolPendingWsol) : null;

// csSOL-WT klend reserve — set after running scripts/setup-cssol-wt-reserve.ts.
// Required by the leveraged-unwind flash-loan path; the v0 unwind tab still
// works without it.
const _cssolWtReserve = import.meta.env.VITE_CSSOL_WT_RESERVE ?? "94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw";
export const CSSOL_WT_RESERVE: PublicKey | null = _cssolWtReserve ? new PublicKey(_cssolWtReserve) : null;

// Margin-pair (EG-3 / EG-4) addresses. cSOL mint already exists
// (CSOL_MINT above) but isn't yet a klend reserve — set
// VITE_CSOL_RESERVE once Stage D' registers it. The USD side of the
// margin pair reuses the existing **plain sUSDC** reserve (already in
// v3 EG-1 stables); we don't wrap it. The KYC gate flows entirely
// through the cSOL wrap requirement on the collateral leg, mirroring
// the EG-1 (ceUSX/sUSDC) and EG-2 (csSOL/wSOL) pattern where only the
// collateral is delta-mint-wrapped.
const _csolReserve = import.meta.env.VITE_CSOL_RESERVE;
export const CSOL_RESERVE: PublicKey | null = _csolReserve ? new PublicKey(_csolReserve) : null;

// Populate the unified whitelist bundle now that all env-driven
// MintConfig addresses are resolved. Order = roughly the order the
// user encounters them in the product flow: deposit → unwind → margin.
CSSOL_WHITELIST_BUNDLE.push(
  // Primary csSOL MintConfig — already covered by the existing
  // self_register / wrap-time gate, but listed here so all surfaces
  // share one source of truth.
  { label: "csSOL", mintConfig: new PublicKey("FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2") },
  // csSOL-WT — needed by enqueue_withdraw_via_pool's mint_to CPI.
  { label: "csSOL-WT", mintConfig: new PublicKey("BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4") },
  // cSOL — KYC wrapper around wSOL, used as collateral in EG-3 (long
  // SOL) and as debt in EG-4 (short SOL). MintConfig deployed; klend
  // reserve still pending registration in Stage D', but the whitelist
  // gate is reachable today.
  { label: "cSOL", mintConfig: CSOL_DM_MINT_CONFIG },
);
