# cUSDC Deployment — KYC-Gating the USDC Borrow Leg

**Status: scripts written, deploy pending.** Replaces the unrestricted
retail sUSDC reserve at `78kkPN…BFy9` with a KYC-gated `cUSDC` reserve
that slots into the existing delta-mint wrapper pattern alongside cSOL,
csSOL, and ceUSX.

## Why

The institutional console's KYC story is currently UI-only on the
USDC side: anyone can deposit sUSDC as collateral or borrow sUSDC
against any non-KYC-gated EG by calling klend directly. The console's
`KycGate` component is a frontend wrapper that doesn't touch the
sUSDC reserve, and the sUSDC SPL mint has no transfer restrictions.

cUSDC moves the gate on-chain by routing every sUSDC inflow through
delta-mint's whitelist PDA — the same mechanism that already gates
csSOL / ceUSX / cSOL.

## Architecture

| Layer | sUSDC (legacy) | cUSDC (new) |
|---|---|---|
| Underlying | Solstice USDC mint | sUSDC (1:1 wrap) |
| Token program | SPL Token (legacy) | Token-2022 |
| Mint authority | Solstice | delta-mint pool PDA |
| KYC gate | none | `[b"whitelist", dmMintConfig, user]` PDA at mint time |
| Decimals | 6 | 6 |
| Oracle | USDC Pyth Receiver `ETLQGf…myW` | same |
| Pool ix | direct deposit | `governor.wrap_native` (sUSDC → cUSDC) before deposit |

The cUSDC reserve replaces sUSDC in:

- **EG-1 (stables)** — debt = cUSDC, collateral = ceUSX / ceUSX-WT.
- **EG-3 (margin long SOL)** — debt = cUSDC, collateral = cSOL.
- **EG-4 (margin short SOL)** — collateral = cUSDC, debt = cSOL.

## IRM

Klend's `borrow_rate_curve` takes 11 linearly-interpolated points.
The cUSDC curve floors at **2.5% APR at 0% utilization** (institutional-
grade idle yield) and steepens past an 80% kink:

| Utilization | Borrow APR |
|---|---|
| 0% | 2.5% |
| 30% | 3% |
| 50% | 4% |
| 70% | 5% |
| **80% (kink)** | **6%** |
| 85% | 9% |
| 90% | 15% |
| 93% | 30% |
| 95% | 50% |
| 98% | 80% |
| 100% | 120% |

Plus `protocolTakeRatePct = 15` (15% of accrued interest goes to the
treasury; the remaining 85% to suppliers).

Full curve lives in [`packages/programs/configs/delta_cUSDC_reserve.json`](../../packages/programs/configs/delta_cUSDC_reserve.json).

## Deploy sequence

All four scripts are idempotent (checkpoint files + on-chain state
checks) so partial failures resume cleanly.

### 0. Pre-flight

```bash
# Repay any in-flight sUSDC debt on dev wallets. The current devnet
# state has 1 obligation (H6wzks5j…WhRyP, the dev wallet) holding
# ~0.0000099 sUSDC borrowed — repay via the institutional UI before
# the migration so klend's integrity validator can flip the EG cleanly.
```

### 1. Deploy the cUSDC pool + mint

```bash
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx tsx packages/programs/scripts/deploy-cusdc-pool-devnet.ts
```

Writes [`packages/programs/configs/devnet/cusdc-pool.json`](../../packages/programs/configs/devnet/cusdc-pool.json) with:

- `cusdcMint` — the new Token-2022 mint
- `pool.poolConfig` — pool PDA at seeds `[b"native_pool", cusdcMint]`
- `dmMintConfig`, `dmMintAuthority` — delta-mint integration handles
- `poolSusdcVault` — pool-owned ATA holding underlying sUSDC

### 2. Init the klend reserve over cUSDC

```bash
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx tsx packages/programs/scripts/setup-cusdc-reserve.ts
```

Reads `cusdc-pool.json`, runs `klend.init_reserve` with the deployer's
seed cUSDC, then applies the full reserve config from
`delta_cUSDC_reserve.json` (LTV 0/0 — collateral-eligibility carried by
the EG-4 entry — IRM curve, deposit/borrow caps, EG flag, etc.).
Writes [`packages/programs/configs/devnet/cusdc-deployed.json`](../../packages/programs/configs/devnet/cusdc-deployed.json) with the reserve PDA + cToken mint/supply addresses.

### 3. Repoint EG-1 + EG-3 debt to cUSDC

```bash
# Dry-run first
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx tsx packages/programs/scripts/migrate-eg-debt-to-cusdc.ts

# Then broadcast
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx tsx packages/programs/scripts/migrate-eg-debt-to-cusdc.ts --send
```

Reads each target EG's full struct from the on-chain `LendingMarket`,
preserves every field (LTV, liq threshold, allowNewLoans, …), and only
swaps `debt_reserve` from sUSDC to cUSDC. Both EG-1 and EG-3 flip in a
single tx for atomicity.

### 4. Deprecate the sUSDC reserve

```bash
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx tsx packages/programs/scripts/deprecate-susdc-reserve.ts          # dry-run
DEPLOY_KEYPAIR=~/.config/solana/id.json \
  npx tsx packages/programs/scripts/deprecate-susdc-reserve.ts --send   # broadcast
```

Five `update_reserve_config` ops:

1. Status → Hidden (`mode=33`, value=2): klend rejects new deposit /
   borrow flows; repay + withdraw stay open for any stragglers.
2. DepositLimit → 0 (defense-in-depth, validated edit).
3. BorrowLimit → 0 (defense-in-depth, validated edit).
4. BorrowLimitOutsideElevationGroup → 0.
5. ElevationGroups → `[0; 20]`.

Each op runs in its own tx so klend's integrity validator reads fresh
state between edits. `skipValidation` is chosen per the
*klend skip-validation flag inverted* memory note (false for cap edits,
true for status / EG-array edits).

### 5. Frontend rewire

After step 2 completes, the addresses are pinned in `cusdc-deployed.json`
and `cusdc-pool.json`. Frontend changes (separate PR after deploy):

1. [`packages/frontend-institutional/src/config/devnet.ts`](../../packages/frontend-institutional/src/config/devnet.ts)
   — add a `cUSDC` token entry, mark the existing `sUsdcReserve` as
   `@deprecated`. Pull addresses from the JSON artifacts.
2. [`packages/frontend-institutional/src/lib/obligation.ts`](../../packages/frontend-institutional/src/lib/obligation.ts)
   — append `cUsdcReserve` to `KNOWN_RESERVES`. Without this,
   `findObligationReserves` misses cUSDC borrows and `refresh_obligation`
   trips InvalidAccountInput 6006.
3. [`packages/frontend-institutional/src/pages/PositionsPage.tsx`](../../packages/frontend-institutional/src/pages/PositionsPage.tsx)
   — extend `BORROW_LEGS`, `COLLATERAL_ASSETS`, `RESERVE_ORACLES`,
   `RESERVE_META`. Replace `USDC_RESERVE` / `USDC_MINT` constants with
   `CUSDC_RESERVE` / `CUSDC_MINT` in `handleBorrow`, `handleRepay`, and
   the debt-row detector.
4. [`packages/frontend-institutional/src/pages/PreparePage.tsx`](../../packages/frontend-institutional/src/pages/PreparePage.tsx)
   — add a sUSDC → cUSDC wrap step (call
   `governor.wrap_native` with the cUSDC pool PDA). Gated behind a
   whitelist precheck — see the *delta-mint whitelist_entry gate* memory.
5. [`packages/frontend-institutional/src/components/KycGate.tsx`](../../packages/frontend-institutional/src/components/KycGate.tsx)
   — add the cUSDC `dmMintConfig` to the pools list it whitelist-checks.
6. Sweep any other call sites that hardcode `USDC_RESERVE` /
   `USDC_MINT`: `BorrowPage.tsx`, `CollateralPage.tsx`, the credit-trade
   panels.

### 6. Smoke test

Against a fresh devnet wallet:

1. KYC self-whitelist via the institutional console.
2. Mint or transfer in a chunk of sUSDC.
3. Wrap sUSDC → cUSDC via the new PreparePage step.
4. Deposit cUSDC as collateral in EG-4 (margin short SOL).
5. Borrow cUSDC against ceUSX collateral in EG-1.
6. Repay → withdraw round-trip.
7. Run a non-KYC wallet through the same flow and verify it bounces at
   the wrap step (not just at the UI gate).

## Reverse path (rollback)

If a flip needs to be undone before the sUSDC deprecation step:

- `migrate-eg-debt-to-cusdc.ts` accepts whatever pubkey lives in
  `cusdc-deployed.json` — point it back at sUSDC by editing the
  `cusdcReserve` field, or re-run with a hand-edited target. The script
  refuses to overwrite if the current debt isn't sUSDC or cUSDC, so it
  won't clobber unrelated state.
- The cUSDC reserve and pool stay live but unused — both keep their
  rent-exempt allocation. Nothing destructive.

After step 4 (`deprecate-susdc-reserve.ts`) the rollback cost is much
higher — you'd have to flip `Status` back to Active and reset all the
caps. Don't run step 4 until you're confident in steps 1–3.
