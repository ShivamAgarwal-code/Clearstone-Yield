# Oracle Configuration — Kamino Lend V2

## Architecture

Kamino Lend V2 supports **three oracle providers** per reserve, all checked during `refresh_reserve`:

```
┌─────────────────────────────────────────────────────────┐
│                  Reserve Oracle Stack                    │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  Pyth    │  │ Switchboard  │  │  Scope (Kamino's   │ │
│  │  Direct  │  │  Direct      │  │  own aggregator)   │ │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘ │
│       │               │                   │             │
│       └───────────────┼───────────────────┘             │
│                       ▼                                 │
│              refresh_reserve()                          │
│        (reads configured oracle(s))                     │
└─────────────────────────────────────────────────────────┘
```

### Scope (Kamino's Oracle Aggregator)

Scope is Kamino's proprietary oracle program (`HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`) that aggregates prices from 26+ sources (Pyth, Switchboard, Chainlink, DEX pools, staking rates, etc.) into a unified feed. It supports price chaining (e.g., TOKEN/USDC * USDC/USD) via `priceChain` arrays.

**We do not use Scope.** Our reserves use direct Pyth feeds, which is simpler and sufficient for stablecoin pairs.

## Our Oracle Setup

| Reserve | Oracle Provider | Feed Address | Token |
|---------|----------------|--------------|-------|
| cUSDY (collateral) | Pyth | `BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb` | USDY/USD |
| USDC (borrow) | Pyth | `Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD` | USDC/USD |

cUSDY uses the underlying USDY price feed since it's a 1:1 wrapped token.

## TokenInfo Configuration

Each reserve's `tokenInfo` in the JSON config controls oracle behavior:

```json
{
  "tokenInfo": {
    "name": "cUSDY",
    "pythConfiguration": {
      "price": "BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb"
    },
    "scopeConfiguration": {
      "priceFeed": "11111111111111111111111111111111",
      "priceChain": [65535, 65535, 65535, 65535],
      "twapChain": [65535, 65535, 65535, 65535]
    },
    "switchboardConfiguration": {
      "priceAggregator": "11111111111111111111111111111111",
      "twapAggregator": "11111111111111111111111111111111"
    },
    "maxAgePriceSeconds": "120",
    "maxAgeTwapSeconds": "240",
    "maxTwapDivergenceBps": "4050",
    "heuristic": { "exp": "0", "lower": "0", "upper": "0" },
    "blockPriceUsage": 0
  }
}
```

### Field Reference

| Field | Description |
|-------|-------------|
| `pythConfiguration.price` | Pyth price feed account pubkey |
| `scopeConfiguration.priceFeed` | Scope feed account (`111...` = disabled) |
| `scopeConfiguration.priceChain` | Array of 4 Scope price indices to chain-multiply (`65535` = unused slot) |
| `scopeConfiguration.twapChain` | Same as priceChain but for TWAP prices |
| `switchboardConfiguration.priceAggregator` | Switchboard V2 aggregator (`111...` = disabled) |
| `switchboardConfiguration.twapAggregator` | Switchboard TWAP aggregator (`111...` = disabled) |
| `maxAgePriceSeconds` | Max staleness before price is rejected (120s for volatile, 300s+ for stables) |
| `maxAgeTwapSeconds` | Max staleness for TWAP price |
| `maxTwapDivergenceBps` | Max allowed divergence between spot and TWAP (basis points) |
| `heuristic.lower` / `upper` / `exp` | Hard price bounds — reject prices outside range (`0` = no bounds) |
| `blockPriceUsage` | `0` = normal, `1` = block this reserve's price from being used |

## refresh_reserve Account Layout

The `refresh_reserve` instruction requires **6 accounts** — all oracle slots must be present even if unused:

```
Account 0: reserve          (writable)
Account 1: lending_market   (read)
Account 2: pyth_oracle      (read) — or PublicKey.default if not configured
Account 3: switchboard_price (read) — or PublicKey.default if not configured
Account 4: switchboard_twap  (read) — or PublicKey.default if not configured
Account 5: scope_prices      (read) — or PublicKey.default if not configured
```

In our SDK (`calldata-sdk-solana`):

```typescript
import { refreshReserve } from "@delta/calldata-sdk-solana";

// Only Pyth configured — switchboard/scope default to PublicKey.default
const ix = refreshReserve(
  reservePubkey,
  marketPubkey,
  PYTH_USDY_PRICE,  // pyth oracle
  // switchboardPrice, switchboardTwap, scopePrices all default to PublicKey.default
);
```

## Applying Oracle Config via updateReserveConfig

Oracle feeds are set post-reserve-initialization using `updateReserveConfig`:

```typescript
import { updateReserveConfig, pubkeyValue, CONFIG_MODE } from "@delta/calldata-sdk-solana";

// Set Pyth oracle on the cUSDY reserve
const ix = updateReserveConfig(
  ownerPubkey,
  marketPubkey,
  reservePubkey,
  CONFIG_MODE.UpdatePythPrice,       // mode 20
  pubkeyValue(PYTH_USDY_PRICE),     // 32-byte pubkey
);
```

### Relevant CONFIG_MODE Values

| Mode | Enum Value | Payload |
|------|-----------|---------|
| `UpdateScopePriceFeed` | 15 | Pubkey (32 bytes) |
| `UpdateScopePriceChain` | 16 | `[u16; 4]` (8 bytes) |
| `UpdateScopeTwapChain` | 17 | `[u16; 4]` (8 bytes) |
| `UpdateTokenInfoMaxAgePriceSeconds` | 18 | u64 (8 bytes) |
| `UpdateTokenInfoMaxAgeTwapSeconds` | 19 | u64 (8 bytes) |
| `UpdatePythPrice` | 20 | Pubkey (32 bytes) |
| `UpdateSwitchboardPrice` | 21 | Pubkey (32 bytes) |
| `UpdateSwitchboardTwap` | 22 | Pubkey (32 bytes) |
| `UpdateTokenInfoTwapDivergence` | 13 | u64 (8 bytes) |
| `UpdateTokenInfoName` | 14 | `[u8; 32]` (32 bytes) |
| `UpdateBlockPriceUsage` | 55 | u8 (1 byte) |

## Full Reserve Config Application Order

When setting up a new reserve, apply configs in this order:

```
1. initReserve(mint, market)
2. updateReserveConfig — UpdatePythPrice (set oracle first)
3. updateReserveConfig — UpdateTokenInfoName
4. updateReserveConfig — UpdateTokenInfoMaxAgePriceSeconds
5. updateReserveConfig — UpdateTokenInfoMaxAgeTwapSeconds
6. updateReserveConfig — UpdateTokenInfoTwapDivergence
7. updateReserveConfig — UpdateLoanToValuePct
8. updateReserveConfig — UpdateLiquidationThresholdPct
9. updateReserveConfig — UpdateDepositLimit
10. updateReserveConfig — UpdateBorrowLimit
11. updateReserveConfig — UpdateBorrowRateCurve
12. updateReserveConfig — UpdateReserveStatus (activate last)
```

Set `skipValidation = true` for all calls except the last one to batch without intermediate checks.

## Switching to Scope (If Needed Later)

If we ever need Scope (e.g., for price chaining or multi-source aggregation):

1. Find/create a Scope configuration with USDY and USDC price indices
2. Set `scopeConfiguration.priceFeed` to the Scope prices account
3. Set `priceChain` to the index chain (e.g., `[42, 65535, 65535, 65535]` for a single index)
4. Set `twapChain` similarly for TWAP
5. Pass the Scope prices account as account 5 in `refresh_reserve`

Scope program (mainnet): `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`
