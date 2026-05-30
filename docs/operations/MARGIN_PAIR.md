# Margin Pair — SOL/USDC Long & Short via klend EG-3 / EG-4

**Status: design locked, deploy pending.** This memo is the contract
between the operator runbook and the implementation: it pins the
elevation-group config, the (asymmetric) gating model, and the UX
pattern for SOL/USDC margin trading on Clearstone.

## Pitch

A single permissioned market that lets a KYC'd wallet take leveraged
long-SOL or short-SOL exposure without leaving the Clearstone stack.
Capital efficiency comes from sharing one underlying liquidity pool
(the klend v3 market that already powers csSOL leverage and ceUSX
stables) across three product surfaces:

- **csSOL leverage** (EG-2) — institutional yield-on-restaked-SOL.
- **Stable lending** (EG-1) — ceUSX collateral, sUSDC debt.
- **SOL/USDC margin** (EG-3 + EG-4) — the new addition; turns idle wSOL
  and sUSDC liquidity into a directional trading venue.

A wallet whitelisted on the unified Clearstone bundle can hold
positions in any combination of these without re-onboarding.

## Klend constraint that shapes the design

klend's `update_elevation_group` ix takes a **single** `debt_reserve`.
There is no "EG with two debt assets". Bidirectional borrowing
therefore requires two EGs, one per direction:

| EG | label | collateral | debt | ltv | liq | max_reserves_as_collateral |
|---|---|---|---|---|---|---|
| 3 | Margin Long SOL  | cSOL  | sUSDC | 65% | 85% | 1 |
| 4 | Margin Short SOL | sUSDC | cSOL  | 65% | 85% | 1 |

A user who wants to be simultaneously delta-hedged opens **two
obligations** under the same wallet (klend supports concurrent
obligations via the `tag`/`id` slots in the obligation PDA seeds), one
in EG-3 and one in EG-4. Operationally this is indistinguishable from
cross-margin from the user's seat — same wallet, same UI, single
margin pool sourced from the user's deposited liquidity.

### Why 65 / 85 (and not 90 / 92 like the other EGs)

EG-1 stables and EG-2 LST/SOL get 90/92 because the assets in those
groups are tightly correlated with the debt asset (ceUSX↔sUSDC are
both USD-pegged; csSOL↔wSOL are both SOL-denominated, with the LST
discount bounded by Jito's redemption window). SOL↔USDC are
**negatively correlated** — a 30% SOL drawdown can easily flip a
position from healthy to liquidatable inside hours, without any
single-asset stress event.

65% LTV gives a meaningful liquidation buffer (35 percentage points to
the liquidation threshold of 85%, plus the 15 percentage points
between liq and 100%). With Pyth as the oracle source and 30s+
staleness windows on devnet, this is the conservative side of what's
safe for a margin product without active health monitoring.

## KYC gating — asymmetric, like the other EGs

EG-1 and EG-2 don't wrap their debt assets — sUSDC and wSOL are plain
SPL tokens, exposed in klend reserves without a delta-mint gate.
The KYC gate flows entirely through the *collateral* wrap requirement:
to deposit ceUSX or csSOL, the user must first wrap the underlying via
delta-mint, which checks the per-MintConfig whitelist on `mint_to`.

EG-3 / EG-4 follow the same pattern:

- **cSOL** — KYC-wrapped wSOL. Mint deployed at
  `AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf`, MintConfig at
  `GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B`. Authority owned by
  the cSOL pool PDA (`7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ`).
  Not yet wired into a klend reserve — see Stage D'.
- **sUSDC** — *plain* Solstice USDC (`8iBux2L…D5g`). Already a klend
  reserve in v3 (`78kkPNAj…BFy9`); reused as-is for the margin pair.
  No second wrap deployed.

What this means for each EG:

- **EG-3 Long SOL**: gate enforced because depositing cSOL requires
  the user to first wrap wSOL → cSOL, which checks the cSOL whitelist.
  Borrowing sUSDC is open to any obligation that has cSOL collateral.
- **EG-4 Short SOL**: a non-KYC wallet *can* deposit sUSDC and borrow
  cSOL, but **cannot unwrap cSOL → wSOL** (unwrap requires the cSOL
  whitelist) and there's no DEX liquidity for cSOL — so the position
  is economically inert for them. The motivated short-SOL user has to
  unwrap, which forces them through the KYC gate. We accept that
  non-KYC wallets can technically open positions and pay borrow
  interest; this is the same affordance EG-2 already gives anyone who
  wants to borrow plain wSOL against csSOL — never observed in
  practice, never an attack surface.

The unified whitelist bundle therefore needs **one new MintConfig**:
cSOL. csSOL, csSOL-WT, and cSOL all sit in
[`whitelist-bundle.json`](../../packages/programs/configs/devnet/whitelist-bundle.json)
and the frontend
[`CSSOL_WHITELIST_BUNDLE`](../../packages/frontend-playground/src/lib/addresses.ts).
A single `whitelist-wallet.ts` invocation covers all three; retail KYC
and institutional KYB pipelines both produce the same Holder PDA on
each.

## Open / close flow

### Long SOL (EG-3)

1. User holds X wSOL (or buys it externally, then bridges in).
2. `governor.wrap_with_susol(X)` → cSOL minted to user (delta-mint
   whitelist check).
3. `klend.deposit_obligation_collateral(cSOL, X)` into a fresh
   obligation tagged for EG-3.
4. `klend.request_elevation_group(3, [cSOL], [sUSDC])`.
5. `klend.borrow_obligation_liquidity(sUSDC, Y)` where Y / X * SOL_USD ≤ 0.65.
6. User externally swaps sUSDC → wSOL (Jupiter / external venue).
7. Loop steps 2-6 to layer leverage; each layer requires a fresh
   wrap on the new wSOL.

Final state: obligation = [cSOL=Σ deposits, debt sUSDC=Σ borrows]. Net
delta = +long SOL by leverage factor.

### Short SOL (EG-4)

Mirror of long: deposit sUSDC, borrow cSOL, unwrap cSOL → wSOL, swap
wSOL → sUSDC, re-deposit, repeat. Final state: obligation =
[sUSDC=Σ, debt cSOL=Σ]. Net delta = -short SOL.

### Close (either direction)

The flash-loan collateral-swap pattern from
[`docs/shipped/CSSOL_WT_PLAN.md`](../shipped/CSSOL_WT_PLAN.md) and the
v2 wSOL-flash unwind in [`OneStepUnwindTab.tsx`](../../packages/frontend-playground/src/tabs/OneStepUnwindTab.tsx)
ports directly:

1. flashBorrow the debt asset (sUSDC or cSOL) at full debt size.
2. repay → withdraw collateral → (unwrap if needed) → swap to debt
   asset externally → flashRepay.

For the partial-close case, scale the borrow / withdraw / swap legs
proportionally; the EG and obligation state survive untouched.

## Per-reserve config requirements

For klend to allow EG-3 / EG-4 borrows, each participating reserve
needs `borrow_limit_against_this_collateral_in_elevation_group[i]`
populated for the new EG indices (mode 45 update). Without this the
borrow trips `BorrowLimitInElevationGroupExceeded` even at zero
utilization.

| reserve | EG-3 cap (debt = sUSDC) | EG-4 cap (debt = cSOL) |
|---|---|---|
| cSOL  | n/a (cSOL is collateral here)             | u64::MAX (cSOL borrowable against sUSDC) |
| sUSDC | u64::MAX (sUSDC borrowable against cSOL)  | n/a (sUSDC is collateral here) |

Bootstrap caps to `u64::MAX` for the launch; tighten to deposit-driven
limits once the markets see real volume.

The sUSDC reserve already participates in EG-1 (debt). Adding it to
EG-3 (debt) and EG-4 (collateral) requires updating its
`elevation_groups: [u8; 20]` array to include `[1, 3, 4, …]`. Same
mechanism `bootstrap-cssol-market-v2.ts` already uses.

## Operator runbook

```bash
cd packages/programs

# 1. Whitelist the deployer on every MintConfig in the bundle.
DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
  npx tsx scripts/whitelist-wallet.ts <DEPLOYER_PUBKEY> holder

# 2. Wrap deployer-side wSOL → cSOL for reserve seed liquidity.
DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
  AMOUNT=10000000 npx tsx scripts/seed-csol-reserve.ts

# 3. Register the cSOL klend reserve and the EG-3 / EG-4 caps.
#    (Stage D' + E in one shot — they're tightly coupled.)
DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
  npx tsx scripts/setup-margin-pair.ts

# 4. Verify.
DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
  npx tsx scripts/verify-margin-egs.ts
```

## Stages

| stage | scope | status |
|---|---|---|
| A | Design memo + market-config JSON | done — this doc, `cssol-market-v3.json` EG-3/EG-4 entries |
| D' | cSOL klend reserve registration | pending — `scripts/setup-margin-pair.ts` |
| E | EG-3 + EG-4 registration via `update_elevation_group` + per-reserve borrow caps | pending — same script as D' |
| F | Frontend: full long/short trade panel in `MarginTradeTab` | pending — currently renders as design preview |

The csUSDC wrapper that an earlier draft of this doc proposed has been
**dropped** — no second wrap is needed because the EG-1/EG-2 pattern
already gates exclusively on the collateral leg. Skipping the wrapper
removes a Token-2022 mint deploy, a delta-mint MintConfig setup, a new
governor pool config, and a governor program upgrade for
`wrap_with_susdc` / `unwrap_with_susdc` ixes — all things that would
have shipped purely defensively.

## Risk notes

- **Oracle drift** — Pyth SOL/USD and USDC/USD both have devnet-grade
  staleness; mainnet should run with stricter `staleness_secs` on the
  reserve refresh chain. Current cssol-market-v3 uses 60s.
- **Liquidation depth** — at 65/85, a 24% SOL move triggers
  liquidations across the EG. We need at least one liquidator bot
  whitelisted as `Liquidator` role on the cSOL MintConfig; use the
  same auto-roll keeper service.
- **MEV on liquidation** — LTV-65 leaves a wider liquidation band than
  EG-2's LTV-90. Sandwich risk on the swap leg of the leverage open
  path is non-trivial; institutional users should prefer Jupiter
  routes with `maxPriceImpactPct = 0.5` or tighter, and ideally batch
  the wrap → deposit → borrow → swap legs through a private mempool
  (Jito bundles).
- **Non-KYC interaction with EG-4** — non-whitelisted wallets can
  deposit sUSDC and borrow cSOL but can't unwrap. They've consumed
  reserve liquidity without realising the short. Identical to EG-2's
  affordance for non-KYC borrowers of plain wSOL; never an issue in
  practice. Hardening would require Token-2022 transfer hooks on
  cSOL — defer until / unless this becomes a live attack surface.

## Cross-references

- Design rationale + product framing: this doc.
- Wrapper deploy mechanics: [`../shipped/CSSOL_WT_PLAN.md`](../shipped/CSSOL_WT_PLAN.md)
  (csSOL-WT pattern; the cSOL deploy follows the same template, minus
  the WT-specific Jito ticket plumbing).
- Flash-loan close machinery:
  [`packages/programs/CSSOL_WITHDRAWAL.md`](../../packages/programs/CSSOL_WITHDRAWAL.md)
  v2 wSOL-flash flow.
- Klend EG semantics: [`docs/KAMINO_ELEVATION_GROUPS.md`](../KAMINO_ELEVATION_GROUPS.md).
- Whitelist bundle: [`whitelist-bundle.json`](../../packages/programs/configs/devnet/whitelist-bundle.json),
  [`CSSOL_WHITELIST_BUNDLE`](../../packages/frontend-playground/src/lib/addresses.ts).
