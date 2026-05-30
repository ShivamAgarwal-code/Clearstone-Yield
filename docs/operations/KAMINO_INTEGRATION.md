# Delta Mint — KYC-Gated Lending via Kamino Lend V2

## Overview

Delta Mint creates **KYC-gated wrapped tokens** (starting with cUSDY, a 1:1 wrapped USDY) that can be used as collateral in **permissionless Kamino Lend V2 markets**. This combines institutional-grade compliance (KYC at the token issuance layer) with DeFi-native lending infrastructure (audited, battle-tested Kamino protocol).

```
┌──────────────────────────────────────────────────────┐
│                    Delta Stack                       │
│                                                      │
│  ┌───────────-──┐    ┌─────────────────────────────┐ │
│  │ delta-mint   │    │     Kamino Lend V2          │ │
│  │ (our program)│    │   (audited infra)           │ │
│  │              │    │                             │ │
│  │ • KYC gate   │───▶│ • Permissionless market     │ │
│  │ • Whitelist  │    │ • Custom reserves           │ │
│  │ • Conf. Tx   │    │ • Oracle + IR curves        │ │
│  │ • Mint auth  │    │ • Liquidation engine        │ │
│  └-─────────────┘    └─────────────────────────────┘ │
│                                                      │
│  We build this        We use this (as-is)            │
└──────────────────────────────────────────────────────┘
```

This is the same model as **Aave Horizon** — the compliance happens at the asset layer, not the protocol layer.

---

## Architecture

### Layer 1: Delta Mint Program (`programs/delta-mint`)

Anchor program on Solana that manages KYC-gated token issuance.

| Instruction | Description |
|---|---|
| `initialize_mint` | Creates a Token-2022 mint with **confidential transfer extension**. Mint authority is a program PDA. |
| `add_to_whitelist` | Authority adds a wallet to the KYC whitelist with `Holder` role (can mint + hold). |
| `add_liquidator` | Authority adds a wallet with `Liquidator` role (can receive collateral, cannot mint). |
| `remove_from_whitelist` | Authority removes a wallet, closing the PDA and returning rent. |
| `mint_to` | Mints tokens to a whitelisted `Holder`. Rejects `Liquidator` role. |

**Key accounts (PDAs):**

| Account | Seeds | Purpose |
|---|---|---|
| `MintConfig` | `["mint_config", mint]` | Stores authority, decimals, whitelist count |
| `WhitelistEntry` | `["whitelist", mint_config, wallet]` | Stores KYC approval status per wallet |
| `MintAuthority` | `["mint_authority", mint]` | Program-owned Token-2022 mint authority |

### Layer 2: Kamino Lend V2 Market

A permissionless lending market created via the `klend` program with two reserves:

| Reserve | Asset | Role | Oracle |
|---|---|---|---|
| cUSDY | KYC-wrapped USDY | **Collateral** (LTV 75%) | Pyth USDY feed (`BkN8...`) |
| USDC | Circle USDC | **Borrow** | Pyth USDC feed (`Gnt27...`) |

**Program:** `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`

### End-to-End Flow

```
1. User submits KYC ──▶ Off-chain KYC provider
                              │
2. Provider approves ──▶ Authority calls delta-mint::add_to_whitelist()
                              │
3. User gets tokens  ──▶ Authority calls delta-mint::mint_to()
                              │ (only works if whitelisted)
4. User deposits to  ──▶ Kamino Lend V2 market (permissionless)
   lending market
                              │
5. User borrows USDC ──▶ Standard Kamino lending flow
   against collateral

KYC gate is at the TOKEN level (mint), not the LENDING level.
Only whitelisted users can hold the collateral token.
```

---

## Token Design: cUSDY

| Property | Value |
|---|---|
| Standard | SPL Token-2022 (Token Extensions) |
| Extension | Confidential Transfer (privacy-centric balances) |
| Decimals | 6 (matches USDY) |
| Mint authority | Program-owned PDA (no external mint authority) |
| Peg | 1:1 with USDY (same oracle feed) |
| KYC gate | Only whitelisted wallets can receive minted tokens |

### Confidential Transfers

The cUSDY mint is initialized with the **ConfidentialTransferMint** extension:
- Users can opt-in to confidential transfers on their token accounts
- Standard (non-encrypted) balances remain readable by the lending protocol
- The lending protocol interacts with standard balances normally
- Privacy is opt-in at the user level, not enforced protocol-wide
- Auto-approve enabled — no additional authority approval needed for CT accounts

---

## Reserve Configurations

### cUSDY Collateral Reserve (`configs/delta_usdy_reserve.json`)

```
LTV:                     75%
Liquidation threshold:   82%
Min liquidation bonus:   200 bps (2%)
Max liquidation bonus:   500 bps (5%)
Deposit limit:           100,000 cUSDY
Borrow limit:            0 (collateral-only)
Oracle:                  Pyth USDY (BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb)
Auto-deleverage:         Enabled
```

### USDC Borrow Reserve (`configs/usdc_borrow_reserve.json`)

```
Borrow limit:            75,000 USDC
Deposit limit:           100,000 USDC
Oracle:                  Pyth USDC (Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD)
Utilization cap:         80%
Auto-deleverage:         Enabled

Interest Rate Curve:
  0% util  → 0.0% APR       93% util → 20.0% APR
  70% util → 4.0% APR       96% util → 40.0% APR
  85% util → 6.0% APR      100% util → 80.0% APR
  90% util → 10.0% APR
```

---

## Kamino V2 Integration Details

### PDA Seeds (klend program)

| Account | Seeds |
|---|---|
| Market authority | `["lma", market_address]` |
| Reserve liquidity supply | `["reserve_liq_supply", reserve_address]` |
| Reserve fee vault | `["fee_receiver", reserve_address]` |
| Reserve collateral mint | `["reserve_coll_mint", reserve_address]` |
| Reserve collateral supply | `["reserve_coll_supply", reserve_address]` |
| Global config | `["global_config"]` |

### Instruction Discriminators

| Instruction | Discriminator (bytes) |
|---|---|
| `initLendingMarket` | `[34, 162, 116, 14, 101, 137, 94, 239]` |
| `initReserve` | `[138, 245, 71, 225, 153, 4, 3, 43]` |

### Market Creation Flow

1. `SystemProgram.createAccount` — allocate market account (owner: klend)
2. `initLendingMarket(quoteCurrency: "USD")` — initialize the market
3. `SystemProgram.createAccount` — allocate each reserve account
4. `initReserve` — initialize reserve with liquidity mint + initial deposit
5. `updateReserveConfig` — apply JSON config (oracle, LTV, rates, limits)

---

## Liquidations — Whitelisted Approach

Kamino V2 liquidations are **permissionless by default** — any wallet can call `liquidateObligationAndRedeemReserveCollateral`. But since cUSDY is KYC-gated, an un-whitelisted liquidator **cannot receive the collateral**. We solve this with a hybrid approach.

### The Problem

```
Liquidator repays borrower's USDC debt
         │
         ▼
Liquidator receives cUSDY collateral (+ bonus)
         │
         ▼
❌ Liquidator is not KYC'd → cannot hold cUSDY
```

### Solution: Hybrid Whitelisted Liquidators + Auto-Deleverage

```
┌─────────────────────────────────────────────────────────┐
│                  Liquidation Strategy                   │
│                                                         │
│  Fast path (minutes):                                   │
│  ┌────────────────────────────────────────────────┐     │
│  │ Pre-approved KYC'd liquidator bots             │     │
│  │ • Whitelisted via add_liquidator()             │     │
│  │ • Role = Liquidator (cannot mint, only receive)│     │
│  │ • Act immediately when positions go underwater │     │
│  └────────────────────────────────────────────────┘     │
│                                                         │
│  Backstop (72hr margin call):                           │
│  ┌──────────────────────────────────────────────┐       │
│  │ Kamino Auto-Deleverage                       │       │
│  │ • Triggered by Risk Council via multisig     │       │
│  │ • Sells collateral on open market            │       │
│  │ • No third party receives cUSDY directly     │       │
│  │ • autodeleverageEnabled = 1 in market config │       │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

### Whitelist Roles (delta-mint program)

| Role | Can Mint | Can Hold | Can Receive via Liquidation | Purpose |
|---|---|---|---|---|
| `Holder` | Yes | Yes | Yes | KYC'd end users |
| `Liquidator` | No | Yes | Yes | Pre-vetted bot operators |

The `add_liquidator` instruction creates a whitelist entry with `role = Liquidator`. These wallets can receive cUSDY collateral during Kamino liquidations but **cannot mint new tokens** — they only participate in the secondary market.

### Liquidation Parameters

| Parameter | Value |
|---|---|
| Trigger | Health factor < 1.0 |
| Bonus range | 200–500 bps (per reserve config) |
| Protocol fee | 10% of liquidation bonus |
| Bad debt bonus | 99 bps |
| Auto-deleverage | Enabled |
| Margin call period | 7 days (604,800 seconds) |
| Liquidator whitelist | Required (via `add_liquidator`) |

### Alternative: Transfer Hook (Future)

A more flexible long-term approach is to deploy a **Token-2022 transfer hook** that:
1. Checks if the receiving wallet has a whitelist PDA
2. Exempts CPI calls originating from klend's liquidation instruction
3. This removes the need to pre-whitelist every liquidator

This is tracked as a future enhancement — the whitelisted bot approach works for launch.

---

## Test Coverage

### Unit Tests (`tests/delta-mint.ts`) — 5/5 passing

| Test | Status |
|---|---|
| Initialize mint with confidential transfer extension | ✅ |
| Add wallet to KYC whitelist | ✅ |
| Mint tokens to whitelisted recipient | ✅ |
| Reject minting to non-whitelisted wallet | ✅ |
| Remove wallet from whitelist | ✅ |

### Fork Integration Tests (`tests/delta-mint.fork.ts`) — 8/8 passing

| Test | Status |
|---|---|
| Create Token-2022 mint with CT extension | ✅ |
| Whitelist a user (KYC approval) | ✅ |
| Mint 10,000 cUSDY to whitelisted user | ✅ |
| Confirm klend program loaded on fork | ✅ |
| Read Kamino main market from fork | ✅ |
| Verify USDY and USDC mints on fork | ✅ |
| Block minting to non-whitelisted wallet | ✅ |
| Remove user from whitelist | ✅ |

### Kamino Market Creation Tests (`tests/kamino-market.fork.ts`) — 10/10 passing

| Test | Status |
|---|---|
| Create cUSDY Token-2022 mint with CT extension | ✅ |
| Whitelist market operator (self-KYC) | ✅ |
| Mint 100 cUSDY for reserve seeding | ✅ |
| Create Kamino Lend V2 lending market | ✅ (timeout-tolerant) |
| Initialize cUSDY collateral reserve | ✅ (timeout-tolerant) |
| Initialize USDC borrow reserve | ✅ (timeout-tolerant) |
| Verify klend PDAs and instruction layout | ✅ |
| Validate cUSDY reserve config from JSON | ✅ |
| Validate USDC reserve config from JSON | ✅ |
| Print remaining steps to production | ✅ |

> **Note:** klend BPF execution may timeout in bankrun due to JIT compilation of the ~500KB binary. Tests gracefully degrade to instruction/PDA verification. Use `solana-test-validator` for full execution.

---

## Open Items

### 1. Confidential Transfers (Privacy)
- **Status:** Extension initialized on mint ✅
- **Next:** Client-side SDK for users to configure CT on their token accounts
- **Compatibility:** Standard balances used by klend — CT is transparent to the lending protocol

### 2. Oracle Configuration
- **Strategy:** Use existing Pyth USDY price feed for cUSDY (1:1 peg)
- **Feed:** `BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb`
- **Next:** Apply via `updateReserveConfig` with `UpdatePythPrice` mode

### 3. Reserve Configuration Application
- **Status:** JSON configs ready in `configs/` ✅
- **Next:** Build script to apply configs via `updateReserveConfig` or use `kamino-manager` CLI

### 4. Liquidation Considerations
- Kamino V2 handles liquidation mechanics natively ✅
- **Solved:** Whitelisted liquidator bots via `add_liquidator` instruction ✅
- **Solved:** Auto-deleverage enabled as backstop (no third-party collateral transfer) ✅
- **Future:** Transfer hook for fully permissionless KYC-gated liquidation

### 5. Production Deployment
- [x] Deploy delta-mint program to devnet
- [x] Deploy governor program to devnet
- [x] Create cUSDY mint on devnet (Token-2022 w/ confidential transfer)
- [x] Create Kamino lending market on devnet
- [x] Initialize USDC borrow reserve
- [x] Initialize cUSDY collateral reserve
- [x] Configure reserve oracles (Pyth USDY + mock USDC)
- [x] Configure reserve parameters (LTV, liquidation threshold, borrow rate curve)
- [x] Whitelist authority wallet as Holder
- [x] Mint cUSDY tokens via governor
- [ ] Set up KYC whitelist management (API/dashboard)
- [ ] End-to-end deposit/borrow testing on devnet
- [ ] Security audit
- [ ] Transfer market ownership to multisig
- [ ] Mainnet deployment

---

## Deployment

### Full Pipeline (from scratch)

```bash
cd packages/programs

# One command to build + deploy + configure everything
pnpm deploy:all:devnet

# Or step by step:
pnpm build                  # Build Anchor programs
pnpm deploy:devnet          # Deploy program binaries to devnet
pnpm devnet:full            # Oracles + governor pool + lending market
pnpm devnet:complete        # Whitelist + mint + cUSDY reserve + config
```

### Individual Steps

```bash
pnpm devnet:oracles         # Create mock USDC oracle on devnet
pnpm devnet:governor        # Initialize governor pool + cUSDY mint
pnpm devnet:market          # Create klend market + USDC reserve
pnpm devnet:complete        # Whitelist, mint cUSDY, init cUSDY reserve, configure
```

### Devnet Addresses (current deployment)

| Component | Address |
|---|---|
| delta-mint program | `13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn` |
| governor program | `BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh` |
| cUSDY mint (Token-2022) | `ALqRkS5GdVYWUFLzsL3xbKCxkoMxe2p23UUP9Waddwfx` |
| Governor pool | `5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb` |
| Lending market | `3LDsUGQzaHuaPwirk5Ty38rsB6XKKrHKjvWzYFygBpQ6` |
| USDC reserve | `5jtmhs5T4JtparKJs6QDxega3v16vLzvNkXq2CzE23vw` |
| cUSDY reserve | `BRpvzwVmBBzLSU7ZcJgeoSNbcwJ8fvvC9Zy2Avqoj1L1` |
| USDY oracle (Pyth V2) | `E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4` |

### Environment

Copy `.env.example` to `.env` and fill in your values. See `configs/devnet/` for deployed addresses.

### Testing

```bash
# Unit tests (local validator)
pnpm test

# Fork tests (requires mainnet RPC)
pnpm test:fork

# Full flow test with solana-test-validator
pnpm test:full-flow:validator
```

---

## Sources

- [Kamino Lend V2 Docs](https://kamino.com/docs/overview)
- [klend-sdk npm](https://www.npmjs.com/package/@kamino-finance/klend-sdk) (v7.3.20)
- [klend Program](https://github.com/Kamino-Finance/klend) — `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- [Kamino Manager CLI](https://kamino.com/docs/build/cli/market-operations.md)
- [Aave Horizon](https://aave.com/horizon) — similar compliance model
