# Credit Trade Tab — Design

A focused tab for institutions to **open and manage leveraged
collateral trades** in a single signature, replacing the manual
deposit→borrow chain on the existing Lending tab. v1 ships the
csSOL/wSOL pair; v2 adds eUSX/sUSDC.

---

## 1. KYC architecture — B2B vs B2C, two-sided gating

### 1.1 Naming convention (established)

The protocol's KYC wrappers all carry the `c-` prefix (delta-mint
wrapper). Existing deployed mints:

| Wrapper  | Underlying                  | Purpose                                                                | Status |
| -------- | --------------------------- | ---------------------------------------------------------------------- | ------ |
| `csSOL`  | Jito Vault VRT (SOL LST)    | KYC-wrapped LST collateral                                              | live   |
| `cSOL`   | wSOL                        | KYC-wrapped SOL — loan asset on the SOL/csSOL credit trade              | TODO   |
| `cUSDC`  | Solstice USDC               | KYC-wrapped USDC — loan asset on the eUSX/USDC credit trade             | TODO   |
| `cUSX`   | Solstice USX                | KYC-wrapped USX (mint `2ftH31x…QgqS4` — Token-2022 metadata still reads `dUSX`, see §1.6) | live, rename pending  |
| `ceUSX`  | Solstice eUSX (yield-bearing)| KYC-wrapped eUSX (mint `8Uy7rmt…q5JX` — Token-2022 metadata still reads `deUSX`, see §1.6) | live, rename pending  |
| `cUSDY`  | USDY                        | KYC-wrapped Ondo USDY (referenced in backend-compliance config)         | TODO   |

`s-` prefix is Solstice (sUSDC, sUSDT — their devnet stablecoins).
There is no `sUSX` mint; underlying USX is just `USX`, and our
wrapped variant is `cUSX`.

### 1.2 Two-sided KYC model (matches the original protocol design)

| Action                                       | KYC required        | Why                                                          |
| -------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| Deposit collateral (csSOL, ceUSX) into klend | **B2B**             | Collateral side is institutional — typically secured against off-chain T+0 obligations |
| Borrow loan asset (cSOL, cUSDC)              | **none** (anyone)   | Borrowers receive the c-wrapper but it auto-unwraps on transfer-out (or on the next governor ix) so they walk away with native SOL/USDC |
| Supply loan asset (mint cSOL, cUSDC)         | **B2C**             | Yield earners on the loan side are retail — KYC at the wrapper boundary    |
| Liquidate                                    | **Liquidator**      | Already a delta-mint role                                    |

Two consequences:

1. **Both legs of the credit trade are c-wrappers**. The klend
   reserves are over `csSOL` (collateral) and `cSOL` (debt). Native
   SOL/wSOL never shows up as a klend reserve mint.
2. **delta-mint role enum extends from `{Holder, Liquidator, Escrow}`
   to also include `{B2BCollateral, B2CSupply}`** (or rename
   `Holder → B2BCollateral` and add `B2CSupply` — TBD). The whitelist
   check at mint-time then validates the role matches the operation
   context. For the simplest first implementation: keep `Holder` as
   the catch-all and split later if compliance needs differentiated
   reporting.

### 1.3 Auto-unwrap on borrow

Borrower never needs to know cSOL exists. The credit-trade flow's
borrow leg is followed in the same tx by an unwrap, so the user
receives native SOL/wSOL. Implemented via a single governor ix
`unwrap_csol_to_native(amount, recipient = user)` callable by
anyone (no whitelist check on unwrap — it's the inverse of supply,
and the c-wrapper has already passed through KYC to be in
circulation).

### 1.4 Implementation outline — cSOL first

Build `cSOL` (the SOL credit-trade loan asset) before the credit
trade tab. Same shape will apply later to `cUSDC`.

1. **`programs/delta-mint/`** — already supports the mint-config /
   whitelist pattern. We add new role variants if/when we split B2B
   vs B2C; otherwise reuse `Holder`.
2. **`programs/governor/` — wSOL pool**:
   - `init_wsol_pool(...)` — mirrors `init_pool` for csSOL, keyed by
     underlying = `NATIVE_MINT (wSOL)`, sets `csol_mint`, `dm_mint_config`,
     vault accounts.
   - `wrap_native_to_csol(amount: u64)` — transfers `amount` wSOL
     from user → `pool_wsol_vault`, CPIs delta-mint to mint
     `amount` cSOL into user's cSOL ATA (B2C whitelist check fires
     inside `mint_to`). Optional pre-wrap of native SOL → wSOL ATA
     in the same tx for one-signature convenience.
   - `unwrap_csol_to_native(amount: u64, recipient: Pubkey)` —
     burns `amount` cSOL from user (no whitelist check; burn is
     unrestricted), transfers `amount` wSOL from `pool_wsol_vault`
     → recipient's wSOL ATA, optional auto-`closeAccount` to
     deliver native SOL.
3. **Update `whitelist-wallet.ts`** — accept a `--mint-config <pk>`
   override so we can whitelist wallets on either the csSOL or the
   cSOL `MintConfig` (the script currently hardcodes the csSOL
   one).
4. **cSOL klend reserve on a fresh market (v4)**:
   - Reuse `bootstrap-cssol-market-v2.ts` with `MARKET_VERSION=v4`,
     swap the wSOL reserve spec for a cSOL reserve. cSOL price feed
     is the same Pyth wSOL/USD push oracle (1:1 backing).
   - `cSOL.disable_usage_outside_emode = 0` — KYC'd wallets can
     supply/withdraw outside eMode 2 too, useful for the B2C
     side's supply-and-earn UX.
5. **Credit-trade flow** uses cSOL throughout (see §3). Open ix
   list interleaves a `governor.unwrap_csol_to_native` between the
   flash-borrow and the Jito vault wrap — Jito vault accepts wSOL
   only, so we must unwrap d→native for the round-trip.
6. **Whitelist UX** in the playground: extend the existing banner
   to check both the csSOL `MintConfig` (B2B) and the cSOL
   `MintConfig` (B2C). Show separate badges so the user knows which
   role they have.
7. **v3 → v4 migration**: v3 (current active market with raw wSOL
   reserve) demoted to read-only; v4 (with cSOL reserve) becomes
   the active market in the playground's market switcher.

### 1.5 What we **don't** do

- We deliberately do not bolt KYC onto the v3 wSOL reserve — klend
  has no permission hook on a reserve. Any in-place gate would be
  frontend-only and trivially bypassable. Build v4 with cSOL from
  the start.
- We do not change the obligation-ownership model (option 2 in the
  earlier draft). The c-wrapper pattern gives us KYC at every
  mint/burn boundary without forking klend, and is symmetric across
  collateral and loan assets.

### 1.6 Rebrand status

**Done** (already shipped):
- Codebase sweep across all configs, scripts, frontend, plans — 0
  remaining `dUSX/deUSX/dSOL/dUSDC/dUSDY` references.
- Playground `KNOWN_MINTS` updated — UI displays the new names
  (`ceUSX`, `cUSX`, etc.) regardless of what's stored on-chain at
  the klend layer.
- Helper script
  [`scripts/rename-wrapper-token.ts`](packages/programs/scripts/rename-wrapper-token.ts)
  for future on-chain renames (Token-2022 metadata + klend
  `tokenInfo.name`).

**Deferred to v4 bootstrap**:
- klend `tokenInfo.name` for the live v3 reserves still reads
  `deUSX` on-chain — locked by the same `InvalidConfig (6004)`
  validation lockout that hit v2 once elevation groups were
  registered. Mode 16 (`UpdateTokenInfoName`) is rejected even
  with `skip=true`. Not user-visible (playground reads from
  `KNOWN_MINTS`, not the klend cache); will be set correctly when
  v4 is bootstrapped from scratch with the new names baked into
  the reserve specs.
- The deployed `dUSX`/`deUSX` mints (`2ftH31x…`, `8Uy7rmt…`) have
  **no Token-2022 metadata extension** at all (verified via
  `spl-token display`), so there's nothing to update at the mint
  layer either.

---

## 2. Credit Trade Tab — scope

A new tab `CreditTradeTab` modeled on the existing Lending tab but
narrowed to a single asset pair at a time. Two options in a top-level
selector:

1. **csSOL/wSOL credit trade** — ships v1.
2. **eUSX/sUSDC credit trade** — ships v2 (same flow, different
   reserves; held until v1 is solid).

### 2.1 Position model

Each obligation in the v3 klend market is already a credit trade
when in eMode 2:

- collateral leg: `csSOL` and/or `csSOL-WT`
- debt leg: `wSOL`

The position's leverage at any moment is
`debt_value / (collateral_value − debt_value)`.

The tab's job: **spin up a target leverage in one signature** and
**unwind in one signature** (the unwind path already exists on the
Unwind tab — we'll reuse `OneStepUnwindTab`'s flash-loan flow).

### 2.2 Inputs (open form)

The form is intentionally tiny:

| Input              | Notes                                                        |
| ------------------ | ------------------------------------------------------------ |
| Margin asset       | Radio: `SOL` / `wSOL` / `csSOL` (existing wallet balance shown next to each). |
| Margin amount      | Number input, units inherited from selection.                |
| Trade size (wSOL)  | The flash-loan amount = the borrow amount = the wSOL the institution effectively shorts. |

Derived (read-only) calculator card:

- **Total collateral after open**: `margin_in_sol + flash_loan` (in csSOL terms; price-of-csSOL conversion via accrual oracle)
- **Debt after open**: `flash_loan`
- **Leverage**: `debt / margin`
- **USD values**: collateral / debt with current oracle prices
- **Target health**: `liq_threshold * collateral_value / debt_value` (eMode 2 → liq_threshold 92%)
- **Liquidation price**: csSOL price at which debt_value = liq_threshold × collateral_value
- **Max trade size** at the eMode-2 LTV cap (90%): `margin × ltv / (1 − ltv)` = `margin × 9` for `ltv=0.9`.

UI guardrail: trade-size input clamps to ≤ max; show a red warning at
≥ 95% of cap.

### 2.3 Existing position view + edit

Below the open form, render the user's current obligation in
eMode 2 (if any) as a single row:

- collateral csSOL + csSOL-WT (combined)
- debt wSOL
- leverage / health / NAV

Two actions:

- **Increase** — opens the open form pre-filled with current position;
  trade size input now means *additional* leverage on top of the
  existing debt. Same signature flow.
- **Close** — links to the existing Unwind tab (or inlined leveraged-
  unwind helper from `OneStepUnwindTab`).

Partial decrease comes later; full unwind covers v1's primary use
case.

---

## 3. Single-tx open — instruction layout (v4 with cSOL)

Given the user holds `margin` of asset `M ∈ {SOL, wSOL, csSOL}` and
wants `loan` of leverage:

```
[0]  ComputeBudget setComputeUnitLimit(1.4M)
[1]  initUserMetadata               (idempotent — only if missing)
[2]  initObligation                 (idempotent)
[3]  createATA(user, csSOL_ATA)     (idempotent)
[4]  createATA(user, wSOL_ATA)      (idempotent)
[5]  createATA(user, dSOL_ATA)     (idempotent — KYC-gated wrapper)
[6]  createATA(user, vrt_ATA)       (idempotent — Jito VRT)

──── flash-borrow leg (cSOL) ──────────────────────────────────
[7]  flash_borrow_reserve_liquidity(dSOL_reserve, loan)
        → mints `loan` cSOL into user's cSOL ATA

──── unwrap to native wSOL so Jito vault can ingest it ─────────
[8]  governor.unwrap_kwsol_to_native(amount = loan)
        → burns cSOL, transfers wSOL pool→user's wSOL ATA

──── pull margin into the wSOL ATA so wrap_with_jito_vault sees
     `loan + margin_in_wsol` available to consume ──────────────
[9]  if M == SOL:
        SystemProgram.transfer(user → wsolAta, margin_lamports)
        syncNative(wsolAta)
     elif M == wSOL:
        // user already holds wSOL; nothing to add
     elif M == csSOL:
        // skip; margin csSOL goes into [13] alongside wrap output

──── wrap into csSOL via Jito vault ─────────────────────────────
[10] wrap_with_jito_vault(amount = loan + (margin if M ∈ {SOL,wSOL} else 0))
        → mints csSOL into user's csSOL ATA
        → governor pool absorbs VRT / pays Jito vault fee

──── refresh chain (klend wants every active reserve fresh) ─────
[11] refresh_reserve(csSOL,  csSOL_oracle)
[12] refresh_reserve(cSOL,  dSOL_oracle)
[13] refresh_obligation(...obligation deposit reserves...)

──── deposit collateral ─────────────────────────────────────────
[14] deposit_reserve_liquidity_and_obligation_collateral(
       csSOL_reserve,
       amount = csSOL_minted_from_wrap + (margin if M == csSOL else 0)
     )

──── re-refresh csSOL (deposit invalidated it) + obligation ─────
[15] refresh_reserve(csSOL, csSOL_oracle)
[16] refresh_obligation(...)

──── borrow the matching cSOL leg ──────────────────────────────
[17] borrow_obligation_liquidity(
       dSOL_reserve,
       amount = loan,
       remaining_accounts = [csSOL_reserve, csSOL_WT_reserve_if_present]
     )
        → klend mints cSOL into user's cSOL ATA (whitelist check
          fires inside delta-mint)

──── flash-repay leg (must be the inverse of [7] in the same tx) ─
[18] flash_repay_reserve_liquidity(dSOL_reserve, loan)  // fee=0
```

Net: `loan` cSOL flashed → unwrapped to wSOL → wrapped via Jito
vault to csSOL (+ margin) → deposited as collateral → cSOL borrowed
→ flash repaid. User ends with `loan + margin_in_csSOL` collateral
and `loan` cSOL debt; their wallet net change is `−margin`.

If we want the user's debt to be **native SOL-redeemable** (so they
can simply `unwrap_kwsol_to_native(debt)` whenever they want SOL out),
the cSOL wrapper makes that a single governor ix, KYC-checked.

**Net effect** in one signature:

- user wallet:   `−margin` of M, `+0` everywhere else
- obligation:    `+(loan + margin_in_csSOL)` collateral, `+loan` debt
- klend wSOL pool: net zero (flash borrow + repay)
- Jito vault:    `+margin_in_wsol+loan` wSOL → minted VRT → csSOL pool

### 3.1 Flash fee = 0

The flash-loan fee on the wSOL/cSOL reserve is set to **zero**
(`reserve.config.fees.flash_loan_fee_sf = 0`) at bootstrap time
([bootstrap-cssol-market-v2.ts](packages/programs/scripts/bootstrap-cssol-market-v2.ts),
phase-1 sets `UpdateFeesFlashLoanFee` and `UpdateFeesOriginationFee`
to `u64(0n)`). The credit-trade open flow can flashBorrow `loan` and
flashRepay exactly `loan` — no headroom math, no debt-vs-loan delta.
We control the market so this is a protocol-level config call.

(Origination fee is also zeroed — it's charged on every regular
borrow and would otherwise add a small markup to the user's debt at
open time, which is undesirable for the credit-trade product.)

### 3.2 ALT (Address Lookup Table) sizing

The full ix list above touches ~25 distinct accounts. Without an ALT
the tx exceeds the 1232-byte legacy limit. We already have
`init-deposit-lut.ts` for the v1 deposit flow; it'll need extending
(or a new `init-credit-trade-lut.ts`) covering wSOL_reserve,
csSOL_reserve, both reserve PDAs, jito_vault accounts,
governor pool_config, delta-mint program + mint_config. Use
`VersionedTransaction` with the LUT for the open path.

---

## 4. Implementation order

The credit trade flow depends on cSOL existing — without it, the
debt leg is un-gated wSOL and we'll have to refactor the entire
flow when KYC is added later. So **build cSOL first, v4 market
second, credit trade third**.

### 4.0 Prerequisite — cSOL wrapper + v4 market

1. **`programs/governor/`**: add `init_wsol_pool`,
   `wrap_native_to_kwsol`, `unwrap_kwsol_to_native` ixes (mirror the
   csSOL pool shape; reuse `delta_cpi::add_to_whitelist_with_co_authority`
   for the same whitelist namespace). Add anchor tests in
   `tests/governor.fork.ts`.
2. **cSOL mint** + delta-mint `MintConfig`: deploy via existing
   `setup-cssol-mint.ts` analog; co_authority = wSOL pool PDA.
3. **`scripts/bootstrap-cssol-market-v2.ts`**: replace the wSOL spec
   with a cSOL spec (mint, oracle = same Pyth wSOL feed, same
   curve, same per-EG limits). Run `MARKET_VERSION=v4`.
4. **`packages/frontend-playground/src/lib/addresses.ts`** + the
   tab market switcher: add v4 to `MARKETS`, demote v3 to read-only.

### 4.1 Credit Trade tab itself

1. **`lib/creditTrade.ts`** — pure-builder layer:
   - `buildOpenCreditTradeIxes({ user, marginAsset, marginAmount, loanAmount, currentObligation? })`
     → returns `TransactionInstruction[]` and the LUT key set.
   - Reuses existing builders: `buildFlashBorrowIx`, `buildFlashRepayIx`,
     `buildWrapWithJitoVaultIx`, `buildDepositCsSolIx`,
     `buildBorrowObligationLiquidityIx`, `buildRefreshReserveIx`,
     `buildRefreshObligationIx`, init-obligation/user-metadata.
   - Adds `quoteCreditTrade({ marginAsset, marginAmount, loanAmount, prices })`
     that returns the calculator output: collateralCsSol, debtWSol,
     leverage, healthAtOpen, liqPrice, maxLoanForMargin.

2. **`tabs/CreditTradeTab.tsx`** — UI:
   - Pair selector (csSOL/wSOL active; eUSX/sUSDC disabled with
     "coming soon" tag).
   - Open form (margin asset, margin amount, trade size) + calculator
     card.
   - Existing-position card (read from current obligation in
     eMode 2). Increase / Close buttons.
   - Reuses `TxConsole`, `ActionPanel` styling.

3. **App tab wiring** — add `{ id: "credit-trade", label: "Credit
   Trade", render: () => <CreditTradeTab /> }` in `App.tsx`.

4. **`scripts/init-credit-trade-lut.ts`** — bootstrap the ALT.

5. **Edge cases**:
   - First-time user: `init_user_metadata` + `init_obligation` injected.
   - Already in eMode 2 with an existing csSOL deposit + wSOL debt:
     same flow with the obligation's existing deposit reserves passed
     as `remaining_accounts` to `borrow_obligation_liquidity` and
     `refresh_obligation`.
   - **Not whitelisted** (delta-mint gate fires inside `wrap_with_jito_vault`):
     show the same banner the Lending tab uses; disable the Open
     button until status flips.
   - **Insufficient flash liquidity** in the wSOL reserve: pre-flight
     check `wSOL_reserve.available_amount ≥ loan`; else surface
     "loan exceeds wSOL pool's available liquidity (X), reduce trade
     size" before signing.
   - **Slippage on wrap** (csSOL ↔ VRT exchange rate moves between
     quote and submit): add a 1-2% headroom on the deposit `amount`
     to avoid `Custom 1` (insufficient funds) at deposit step;
     validate via simulation.

6. **Increase position** — same builder, but `marginAmount` may be 0
   (pure leverage bump on existing deposit). Calculator factors in
   current debt + collateral.

7. **Decrease/close** — defer; for v1 link to existing Unwind tab.

---

## 5. eUSX/sUSDC v2 path (informational)

Same transaction shape, swap the asset pair. The **same cSOL-style
wrapper pattern** applies on the stables side: introduce a
`cUSDC` (KYC-gated wrapper of Solstice USDC) so the debt leg is
gated. The flow:

- flash-borrow `cUSDC`
- governor.unwrap_ksusdc_to_native (cUSDC → sUSDC)
- governor.usx_pool.wrap (sUSDC → USX → eUSX → ceUSX) — analogue of
  `wrap_with_jito_vault`, doesn't exist yet
- deposit ceUSX
- borrow cUSDC (KYC-checked at MintTo time)
- flash-repay cUSDC

Shipping this requires both the cUSDC wrapper (mirrors §1.3 for
USDC) and the USX wrapping flow on the governor side. Out of scope
for v1; both built once the cSOL pattern lands and we know the
shape.

---

## 5.5 Status — current build state

**Done:**
- Governor program upgraded with `initialize_native_pool`,
  `wrap_native`, `unwrap_native`, `add_participant_native_via_pool`,
  `mint_wrapped_native`, `activate_wrapping_native`. Deployed at
  `6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi`.
- cSOL pool live on devnet:
  - Pool config PDA: `7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ`
  - cSOL mint: `AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf` (Token-2022)
  - Pool wSOL vault: `6fH4CVZ6m9mUBRBdbFT6Tqu4bGr29eC5cvybuA2tYQ3o`
  - Whitelisted: `DiDbnkw…uDcFn` (deployer) + `AhKNmB…qPaJX` (id.json)
- Bootstrap script extended with `MARKET_VERSION=v4` swap (cSOL replaces
  wSOL as the loan-side reserve in spec).
- Flash-loan fee + origination fee zeroed in bootstrap phase-1.

**Blocker — v4 klend integration**:
- Newest klend devnet binary marks every freshly init'd reserve with
  `is_usage_blocked = true` and rejects every `update_reserve_config`
  call with `InvalidSigner (6005)` until the flag clears.
- `seed_deposit_on_init_reserve` returns `InitialAdminDepositExecuted
  (6130)` (i.e. already done) and **does not** clear `is_usage_blocked`.
- `lending_market_owner_cached` is `default::Pubkey` post-`init_lending_market`,
  so `update_lending_market_owner` is unreachable (its signer must equal
  the cached owner).
- Net effect: v3 (already running) is the latest working market; v4
  bootstrap aborts at phase-1 step 1 (`UpdateTokenInfoName`).
- Reserves left from the failed v4 attempts are documented in
  `configs/devnet/cssol-market-v4.checkpoint.json` for the next investigation.

**Interim path (this turn)**: build the credit-trade flow against the
**v3 market with raw wSOL** as the borrow asset. The cSOL pool exists
and the wrap/unwrap ixes work, so the flow can wrap user margin into
csSOL (existing path) but borrows raw wSOL temporarily. This keeps the
flash-loan/leveraged-position UX shippable while we untangle the klend
v4 lockout.

When klend devnet either ships a fix or we surface the right
unblock-ix, swap the credit trade's borrow reserve from wSOL → cSOL
in one config change ([v4 bootstrap](packages/programs/scripts/bootstrap-cssol-market-v2.ts)
+ [addresses.ts](packages/frontend-playground/src/lib/addresses.ts)).

## 6. Open questions

1. ~~**Flash fee handling**~~ — **resolved**: fee = 0, baked into
   bootstrap. See §3.1.
2. ~~**KYC for the borrow leg**~~ — **resolved**: build cSOL
   wrapper + v4 market before the credit-trade flow. See §1.
3. **csSOL margin path** — should the user be allowed to mix
   csSOL margin + flash-loan-derived csSOL into a single deposit ix?
   Yes, but the deposit amount must equal `wrap_output + margin_csSOL`
   exactly; otherwise klend's
   `deposit_reserve_liquidity_and_obligation_collateral` will leave
   residue in the user's csSOL ATA.
4. **Calculator price source** — use the same `readReserve` pricing
   the Lending tab uses (live oracle if known, fallback to klend
   cached). Acceptable for the calculator's "expected" values; the
   actual ratios on submit come from the on-chain values at sim time.
5. **Quote vs sim** — should we run `simulateTransaction` before
   showing the calculator's "as built" numbers? Yes for v1.1 — for
   v1 ship the static calculator and add sim-based as a follow-up.
6. **cSOL pool initial liquidity** — the `pool_wsol_vault` needs
   initial wSOL deposited to bootstrap unwraps. Easiest: at pool
   init, governor accepts a seed deposit from the pool authority
   (mirrors the csSOL/jito-vault VRT seed path). Alternative: have
   `wrap_native_to_kwsol` always replenish the vault on every wrap,
   but then the first `unwrap_kwsol_to_native` after init has no
   liquidity to draw from — a credit trade open for a fresh pool
   would block until enough wraps have happened. Seed at init is
   cleaner.
