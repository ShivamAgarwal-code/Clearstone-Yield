# Clearstone — Architecture

The big picture in one page: what's on-chain, what talks to what, and
where your tokens move during each operation.

For curator-side ops ("I want to create a market") see
[CURATOR_GUIDE.md](CURATOR_GUIDE.md).
For the safety spec see [INVARIANTS.md](INVARIANTS.md).

## Programs in the system

```
┌────────────────────────────┐     ┌────────────────────────────┐
│  clearstone_core           │     │  SY program                │
│  (trusted, audited)        │─CPI→│  (user-selected, untrusted)│
│                            │     │                            │
│  - init_vault              │     │  - mint_sy / redeem_sy     │
│  - init_market_two         │     │  - deposit_sy / withdraw_sy│
│  - strip / merge           │     │  - get_sy_state            │
│  - trade_pt / buy_yt       │     │  - claim_emission          │
│  - collect_interest        │     │  - get_position            │
│  - deposit/withdraw_liq    │     │  - init_personal_account   │
│  - modify_* (curator)      │     │                            │
└─────────┬──────────────────┘     │  Reference impls:          │
          ▲                        │  - generic_exchange_rate_sy│
          │                        │    (pokable exchange rate) │
          │                        │                            │
          │ CPI                    │  Test-only impls:          │
          │                        │  - malicious_sy_nonsense   │
  ┌───────┴────────┐               │    (returns garbage state) │
  │ clearstone_    │               └────────────────────────────┘
  │ router         │                            ▲
  │                │                            │ CPI
  │ (periphery —   │                            │
  │  base ↔ SY     │──────────────CPI───────────┘
  │  UX sugar)     │
  └────────────────┘
          ▲
          │ user tx
          │
      ┌───┴───┐
      │ user  │
      └───────┘


  ┌──────────────────────┐        ┌──────────────────────┐
  │ clearstone_rewards   │        │ clearstone_curator   │
  │ (periphery)          │        │ (periphery,          │
  │                      │        │  MetaMorpho analog)  │
  │ LP staking +         │        │                      │
  │ farm emissions.      │        │ base → super-shares. │
  │ No CPI into core —   │        │ Rebalances base      │
  │ users transfer LP    │        │ across multiple      │
  │ tokens here.         │        │ core markets via CPI.│
  └──────────────────────┘        └──────────────────────┘
```

**Trust boundary.** Everything to the left of the "│ CPI →" is
trusted. Everything to the right is **whatever program the curator
picked** at vault init time — clearstone_core never validates that
program's behavior, it just CPIs into a standard discriminator
interface and validates returns (`validate_sy_state` in
[utils/sy_cpi.rs](programs/clearstone_core/src/utils/sy_cpi.rs)).

**Permissioning.** The core is permissionless in creation
(anyone can init a vault + market). It is *per-market* curated: the
curator named at init is the only key that can change that specific
vault/market's settings (see [INTERFACE.md](INTERFACE.md) →
"Curator-gated instructions").

## Per-market state graph

```
 base mint (SPL)
    │
    │ (adapter.mint_sy wraps 1:1 at configurable exchange rate)
    ▼
 sy mint (SPL — authority = sy_market PDA)
    │
    │ (core.strip / core.merge)
    ▼
 ┌───────────────────────────────────────────────┐
 │ Vault                                         │
 │  - curator: Pubkey   (immutable, governs)     │
 │  - creator_fee_bps:  (immutable, capped 25%)  │
 │  - reentrancy_guard: (byte offset 42)         │
 │  - mint_pt / mint_yt                          │
 │  - escrow_sy (vault's SY custody)             │
 │  - yield_position  (vault's own SY deposit    │
 │                     in the SY program)        │
 │  - last_seen / all_time_high / final          │
 │                     exchange rates            │
 │  - sy_for_pt (backing math — I-V1)            │
 └───────────────────────────────────────────────┘
    │
    │ (one or more markets per vault, seed_id 1..=255)
    ▼
 ┌───────────────────────────────────────────────┐
 │ MarketTwo                                     │
 │  - curator: Pubkey   (immutable)              │
 │  - mint_lp                                    │
 │  - escrow_pt / escrow_sy  (AMM reserves)      │
 │  - financials:                                │
 │     pt_balance, sy_balance (real)             │
 │     + VIRTUAL_PT, VIRTUAL_SY (phantom floor)  │
 │     ln_fee_rate_root  (immutable curve param) │
 │     rate_scalar_root  (immutable curve param) │
 │     last_ln_implied_rate                      │
 └───────────────────────────────────────────────┘
```

Numeric caps:
- `PROTOCOL_FEE_MAX_BPS = 2500` (25%, compile-time, I-E1).
- `MIN_DURATION_SECONDS = 86_400` (1 day).
- `MAX_DURATION_SECONDS = 5 years`.
- `VIRTUAL_PT = VIRTUAL_SY = VIRTUAL_LP_FLOOR = 1_000_000` (Blue-style
  anti-donation / anti-sandwich).

## Data flow: user operations

### Strip (base SY → PT + YT)

```
user                core.strip                 SY program
│                         │                         │
│ SY src → escrow_sy      │                         │
├─────────(SPL transfer)─►│                         │
│                         │                         │
│                         │  latch guard=1 @ off 42 │
│                         │      deposit_sy CPI     │
│                         ├────────────────────────►│
│                         │  ←── SyState return ──  │
│                         │  unlatch guard=0        │
│                         │                         │
│                         │  validate_sy_state      │
│                         │  update sy_for_pt       │
│                         │                         │
│                 mint PT to pt_dst ◄──────         │
│                 mint YT to yt_dst ◄──────         │
│                         │                         │
```

The guard byte on the Vault (see
[reentrancy.rs](programs/clearstone_core/src/reentrancy.rs)) is set
via raw-byte write at offset 42 *before* the CPI fires. A malicious
SY program that reenters would hit a latched byte and fail with
`ReentrancyLocked`.

### Merge (PT + YT → base SY)

```
user                core.merge                 SY program
│                         │                         │
│                         │  get_sy_state CPI ────► │
│                         │  ←──── SyState ──────── │
│                         │  handle_merge math      │
│                         │  withdraw_sy CPI ─────► │
│                         │  ←──── SyState ──────── │
│                         │                         │
│         escrow_sy → sy_dst ◄────(SPL)─            │
│         burn PT from pt_src ◄─────────            │
│         burn YT from yt_src ◄───────── (if active)│
```

Both CPIs latch the guard independently. Between them, state is
persisted to disk so a reentry attempt finds the latch set.

### Trade PT (AMM swap)

```
user           core.trade_pt               SY program
│                    │                         │
│                    │  get_sy_state CPI ────► │
│                    │  ←──── SyState ──────── │
│                    │  financials.trade_pt    │
│                    │    (virtualized math:   │
│                    │     pt_balance+VP,      │
│                    │     sy_balance+VS)      │
│                    │  updates pt_balance,    │
│                    │  sy_balance, implied    │
│                    │  rate (real only)       │
│                    │                         │
│  SPL transfers:    │                         │
│    PT trader ↔ escrow_pt                     │
│    SY trader ↔ escrow_sy                     │
│    treasury fee ↔ token_fee_treasury_sy      │
│                    │                         │
│  second SY CPI for the net SY movement:      │
│   buy: deposit_sy ─────────────────────────► │
│   sell: withdraw_sy ────────────────────────►│
```

Reserves are tracked as **real** balances; the AMM math reads them
through `v_pt_balance()` / `v_sy_balance()` which add the virtual
floor. A 1-wei donation to `escrow_sy` inflates the real balance but
the virtualized view barely moves — this is what I-M3 buys you.

## Lifecycle of a vault

```
 ┌─────────┐   anyone calls initialize_vault(curator, creator_fee_bps, ...)
 │ created │ ◄──── requires: creator_fee_bps ≤ 25%,
 └────┬────┘                  duration in [1 day, 5 years],
      │                       start_timestamp ≥ now,
      │                       min_op_sizes > 0
      │ start_timestamp
      ▼
 ┌─────────┐   strip / merge / trade / deposit / withdraw
 │ active  │ ──── curator: can pause (status flags),
 └────┬────┘       ratchet-down interest_bps_fee,
      │            tune claim limits, update LUT
      │            …but cannot raise any fee, change curve,
      │            or bump max_py_supply.
      │ start_ts + duration
      ▼
 ┌─────────┐   PT redeems 1:1 at frozen final_sy_exchange_rate
 │ matured │ ──── I-V4: no more updates to final rate.
 └─────────┘       YT stops accruing. Treasury can drain
                   post-maturity SY appreciation (lambo fund).
```

## File index

- Core state: [vault.rs](programs/clearstone_core/src/state/vault.rs),
  [market_two.rs](programs/clearstone_core/src/state/market_two.rs).
- Core instructions: [src/instructions/](programs/clearstone_core/src/instructions/).
- SY CPI wrappers (guarded): [utils/sy_cpi.rs](programs/clearstone_core/src/utils/sy_cpi.rs).
- Reentrancy helpers: [reentrancy.rs](programs/clearstone_core/src/reentrancy.rs).
- Compile-time constants: [constants.rs](programs/clearstone_core/src/constants.rs).
- Reference SY adapter: [reference_adapters/generic_exchange_rate_sy/](reference_adapters/generic_exchange_rate_sy/src/lib.rs).
- Test-only nonsense adapter: [reference_adapters/malicious_sy_nonsense/](reference_adapters/malicious_sy_nonsense/src/lib.rs).
- Router (base-asset UX): [periphery/clearstone_router/](periphery/clearstone_router/src/lib.rs).
- Test helpers: [tests/fixtures.ts](tests/fixtures.ts).
