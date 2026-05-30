# Solstice USX / eUSX Integration

## Overview

[Solstice Finance](https://solstice.finance) provides USX (a 1:1 backed stablecoin) and eUSX (yield-bearing staked USX via YieldVault). We integrate eUSX as **yield-bearing collateral** in our KYC-gated lending market.

### Value Proposition

Institutions deposit eUSX (earning ~8-12% APY) as collateral, then borrow USDC against it. This creates a **leveraged yield carry trade**: earn 10% on collateral while borrowing at 5% = net 5% profit. Exactly what institutional treasury desks want.

## Token Details (Devnet)

| Token | Mint Address | Decimals | Program | Price |
|-------|-------------|----------|---------|-------|
| **USDT** (Solstice) | `5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft` | 6 | Token | $1.00 |
| **USDC** (Solstice) | `8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g` | 6 | Token | $1.00 |
| **USX** | `7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS` | 6 | Token | $1.00 |
| **eUSX** | `Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt` | 6 | Token | ~$1.08* |
| **USDG** | `HLwjxqGBrZPN7hehv7e9RXnqBr4AHJ9YMczFpw9AZu7r` | 6 | Token-2022 | $1.00 |

> *eUSX accrues yield over time, so its price increases relative to USX (similar to stETH vs ETH).

## Programs (Devnet)

| Program | Address |
|---------|---------|
| USX Program | `usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD` |
| YieldVault Program | `euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr` |

## API

**Endpoint**: `POST https://instructions.solstice.finance/v1/instructions`

**Header**: `x-api-key: SET_VIA_ENV_VAR`

### Operations

| Operation | Description |
|-----------|-------------|
| `RequestMint` | Deposit USDC/USDT → receive USX |
| `ConfirmMint` | Confirm a pending mint |
| `CancelMint` | Cancel a pending mint |
| `RequestRedeem` | Return USX → receive USDC/USDT back |
| `ConfirmRedeem` | Confirm a pending redemption |
| `CancelRedeem` | Cancel a pending redemption |
| `Lock` | Lock USX in YieldVault → receive eUSX |
| `Unlock` | Begin eUSX unlock (cooldown period) |
| `Withdraw` | Withdraw USX after unlock cooldown |

### Example: Mint USX

```json
{
  "type": "RequestMint",
  "data": {
    "amount": 1000,
    "collateral": "usdc",
    "user": "<wallet-pubkey>"
  }
}
```

The API returns a serialized Solana instruction to include in your transaction.

## Integration Architecture

```
┌────────────────────────────────────────────────────────┐
│                    User Flow                            │
├────────────────────────────────────────────────────────┤
│                                                        │
│  1. Deposit USDC/USDT ──→ Mint USX (Solstice API)     │
│  2. Lock USX ──→ Get eUSX (YieldVault, earns ~10%)    │
│  3. KYC Check ──→ Whitelist wallet (Governor)          │
│  4. Wrap eUSX ──→ Get ceUSX (KYC-gated d-token)       │
│  5. Deposit ceUSX ──→ Collateral in klend market       │
│  6. Borrow USDC ──→ Against ceUSX collateral           │
│                                                        │
│  Net effect: Earn ~10% on collateral, borrow at ~5%   │
│  = ~5% carry trade for institutional treasury          │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## Whitelisted Wallets

| Wallet | Address | Status |
|--------|---------|--------|
| Achthar (Phantom) | `J4vmoD6gQe4YyX9Qc8Z7euVwnimmrxUX5JMhfwbEhuB7` | ✓ Whitelisted, has 3000 USDT + 3000 USDC |
| Authority | `AhKNmBmaeq6XrrEyGnSQne3WeU4SoN7hSAGieTiqPaJX` | Needs whitelisting |

## Oracle Pricing

- **USX**: $1.00 (pegged stablecoin)
- **eUSX**: ~$1.08+ (yield-bearing, price increases over time)
  - On mainnet: price = `USX_in_vault / eUSX_supply` (read from YieldVault)
  - On devnet: we set via TradeDesk Oracle (PriceUpdateV2 format)

## Important Notes

1. **USDC/USDT mints are Solstice-specific** — they are NOT Circle/Tether devnet mints. Use the addresses above.
2. **Wallet must be whitelisted** by Solstice before interacting with USX programs.
3. **eUSX has a cooldown period** for unlocking — you can't instantly redeem back to USX.
4. **PDA interactions**: The whitelist checks against the `user` field, not the `collateral_account`. So PDAs can hold tokens but the whitelisted user wallet must be the signer.
