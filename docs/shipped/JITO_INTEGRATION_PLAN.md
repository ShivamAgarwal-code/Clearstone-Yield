# Jito Integration Plan — csSOL as a KYC-gated VRT wrapper

> Status: step 1 pivoted (see "Architectural pivot" below).
> Target: Jito hackathon track ($2k bounty), devnet-only deploy.

## Architectural pivot (2026-04-27)

We initially planned a three-layer stack: `our SPL Stake Pool → our Jito
Vault → delta-mint wrapper`, with each layer gated to KYC'd wallets via
`stake_deposit_authority` / `mintBurnAdmin` / Token-2022 transfer hooks
respectively.

When we tried to init the gated SPL Stake Pool we hit a hard blocker:
the SPL Stake Pool program deployed on devnet is from slot 197M (~2023,
v1.x era) while the published `spl-stake-pool-cli` is v2.0.1. The
Initialize ix ABI has shifted between those versions; the on-chain
program returns `CalculationFailure (0x3)` on the v2.0.1-formatted ix.

Rather than pin to an older CLI or hand-build the v1 Initialize ix, we
pivoted to a simpler architecture that's actually closer to the
Aave-Horizon compliance model:

  - **csSOL is a KYC-gated wrapper of a Jito Vault VRT.** That's it. One
    Jito layer (Vault) instead of two (Stake Pool + Vault).
  - The Vault's `supportedMint` is wSOL on devnet. On mainnet it would be
    `JitoSOL` (users would Jupiter-swap to JitoSOL beforehand and bring
    that token to our Vault as the deposit asset).
  - The Vault's `mintBurnAdmin = governor pool PDA`. Only governor-PDA-
    co-signed mints succeed → only KYC'd wallets can deposit.
  - We do NOT operate a stake pool. JitoSOL itself (when used as the
    underlying on mainnet) is acquired by users on the open market —
    JitoSOL's own pool dynamics are Jito Foundation's compliance scope,
    same way Aave Horizon's USDC borrow asset is Circle's scope.
  - We **don't** deposit our pool's funds into a community/public pool at
    any layer. Every layer we operate is KYC-only.

This is one Jito product (Vault) used in a meaningfully gated way, plus
Bundles and (stretch) ShredStream. The bounty's depth-of-integration bar
is satisfied by the Vault layer being central architecture rather than
decoration — `mintBurnAdmin` is doing real compliance work.

## Goal

Turn csSOL from a "wrapped wSOL with an authority-set rate" into a **fully Jito-stack-backed regulated LST** without ever commingling KYC'd user funds with non-KYC counterparties at any architectural layer.

The submission narrative we are aiming for:

> *Clearstone csSOL — a KYC-gated re-staked LST. The full Jito stack: a Solana SPL Stake Pool we manage (with `stake_deposit_authority` restricted to KYC'd wallets), a Jito Vault layered on top (`mintBurnAdmin` similarly gated), and a delta-mint Token-2022 wrapper for the user-facing csSOL token. Every depositor at every layer is identified by us — no commingling at any point. Yield comes from validator inflation + Jito-Solana MEV (mainnet) at the stake-pool layer plus NCN rewards at the restaking layer. User wrap+deposit flows go through Jito Bundles; elevation-group-2 liquidations are watched via ShredStream.*

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│     KYC user                                                         │
│        │  SOL                                                        │
│        ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ governor::wrap_with_jito_stack  (delta-mint whitelist gate) │    │
│  │                                                             │    │
│  │   1. CPI → SPL Stake Pool::deposit_sol                      │    │
│  │      (our pool, deposit_authority = governor PDA)           │    │
│  │   2. CPI → Jito Vault::mint_to                              │    │
│  │      (our vault, mintBurnAdmin = governor PDA)              │    │
│  │   3. CPI → delta_mint::mint_to → csSOL  (KYC checked)       │    │
│  │                                                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│        │                                                             │
│        ▼                                                             │
│  user receives csSOL — Token-2022 KYC-gated, 1:1 with VRT            │
│        │                                                             │
│        ▼                                                             │
│  Klend csSOL collateral reserve in elevation group 2  → borrow wSOL  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

Layered backing chain (every layer is gated to KYC'd wallets only):

       SOL (devnet)
        │
        ▼  SPL Stake Pool   →  yields validator inflation + MEV (mainnet)
        │   pool_token  (intermediate LST we issue, e.g. "csSOL-LST")
        ▼
        ▼  Jito Vault      →  yields NCN restaking rewards, slashing-aware
        │   VRT
        ▼
        ▼  delta-mint wrap →  KYC enforcement, Token-2022 confidential ext
        │   csSOL  (1:1 with VRT, fungible only between whitelisted wallets)
```

## Why this is AML-clean

**The commingling concern in the original "use a community pool" sketch:**
KYC user's SOL → community SPL Stake Pool (open) → pooled with non-KYC SOL at
the validator stake account level. Token-2022 transfer hooks on the wrapper
do not fix this — the commingling happens *under* the wrapper.

**Why this design avoids it:**
- The SPL Stake Pool is **ours**. `stake_deposit_authority = governor pool PDA`. The SPL Stake Pool program rejects every deposit ix that isn't co-signed by that PDA. The PDA only signs after delta-mint whitelist verification.
- The Jito Vault is **ours**. `mintBurnAdmin = governor pool PDA`. Same gate.
- delta-mint enforces Token-2022 KYC at the user-facing wrapper.

Three independent gates, all controlled by the same PDA, all enforcing the same whitelist. There is no path for non-KYC SOL to enter any layer of the backing.

This is structurally identical to **Aave Horizon**'s compliance posture (regulated wrapper around regulated assets), but with three Jito-stack-native layers instead of one.

## Devnet vs. mainnet

| Layer | Devnet | Mainnet |
|---|---|---|
| User entry | SOL (lamports) | SOL (lamports) |
| Stake pool | Our own SPL Stake Pool, validators picked from devnet leader schedule | Our own SPL Stake Pool, validators picked from mainnet (or Jito-Foundation curated) |
| Pool LST | `csSOL-LST` (Token-2022, our mint) | Same — same mint key migrates |
| Restaking layer | Our Jito Vault (`Vau1t6sLN…`, devnet-deployed) | Same program, mainnet-deployed |
| VRT | Vault VRT mint | Vault VRT mint (same key) |
| User token | csSOL (delta-mint Token-2022) | Same |
| Yield source (devnet) | Validator inflation only (~5% APY at devnet rates) | Validator inflation + Jito-Solana MEV + NCN rewards (~7-9% APY blended) |

The deploy scripts accept `SOLANA_RPC_URL` so a mainnet swap requires no code changes — the same scripts run against mainnet with the same program IDs.

## Implementation steps (post-pivot)

Status as of 2026-04-28:
- ✅ Step 1 — gated Jito Vault deployed
- ✅ Step 2/3 — deposit POC works against our vault
- ✅ Step 4 — accrual oracle now reads Vault state via `refresh_with_vault`
- ✅ Step 5 — Jito Bundles for atomic user flows (UUID `3e3fbca8…`)
- ✅ Step 6 — klend monitor / liquidator detector (devnet stand-in for ShredStream; mainnet swap = wire change only)

### Step 1 — Init our gated Jito Vault ✅ DONE

Deployed: vault `EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W`, vrtMint `6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8`, mintBurnAdmin = governor pool PDA `QoR6KX…`.

Init tx: `2WCJmEouPzq5c65eXgzuNy6bzBmHNJjhzA2ck9ni9JkzQ4FZwQn4T4EjVrTajCGh6BorcmKz4tqWDPnJGwgu371y` · SetSecondaryAdmin: `P8NW1fBRBpizXCTmJFWMqrodHppuEs1vJ2n1nojN2mozRHqqt4gkYKhdyT117e8GKKswU9rNUgLaoW5h2F2ZLKu`

Original step 1 description preserved below for the deploy walkthrough:

[`scripts/init-cssol-jito-vault.ts`](packages/programs/scripts/init-cssol-jito-vault.ts)

- Bridge to `@solana/kit` for the Jito Vault SDK (kit-native).
- Generate fresh keypairs for `base` and `vrtMint`.
- Compute the Vault PDA: `findProgramAddress(["vault", base.publicKey], Vau1t6sLN…)`.
- Call `getInitializeVaultInstruction` from `@jito-foundation/vault-sdk`:
  - `stMint = wSOL` on devnet (would be JitoSOL on mainnet).
  - `admin = our deployer keypair` initially (transferable to governor PDA after).
  - `base = fresh keypair`, `vrtMint = fresh keypair`.
  - `depositFeeBps = 0`, `withdrawalFeeBps = 0`, `rewardFeeBps = 100` (1%).
  - `decimals = 9` to match wSOL.
  - `initializeTokenAmount = 1_000_000` (0.001 wSOL bootstrap so the vault has a non-zero supported balance at init).
- Then call `getSetSecondaryAdminInstruction(MintBurnAdmin, governor pool PDA)` to gate every future `MintTo` to require governor PDA co-signing.
- Persist addresses to `configs/devnet/cssol-jito-vault.json`.

Cost: ~0.05 SOL on devnet (vault state + VRT mint + ATAs).

### Step 2 — Land the deposit POC against our vault

Finish [`scripts/poc-jito-vault-deposit.ts`](packages/programs/scripts/poc-jito-vault-deposit.ts) by depositing into **our** vault (same SDK call shape — and now we know `feeWallet` because we set it ourselves at init).

### Step 3 — Modify `governor::wrap` to CPI into the Jito Vault

Add new ix `wrap_with_jito_vault(amount: u64)`:

1. Verify user's delta-mint whitelist entry.
2. Wrap incoming SOL into wSOL inside the user's wSOL ATA (same as existing wrap).
3. CPI to Jito Vault `mint_to` with governor PDA signing as `mintBurnAdmin`. wSOL → VRT to a pool-PDA-owned VRT vault.
4. CPI to delta-mint `mint_to`. Mint csSOL 1:1 against the VRT received.

Keep the existing `wrap` ix for backward compatibility (just-wSOL backing, no Vault).

### Step 4 — Update accrual oracle to read from real Vault state

The accrual oracle's `index_e9` becomes a pure function of the Jito Vault's on-chain state:

```
index = (vault.tokensDeposited / vault.vrtSupply) × 1e9
```

No more authority-set `rate_bps_per_year` knob. The keeper crank reads vault state and writes the derived index. Yield is provably sourced from on-chain VRT exchange-rate appreciation (NCN reward distributions on mainnet; flat on devnet until NCNs are paying).

### Step 5 — Bundles via `@jito-labs/jito-ts`

Wrap `wrap_with_jito_vault + klend.deposit + klend.refresh_obligation` into a Jito Bundle. Submit via the Block Engine RPC. Devnet validators don't auction MEV but bundle execution semantics still hold (atomic-or-revert relay).

### Step 6 (stretch) — ShredStream-fed liquidator

Subscribe to ShredStream gRPC, decode klend ixs touching our market, simulate health-factor drift, fire liquidation bundles for elevation-group-2 obligations.

## Bundles scope — what they wrap, what they don't

Two unrelated meanings of "bundle" appear in this repo. Anyone reviewing the
code or the submission needs to keep them apart:

- **Jito Bundle** (capital B) — atomic-or-revert group of *transactions*
  relayed through the Block Engine. Single product: `@jito-labs/jito-ts` →
  `sendBundle` at `…/api/v1/bundles`.
- **lowercase "bundle"** in `creditTrade.ts` / `OneStepUnwindTab` — the set
  of *instructions inside a single transaction* (e.g. `flash_borrow … flash_repay`).
  Local terminology only; nothing to do with Jito.

### Klend flash-loans are NOT inside Jito Bundles

klend's `flash_borrow_reserve_liquidity` and `flash_repay_reserve_liquidity`
use the introspection sysvar to enforce same-***transaction*** matching.
Splitting borrow and repay across two txs in a Jito Bundle would fail klend's
check. Atomicity is provided by the transaction itself, not by the bundle
relay. Anything in the credit-trade or one-step-unwind code that talks about
"the bundle" is referring to the tx-internal ix sequence, not a Block Engine
bundle.

### What our Jito Bundles actually wrap

Bundle UUID `3e3fbca8…` (per step 5):

  - `governor::wrap_with_jito_vault`
  - `klend::deposit_reserve_liquidity_and_obligation_collateral`
  - `klend::refresh_obligation`

Three ixs into one Bundle, one tx per ix, atomic-or-revert across all three.

### Where Bundles could legitimately help around (not inside) flash-loans

If we want to extend Bundle usage honestly:

- **CU pressure** — when a flash-loan tx is too large to fit refresh ixs
  alongside borrow/repay, put `refresh_reserve` / `refresh_obligation` in a
  companion tx and bundle the pair. Same atomicity guarantee, more headroom.
- **MEV protection** — land credit-trade / one-step-unwind txs via Block
  Engine with a tip so searchers can't sandwich between our refresh and our
  borrow. This is the real Jito-mainnet value-add for these flows.
- **Cross-tx composition** — sequencing that genuinely doesn't fit one tx
  (e.g. multi-leg liquidations).

What we **don't** want to claim in the submission: "Jito Bundles wrap our
flash-loans." That would mislead a judge who knows klend's introspection
model. The accurate claim is "Bundles wrap the wrap+deposit+refresh flow"
plus, if we ship the MEV-protection wrapper, "Bundles land credit-trade
flows MEV-protected."

## Devnet cost budget

| Item | Cost |
|---|---|
| Step 1: SPL Stake Pool init + reserve | ~0.05 SOL |
| Step 1b: 3 validator slots | ~0.01 SOL |
| Step 2: Jito Vault init + ATAs | ~0.05 SOL |
| Step 3: Test deposits | ~0.01 SOL |
| Step 4: Governor program upgrade | ~0.01 SOL (rent diff) |
| Step 5: Accrual oracle program upgrade | ~0.01 SOL (rent diff) |
| Step 6-7: Tx fees | <0.01 SOL |
| **Total devnet** | **~0.15 SOL** |
| **Mainnet exposure** | **0** |

## What we're explicitly NOT doing

- Operating validators ourselves. We delegate to existing community validators via the SPL Stake Pool's validator list.
- Running consensus. The stake pool is just a delegation manager.
- Mainnet deploy. Scripts accept `SOLANA_RPC_URL` for trivial mainnet portability later, but the hackathon submission is devnet-only.
- Touching the `Jito4APyf…` mainnet stake pool. We run our own on devnet.

## Files this plan creates / modifies

```
packages/programs/
  programs/
    governor/src/lib.rs                            (modify — add wrap_with_jito_stack ix)
    accrual-oracle/src/lib.rs                      (modify — derived index)
  scripts/
    init-cssol-stake-pool.ts                       (new — step 1)
    add-cssol-pool-validators.ts                   (new — step 1b)
    init-cssol-jito-vault.ts                       (new — step 2)
    wrap-sol-jito-stack.ts                         (new — user-facing demo)
    poc-jito-vault-deposit.ts                      (modify — finish step 3)
    keeper-stake-pool-crank.ts                     (new — step 6)
  configs/devnet/
    cssol-stake-pool.json                          (new — step 1 output)
    cssol-jito-vault.json                          (new — step 2 output)

packages/keeper-cloud/                             (modify — add epoch crank to scheduled handler)
packages/keeper-bundles/                           (new — step 7)
packages/keeper-liquidator/                        (new — step 8 stretch)
```
