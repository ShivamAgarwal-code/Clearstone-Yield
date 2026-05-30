# Fixed-Rate Savings on Clearstone — Implementation Plan

Product: fixed-rate savings accounts built on a permissionless Pendle-style
PT/YT protocol, sourcing yield from Kamino USDC / USDT reserves.

Repos in scope:

- [clearstone-finance](../clearstone-finance) — this repo (UX, SDK, backends,
  existing governor/delta-mint for optional KYC gating).
- [clearstone-fixed-yield](/home/axtar-1/clearstone-fixed-yield) — Morpho-Blue-style
  permissionless fork of Exponent Core (`clearstone_core` + adapters + periphery).

## 1. Product shape

Three user modes, one protocol:

| Mode | Who | Flow | Maturity picking |
|---|---|---|---|
| **Fixed-term CD** | Retail / institutional, self-directed | Deposit USDC → buy PT at discount → hold to maturity → redeem 1:1 | Pick an open maturity |
| **Auto-roll savings account** | Retail "set and forget" | Deposit USDC → router buys PT in a curator-chosen maturity → router auto-rolls at maturity | Router decides |
| **KYC-gated fixed yield** | Institutional, compliance-required | Same as above, but gated by a whitelist at the Clearstone-router level | Either |

Fixed APY shown to the user = `(1/PT_price)^(365/days_to_maturity) − 1`, inclusive
of AMM slippage on entry.

## 2. On-chain architecture

```
            ┌───────────────────────────────────────────────────────┐
            │           clearstone-finance (this repo)              │
            │                                                       │
  user ─▶ savings-router ──(opt.)─▶ governor whitelist check       │
     │      │                                                       │
     │      │ zap in: USDC → kamino supply → SY wrap → AMM buy PT   │
     │      │ redeem:  PT → SY unwrap → kamino withdraw → USDC      │
     │      │ auto-roll: on maturity, unwrap PT, re-buy PT(next)    │
     │      └───────────────────────────────────────────────────────┘
     │
     │   ┌───────────────────────────────────────────────────────┐
     └─▶ │         clearstone-fixed-yield (fork)                 │
         │                                                       │
         │   kamino_sy_adapter ──► clearstone_core               │
         │   (SY interface)         (PT / YT split + AMM, ~21 ix) │
         │                                                       │
         │   periphery/clearstone_curator  (MetaMorpho-analog)   │
         │   periphery/clearstone_router   (zap + auto-roll)     │
         │   periphery/clearstone_rewards  (LP emissions, later) │
         └───────────────────────────────────────────────────────┘
                           │
                           ▼
                   Kamino Lend V2 (USDC + USDT reserves only)
```

Key property: **permissionlessness is the default, KYC is opt-in at the
periphery**. The core PT/YT market is always open; a curator vault or router
instance can layer on a whitelist check via CPI into the existing `governor`
whitelist from Clearstone's original KYC stack. Exactly the Kamino model — the
primitive is permissionless, product-level curators choose the policy.

## 3. Components and scope

### 3.1 kamino_sy_adapter (new program — in clearstone-fixed-yield)

Purpose: expose Kamino collateral (kUSDC, kUSDT) to `clearstone_core` via the SY
interface.

- Implement the SY trait that `clearstone_core` expects: `wrap`, `unwrap`,
  `exchange_rate`, plus a permissionless `poke` that refreshes the exchange
  rate from the Kamino reserve.
- Exchange rate = `reserve.liquidity.available + borrowed − protocol_fees ÷
  reserve.collateral.mint_total_supply` (same formula Kamino uses internally
  for kToken redemption).
- Thin implementation: one Kamino reserve per SY account; the SY's underlying
  mint is the reserve's collateral mint (kUSDC / kUSDT).
- No trusted authority. Anyone can create an SY for any Kamino reserve.

Deliverables:

- `programs/kamino_sy_adapter/` with 4 instructions: `init_sy`, `wrap`,
  `unwrap`, `poke_exchange_rate`.
- Integration test hitting the Kamino mainnet fork (pattern already exists in
  [packages/programs/tests/kamino-full-flow.fork.ts](packages/programs/tests/kamino-full-flow.fork.ts)).

### 3.2 clearstone_core integration (fork already has this)

Confirm the existing core supports:

- `create_market(sy, maturity_ts)` — permissionless, maturity chosen by the
  creator.
- PT/YT mint derivation pinned to `(sy, maturity)`.
- AMM pool per market.

Actions:

- Verify curator-addressable fields on `Market` so the savings-router can
  discover maturities.
- Add a `market_registry` view (off-chain) rather than on-chain enumeration.

### 3.3 savings_router (new periphery program — in clearstone-fixed-yield)

The user-facing atomic instruction set. Lives in
`periphery/clearstone_router/` (scaffold already exists).

Instructions:

| Ix | Behavior |
|---|---|
| `zap_in_usdc(amount, market, min_pt_out, optional_whitelist)` | USDC → Kamino supply → SY wrap → buy PT on AMM. If `optional_whitelist` is set, CPI to governor to verify the signer is whitelisted. |
| `zap_out_usdc(pt_amount, market, min_usdc_out)` | At/after maturity: redeem PT 1:1 → SY unwrap → Kamino withdraw → USDC. |
| `register_auto_roll(vault, user, next_maturity, params)` | User opts into auto-roll: stores policy PDA `(vault, user)`. |
| `cancel_auto_roll(vault, user)` | User exits. |
| `crank_auto_roll(vault, user)` | Permissionless cranker: at maturity, unwrap matured PT, re-zap into curator's current target maturity. Cranker tip paid from a small configurable fee. |

The router is stateless for one-shot flows; auto-roll is the only state it
owns, and only `(vault, user)` policy PDAs.

### 3.4 clearstone_curator (periphery — scaffold exists)

MetaMorpho-analog vault that defines the "savings account" product:

- `create_vault(underlying, risk_tier, whitelist_required: bool)` — whitelist
  flag decides whether this vault requires KYC via governor CPI.
- `curator_set_target_market(market)` — curator picks which maturity the
  auto-roller targets next.
- `curator_allowlist_markets([...])` — only these markets are acceptable for
  this vault's auto-roll.
- Shares: vault shares representing pro-rata claim on underlying USDC +
  accrued fixed yield (mint-able as Token-2022 with optional confidential
  extension if KYC is on).

Immutable at init: underlying, whitelist_required, risk_tier.
Mutable by curator: target_market, allowlist_markets, fee (capped).

### 3.5 Optional KYC integration (this repo)

Reuse what already exists — do **not** build a second whitelist.

- `governor` program already has `add_participant(role)` with `Holder` /
  `Liquidator` roles. Extend with a `FixedYield` role (or treat `Holder`
  role as sufficient).
- The savings-router and curator CPI into governor's whitelist check when
  `whitelist_required = true`.
- For non-KYC vaults, the check is skipped entirely — nothing to pay, no
  extra accounts needed.

This matches answer (1): **optional whitelist, configured per vault**,
identical to Kamino's permissionless-with-optional-permissioned-markets model.

### 3.6 calldata-sdk-solana extensions

New module: `src/fixed-yield/` in
[packages/calldata-sdk-solana](packages/calldata-sdk-solana/).

- `buildZapInPT(params)` — composes Kamino supply + SY wrap + AMM buy in one
  tx, sized for one 1232-byte packet where possible (otherwise v0 with LUT).
- `buildZapOutPT(params)`.
- `buildRegisterAutoRoll(params)`, `buildCancelAutoRoll(params)`.
- `buildCrankAutoRoll(params)` — for the keeper bot.
- `quoteFixedAPY(market, amount)` — off-chain quote including AMM slippage.
- `listMarkets({ underlying: 'USDC' | 'USDT' })` — enumerates open markets
  from the indexer.

### 3.7 backend-edge — market indexer

New Cloudflare Worker route in
[packages/backend-edge](packages/backend-edge/):

- `GET /markets` — list of active PT markets (underlying, maturity, AMM state,
  implied fixed APY, Kamino floating APY, TVL).
- `GET /markets/:id` — single-market detail with depth/slippage curve.
- `GET /vaults` — active curator vaults with their current target market.
- `GET /vaults/:id/positions/:user` — user position + next roll time.
- Cache TTL: 15–30s.

Data source: RPC reads of `Market`, `Vault`, `Sy` accounts + Kamino
`Reserve` accounts. No third-party indexer required.

### 3.8 backend-compliance

No changes required for non-KYC vaults. For KYC-gated vaults, the existing
flow ([packages/backend-compliance](packages/backend-compliance/)) already
writes to the governor whitelist — the fixed-yield product reuses it
transparently.

### 3.9 Auto-roll keeper

New service (tiny — can live in backend-edge or as a stand-alone Fly.io box):

- Scans `AutoRollPolicy` PDAs.
- At policy's `next_maturity ≤ now`, submits `crank_auto_roll`.
- Earns the per-crank tip; users who opted in pay a small BPS fee on roll.
- MEV-tolerant: worst case is the user pays a tiny slippage on the rollover
  AMM trade, bounded by the `min_pt_out` stored in the policy.

### 3.10 Frontend surfaces

- [frontend-retail](packages/frontend-retail/) — new `/savings` page.
  - Hero: two cards — "Fixed CD" (pick maturity) and "Savings Account"
    (auto-roll).
  - Entry widget: amount in USDC, dropdown of maturities with APY, deposit
    button.
  - Positions tab: outstanding PTs with maturity countdown + "enable
    auto-roll" toggle.
- [frontend-institutional](packages/frontend-institutional/) — same surface
  but defaults to KYC-gated vaults.
- [frontend-console](packages/frontend-console/) — curator panel:
  create vault, set target market, manage allowlist.

## 4. Answers to the four decisions (locked)

1. **KYC**: optional, per-vault flag. Whitelist check is a governor CPI that
   only fires when the vault was created with `whitelist_required = true`.
   Matches Kamino's permissioned-market pattern.
2. **Assets**: Kamino USDC + USDT reserves only for v1. USDY / eUSX excluded
   (they already carry yield — wrapping them would be double-counting).
3. **Maturities**: fully curator-chosen. Core accepts any `maturity_ts >
   now + MIN_TENOR` (suggest 7-day minimum to avoid dust markets).
4. **Auto-roll**: router/curator feature. User opts in with
   `register_auto_roll`, a permissionless cranker advances the roll, user
   can `cancel_auto_roll` anytime.

## 5. Milestones

| M | Scope | Duration |
|---|---|---|
| **M1 — SY + core wiring** | `kamino_sy_adapter`, fork core `create_market` on USDC/USDT reserves, fork test end-to-end (wrap → split → AMM → redeem) | 1 week |
| **M2 — Router + zaps** | `savings_router` zap in/out, SDK + tx building, retail UI "Fixed CD" | 1 week |
| **M3 — Curator + auto-roll** | `clearstone_curator` savings vault, `register/cancel/crank_auto_roll`, keeper service, retail UI "Savings Account" card | 1.5 weeks |
| **M4 — KYC-gated vaults** | governor CPI wired into router + curator, institutional frontend, compliance backend hookup | 3 days |
| **M5 — Indexer + polish** | backend-edge `/markets`, `/vaults`, console curator panel, monitoring | 4 days |

Total: ~4 weeks of focused work for v1.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Kamino exchange-rate manipulation pre-poke | Require fresh `poke_exchange_rate` in same tx as `wrap/unwrap`; `clearstone_core` already does this pattern for SY calls. |
| Thin AMM liquidity on fresh markets | Seed liquidity from a Clearstone treasury position; curator vaults concentrate liquidity on a few maturities rather than fragmenting. |
| Auto-roll MEV at maturity | Per-policy `min_pt_out` slippage bound; cranker tip small enough that sandwich attack is unprofitable; optional private-RPC submission. |
| Kamino reserve being paused / frozen | SY adapter exposes a `pause_sy` that the *SY creator* (not a global admin) can set — PTs remain redeemable for SY, users just can't unwrap to USDC until Kamino is live. Document this failure mode on the UI. |
| Token-2022 vs SPL mismatch | USDC/USDT are both SPL. If a KYC-gated vault issues Token-2022 shares, the share mint is Token-2022 but the underlying is SPL — same pattern as existing cUSDY wrapping, no new ground. |

## 7. What ships in this repo vs the fork

Changes to this repo ([clearstone-finance](/home/axtar-1/clearstone-finance)):

- `packages/calldata-sdk-solana/src/fixed-yield/` — new module.
- `packages/backend-edge/src/fixed-yield/` — indexer routes.
- `packages/frontend-retail/src/pages/SavingsApp.tsx` — rework to include
  `/savings`.
- `packages/frontend-institutional/src/pages/` — new `SavingsPage.tsx`.
- `packages/frontend-console/src/pages/CuratorPanel.tsx` — new.
- `packages/programs/programs/governor/src/lib.rs` — optional new
  `FixedYield` role (or reuse `Holder`).
- `DECLARATION.md` — add fixed-yield components to §4.

Changes to the fork ([clearstone-fixed-yield](/home/axtar-1/clearstone-fixed-yield)):

- `programs/kamino_sy_adapter/` — new.
- `periphery/clearstone_router/` — flesh out zap + auto-roll instructions.
- `periphery/clearstone_curator/` — flesh out vault + KYC flag + allowlist.
- `tests/` — Kamino-fork integration tests covering the full flow.
- `README.md` / `INTERFACE.md` — document the new instruction surface.

## 8. Open questions (non-blocking)

- **Fee model** — protocol fee on PT trades? Curator fee on vault shares? Both
  need defaults and caps baked into the core at M1.
- **Treasury seeding** — who provides initial AMM liquidity per market? A
  Clearstone-owned address is fine for launch but should be documented.
- **Governance of parameter caps** — `MIN_TENOR`, max curator fee, max protocol
  fee. Frozen at deploy or behind a timelock?
