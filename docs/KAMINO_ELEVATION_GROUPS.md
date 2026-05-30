# Kamino Elevation Groups (eMode)

Kamino Lend's equivalent of Aave v3's **E-Mode**. Elevation groups let correlated-asset positions (e.g. LSTs borrowing SOL) run at materially higher LTV than the cross-asset default, while keeping the reserve's conservative base parameters intact for everyone else.

## Concept

Each reserve on Kamino has a default `loan_to_value_pct` and `liquidation_threshold_pct`. When an obligation opts into an elevation group, those defaults are **overridden** for the duration of that obligation's membership by the group's own parameters.

| Param | Source when NOT in a group | Source when IN a group |
|---|---|---|
| LTV | reserve config | `ElevationGroup.ltv_pct` |
| Liquidation threshold | reserve config | `ElevationGroup.liquidation_threshold_pct` |
| Liquidation bonus | reserve config | `ElevationGroup.liquidation_bonus_bps` |
| Allowed debt reserve | any borrowable reserve | exactly one — `ElevationGroup.debt_reserve` |
| Allowed collateral reserves | any with LTV > 0 | the group's whitelist |
| Max reserves as collateral | obligation limit | `ElevationGroup.max_reserves_as_collateral` (often 1) |

## Canonical example: LST → SOL

Kamino's main market has an elevation group roughly like:

- **Debt:** SOL
- **Collateral:** JitoSOL, mSOL, bSOL (LSTs correlated to SOL)
- **LTV:** ~90–95%
- **Liquidation threshold:** ~92–97%

A user depositing JitoSOL and borrowing SOL inside this group can lever ~10x–20x. The same JitoSOL reserve used outside the group (e.g. to borrow USDC) falls back to the reserve's base LTV (~50–65%).

## Constraints enforced on-chain

When `request_elevation_group` is called, the program validates:

1. The obligation's **only borrow** is the group's `debt_reserve` (or it has no debt yet).
2. Every **deposited collateral** is in the group's whitelist.
3. The number of collateral reserves ≤ `max_reserves_as_collateral` (frequently 1 — meaning single-collateral groups).
4. The obligation is **healthy** under the new (group) parameters. Switching into a group that tightens thresholds while you're at the limit will revert.
5. The group is not disabled.

Leaving a group (switching to group `0`) has symmetric health checks under the base reserve params.

## Switching

```
kamino_lending::request_elevation_group { elevation_group: u8 }
```

- `0` = default / no elevation.
- Any non-zero value must correspond to an enabled `ElevationGroup` on the `LendingMarket`.
- One obligation = one active group at a time.
- To run an LST-leveraged SOL position **and** a stSOL→USDC position simultaneously, use two separate obligations (different seed/tag under the same wallet).

## How this differs from Aave v3 E-Mode

| | Aave v3 E-Mode | Kamino Elevation Group |
|---|---|---|
| Debt restriction | all assets in the category are borrowable | **exactly one** debt reserve per group |
| Collateral restriction | any asset in the category | whitelist, often capped to **one** collateral reserve |
| Parameter override | LTV / LT / liq. bonus | LTV / LT / liq. bonus |
| Per-position | one category per user | one group per obligation (multiple obligations allowed) |
| Switching cost | health check | health check |

The tighter debt/collateral restrictions are why Kamino can safely push group LTVs above what Aave typically offers for the same asset pair.

## Implementation pointers

- Struct: `ElevationGroup` on the `LendingMarket` account (`kamino-lending` program).
- Instruction: `request_elevation_group(u8)` on the obligation.
- Reads: `obligation.elevation_group` tells you the active group; `0` = none.
- Per-market groups differ — always read the market's `elevation_groups` array rather than hard-coding LTVs.

## Practical notes for Clearstone integrations

- When composing strategies on top of Kamino, fetch `ElevationGroup` at build time; do **not** cache LTVs across markets.
- A vault that moves collateral in/out of a group must re-run the health check logic the program enforces, or it will hit `ElevationGroupBorrowDisallowed` / `ElevationGroupHasMultipleDebtReserves` / `ElevationGroupNewLoansDisabled` on-chain.
- For single-collateral groups, deposit ordering matters: you cannot enter the group while holding a non-whitelisted collateral, even dust.
