# Kamino Lend (klend) Market Configuration Guide

Findings from configuring a klend lending market on Solana devnet.

## Oracle Setup

klend supports three oracle paths, checked in order: **Pyth → Switchboard → Scope**.

### Key Finding: Pyth Receiver Discriminator-Only Check

klend uses the **Pyth Solana Receiver** format (`PriceUpdateV2`), NOT the old Pyth V2 format.
The on-chain code calls `PriceUpdateV2::try_deserialize()` which **only checks the 8-byte Anchor discriminator** — it does NOT validate the account owner.

This means you can create mock oracle accounts owned by any program, as long as the data starts with the correct discriminator:

```
PriceUpdateV2 discriminator: 22f123639d7ef4cd
(= sha256("account:PriceUpdateV2")[0..8])
```

### PriceUpdateV2 Data Layout (133 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 8 | discriminator | `22f123639d7ef4cd` |
| 8 | 32 | write_authority | Any pubkey (e.g., admin wallet) |
| 40 | 1 | verification_level | `1` = Full |
| 41 | 32 | feed_id | Arbitrary identifier |
| 73 | 8 | price (i64) | Price × 10^|exponent| (e.g., 108000000 for $1.08 with expo=-8) |
| 81 | 8 | conf (u64) | Confidence interval (e.g., 10000) |
| 89 | 4 | exponent (i32) | Price exponent (e.g., -8) |
| 93 | 8 | publish_time (i64) | Unix timestamp of last update |
| 101 | 8 | prev_publish_time (i64) | Previous timestamp |
| 109 | 8 | ema_price (i64) | EMA price (same as price for static) |
| 117 | 8 | ema_conf (u64) | EMA confidence |
| 125 | 8 | posted_slot (u64) | Slot when posted |

### Oracle Owner Validation Summary

| Oracle | Account Owner Checked? | Program ID |
|--------|----------------------|------------|
| Pyth (Receiver) | **NO** (discriminator only) | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` |
| Switchboard (On-Demand) | **YES** (via FatAccountLoader) | `SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv` |
| Scope | **NO** (discriminator only) | `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ` |

## Reserve Configuration

### Config Update Modes (UpdateReserveConfig)

| Mode | Name | Value Type | Notes |
|------|------|-----------|-------|
| 0 | UpdateLoanToValuePct | u8 (0-99) | Must be < liquidation_threshold |
| 2 | UpdateLiquidationThresholdPct | u8 | Must be >= LTV, <= 100 |
| 8 | UpdateDepositLimit | u64 | In native token units |
| 9 | UpdateBorrowLimit | u64 | Must be >= borrowLimitOutsideElevationGroup |
| 16 | UpdateTokenInfoName | [u8; 32] | Required for validation to pass |
| 17 | UpdateTokenInfoPriceMaxAge | u64 | Seconds. Set to u64::MAX for static oracles |
| 18 | UpdateTokenInfoTwapMaxAge | u64 | Seconds |
| 19 | UpdateScopePriceFeed | Pubkey | Set to default to disable |
| 20 | UpdatePythPrice | Pubkey | The PriceUpdateV2 oracle address |
| 21 | UpdateSwitchboardFeed | Pubkey | Set to default to disable |
| 23 | UpdateBorrowRateCurve | 88 bytes | 11 × (util_bps: u32, rate_bps: u32) |
| 32 | UpdateBorrowFactor | u64 | Must be >= 100 |
| 38 | UpdateReserveStatus | u8 | 0=Active, 1=Obsolete, 2=Hidden |
| 44 | UpdateBorrowLimitOutsideElevationGroup | u64 | **Must be set for borrows to work** |

### Critical: skip_config_integrity_validation Flag

The last byte of the update instruction data is `skipConfigIntegrityValidation`.

- **`skip=false` (0)**: Runs full `validate_reserve_config_integrity()`. Use this for reserves that are "in use" (have deposits).
- **`skip=true` (1)**: Only allowed when the reserve is **NOT in use** AND **usage is blocked** (deposit_limit=0 AND borrow_limit=0). Fails with `InvalidConfig` on active reserves.

**Always use `skip=false` for production reserves.**

### Config Validation Requirements

`validate_reserve_config_integrity()` checks:
1. `status` is valid enum value
2. `loan_to_value_pct < 100`
3. `liquidation_threshold_pct` in `[LTV, 100]`
4. `borrow_factor_pct >= 100`
5. `token_info.is_valid()` — at least one oracle (pyth/switchboard/scope) enabled
6. `token_info.is_twap_config_valid()` — if TWAP enabled, all sources must have TWAP configured
7. If `borrow_limit_outside_elevation_group != u64::MAX`: `borrow_limit >= borrow_limit_outside_elevation_group`
8. Various elevation group consistency checks

### Minimum Config for a Working Reserve

1. **Name** (mode 16) — non-empty, up to 32 bytes
2. **Oracle** (mode 20) — valid PriceUpdateV2 account address
3. **PriceMaxAge** (mode 17) — non-zero (use u64::MAX for static oracles)
4. **LTV** (mode 0) — e.g., 75
5. **LiquidationThreshold** (mode 2) — e.g., 85
6. **BorrowFactor** (mode 32) — at least 100
7. **BorrowRateCurve** (mode 23) — 11-point curve
8. **DepositLimit** (mode 8) — non-zero for deposits
9. **BorrowLimit** (mode 9) — non-zero for borrows
10. **BorrowLimitOutsideElevationGroup** (mode 44) — **set to u64::MAX for no-elevation-group borrows**
11. **Status** (mode 38) — 0 (Active)

## Transaction Ordering

klend's `check_refresh` validates that specific instructions appear in the correct positions:

### Deposit (depositReserveLiquidityAndObligationCollateral)

Required instruction order in the same transaction:
```
ix[N-2]: RefreshReserve (for the deposit reserve)
ix[N-1]: RefreshObligation
ix[N]:   DepositReserveLiquidityAndObligationCollateral
```

### Borrow (borrowObligationLiquidity)

Required instruction order:
```
ix[N-3]: RefreshReserve (collateral reserve)
ix[N-2]: RefreshReserve (borrow reserve)
ix[N-1]: RefreshObligation
ix[N]:   BorrowObligationLiquidity
```

### RefreshObligation Remaining Accounts

`RefreshObligation` takes `[lendingMarket, obligation]` as declared accounts, plus **remaining accounts** for each deposit position:
- For each deposit in the obligation: pass the **reserve** account (1 account per deposit)
- After all deposits: for each borrow: pass the **reserve** account
- Count must match: `deposits.count + borrows.count` remaining accounts

## Obligation PDA Seeds

```
seeds = [&[tag], &[id], owner.key(), lending_market.key(), seed1.key(), seed2.key()]
```

For default obligation (tag=0): `seed1 = seed2 = PublicKey::default()` (all zeros).

### check_obligation_seeds Validation

| Tag | Seed1 | Seed2 | Use Case |
|-----|-------|-------|----------|
| 0 | default pubkey | default pubkey | Standard obligation |
| 1 | valid Mint | valid Mint | Mint-seeded obligation |
| 2 | valid Mint | same as seed1 | Same-mint obligation |
| 3 | valid Mint | valid Mint | Dual-mint obligation |

## UserMetadata

Required before creating an obligation.

**PDA**: `["user_meta", owner_pubkey]` (no market in seeds)

**initUserMetadata args**: `userLookupTable: Pubkey` (can be `PublicKey::default()`)

## Addresses (Devnet)

| Component | Address |
|-----------|---------|
| klend program | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` |
| Global config | `BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W` |
| Lending market | `45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98` |
| cUSDY reserve | `HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw` |
| USDC reserve | `7fYbqqcWnUvz3ffH6knnRRoRhDYaK4MgHH8Cj1Uwii4j` |
| cUSDY oracle (PriceUpdateV2) | `EZxvCYEjyogA2R1Eppz1AWyxhgjZWs4nXQRk3RC2yRLt` |
| USDC oracle (PriceUpdateV2) | `CRhtYFcS32PBbRBrP31JafW15DpPpydZPKMnbkyuiD7W` |
| TradeDesk Oracle program | `7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm` |
