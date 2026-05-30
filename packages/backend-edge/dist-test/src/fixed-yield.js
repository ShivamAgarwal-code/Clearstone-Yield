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
import { Connection, PublicKey } from "@solana/web3.js";
// Canonical Solana programs. Duplicated here to avoid a
// @solana/spl-token runtime dep in the worker.
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const fixedYield = new Hono();
// ---------------------------------------------------------------------------
// Fixtures (v0). Replace with `fetchMarketsOnChain` once the indexer is real.
// ---------------------------------------------------------------------------
const NOW = () => Math.floor(Date.now() / 1000);
function fixtureMarkets() {
    return [
        {
            id: "fx-usdc-30d",
            label: "USDC · 30d",
            baseSymbol: "USDC",
            baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            baseDecimals: 6,
            vault: "11111111111111111111111111111111",
            market: "11111111111111111111111111111111",
            maturityTs: NOW() + 30 * 86400,
            ptPrice: 0.9925,
            syExchangeRate: 1.0,
            kycGated: false,
        },
        {
            id: "fx-usdc-90d",
            label: "USDC · 90d",
            baseSymbol: "USDC",
            baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            baseDecimals: 6,
            vault: "11111111111111111111111111111111",
            market: "11111111111111111111111111111111",
            maturityTs: NOW() + 90 * 86400,
            ptPrice: 0.9765,
            syExchangeRate: 1.0,
            kycGated: false,
        },
        {
            id: "fx-usdt-180d",
            label: "USDT · 180d (KYC)",
            baseSymbol: "USDT",
            baseMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            baseDecimals: 6,
            vault: "11111111111111111111111111111111",
            market: "11111111111111111111111111111111",
            maturityTs: NOW() + 180 * 86400,
            ptPrice: 0.948,
            syExchangeRate: 1.0,
            kycGated: true,
        },
    ];
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * GET /markets
 *
 * Returns all active PT markets with derived PT price + implied fixed
 * APY inputs. The frontend computes the APY itself via the SDK's
 * `quoteFixedApy` helper so we don't need to agree on math twice.
 */
fixedYield.get("/markets", async (c) => {
    const markets = await getMarkets(c.env);
    return c.json({ markets }, 200, {
        "Cache-Control": "public, max-age=30",
    });
});
/**
 * GET /markets/:id
 *
 * Single-market detail endpoint. Useful when the deposit modal wants
 * a depth/slippage curve without re-fetching the full list.
 */
fixedYield.get("/markets/:id", async (c) => {
    const id = c.req.param("id");
    const markets = await getMarkets(c.env);
    const market = markets.find((m) => m.id === id);
    if (!market)
        return c.json({ error: "not found" }, 404);
    return c.json({ market }, 200, {
        "Cache-Control": "public, max-age=15",
    });
});
/**
 * GET /vaults
 *
 * Groups markets by vault. Institutional/curator frontends use this to
 * render maturity ladders per underlying.
 */
fixedYield.get("/vaults", async (c) => {
    const markets = await getMarkets(c.env);
    const vaults = groupByVault(markets);
    return c.json({ vaults }, 200, {
        "Cache-Control": "public, max-age=30",
    });
});
/**
 * GET /vaults/:id/positions/:user
 *
 * Returns a specific user's PT + YT + LP holdings in the vault plus any
 * auto-roll policy. Not cached — balances change per tx.
 */
fixedYield.get("/vaults/:id/positions/:user", async (c) => {
    const vaultId = c.req.param("id");
    const user = c.req.param("user");
    const position = await fetchUserPosition(c.env, vaultId, user);
    return c.json({ position }, 200, {
        "Cache-Control": "no-store",
    });
});
/**
 * GET /curator-vaults
 *
 * Lists all curator-run auto-roll vaults. Separate from `/vaults`
 * (which is grouped-by-vault direct-PT markets) because the product
 * shape is distinct: one share mint + multiple PT allocations vs.
 * per-maturity PT markets.
 */
fixedYield.get("/curator-vaults", async (c) => {
    const vaults = await getCuratorVaults(c.env);
    return c.json({ vaults }, 200, {
        "Cache-Control": "public, max-age=30",
    });
});
/**
 * GET /curator-vaults/:id/positions/:user
 *
 * Per-user share balance + implied base value at current NAV.
 */
fixedYield.get("/curator-vaults/:id/positions/:user", async (c) => {
    const vaultId = c.req.param("id");
    const user = c.req.param("user");
    const position = await fetchCuratorUserPosition(c.env, vaultId, user);
    return c.json({ position }, 200, {
        "Cache-Control": "no-store",
    });
});
// ---------------------------------------------------------------------------
// Internals — v1 replaces these with real RPC reads. Keep the names
// stable so the route handlers don't change when wiring the real path.
// ---------------------------------------------------------------------------
async function getMarkets(env) {
    // 1. KV cache hit.
    const cached = await env.WHITELIST_CACHE?.get("fixed-yield:markets:v1");
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch {
            /* ignore — recompute */
        }
    }
    // 2. Live RPC if a registry is configured.
    try {
        const live = await fetchMarketsOnChain(env);
        if (live && live.length > 0) {
            await env.WHITELIST_CACHE?.put("fixed-yield:markets:v1", JSON.stringify(live), { expirationTtl: 30 });
            return live;
        }
    }
    catch (err) {
        console.error("fetchMarketsOnChain failed, falling back to fixture:", err);
    }
    // 3. Fixture.
    return fixtureMarkets();
}
function groupByVault(markets) {
    const byVault = new Map();
    for (const m of markets) {
        const arr = byVault.get(m.vault) ?? [];
        arr.push(m);
        byVault.set(m.vault, arr);
    }
    return [...byVault.entries()].map(([vault, ms]) => {
        ms.sort((a, b) => a.maturityTs - b.maturityTs);
        const first = ms[0];
        return {
            id: vault,
            label: `${first.baseSymbol} vault`,
            underlying: first.baseMint,
            baseDecimals: first.baseDecimals,
            curator: "11111111111111111111111111111111",
            creatorFeeBps: 0,
            whitelistRequired: first.kycGated,
            markets: ms,
        };
    });
}
/**
 * Reads the user's PT / YT / LP ATAs via `getMultipleAccountsInfo`
 * and decodes the `amount` field from each. Falls back to an empty
 * position if the vault isn't in the registry or the user has no ATAs
 * yet — both are normal pre-first-deposit states.
 *
 * `nextAutoRollTs` stays `null` until the curator program ships the
 * auto-roll policy PDA; hook that in by deriving the PDA from
 * (curator_program, vault, user) and decoding `next_maturity`.
 */
async function fetchUserPosition(env, vaultId, user) {
    const empty = {
        ptAmount: "0",
        ytAmount: "0",
        lpAmount: "0",
        nextAutoRollTs: null,
    };
    // Resolve the registry entry for this vault. Without it we can't know
    // which mints to query.
    const registry = parseRegistry(env);
    const entry = registry.find((e) => e.vault === vaultId);
    if (!entry)
        return empty;
    let userPk;
    let mintPt;
    let mintYt;
    let mintLp;
    try {
        userPk = new PublicKey(user);
        mintPt = new PublicKey(entry.accounts.mintPt);
        mintYt = new PublicKey(entry.accounts.mintYt);
        mintLp = new PublicKey(entry.accounts.mintLp);
    }
    catch {
        return empty;
    }
    // ATAs: PT/YT/LP are all plain SPL Token (not Token-2022) per the
    // core program's init. SY is the only one that might be Token-2022
    // in a KYC-gated market, and we don't index SY balances here — the
    // user doesn't hold SY directly in the strip→hold-PT flow.
    const ataPt = deriveAta(userPk, mintPt, TOKEN_PROGRAM_ID);
    const ataYt = deriveAta(userPk, mintYt, TOKEN_PROGRAM_ID);
    const ataLp = deriveAta(userPk, mintLp, TOKEN_PROGRAM_ID);
    const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const infos = await conn.getMultipleAccountsInfo([ataPt, ataYt, ataLp]);
    return {
        ptAmount: decodeAmountOrZero(infos[0]?.data),
        ytAmount: decodeAmountOrZero(infos[1]?.data),
        lpAmount: decodeAmountOrZero(infos[2]?.data),
        nextAutoRollTs: null,
    };
}
function decodeAmountOrZero(data) {
    if (!data)
        return "0";
    try {
        return decodeTokenAccountAmount(data).toString();
    }
    catch {
        return "0";
    }
}
function parseRegistry(env) {
    const raw = env.MARKET_REGISTRY;
    if (!raw)
        return [];
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        console.error("MARKET_REGISTRY is not valid JSON:", err);
        return [];
    }
}
/**
 * Read the vault + market accounts for every configured entry and
 * decorate with dynamic fields. Returns `null` when the registry is
 * empty so the caller can fall through to the fixture.
 */
async function fetchMarketsOnChain(env) {
    const registry = parseRegistry(env);
    if (registry.length === 0)
        return null;
    const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const keys = registry.flatMap((r) => [
        new PublicKey(r.vault),
        new PublicKey(r.market),
    ]);
    // @solana/web3.js caps at 100 per batch; we expect far fewer markets.
    const infos = await conn.getMultipleAccountsInfo(keys);
    const out = [];
    for (let i = 0; i < registry.length; i++) {
        const entry = registry[i];
        const vaultInfo = infos[i * 2];
        const marketInfo = infos[i * 2 + 1];
        if (!vaultInfo || !marketInfo) {
            console.warn(`Missing account data for ${entry.id}`);
            continue;
        }
        const maturityTs = decodeVaultMaturity(vaultInfo.data);
        const ptPrice = decodeMarketPtPrice(marketInfo.data);
        out.push({
            id: entry.id,
            label: entry.label,
            baseSymbol: entry.baseSymbol,
            baseMint: entry.baseMint,
            baseDecimals: entry.baseDecimals,
            vault: entry.vault,
            market: entry.market,
            maturityTs,
            ptPrice,
            // TODO(decoder): read `last_seen_sy_exchange_rate` from the vault.
            // It's a `precise_number::Number` — non-trivial borsh type. v1
            // keeps this at 1.0 for stablecoin-backed markets; revisit when
            // yield-bearing collateral markets (eUSX / JitoSOL-style) ship.
            syExchangeRate: 1.0,
            kycGated: entry.kycGated,
            accounts: entry.accounts,
        });
    }
    return out;
}
// ---------------------------------------------------------------------------
// Borsh offset decoders — hand-rolled to avoid pulling @coral-xyz/anchor
// into the worker. Offsets follow the field order in
//   clearstone-fixed-yield/programs/clearstone_core/src/state/{vault,market_two}.rs
// If those structs are edited, bump the offsets below and rerun the
// account-dump fixture test before deploying.
// ---------------------------------------------------------------------------
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
export const VAULT_START_TS_OFFSET = 299;
export const VAULT_DURATION_OFFSET = 303;
export function decodeVaultMaturity(data) {
    if (data.length < VAULT_DURATION_OFFSET + 4) {
        throw new Error(`Vault account too small: ${data.length} < ${VAULT_DURATION_OFFSET + 4}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const startTs = view.getUint32(VAULT_START_TS_OFFSET, true);
    const duration = view.getUint32(VAULT_DURATION_OFFSET, true);
    return startTs + duration;
}
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
export const MARKET_PT_BALANCE_OFFSET = 373;
export const MARKET_SY_BALANCE_OFFSET = 381;
export function decodeMarketPtPrice(data) {
    if (data.length < MARKET_SY_BALANCE_OFFSET + 8) {
        throw new Error(`MarketTwo account too small: ${data.length} < ${MARKET_SY_BALANCE_OFFSET + 8}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pt = view.getBigUint64(MARKET_PT_BALANCE_OFFSET, true);
    const sy = view.getBigUint64(MARKET_SY_BALANCE_OFFSET, true);
    if (pt === 0n)
        return 0;
    // Spot price approximation: SY-per-PT from the AMM reserves.
    // Ignores virtual reserves + curve shape; fine for display.
    return Number(sy) / Number(pt);
}
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
export const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
/**
 * Base byte length of a classic SPL token account (no extensions).
 * Token-2022 accounts are ≥ this length but may be larger depending on
 * configured extensions — the amount offset is identical so we only
 * validate the floor.
 */
export const TOKEN_ACCOUNT_BASE_SIZE = 165;
export function decodeTokenAccountAmount(data) {
    if (data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
        throw new Error(`Token account too small: ${data.length} < ${TOKEN_ACCOUNT_AMOUNT_OFFSET + 8}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return view.getBigUint64(TOKEN_ACCOUNT_AMOUNT_OFFSET, true);
}
/**
 * Derive the classic Associated Token Account address for `owner` ⨯
 * `mint` ⨯ `tokenProgram`. Mirrors the
 * `@solana/spl-token` `getAssociatedTokenAddressSync` helper without
 * the runtime dependency.
 */
export function deriveAta(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
// ---------------------------------------------------------------------------
// Curator-vault decoders
// ---------------------------------------------------------------------------
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
export const CURATOR_VAULT_TOTAL_ASSETS_OFFSET = 104;
export const CURATOR_VAULT_TOTAL_SHARES_OFFSET = 112;
export const CURATOR_VAULT_FEE_BPS_OFFSET = 120;
export const CURATOR_VAULT_ALLOCATIONS_OFFSET = 130;
export const CURATOR_ALLOCATION_SIZE = 50;
export function decodeCuratorVaultHeader(data) {
    if (data.length < CURATOR_VAULT_FEE_BPS_OFFSET + 2) {
        throw new Error(`CuratorVault account too small: ${data.length} < ${CURATOR_VAULT_FEE_BPS_OFFSET + 2}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const curator = new PublicKey(data.slice(8, 40)).toBase58();
    const baseMint = new PublicKey(data.slice(40, 72)).toBase58();
    const baseEscrow = new PublicKey(data.slice(72, 104)).toBase58();
    const totalAssets = view.getBigUint64(CURATOR_VAULT_TOTAL_ASSETS_OFFSET, true);
    const totalShares = view.getBigUint64(CURATOR_VAULT_TOTAL_SHARES_OFFSET, true);
    const feeBps = view.getUint16(CURATOR_VAULT_FEE_BPS_OFFSET, true);
    return { curator, baseMint, baseEscrow, totalAssets, totalShares, feeBps };
}
export function decodeCuratorVaultAllocations(data) {
    if (data.length < CURATOR_VAULT_ALLOCATIONS_OFFSET + 4)
        return [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const len = view.getUint32(CURATOR_VAULT_ALLOCATIONS_OFFSET, true);
    const allocStart = CURATOR_VAULT_ALLOCATIONS_OFFSET + 4;
    const out = [];
    for (let i = 0; i < len; i++) {
        const off = allocStart + i * CURATOR_ALLOCATION_SIZE;
        if (off + CURATOR_ALLOCATION_SIZE > data.length)
            break;
        out.push({
            market: new PublicKey(data.slice(off, off + 32)).toBase58(),
            weightBps: view.getUint16(off + 32, true),
            capBase: view.getBigUint64(off + 34, true),
            deployedBase: view.getBigUint64(off + 42, true),
        });
    }
    return out;
}
/**
 * `UserPosition` layout (for curator auto-roll vaults):
 *
 *   8    discriminator
 *   32   vault
 *   32   owner
 *   8    shares                ← offset 72
 */
export const CURATOR_USER_POSITION_SHARES_OFFSET = 72;
export function decodeCuratorUserPositionShares(data) {
    if (data.length < CURATOR_USER_POSITION_SHARES_OFFSET + 8) {
        throw new Error(`UserPosition too small: ${data.length} < ${CURATOR_USER_POSITION_SHARES_OFFSET + 8}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return view.getBigUint64(CURATOR_USER_POSITION_SHARES_OFFSET, true);
}
function parseCuratorRegistry(env) {
    const raw = env
        .CURATOR_VAULT_REGISTRY;
    if (!raw)
        return [];
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        console.error("CURATOR_VAULT_REGISTRY is not valid JSON:", err);
        return [];
    }
}
async function getCuratorVaults(env) {
    const registry = parseCuratorRegistry(env);
    if (registry.length === 0)
        return [];
    const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const keys = registry.map((e) => new PublicKey(e.vault));
    const infos = await conn.getMultipleAccountsInfo(keys);
    // Resolve the maturities of each allocation market in one batched call.
    const allocations = [];
    const marketPubkeys = new Set();
    for (let i = 0; i < registry.length; i++) {
        const info = infos[i];
        if (!info) {
            allocations.push([]);
            continue;
        }
        const allocs = decodeCuratorVaultAllocations(info.data);
        allocations.push(allocs);
        for (const a of allocs)
            marketPubkeys.add(a.market);
    }
    const marketKeys = [...marketPubkeys].map((k) => new PublicKey(k));
    const marketInfos = marketKeys.length
        ? await conn.getMultipleAccountsInfo(marketKeys)
        : [];
    const marketMaturity = new Map();
    for (let i = 0; i < marketKeys.length; i++) {
        const info = marketInfos[i];
        if (!info) {
            marketMaturity.set(marketKeys[i].toBase58(), null);
            continue;
        }
        // MarketTwo carries the maturity indirectly via financials.expiration_ts @ 365.
        if (info.data.length >= 365 + 8) {
            const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
            marketMaturity.set(marketKeys[i].toBase58(), Number(view.getBigUint64(365, true)));
        }
        else {
            marketMaturity.set(marketKeys[i].toBase58(), null);
        }
    }
    const out = [];
    for (let i = 0; i < registry.length; i++) {
        const entry = registry[i];
        const info = infos[i];
        if (!info) {
            console.warn(`Missing CuratorVault account for ${entry.id}`);
            continue;
        }
        const header = decodeCuratorVaultHeader(info.data);
        const allocs = allocations[i];
        // Earliest-maturity allocation dictates when the next rebalance fires.
        let nextRoll = null;
        for (const a of allocs) {
            const m = marketMaturity.get(a.market);
            if (m && (nextRoll === null || m < nextRoll))
                nextRoll = m;
        }
        out.push({
            id: entry.id,
            label: entry.label,
            baseSymbol: entry.baseSymbol,
            baseMint: header.baseMint,
            baseDecimals: entry.baseDecimals,
            kycGated: entry.kycGated,
            vault: entry.vault,
            curator: header.curator,
            baseEscrow: header.baseEscrow,
            totalAssets: header.totalAssets.toString(),
            totalShares: header.totalShares.toString(),
            feeBps: header.feeBps,
            nextAutoRollTs: nextRoll,
            allocations: allocs.map((a) => ({
                market: a.market,
                weightBps: a.weightBps,
                deployedBase: a.deployedBase.toString(),
            })),
        });
    }
    return out;
}
/**
 * Per-user curator-vault position. Fetches the user_pos PDA and the
 * parent vault (for NAV) in one batch.
 */
async function fetchCuratorUserPosition(env, vaultId, user) {
    const empty = {
        shares: "0",
        baseValue: "0",
        nextAutoRollTs: null,
    };
    let vaultPk;
    let userPk;
    try {
        vaultPk = new PublicKey(vaultId);
        userPk = new PublicKey(user);
    }
    catch {
        return empty;
    }
    // user_pos PDA: [b"user_pos", vault, owner] under the curator program.
    const curatorProgram = new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm");
    const [posPk] = PublicKey.findProgramAddressSync([
        new TextEncoder().encode("user_pos"),
        vaultPk.toBuffer(),
        userPk.toBuffer(),
    ], curatorProgram);
    const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const [posInfo, vaultInfo] = await conn.getMultipleAccountsInfo([
        posPk,
        vaultPk,
    ]);
    if (!posInfo)
        return empty;
    const shares = decodeCuratorUserPositionShares(posInfo.data);
    if (shares === 0n)
        return empty;
    let baseValue = 0n;
    let nextRoll = null;
    if (vaultInfo) {
        const header = decodeCuratorVaultHeader(vaultInfo.data);
        if (header.totalShares > 0n) {
            // Pro-rata NAV. bigint-safe multiplication.
            baseValue = (shares * header.totalAssets) / header.totalShares;
        }
        // Resolve earliest-maturity allocation for display.
        const allocs = decodeCuratorVaultAllocations(vaultInfo.data);
        if (allocs.length > 0) {
            const marketKeys = allocs.map((a) => new PublicKey(a.market));
            const infos = await conn.getMultipleAccountsInfo(marketKeys);
            for (let i = 0; i < infos.length; i++) {
                const info = infos[i];
                if (!info || info.data.length < 365 + 8)
                    continue;
                const view = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
                const expiry = Number(view.getBigUint64(365, true));
                if (nextRoll === null || expiry < nextRoll)
                    nextRoll = expiry;
            }
        }
    }
    return {
        shares: shares.toString(),
        baseValue: baseValue.toString(),
        nextAutoRollTs: nextRoll,
    };
}
//# sourceMappingURL=fixed-yield.js.map