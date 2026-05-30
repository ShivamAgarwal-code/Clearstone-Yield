/**
 * Fixed-yield market indexer — Cloudflare Worker route.
 *
 * Serves the same `FixedYieldMarket` shape the retail/institutional
 * frontends consume. v0 implementation returns a seeded fixture so
 * the frontend can be wired end-to-end against a real HTTP endpoint
 * while the on-chain data path is built out.
 *
 * v1 implementation (outlined below as `fetchMarketsOnChain`) will:
 *   1. Scan all `Vault` accounts owned by clearstone_core.
 *   2. For each vault, enumerate its `MarketTwo` children (seed_id 1..=255).
 *   3. For each market, read PT price + SY exchange rate + maturity.
 *   4. Derive `kyc_gated` from the vault's curator config.
 *
 * Cached at the edge for 15–30s — PT prices move but the UI shouldn't
 * hammer RPC.
 */
import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import type { Env } from "./types.js";
export declare const fixedYield: Hono<{
    Bindings: Env;
}, import("hono/types").BlankSchema, "/">;
export interface MarketDto {
    id: string;
    label: string;
    baseSymbol: string;
    baseMint: string;
    baseDecimals: number;
    vault: string;
    market: string;
    maturityTs: number;
    ptPrice: number;
    syExchangeRate: number;
    kycGated: boolean;
    /**
     * Everything the SDK needs to build a ready-to-sign deposit / redeem
     * tx beyond what the frontend already knows (user, amounts). Omitted
     * in v0 fixture mode to signal "accounts not resolvable" — frontend
     * should error loudly rather than build a tx against bogus PDAs.
     */
    accounts?: MarketAccountsDto;
}
/**
 * Adapter + vault + market PDAs + user-side token-account derivation
 * anchors. These are read from on-chain state by the indexer; the
 * frontend passes them verbatim into `fixedYield.tx.buildZapInToPtV0Tx`
 * / `buildZapOutToBaseV0Tx`.
 */
export interface MarketAccountsDto {
    syProgram: string;
    syMarket: string;
    syMint: string;
    /** Adapter-owned vault holding wrapped base. */
    baseVault: string;
    vaultAuthority: string;
    yieldPosition: string;
    mintPt: string;
    mintYt: string;
    /** Vault's own SY escrow. */
    escrowSy: string;
    /** Vault's address_lookup_table. */
    vaultAlt: string;
    coreEventAuthority: string;
    mintLp: string;
    marketEscrowPt: string;
    marketEscrowSy: string;
    marketAlt: string;
    tokenFeeTreasurySy: string;
    /**
     * Kamino-adapter accounts. Present only when the market's SY adapter
     * is `kamino_sy_adapter` (cssol-90d, kUSDC-30d, …). Consumed by the
     * `wrapper_buy_pt_kamino` deposit path.
     *
     * `realKlend` is itself optional inside this bundle: pass `null` for
     * mock-klend reserves so the wrapper skips the 8 real-klend optional
     * slots; pass the full set otherwise.
     */
    kamino?: {
        klendReserve: string;
        klendLiquiditySupply: string;
        klendCollateralMint: string;
        klendProgram: string;
        /** Token program for the underlying d-token (Token-2022 for csSOL). */
        tokenProgramKamino: string;
        realKlend: {
            klendLendingMarket: string;
            klendLendingMarketAuthority: string;
            klendInstructionSysvar: string;
            klendLiquidityTokenProgram: string;
            klendPythOracle: string;
            klendSwitchboardPrice: string | null;
            klendSwitchboardTwap: string | null;
            klendScopePrices: string | null;
        } | null;
    };
}
export interface VaultDto {
    id: string;
    label: string;
    underlying: string;
    baseDecimals: number;
    curator: string;
    creatorFeeBps: number;
    whitelistRequired: boolean;
    /** Markets tracked by this vault, by maturity (ascending). */
    markets: MarketDto[];
}
export interface UserPositionDto {
    /** PT balance in base units. */
    ptAmount: string;
    /** YT balance in base units. */
    ytAmount: string;
    /** LP balance (if any). */
    lpAmount: string;
    /** For auto-roll opt-in vaults, the next scheduled roll ts. */
    nextAutoRollTs: number | null;
}
/**
 * Curator-vault (auto-roll savings account) summary.
 *
 * Distinct product from direct PT markets — users deposit base and hold
 * shares; the curator rebalances across allocated PT markets so
 * rollovers happen automatically at each maturity.
 */
export interface CuratorVaultDto {
    id: string;
    label: string;
    baseSymbol: string;
    baseMint: string;
    baseDecimals: number;
    kycGated: boolean;
    /** Curator-program vault account. */
    vault: string;
    /** Curator wallet/program-id who set the allocations. */
    curator: string;
    /** Vault-owned base-mint escrow (idle liquidity). */
    baseEscrow: string;
    totalAssets: string;
    totalShares: string;
    feeBps: number;
    /** Earliest-maturity allocation — what the next auto-roll will target. */
    nextAutoRollTs: number | null;
    /** Directly-held allocations, for display. */
    allocations: Array<{
        market: string;
        weightBps: number;
        deployedBase: string;
    }>;
}
/**
 * Curator-vault per-user position.
 */
export interface CuratorUserPositionDto {
    shares: string;
    /** Pro-rata base-asset value at current NAV (display-only). */
    baseValue: string;
    nextAutoRollTs: number | null;
}
/**
 * Operator-curated registry of markets. Each entry carries the static
 * pubkeys that are known at market-creation time (mints, escrows,
 * ALTs, SY-program wiring). The indexer reads the dynamic bits
 * (ptPrice, syExchangeRate, maturityTs) from the accounts themselves.
 *
 * Populate by setting the `MARKET_REGISTRY` env var to a JSON array
 * of `MarketRegistryEntry`. Empty or unset → fixture path wins.
 *
 * Rationale for a curated registry rather than `getProgramAccounts`:
 *   - Public RPCs rate-limit `getProgramAccounts` heavily.
 *   - `seed_id` in the MarketTwo PDA is not trivially discoverable
 *     without walking a bitmap — cheaper for operators to list markets
 *     as they're created than to reverse-discover them.
 *   - Lets the operator gate which markets show up in the retail UI
 *     without changing the frontend.
 */
export interface MarketRegistryEntry {
    id: string;
    label: string;
    baseSymbol: string;
    baseDecimals: number;
    kycGated: boolean;
    vault: string;
    market: string;
    baseMint: string;
    accounts: MarketAccountsDto;
}
/**
 * Vault layout prefix (fixed-size, up to the Number fields we skip):
 *
 *   8    discriminator
 *   32   curator
 *   2    creator_fee_bps
 *   1    reentrancy_guard
 *   32   sy_program
 *   32   mint_sy
 *   32   mint_yt
 *   32   mint_pt
 *   32   escrow_yt
 *   32   escrow_sy
 *   32   yield_position
 *   32   address_lookup_table
 *   4    start_ts      ← read
 *   4    duration      ← read
 *
 * Cumulative: 8+32+2+1 = 43, then 8 pubkeys × 32 = 256, → start_ts at 299.
 * (The previous 331/335 constants here decoded a Pubkey field as a u32
 * — produced 2011-era timestamps for live vaults. Caught while wiring
 * the cssol seedId=5 + kUSDC stacks into MARKET_REGISTRY 2026-05-05.)
 */
export declare const VAULT_START_TS_OFFSET = 299;
export declare const VAULT_DURATION_OFFSET = 303;
export declare function decodeVaultMaturity(data: Uint8Array): number;
/**
 * MarketTwo header (everything before `financials`):
 *
 *   8    discriminator
 *   32   curator
 *   2    creator_fee_bps
 *   1    reentrancy_guard
 *   32   address_lookup_table
 *   32   mint_pt
 *   32   mint_sy
 *   32   vault
 *   32   mint_lp
 *   32   token_pt_escrow
 *   32   token_sy_escrow
 *   32   token_fee_treasury_sy
 *   2    fee_treasury_sy_bps
 *   32   self_address
 *   1    signer_bump
 *   1    status_flags
 *   32   sy_program
 *                       = 365 bytes
 *
 * financials.expiration_ts @ 365 (u64), pt_balance @ 373, sy_balance @ 381.
 */
export declare const MARKET_PT_BALANCE_OFFSET = 373;
export declare const MARKET_SY_BALANCE_OFFSET = 381;
export declare function decodeMarketPtPrice(data: Uint8Array): number;
/**
 * SPL Token / Token-2022 token-account layout:
 *   0..32   mint
 *   32..64  owner
 *   64..72  amount (u64 LE)  ← we read this
 *   72..   delegate, state, is_native, delegated_amount, close_authority, ...
 *
 * Token-2022 accounts append extension data past byte 165, but the base
 * `amount` field at offset 64 is stable across both programs.
 */
export declare const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
/**
 * Base byte length of a classic SPL token account (no extensions).
 * Token-2022 accounts are ≥ this length but may be larger depending on
 * configured extensions — the amount offset is identical so we only
 * validate the floor.
 */
export declare const TOKEN_ACCOUNT_BASE_SIZE = 165;
export declare function decodeTokenAccountAmount(data: Uint8Array): bigint;
/**
 * Derive the classic Associated Token Account address for `owner` ⨯
 * `mint` ⨯ `tokenProgram`. Mirrors the
 * `@solana/spl-token` `getAssociatedTokenAddressSync` helper without
 * the runtime dependency.
 */
export declare function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram?: PublicKey): PublicKey;
/**
 * `CuratorVault` layout (from
 * clearstone-fixed-yield/periphery/clearstone_curator/src/lib.rs):
 *
 *   8    discriminator
 *   32   curator
 *   32   base_mint
 *   32   base_escrow
 *   8    total_assets          ← offset 104
 *   8    total_shares          ← offset 112
 *   2    fee_bps               ← offset 120
 *   8    last_harvest_total_assets
 *   4    allocations vec length ← offset 130
 *   allocations[]               ← @ 134, each Allocation::SIZE = 50 bytes
 *   1    bump
 *
 * Allocation layout: pubkey(32) + u16(2) + u64(8) + u64(8) = 50.
 */
export declare const CURATOR_VAULT_TOTAL_ASSETS_OFFSET = 104;
export declare const CURATOR_VAULT_TOTAL_SHARES_OFFSET = 112;
export declare const CURATOR_VAULT_FEE_BPS_OFFSET = 120;
export declare const CURATOR_VAULT_ALLOCATIONS_OFFSET = 130;
export declare const CURATOR_ALLOCATION_SIZE = 50;
export interface CuratorVaultHeader {
    curator: string;
    baseMint: string;
    baseEscrow: string;
    totalAssets: bigint;
    totalShares: bigint;
    feeBps: number;
}
export interface CuratorAllocation {
    market: string;
    weightBps: number;
    capBase: bigint;
    deployedBase: bigint;
}
export declare function decodeCuratorVaultHeader(data: Uint8Array): CuratorVaultHeader;
export declare function decodeCuratorVaultAllocations(data: Uint8Array): CuratorAllocation[];
/**
 * `UserPosition` layout (for curator auto-roll vaults):
 *
 *   8    discriminator
 *   32   vault
 *   32   owner
 *   8    shares                ← offset 72
 */
export declare const CURATOR_USER_POSITION_SHARES_OFFSET = 72;
export declare function decodeCuratorUserPositionShares(data: Uint8Array): bigint;
/**
 * Operator-curated list of auto-roll vaults. Separate env var so
 * operators can publish curator vaults independently of direct PT
 * markets. Each entry points at a live `CuratorVault` account; the
 * indexer fills in totals + allocations dynamically.
 */
export interface CuratorVaultRegistryEntry {
    id: string;
    label: string;
    baseSymbol: string;
    baseDecimals: number;
    kycGated: boolean;
    vault: string;
}
//# sourceMappingURL=fixed-yield.d.ts.map