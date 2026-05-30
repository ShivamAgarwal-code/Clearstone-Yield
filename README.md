# Delta — KYC-Gated Lending on Solana

Regulated lending pools built on permissionless infrastructure. Compliance at the token layer, lending via audited protocols.

## What This Is

A **KYC-wrapped USDY** token (cUSDY) that can be used as collateral in **Kamino Lend V2** permissionless markets — enabling institutional-grade, regulated lending without building custom lending infrastructure.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   KYC Provider ──▶ Governor ──▶ delta-mint ──▶ Kamino V2     │
│   (off-chain)      (orchestrator) (on-chain)   (audited)     │
│                                                               │
│   1. Operator creates pool via governor (one tx)              │
│   2. User passes KYC → authority whitelists wallet            │
│   3. User receives cUSDY (1:1 wrapped USDY, Token-2022)      │
│   4. User deposits cUSDY as collateral into Kamino market     │
│   5. User borrows USDC against it (95% LTV)                  │
│                                                               │
│   Only KYC'd wallets can hold the token = only they can lend │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Same model as **Aave Horizon** — compliance at the asset layer, not the protocol layer.

The same primitive applies to other underlying assets. The codebase ships
two productionized wrappers and an extensible governor that can mint more.

## Products built on this primitive

### cUSDY — KYC-wrapped USDY for stablecoin lending

The original product. KYC-gated wrapper around Ondo's USDY, deposited into
a permissionless Kamino market (USDC borrow), in elevation group 1
(stables). Live on devnet; see [KAMINO_INTEGRATION.md](docs/operations/KAMINO_INTEGRATION.md).

### csSOL — KYC-gated re-staked LST on the Jito stack

A second instance of the same wrapper pattern, but with the underlying
backed by a **Jito Vault VRT** instead of a stable. Users deposit SOL,
receive csSOL, and use it as collateral in elevation group 2 (LST/SOL,
90% LTV) to borrow wSOL. The accrual/yield comes from the Jito Vault
layer; the compliance boundary is enforced at every layer we operate.

Three Jito products are central architectural pieces — not surface-level
integrations:

| Layer | Jito product | What it does for csSOL |
|---|---|---|
| Backing | **Jito Vault** (`Vau1t6sLN…`) | Holds the supportedMint (wSOL on devnet, JitoSOL on mainnet). `mintBurnAdmin` set to our governor pool PDA → only KYC-gated CPI from `governor::wrap` can mint VRT. |
| Pricing | **Jito Vault state** | `accrual_oracle::refresh_with_vault` reads `vault.tokensDeposited / vault.vrtSupply` on-chain. csSOL price = SOL/USD × on-chain Vault ratio. No authority knob in the price path — yield/loss is sourced from real Jito stack state. |
| Execution | **Jito Bundles** (Block Engine) | Wrap+deposit user flows submitted as atomic-or-revert bundles via the Block Engine RPC. Mainnet-ready code path; devnet POC verified by Jito UUID. |
| Monitoring (planned) | **Jito ShredStream** | Liquidator that consumes shred-level data ~150ms ahead of confirmed slots. Devnet stand-in via `Connection.onLogs(processed)` proves the architecture; mainnet swap is wire-only. |

End-to-end verified on devnet. Architecture and live deploy state in
[JITO_INTEGRATION_PLAN.md](docs/shipped/JITO_INTEGRATION_PLAN.md) and
[packages/programs/configs/devnet/](packages/programs/configs/devnet/).

#### AML posture (csSOL specifically)

KYC enforcement layered at every protocol layer we operate, not just at
the user-facing wrapper:

1. **delta-mint Token-2022 KYC gate** — only whitelisted wallets can hold
   csSOL; transfers to non-whitelisted destinations are rejected.
2. **governor pool PDA as `mintBurnAdmin` on the Jito Vault** — VRT
   minting is only possible via CPI from `governor::wrap`, which itself
   verifies the delta-mint whitelist before signing. There is no path for
   a non-KYC wallet to mint VRT against our vault.
3. **Underlying asset is acquired upstream** — wSOL on devnet (native,
   AML-neutral) or JitoSOL on mainnet. JitoSOL's own pool dynamics are
   Jito Foundation's compliance scope, the same way USDY's are Ondo's.
   We do not deposit our pool's funds into a community/public pool at any
   layer.

This is the Aave-Horizon compliance model applied across a Jito stack:
regulated wrapper around upstream-managed assets, with our own gated
restaking layer in between.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Governor Program                                                     │
│ (orchestrator — single entry point)                                  │
│                                                                      │
│  initialize_pool(params) ──CPI──▶ delta-mint.initialize_mint()      │
│  add_participant(role)   ──CPI──▶ delta-mint.add_to_whitelist()     │
│  mint_wrapped(amount)    ──CPI──▶ delta-mint.mint_to()              │
│  register_lending_market()       (stores klend addresses)            │
│  set_pool_status()               (freeze / unfreeze)                 │
├─────────────────────────────────────────────────────────────────────┤
│ Delta-Mint Program                                                   │
│ (KYC whitelist + Token-2022 mint with confidential transfers)        │
│                                                                      │
│  Roles: Holder (KYC'd, can mint+hold) | Liquidator (receive-only)   │
├─────────────────────────────────────────────────────────────────────┤
│ Kamino Lend V2 (external, audited)                                   │
│ (permissionless markets, reserves, liquidation, interest rates)      │
├─────────────────────────────────────────────────────────────────────┤
│ Pyth Oracle (external)                                               │
│ USDY/USD: BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb            │
│ USDC/USD: Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD            │
└─────────────────────────────────────────────────────────────────────┘
```

| Layer | What | Who Builds It |
|-------|------|---------------|
| **Orchestration** | Pool lifecycle, whitelist management, status control | Us (governor program) |
| **Token** | Token-2022 mint with confidential transfer ext, PDA mint authority, KYC whitelist with roles | Us (delta-mint program) |
| **Lending** | Permissionless market, reserves, liquidation engine, interest rate curves | Kamino Lend V2 (audited) |
| **Oracle** | USDY/USD + USDC/USD price feeds — reuse underlying asset feeds | Pyth Network |

## Project Structure

```
packages/
├── programs/                         # Solana programs (Anchor 0.30.1)
│   ├── programs/
│   │   ├── delta-mint/               # KYC-gated token program
│   │   └── governor/                 # Pool orchestration program
│   ├── tests/
│   │   ├── delta-mint.ts             # Unit tests (local validator)
│   │   ├── delta-mint.fork.ts        # Fork tests (mainnet state)
│   │   ├── kamino-market.fork.ts     # Market creation + PDA verification
│   │   ├── governor.fork.ts          # Governor-orchestrated flow
│   │   └── kamino-full-flow.fork.ts  # E2E: mint → deposit → borrow
│   └── configs/
│       ├── delta_usdy_reserve.json   # Kamino reserve config (cUSDY collateral)
│       └── usdc_borrow_reserve.json  # Kamino reserve config (USDC borrow)
├── frontend/                         # React + Vite (Solana wallet adapter)
└── backend/                          # Fastify API server
```

## Programs

### delta-mint

**Program ID:** `3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY`

| Instruction | Description |
|---|---|
| `initialize_mint(decimals)` | Creates Token-2022 mint with confidential transfer extension. Mint authority = program PDA. |
| `add_to_whitelist()` | Authority approves a wallet (Holder role). Creates WhitelistEntry PDA. |
| `add_liquidator()` | Authority approves a liquidator bot (Liquidator role — receive-only, cannot mint). |
| `remove_from_whitelist()` | Revokes approval. Closes PDA, returns rent. |
| `mint_to(amount)` | Mints tokens to a whitelisted Holder. Rejects Liquidators and non-whitelisted wallets. |

### governor

**Program ID:** `2TaDoLXG6HzXpFJngMvNt9tY29Zovah77HvJZvqW96sr`

| Instruction | Description |
|---|---|
| `initialize_pool(params)` | Creates PoolConfig + wrapped Token-2022 mint via CPI to delta-mint. Minimal params: oracles, LTV, decimals. |
| `register_lending_market(market, col, borrow)` | Stores klend addresses after off-chain creation. Activates the pool. |
| `add_participant(role)` | Unified whitelist — CPI to delta-mint (Holder or Liquidator). |
| `mint_wrapped(amount)` | Mint to whitelisted Holder via CPI. Only works when pool is Active. |
| `set_pool_status(status)` | Freeze/unfreeze (Initializing → Active → Frozen). |

## Full Lending Flow (Proven in Fork Tests)

```
Step 1: Create KYC-gated token
  governor.initializePool({
    underlying: USDY, oracle: Pyth_USDY,
    borrow: USDC,     borrowOracle: Pyth_USDC,
    decimals: 6, ltv: 95, liquidation: 97
  })
  → Creates cUSDY Token-2022 mint + PoolConfig PDA

Step 2: Configure Kamino market (off-chain SDK)
  → initLendingMarket (quoteCurrency: USD)
  → initReserve (cUSDY collateral, Token-2022)
  → initReserve (USDC borrow, SPL Token)
  → updateReserveConfig × N (LTV=95%, oracle, limits)

Step 3: governor.registerLendingMarket(market, reserves)
  → Pool transitions to Active

Step 4: KYC + Deposit
  governor.addParticipant({ holder: {} })  → whitelist user
  governor.mintWrapped(1000_000_000)       → 1000 cUSDY
  klend.depositAndCollateral(500_000_000)  → 500 cUSDY collateral

Step 5: Borrow
  klend.refreshReserve (cUSDY + USDC oracles)
  klend.refreshObligation
  klend.borrowObligationLiquidity(400_000_000)  → 400 USDC borrowed

Result: 500 cUSDY collateral → 400 USDC borrowed (80% of 95% LTV)
```

## Reserve Configurations

**cUSDY Collateral** ([delta_usdy_reserve.json](packages/programs/configs/delta_usdy_reserve.json)):
| Parameter | Value | Rationale |
|---|---|---|
| LTV | 95% (configurable) | High LTV for stablecoin-backed collateral |
| Liquidation Threshold | 97% | Tight buffer — stablecoin peg assumption |
| Liquidation Bonus | 2–5% | Dynamic auction model |
| Oracle | Pyth USDY/USD (`BkN8...`) | Reuse underlying feed |
| Borrow Limit | 0 | Collateral only — not borrowable |

**USDC Borrow** ([usdc_borrow_reserve.json](packages/programs/configs/usdc_borrow_reserve.json)):
| Parameter | Value | Rationale |
|---|---|---|
| LTV | 0% | Borrow-only |
| Borrow Rate Curve | 0.01%→4%→80% | Kink at 70% utilization |
| Borrow Limit | 75K USDC | Initial cap |
| Oracle | Pyth USDC/USD (`Gnt27...`) | Standard stablecoin feed |

## Key Addresses

### Underlying assets

| Asset | Address |
|---|---|
| USDY (Ondo, Solana) | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` |
| USDC (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| wSOL (Solana native) | `So11111111111111111111111111111111111111112` |
| Kamino Lend V2 | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` |
| Pyth USDY/USD feed | `BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb` |
| Pyth USDC/USD feed | `Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD` |
| Pyth SOL/USD push feed | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| Jito Vault program | `Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8` |
| Jito Restaking program | `RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q` |

### Our programs (devnet)

| Program | Address |
|---|---|
| delta-mint | `BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy` |
| governor | `6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi` |
| accrual-oracle | `8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec` |
| mock-oracle (devnet only) | `BbjcMyV2yQaxsgTZAdMFXxFiXSeaUWggoRJMLvZhYFzU` |

### csSOL devnet deploy state

| Component | Address |
|---|---|
| csSOL Token-2022 mint | `6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt` |
| Governor csSOL pool | `QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e` |
| Jito Vault (ours, gated) | `EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W` |
| VRT mint | `6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8` |
| Klend market | `2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW` |
| csSOL collateral reserve | `Ez1axBhD6M6t1Zmzfz8MQ95Kmuc48BuoYhQEEHEhT4U1` |
| wSOL borrow reserve | `4RvKrQVTdgvGEf75yvZE9JwzG4rZJrbstNcvVoXrkZ8o` |
| Accrual output (csSOL price feed) | `3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P` |
| FeedConfig PDA | `6ZhhrkGkN91zz6qPu4n3YmyMCFA7hoPYpj5jtzvkF1JM` |

## Privacy

The cUSDY mint uses **Token-2022 ConfidentialTransferMint** extension:
- ElGamal-encrypted balances — on-chain observers can't see amounts
- Auto-approve enabled — holders configure confidential transfers immediately
- Auditor key slot available for compliance
- Kamino uses standard (public) balances for deposits/borrows — no conflict

## Liquidation (Whitelisted Approach)

| Path | Mechanism |
|---|---|
| **Primary** | Pre-approved liquidator bots (`add_liquidator`) — vetted operators that can receive cUSDY collateral |
| **Backstop** | Kamino auto-deleverage (`autodeleverageEnabled: 1`) — 7-day margin call, no third-party collateral transfer |
| **Future** | Token-2022 transfer hook for permissionless KYC-gated liquidation |

Liquidator role: can receive cUSDY during liquidations, **cannot mint** new tokens.

## Test Coverage

```
  kamino-full-flow (mainnet fork)          ← E2E proof of concept
    ✔ creates cUSDY mint, whitelists operator, mints 1000 cUSDY
    ✔ creates klend market with cUSDY + USDC reserves
    ✔ configures cUSDY reserve: 95% LTV, Pyth oracle, deposit limit
    ✔ configures USDC reserve: oracle, borrow limit
    ✔ creates user obligation and deposits 500 cUSDY collateral
    ✔ borrows 400 USDC against cUSDY collateral
    ✔ verifies the complete KYC-gated lending position

  governor-pool-creation (mainnet fork)    ← Governor orchestration
    ✔ initializes a KYC-gated lending pool via governor
    ✔ whitelists the operator as a Holder via governor
    ✔ mints 100 cUSDY to operator via governor
    ✔ whitelists a liquidator bot via governor
    ✔ rejects minting to a liquidator via governor

  kamino-market-creation (mainnet fork)    ← Market + reserve setup
    ✔ creates cUSDY Token-2022 mint with confidential transfer extension
    ✔ whitelists the market operator
    ✔ mints 100 cUSDY to the operator for reserve seeding
    ✔ whitelists a liquidator bot via add_liquidator
    ✔ rejects minting to a liquidator-role wallet
    ✔ creates a new Kamino Lend V2 lending market
    ✔ initializes cUSDY collateral reserve
    ✔ initializes USDC borrow reserve
    ✔ verifies klend PDA derivations and instruction layout
    ✔ validates cUSDY collateral config from JSON
    ✔ validates USDC borrow config from JSON

  delta-mint (unit)
    ✔ initializes the mint with confidential transfer extension
    ✔ adds a wallet to the KYC whitelist
    ✔ mints tokens to a whitelisted recipient
    ✔ rejects minting to a non-whitelisted wallet
    ✔ removes a wallet from the whitelist
```

## Running

```bash
pnpm install

# Build all programs
pnpm -r build

# Unit tests (local validator)
cd packages/programs && pnpm test

# Fork tests (mainnet state — Kamino + oracles + USDY/USDC)
cd packages/programs && pnpm test:fork

# Run specific fork test
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/kamino-full-flow.fork.ts
```

### csSOL devnet deploy (full chain)

```bash
cd packages/programs

# 1. accrual oracle wiring (binds to live Pyth SOL/USD)
DEPLOY_KEYPAIR=$KP npx tsx scripts/setup-cssol-oracle.ts

# 2. governor pool + csSOL Token-2022 mint + KYC whitelist
DEPLOY_KEYPAIR=$KP npx tsx scripts/deploy-cssol-governor-devnet.ts

# 3. klend market + reserves + elevation group 2  (note two-keypair split)
DEPLOY_KEYPAIR=~/.config/solana/id.json \
POOL_AUTHORITY_KEYPAIR=$KP \
  npx tsx scripts/setup-cssol-market.ts

# 4. our gated Jito Vault (mintBurnAdmin = governor PDA)
DEPLOY_KEYPAIR=$KP npx tsx scripts/init-cssol-jito-vault.ts

# 5. one-time: enable governor::wrap into the pool's wSOL vault
DEPLOY_KEYPAIR=$KP npx tsx scripts/init-cssol-vault.ts
```

### Demo flows (ready to run)

```bash
# User flow: SOL → csSOL via the existing wrap path
DEPLOY_KEYPAIR=$KP AMOUNT=10000000 npx tsx scripts/wrap-sol-to-cssol.ts

# Pool admin: deposit pool's wSOL backing into our Jito Vault, receive VRT
DEPLOY_KEYPAIR=$KP AMOUNT=5000000 npx tsx scripts/poc-cssol-vault-mint.ts

# Refresh accrual oracle from live Vault state (no authority knob)
DEPLOY_KEYPAIR=$KP npx tsx scripts/poc-refresh-with-vault.ts

# Submit a wrap+tip Jito Bundle (Block Engine NY testnet)
DEPLOY_KEYPAIR=$KP AMOUNT=1000000 npx tsx scripts/poc-cssol-bundle.ts

# Klend monitor — devnet stand-in for ShredStream-fed liquidator
SELF_TRIGGER=1 npx tsx scripts/poc-shredstream-liquidator.ts
```

## Prerequisites

```bash
# Node.js + pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20 && nvm use 20
npm install -g pnpm

# Rust + Solana + Anchor
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --force
```

## Hackathon track context

This stack is a product, not a hackathon entry — but the csSOL leg
qualifies for Jito's hackathon "depth of integration" track. The
[JITO_INTEGRATION_PLAN.md](docs/shipped/JITO_INTEGRATION_PLAN.md) summary maps each
of the bounty's judging criteria to the architecture above:

| Bounty criterion | How csSOL satisfies it |
|---|---|
| Depth of Jito integration | Three central Jito products (Vault, Bundles, ShredStream-shaped monitor), each enforcing a meaningful piece of architecture rather than decoration. |
| Technical execution | All on-chain primitives deployed on devnet; gating verified end-to-end; programs compile clean and have backwards-compatible reallocation paths for v3 → v4 migrations. |
| Originality | KYC-gated re-staked LST as Kamino elevation-group collateral with on-chain-derived accrual is a novel composition — Aave-Horizon-style compliance applied across Jito's restaking primitives. |
| Impact potential | Same wrapper primitive scales to other regulated underlyings (cUSDY already shipped; csSOL is the second instance). The gated Jito Vault pattern is reusable for any compliance-bound protocol that wants to consume Jito's stack. |
| Demo quality | Every step has a `tx`, `signature`, or UUID anchored on devnet (or on Jito's actual block engine for the Bundle leg). All commands documented above. |

## Further Reading

- [Kamino Integration Plan](docs/operations/KAMINO_INTEGRATION.md) — detailed reference on market creation, reserve config, liquidation
- [Kamino Elevation Groups](docs/KAMINO_ELEVATION_GROUPS.md) — eMode-style high-LTV groups; what we use for csSOL/wSOL
- [csSOL deploy status](packages/programs/configs/devnet/cssol-deploy-status.md) — live devnet addresses, runbook, and known klend gotchas

## External references

### Kamino
- [klend (Kamino Lend V2) program source](https://github.com/Kamino-Finance/klend) — `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- [klend SDK on npm](https://www.npmjs.com/package/@kamino-finance/klend-sdk) — used in `packages/programs/scripts/setup-cssol-market.ts`
- [Kamino docs — overview](https://kamino.com/docs/overview)
- [Kamino docs — market operations CLI](https://kamino.com/docs/build/cli/market-operations.md)

### Pyth (oracle source)
- [Pyth Solana Receiver program](https://github.com/pyth-network/pyth-crosschain/tree/main/target_chains/solana) — `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (same on devnet + mainnet)
- [Pyth Push Oracle / sponsored feed PDAs](https://docs.pyth.network/price-feeds/use-real-time-data/solana#price-feed-accounts) — `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`
- Devnet SOL/USD push feed (live, ~30 s cadence): [`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`](https://explorer.solana.com/address/7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE?cluster=devnet)
- [Hermes API](https://hermes.pyth.network) — VAA pull endpoint

### Jito (LST research)

**Important:** there is no Jito-branded LST stake pool deployed on devnet. The
mainnet pool address `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb` exists as a
plain (non-executable) account on devnet but holds no real stake-pool data.
Jito's stake pool is mainnet-only.

What IS on devnet:

- **SPL Stake Pool program** ([`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`](https://explorer.solana.com/address/SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy?cluster=devnet)) — same program JitoSOL is built on. ~243 community-operated pools live; our [`scripts/poc-jito-deposit.ts`](packages/programs/scripts/poc-jito-deposit.ts) deposits into one to verify our SDK + ix flow are mainnet-portable.
- **Jito Restaking program** ([`RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q`](https://explorer.solana.com/address/RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q?cluster=devnet)) — restaking framework, **not** an LST. Different product than JitoSOL.
- **Jito Vault program** ([`Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8`](https://explorer.solana.com/address/Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8?cluster=devnet)) — ~812 vaults exist on devnet. This is the product the [Jito Restaking docs](https://www.jito.network/docs/restaking/core-concepts/vault/#overview) describe. It lets anyone create a Vault Receipt Token (VRT) backed by a deposited supported asset; not a stake pool, not directly a SOL-yield product.

**Reference docs:**

- [JitoSOL — `mainnet-only`](https://www.jito.network/jitosol/) — the SOL LST that elevation group 2 is designed for. Mainnet pool: `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`.
- [Jito Restaking docs](https://www.jito.network/docs/restaking/) — the product live on devnet. Useful if we ever want to launch csSOL as a VRT instead of a delta-mint wrapper.
- [Jito Restaking program source](https://github.com/jito-foundation/restaking)
- [SPL Stake Pool program source](https://github.com/solana-program/stake-pool) — what JitoSOL is built on; same SDK works for any pool.
- [`@solana/spl-stake-pool` SDK](https://www.npmjs.com/package/@solana/spl-stake-pool) — used by our POC.

**Mainnet swap for our POC:** [`scripts/poc-jito-deposit.ts`](packages/programs/scripts/poc-jito-deposit.ts) accepts `STAKE_POOL=<pubkey>` — point it at the JitoSOL mainnet pool and run with `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com` to do the same deposit against the real Jito stake pool. Same code path, no changes.

### Jito Vault SDKs (`@jito-foundation/restaking-sdk` + `@jito-foundation/vault-sdk`)

Yes, both are installed and partially usable on devnet:

- [`scripts/poc-jito-vault-discover.ts`](packages/programs/scripts/poc-jito-vault-discover.ts) — **working**. Uses `@jito-foundation/vault-sdk`'s `getConfigDecoder` to decode the singleton Config at PDA `UwuSgAq4zByffCGCrWH87DsjfsewYjuqHfJEpzw1Jq3`, then enumerates Vault accounts (raw-decoded — see SDK note below). Found **7 wSOL-supporting vaults** on devnet, including [`CSLdXAxizcHzEGDTfGWrfYoUQ8wpr4uN4nCLX1qjiNr5`](https://explorer.solana.com/address/CSLdXAxizcHzEGDTfGWrfYoUQ8wpr4uN4nCLX1qjiNr5?cluster=devnet) which already holds ~0.05 SOL of stake.
- [`scripts/poc-jito-vault-deposit.ts`](packages/programs/scripts/poc-jito-vault-deposit.ts) — **in progress**. Reaches the `MintTo` ix on-chain (correct discriminator), but fails on `vaultFeeTokenAccount` derivation. The vault's `feeWallet` field offset isn't reliably raw-decodable because of padding in `DelegationState`. Two known follow-up paths: (a) bridge to `@solana/kit` so we can call `getMintToInstruction` from the SDK directly, (b) read the `feeWallet` offset from the Jito Vault Rust source.

**SDK version drift to flag:** `@jito-foundation/vault-sdk@1.0.0` ships a stale `Vault` decoder (the on-chain struct has additional fields the SDK doesn't know about, so `getVaultDecoder().decode()` errors with `Codec [u8] cannot decode empty byte arrays`). The Config decoder works fine. We work around it via raw byte-offset decode — fields up to `tokensDeposited` are stable. Watch for an SDK 1.1.x update.

**On-chain account discriminators are off-by-one from the SDK enum** — `JitoVaultAccount.Config = 0` per the TS enum but on-chain Config has `disc=1` in u64 LE; on-chain Vault has `disc=2` (not 1). Filter accordingly: base58 of u64 LE 2 = `LQM2cdzDY3`. Instruction discriminators (the `*_DISCRIMINATOR` constants) are correct as exported.
