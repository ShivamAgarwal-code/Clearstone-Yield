# Clearstone — Cross-Repo Deployment Guide

> **Audience:** anyone deploying the Clearstone stack to devnet or mainnet.
> This document coordinates three repos:
>
> - **[clearstone-finance](https://github.com/1delta-DAO/clearstone-finance)** — KYC stack (governor + delta-mint)
> - **[clearstone-fusion-protocol](https://github.com/1delta-DAO/clearstone-fusion-protocol)** — intent settlement
> - **[clearstone-fixed-yield](https://github.com/1delta-DAO/clearstone-fixed-yield)** — PT/YT core + adapters + solver callback
>
> Keep this file identical across the three repos. When you change it in one,
> mirror the change to the other two so nobody reads stale instructions.

---

## TL;DR deployment order

```
Tier 1 — External prerequisites (must exist on the cluster before anything else)
   ├── delta-mint              (clearstone-finance)
   ├── governor                (clearstone-finance)  — depends on delta-mint
   ├── clearstone-fusion       (clearstone-fusion-protocol)
   ├── Kamino Lend V2 (klend)  (Kamino — already deployed on mainnet/devnet)
   └── Metaplex Token Metadata (Metaplex — already deployed everywhere)

Tier 2 — Core + SY adapters (clearstone-fixed-yield)   order within tier: irrelevant
   ├── clearstone_core
   ├── generic_exchange_rate_sy
   └── kamino_sy_adapter

Tier 3 — Periphery (clearstone-fixed-yield)            order within tier: irrelevant
   ├── clearstone_router
   ├── clearstone_rewards
   ├── clearstone_curator
   └── clearstone_solver_callback

Tier 4 — TEST-ONLY (never deploy to mainnet)
   ├── mock_klend
   ├── mock_flash_callback
   ├── malicious_sy_nonsense
   └── malicious_sy_reentrant
```

Within a tier, programs can deploy in parallel. Across tiers, later tiers
depend at *runtime* on earlier tiers being callable — but program-load
ordering between tiers is not enforced by Solana, so you only need to make
sure each later tier's first *initialization* CPI happens after the target
is on-chain.

---

## Program IDs

Pinned. Do not regenerate without cross-repo coordination.

| Program | Program ID | Repo |
|---|---|---|
| delta_mint | `BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy` | clearstone-finance |
| governor | `6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi` | clearstone-finance |
| accrual_oracle | `8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec` | clearstone-finance |
| mock_oracle | `BbjcMyV2yQaxsgTZAdMFXxFiXSeaUWggoRJMLvZhYFzU` | clearstone-finance |
| clearstone_fusion | `9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J` | clearstone-fusion-protocol |
| clearstone_core | `DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW` | clearstone-fixed-yield |
| generic_exchange_rate_sy | `HA1T2p7DkktepgtwrVqNBK8KidAYr5wvS1uKqzvScNm3` | clearstone-fixed-yield |
| kamino_sy_adapter | `29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd` | clearstone-fixed-yield |
| clearstone_router | `DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW` | clearstone-fixed-yield |
| clearstone_rewards | `7ddrynBQiCNjxejxRwxvSbDb56k8F8Yp4KwYgfiaHX8g` | clearstone-fixed-yield |
| clearstone_curator | `831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm` | clearstone-fixed-yield |
| clearstone_solver_callback | `27UhEF34wbyPdZw4nnAFUREU5LHMFs55PethnhJ6yNCP` | clearstone-fixed-yield |

External (already deployed on mainnet / devnet):

| Program | Program ID |
|---|---|
| Kamino Lend V2 | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |

---

## Pre-flight

### Required tools

- `solana-cli` ≥ 2.0
- `anchor-cli` 0.31.1 (all three repos pin this)
- `cargo` with `cargo-build-sbf` extension
- `pnpm` or `yarn` for TypeScript builds

### Wallets

- **Upgrade authority** — one keypair per program (or one shared, per policy).
  Publish the pubkey(s) to the team before deploying.
- **Deployer** — funded with enough SOL to cover rent. Rule of thumb:
  ~5 SOL per program on mainnet (varies with program size).

### Cluster targets

- **devnet** — `https://api.devnet.solana.com`. Use for any non-production deploy.
- **mainnet** — `https://api.mainnet-beta.solana.com`. Coordinate upgrade
  authority handoffs before touching.

### Verify the program keypair files exist

Each repo ships its program keypairs at `target/deploy/<name>-keypair.json`.
These generate the program IDs table above. If a file is missing, the
deploy regenerates the id — **coordinate before doing this**.

```bash
# In each repo:
ls target/deploy/*-keypair.json
# For every keypair that exists, confirm its pubkey matches the table:
solana-keygen pubkey target/deploy/governor-keypair.json
# Must print: 6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi
```

If any pubkey disagrees, **STOP** — do not deploy. Coordinate.

---

## Tier 1 — External prerequisites

Deploy first in this order:

### 1.1 delta-mint

**Repo:** clearstone-finance. **Depends on:** nothing.

```bash
# From clearstone-finance root:
cd packages/programs
anchor build -p delta-mint
anchor deploy -p delta-mint \
  --provider.cluster devnet \
  --program-keypair target/deploy/delta_mint-keypair.json
anchor idl init BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy \
  --filepath target/idl/delta_mint.json --provider.cluster devnet
```

**Verify:** `solana program show BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy`.

### 1.2 governor

**Repo:** clearstone-finance. **Depends on:** delta-mint deployed (CPI target at runtime).

```bash
cd packages/programs
anchor build -p governor
anchor deploy -p governor --provider.cluster devnet \
  --program-keypair target/deploy/governor-keypair.json
anchor idl init 6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi \
  --filepath target/idl/governor.json --provider.cluster devnet
```

### 1.3 clearstone-fusion

**Repo:** clearstone-fusion-protocol. **Depends on:** nothing.

```bash
# From clearstone-fusion-protocol root:
anchor build -p clearstone-fusion
anchor deploy -p clearstone-fusion --provider.cluster devnet \
  --program-keypair target/deploy/clearstone_fusion-keypair.json
anchor idl init 9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J \
  --filepath target/idl/clearstone_fusion.json --provider.cluster devnet
```

### 1.4 klend + Metaplex

Already deployed on mainnet and devnet; nothing to do. If you're on
localnet, clone via Anchor.toml:

```toml
[[test.validator.clone]]
address = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
[[test.validator.clone]]
address = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
```

---

## Tier 2 — Core + SY adapters

### 2.1 clearstone_core

**Repo:** clearstone-fixed-yield. **Depends on:** Metaplex (CPI target at runtime for PT metadata).

```bash
# From clearstone-fixed-yield root:
anchor build -p clearstone_core
anchor deploy -p clearstone_core --provider.cluster devnet \
  --program-keypair target/deploy/clearstone_core-keypair.json
anchor idl init DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW \
  --filepath target/idl/clearstone_core.json --provider.cluster devnet
```

### 2.2 generic_exchange_rate_sy

**Repo:** clearstone-fixed-yield. **Depends on:** nothing at deploy time.

```bash
anchor build -p generic_exchange_rate_sy
anchor deploy -p generic_exchange_rate_sy --provider.cluster devnet \
  --program-keypair target/deploy/generic_exchange_rate_sy-keypair.json
anchor idl init HA1T2p7DkktepgtwrVqNBK8KidAYr5wvS1uKqzvScNm3 \
  --filepath target/idl/generic_exchange_rate_sy.json --provider.cluster devnet
```

### 2.3 kamino_sy_adapter

**Repo:** clearstone-fixed-yield. **Depends on:** governor + delta-mint (CPI targets at `init_sy_params` when `KycMode::GovernorWhitelist`), klend (CPI target at runtime for deposit/redeem).

```bash
anchor build -p kamino_sy_adapter
anchor deploy -p kamino_sy_adapter --provider.cluster devnet \
  --program-keypair target/deploy/kamino_sy_adapter-keypair.json
anchor idl init 29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd \
  --filepath target/idl/kamino_sy_adapter.json --provider.cluster devnet
```

---

## Tier 3 — Periphery

Deploy after Tier 2. All four live in clearstone-fixed-yield.

### 3.1 clearstone_router

**Depends on:** clearstone_core + generic_exchange_rate_sy (CPI targets).

```bash
anchor build -p clearstone_router
anchor deploy -p clearstone_router --provider.cluster devnet \
  --program-keypair target/deploy/clearstone_router-keypair.json
anchor idl init DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW \
  --filepath target/idl/clearstone_router.json --provider.cluster devnet
```

### 3.2 clearstone_rewards

**Depends on:** nothing at deploy time (LP/farm side, doesn't CPI core).

```bash
anchor build -p clearstone_rewards
anchor deploy -p clearstone_rewards --provider.cluster devnet \
  --program-keypair target/deploy/clearstone_rewards-keypair.json
anchor idl init 7ddrynBQiCNjxejxRwxvSbDb56k8F8Yp4KwYgfiaHX8g \
  --filepath target/idl/clearstone_rewards.json --provider.cluster devnet
```

### 3.3 clearstone_curator

**Depends on:** clearstone_core + generic_exchange_rate_sy (CPI targets via rebalance).

```bash
anchor build -p clearstone_curator
anchor deploy -p clearstone_curator --provider.cluster devnet \
  --program-keypair target/deploy/clearstone_curator-keypair.json
anchor idl init 831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm \
  --filepath target/idl/clearstone_curator.json --provider.cluster devnet
```

### 3.4 clearstone_solver_callback

**Depends on:** clearstone_core (invoked BY core via `flash_swap_pt`) + clearstone-fusion (CPI target inside the callback body).

```bash
anchor build -p clearstone_solver_callback
anchor deploy -p clearstone_solver_callback --provider.cluster devnet \
  --program-keypair target/deploy/clearstone_solver_callback-keypair.json
anchor idl init 27UhEF34wbyPdZw4nnAFUREU5LHMFs55PethnhJ6yNCP \
  --filepath target/idl/clearstone_solver_callback.json --provider.cluster devnet
```

---

## Post-deploy verification

Run these in order against the freshly-deployed cluster.

### Smoke checks

```bash
# Every deployed program id is addressable.
for ID in \
    BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy \
    6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi \
    9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J \
    DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW \
    HA1T2p7DkktepgtwrVqNBK8KidAYr5wvS1uKqzvScNm3 \
    29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd \
    DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW \
    7ddrynBQiCNjxejxRwxvSbDb56k8F8Yp4KwYgfiaHX8g \
    831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm \
    27UhEF34wbyPdZw4nnAFUREU5LHMFs55PethnhJ6yNCP
do
    solana program show "$ID" --url devnet 2>&1 | head -1
done
```

### IDL availability

Every on-chain IDL should be fetchable:

```bash
anchor idl fetch <ID> --provider.cluster devnet | head -5
```

### Live integration tests

Run the test suite against the live cluster (not localnet):

```bash
# clearstone-fixed-yield
anchor test --skip-build --skip-deploy --provider.cluster devnet
```

The GovernorWhitelist and fusion-flash `it.skip` tests should be un-skipped
once all Tier 1 + Tier 3 programs are verified-deployed.

---

## Initialization order (on-chain state bring-up)

After programs are deployed, bringing up a live KYC'd fixed-yield market
requires this sequence. Everything before step 7 is per-underlying; step 7
onwards is per-market-per-maturity.

### One-time per underlying asset (KYC path)

1. `governor.initialize_pool(underlying_mint)` — creates the d-token mint.
2. `governor.activate_wrapping()` — transfers delta-mint authority to pool PDA.
3. `governor.fix_co_authority()` — enables `via_pool` whitelisting.
4. (optional) `governor.set_gatekeeper_network(gatekeeper)` — enables Civic self-registration.
5. `governor.add_participant(Holder, maker_wallet)` or `governor.mint_wrapped(...)` — seed d-token holders.

### klend setup (per market, real klend path)

6. `klend.init_lending_market + init_reserve` for the d-token (external Kamino flow).

### Adapter SY setup (per (asset, maturity) pair)

7. `kamino_sy_adapter.init_sy_params`:
   - With `KycMode::None` for retail.
   - With `KycMode::GovernorWhitelist { .. }` for KYC'd markets — the
     adapter CPIs `governor.add_participant_via_pool(Escrow)` for each
     core PDA listed in `core_pdas_to_whitelist`.

### Core setup

8. `clearstone_core.initialize_vault(sy_program=<adapter pid>, ...)`.
9. `clearstone_core.init_market_two(vault, seed_id, curve_params, ...)`.

### Fusion + solver setup (per order)

10. Maker: `spl_token.approve(delegate=fusion_delegate_pda, cap=N)` on their src ATA.
11. Maker: off-chain sign `OrderConfig` + side-data pubkeys; publish to solver relay.
12. Solver: submit `[Ed25519.verify, core.flash_swap_pt]` tx.

Steps 1–5 are governor-admin-gated. Steps 6–9 are permissionless per-market.
Steps 10–12 are permissionless per-fill.

---

## csSOL devnet bring-up (LST/SOL elevation group)

Standalone path that brings up a fresh klend market for the csSOL/wSOL pair
inside elevation group 2 (LST collateralizes SOL borrowing). Independent of
the cUSDY market — runs beside it without migration.

Prereqs: `delta_mint`, `governor`, `accrual_oracle`, and `mock_oracle` deployed
on devnet (`anchor build && anchor deploy --provider.cluster devnet`). The
SOL/USD push feed at `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` already
exists on devnet — no keeper-side bootstrap required for it.

```bash
cd packages/programs

# 1. Allocate the accrual-oracle output and FeedConfig (one-time per env).
#    Writes configs/devnet/cssol-oracle.json.
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx ts-node scripts/setup-cssol-oracle.ts

# 2. Initialize the governor csSOL pool, whitelist the deployer, mint a
#    0.001 csSOL seed for the klend reserve init. Writes configs/devnet/cssol-pool.json.
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx ts-node scripts/deploy-cssol-governor-devnet.ts

# 3. Create a fresh lending market, both reserves, register elevation group 2,
#    register the market with governor. Writes configs/devnet/cssol-deployed.json.
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx ts-node scripts/setup-cssol-market.ts
```

Then deploy the keeper Worker so the csSOL accrual output stays fresh:

```bash
cd packages/keeper-cloud
pnpm install

# Paste accrualOutput / accrualConfig from cssol-oracle.json into wrangler.toml
$EDITOR wrangler.toml

# Devnet-only signer with ~0.05 SOL for tx fees
pnpm secret:keypair    # paste 64-byte JSON array

pnpm deploy
curl https://<your-worker>.workers.dev/    # one-shot smoke test
```

State after deploy:

| Component | Location |
|---|---|
| csSOL Token-2022 mint | `cssol-pool.json::cssolMint` |
| Governor PoolConfig (elevation_group=2) | `cssol-pool.json::poolConfig` |
| Lending market | `cssol-deployed.json::market` |
| csSOL collateral reserve | `cssol-deployed.json::reserves.csSOL.address` |
| wSOL borrow reserve | `cssol-deployed.json::reserves.wSOL.address` |
| Accrual output (csSOL price feed klend reads) | `cssol-oracle.json::accrualOutput` |
| Pyth SOL/USD source (wSOL price feed klend reads) | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |

**Mainnet path:** every script accepts `SOLANA_RPC_URL` env. Pyth's SOL/USD
PDA (`7UVi…`) is the same mainnet PDA — feed_id is network-agnostic. Re-run
the three scripts against a mainnet RPC, paste the new addresses into
`packages/keeper-cloud/wrangler.toml`, and redeploy the Worker. No code
changes required.

---

## Upgrade authority handoff (mainnet)

1. On deploy, each program's upgrade authority defaults to the deployer.
2. **Before going live on mainnet**, transfer authority to a multisig (Squads, etc.):

   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> \
     --new-upgrade-authority <MULTISIG_PDA> \
     --url mainnet-beta
   ```
3. Long-term plan per [PLAN.md §13](PLAN.md): burn upgrade authority post-audit.

   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> --final --url mainnet-beta
   ```

   **Destructive and irreversible.** Only run after the full invariant
   checklist in [INVARIANTS.md](INVARIANTS.md) passes review.

---

## Rollback

If a deploy goes wrong:

- **Before upgrade-authority transfer:** `anchor upgrade <PROGRAM_ID> --program-filepath <old.so>` rolls back the bytecode.
- **After transfer:** only the multisig can upgrade. Coordinate there.
- **After burn:** rollback is impossible. Spin up a new program id with a new
  keypair and update all downstream configs (`[programs.localnet]` in
  Anchor.toml, Cargo-pinned revs in dependents, on-chain state that
  references the old id).

---

## Repo coordination

When one repo cuts a semver tag:

1. Tag the commit in the originating repo (e.g. `v0.2.0-escrow-role` in clearstone-finance).
2. Update `Cargo.toml` in every dependent crate to pin `tag = "..."` instead of `rev = "..."` on the git dep.
3. Run `cargo update -p <crate-name>` in each dependent repo to regenerate Cargo.lock.
4. Reopen PRs against dependent repos with the Cargo.lock delta.

Current pinned rev (all dependents should match): `a414ff6c1477d2338cd9e945aa06f8c93ca8a590` in clearstone-finance, commit tip for clearstone-fusion-protocol.

---

## Who-owns-what matrix

| Program | Deploy-day owner | Upgrade authority at audit | Post-audit |
|---|---|---|---|
| delta_mint, governor | clearstone-finance team | team multisig | burn or 6mo timelock |
| clearstone_fusion | clearstone-fusion team | team multisig | team policy |
| clearstone_core | 1delta DAO | 3-of-5 multisig | burn |
| generic_exchange_rate_sy, kamino_sy_adapter | 1delta DAO | same multisig | burn |
| clearstone_router, clearstone_rewards, clearstone_curator | 1delta DAO | same multisig | burn |
| clearstone_solver_callback | 1delta DAO | same multisig | burn |

Confirm the specific multisig pubkeys with the team before cutover.

---

## FAQ / gotchas

**Q: Can I deploy in parallel across tiers?**
A: You can `anchor build` in parallel everywhere. You can `anchor deploy` any
Tier 1 in parallel with any Tier 1; same for Tier 2 and Tier 3. But Tier 2
programs must not run their *first init-time CPI* into a Tier 1 program
until Tier 1 is confirmed-deployed. Safest: serialize between tiers.

**Q: What if a program's IDL is already initialized at the target id?**
A: `anchor idl init` fails. Use `anchor idl upgrade <ID> --filepath ...`
instead.

**Q: The pinned commit rev in Cargo.toml of clearstone-fixed-yield
references a commit hash on clearstone-finance — do I need to deploy that
exact commit?**
A: Yes for Rust ABI compatibility. The commit pins the CPI client types
the adapter was built against. Bumping one side without the other risks
silently-skewed borsh encodings.

**Q: Do I need to deploy fusion if I only care about the SY / PT/YT markets?**
A: No. Skip fusion + clearstone_solver_callback. Core strip/merge/trade_pt
all work without fusion. Flash fills require fusion + callback.

**Q: Do I need to deploy delta-mint + governor if I only want permissionless (non-KYC) markets?**
A: No. The adapter's `KycMode::None` path makes no CPI into either. You
still need both Rust crates as git-deps at build time (the adapter's
code references `governor::cpi::*` types), but runtime CPIs only fire
for `KycMode::GovernorWhitelist` markets.

**Q: What's the minimum viable local dev setup?**
A: `anchor test` from clearstone-fixed-yield root — it spins up a local
validator with Metaplex cloned from devnet. That's enough for every
test that isn't `it.skip`-gated on the external KYC / fusion stack.
