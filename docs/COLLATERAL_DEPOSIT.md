# Collateral Deposit & Wrapping — Technical Guide

## Overview

Institutions deposit yield-bearing collateral (ceUSX) into a klend lending market and borrow stablecoins (USDC) against it. The collateral goes through a KYC-wrapping pipeline before it can be deposited.

## Token Pipeline

```
USDC/USDT → Mint USX → Lock in YieldVault → eUSX → KYC Wrap → ceUSX → Deposit as Collateral
                (Solstice API)   (Solstice API)        (Governor)       (klend)
```

| Step | Input | Output | Program | Notes |
|------|-------|--------|---------|-------|
| 1. Mint USX | USDC or USDT | USX | Solstice API | Amount in **lamports** (1 USDC = 1,000,000) |
| 2. Lock USX | USX | eUSX | Solstice API | Yield-bearing (~8-12% APY) |
| 3. KYC Wrap | eUSX | ceUSX | Governor (`wrap`) | Requires whitelist entry |
| 4. Deposit | ceUSX | Collateral position | klend | Creates/uses obligation |

## Solstice API Integration

**Endpoint**: `POST /v1/instructions`
**Auth**: `x-api-key` header (set via `VITE_SOLSTICE_API_KEY` env var)

### Key Details

- The API returns **raw instruction bytes** (`{ instruction: { program_id, accounts, data } }`), not serialized transactions
- `RequestMint` + `ConfirmMint` must be in the **same transaction** (atomic) — otherwise the pending mint expires
- `amount` parameter is in **lamports** (base units with 6 decimals), not whole tokens
- ATAs for USX and eUSX must be **created before** the respective instructions (add `createAssociatedTokenAccountInstruction` before the API instruction)
- The Solstice API is **CORS-blocked** — use a Vite proxy (`/api/solstice`) in dev mode

### Vite Proxy Config

```typescript
// vite.config.ts
server: {
  proxy: {
    "/api/solstice": {
      target: "https://instructions.solstice.finance",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/solstice/, "/v1/instructions"),
    },
  },
}
```

## KYC Wrapping

The `wrap` instruction on the Governor program:
1. Transfers eUSX from user → pool vault (1:1)
2. Mints ceUSX to user (Token-2022)
3. Requires the user to be **whitelisted** on the pool's MintConfig

### Whitelisting for Activated Pools

When `activate_wrapping` is called on a pool, the delta-mint authority transfers to the pool PDA. After this:

- **Cannot** use `add_participant` (old path — signer is no longer the authority)
- **Must** use `add_participant_via_pool` (signs as pool PDA via CPI)
- Requires `fix_co_authority` first if the pool was activated before the co_authority fix was deployed

```bash
# Fix co_authority (one-time, per pool)
pnpm add-admin-via-pool --fix-co-authority <POOL_ADDRESS>

# Whitelist a wallet on an activated pool
pnpm whitelist-via-pool <WALLET_ADDRESS> <POOL_ADDRESS>
```

### Anchor Discriminators

Browser code **cannot** use `crypto.createHash` (Node.js API). All discriminators must be precomputed:

```typescript
const DISC = {
  init_user_metadata: Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]),
  init_obligation: Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]),
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refresh_obligation: Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]),
  deposit_reserve_liquidity_and_obligation_collateral: Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]),
  borrow_obligation_liquidity: Buffer.from([121, 127, 18, 204, 73, 245, 225, 65]),
  wrap: Buffer.from([178, 40, 10, 189, 228, 129, 186, 140]),
};
```

## klend Deposit Transaction

The deposit transaction requires these instructions **in order**:

```
1. [If new user]    InitUserMetadata
2. [If new user]    InitObligation (with unique id)
3.                  RefreshReserve (collateral reserve + oracle)
4.                  RefreshObligation (+ remaining accounts for existing deposits)
5.                  DepositReserveLiquidityAndObligationCollateral
```

### Obligation IDs — Critical Nuance

Each wallet can have multiple obligations per market, differentiated by `(tag, id)`. The PDA is:

```
seeds = [tag(u8), id(u8), wallet, market, seed1, seed2]
```

**Problem**: Old obligations may contain deposits in **stranded reserves** (reserves created during earlier iterations that are no longer used). When `RefreshObligation` runs, it requires remaining accounts for ALL deposit positions. If the obligation has deposits in reserves we don't know about, the refresh fails with `InvalidAccountInput (0x1776)`.

**Solution**: Use a **fresh obligation id** that has no prior deposits:

```typescript
const OB_ID = 3; // Avoid 0, 1, 2 which may have old deposits
const [obPda] = PublicKey.findProgramAddressSync(
  [Buffer.from([0]), Buffer.from([OB_ID]), wallet.toBuffer(), market.toBuffer(),
   PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
  KLEND
);
```

**Currently used obligation IDs**:
| ID | Status | Contents |
|----|--------|----------|
| 0 | Stranded | Old cUSDY + old USDC deposits |
| 1 | Stranded | Old USDC deposit |
| 2 | Used by authority USDC liquidity deposit | sUSDC collateral |
| **3** | **Active** | ceUSX deposits (institutional frontend) |

### RefreshObligation Remaining Accounts

`RefreshObligation` expects remaining accounts matching the obligation's positions:

- For each **deposit position**: pass the reserve address (read-only)
- For each **borrow position**: pass the reserve address (read-only)
- Count must exactly match `num_deposits + num_borrows`

If the obligation is empty (just created), pass **zero** remaining accounts.

### Reserve Account Offsets (Raw Bytes)

When reading reserve config from raw account data (browser, no SDK):

| Field | Absolute Offset | Type |
|-------|----------------|------|
| LTV | 4872 | u8 |
| Liquidation Threshold | 4873 | u8 |
| Borrow Factor | 5008 | u64 |
| Deposit Limit | 5016 | u64 |
| Borrow Limit | 5024 | u64 |
| Token Name | 5032 | 32 bytes (UTF-8) |
| Status | 4861 | u8 (0=Active, 1=Obsolete, 2=Hidden) |
| Borrow Rate Curve | 4920 | 11 × (u32, u32) = 88 bytes |

### Wallet Adapter Issues

The Solana wallet adapter's `sendTransaction` can fail with "Unexpected error" when:
- The transaction has duplicate signer pubkeys (same wallet listed twice)
- The transaction is missing `recentBlockhash` or `feePayer`

**Fix**: Use `signTransaction` + `sendRawTransaction` instead:

```typescript
async function signAndSend(tx: Transaction): Promise<string> {
  if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
```

## Active Reserves

| Reserve | Address | Mint | Oracle | LTV | Price |
|---------|---------|------|--------|-----|-------|
| ceUSX | `3FkBgVfn...` | `8Uy7rmtA...` (Token-2022) | `6dbNQrjL...` | 95% | $1.08 |
| dtUSDY | `HhTUuM5X...` | `6SV8ecHh...` (Token-2022) | `4Xv1RpZQ...` | 95% | $1.08 |
| sUSDC | `AYhwFLgz...` | `8iBux2LR...` (Token) | `EN2FsFZF...` | 0% | $1.00 |

Market: `45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98`

## Stranded Reserves (Do Not Use)

These were created during earlier setup and have locked configs:

- `HoEa26bH...` — old cUSDY
- `7fYbqqcW...` — old test USDC
- `GwcTF1ux...` — old Solstice USDC
- `D4qXufDq...` — old USDC (first attempt)

## Common Errors

| Error | Code | Cause | Fix |
|-------|------|-------|-----|
| `InvalidAccountInput` | 0x1776 / 6006 | Obligation has deposits in unknown reserves | Use a fresh obligation id |
| `DepositLimitExceeded` | 0x17c9 / 6089 | Reserve deposit limit reached | Increase via UpdateReserveConfig |
| `BorrowLimitExceeded` | 0x17c9 / 6089 | Same but for borrows | Increase limit or borrowLimitOutsideEG |
| `AccountNotInitialized` | 0xbc4 / 3012 | ATA doesn't exist | Create ATA before the instruction |
| `InsufficientLiquidity` | 0x1778 / 6008 | Reserve vault has no tokens | Deposit liquidity first |
| `InvalidConfig` | 0x1774 / 6004 | Config validation failed | Check LTV < LiqThresh, name set, oracle valid |
| `PriceNotValid` | 0x179c / 6044 | Oracle price invalid | Check oracle owner, data format, staleness |
| `AccountDiscriminatorMismatch` | 0xbba / 3002 | Wrong account type passed | Verify account addresses |
| `crypto.createHash not a function` | — | Node.js API in browser | Use precomputed discriminators |
| `Unexpected error` (wallet) | — | Wallet adapter issue | Use `signTransaction` + `sendRawTransaction` |
