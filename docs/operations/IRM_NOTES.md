# Interest Rate Model (IRM) — klend Operator Guide

**Last updated:** 2026-05-06 (after the cSOL curve-edit incident clarified the `skip_config_integrity_validation` semantics).

This document supersedes the earlier "klend rejects all post-init updates" note.
That theory was wrong; we had the skip-validation flag inverted.

---

## TL;DR

- klend's `update_reserve_config` instruction (mode 23 = `UpdateBorrowRateCurve`) **does** accept curve edits on live, in-use reserves.
- The `skip_config_integrity_validation` byte at the tail of the ix data is the OPPOSITE of what its name suggests:
  - `true` (1) → fast path that **requires** the reserve to be `is_predeposit` (no live deposits / below `market.min_initial_deposit_amount`). Fails with `InvalidConfig (6004)` on any reserve that has accumulated activity.
  - `false` (0) → routes through `validate_reserve_config_integrity`, which is the path that actually accepts well-formed config edits on in-use reserves.
- For every reserve we ship (`cSOL`, `csSOL`, `csSOL-WT`, `ceUSX`, `ceUSX-WT`, `sUSDC`, retired-but-not-empty `wSOL`), **send `skipValidation = false`**.

---

## Background — the line-49 trap

The error every caller hits when they get this wrong:

```
AnchorError thrown in programs/klend/src/handlers/handler_update_reserve_config.rs:49.
Error Code: InvalidConfig.
Error Number: 6004.
Error Message: Input config value is invalid.
```

The handler at that line looks roughly like this (verbatim from the open-source klend):

```rust
let clock = Clock::get()?;
lending_operations::refresh_reserve(reserve, &clock, None, market.referral_fee_bps)?;
lending_operations::update_reserve_config(reserve, mode, value, &clock)?;

if skip_config_integrity_validation {
    require!(
        reserve.is_predeposit(market.min_initial_deposit_amount),
        LendingError::InvalidConfig
    );                                                   // <-- line 49
    msg!("WARNING! Skipping validation of the config");
} else {
    lending_operations::utils::validate_reserve_config_integrity(
        &reserve.config,
        &market,
        ctx.accounts.reserve.key(),
    )?;
}
```

So:

- The "Prv value: …" / "New value: …" logs are emitted by `update_reserve_config` *before* the require fires — that's why you see the writeback succeed in the logs but still get a rejection.
- The `Reserve is used: false, is usage blocked: false, proposer authority locked: false` log is informational; it does NOT reflect whether the curve update is permitted. A reserve can show `is_used: false` but `is_predeposit: false` simultaneously (deposits below the "in-use" threshold but above `min_initial_deposit_amount`).
- Sending `skipValidation = true` against a reserve with even modest deposits guarantees rejection regardless of the mode — even mode 16 (`set-name`) writing the existing name back will fail.

### Empirical confirmation (2026-05-06)

Against the live cSOL reserve (`7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg`, currently the EG-2 debt reserve):

| Test | `skipValidation` | Result |
|---|---|---|
| mode 16 set-name `cSOL` → `cSOL` (no-op) | `true` | ❌ InvalidConfig 6004 |
| mode 16 set-name `cSOL` → `cSOL` (no-op) | `false` | ✅ success |
| mode 23 curve change (point 0 rate 1 → 175) | `true` | ❌ InvalidConfig 6004 |
| mode 23 curve change (point 0 rate 1 → 175) | `false` | ✅ success |

The integrity validator on the false path is the path you want.

---

## How to update an IRM today

Two routes, both wired up.

### A. Console UI — interactive (recommended)

`packages/frontend-console` ships a **Rate Curves** tab (`pnpm dev:console` →
sidebar). The panel lets you:

1. Pick a reserve (cSOL, csSOL, csSOL-WT, ceUSX, ceUSX-WT, sUSDC, retired wSOL,
   or paste any address).
2. View the on-chain 11-point curve as a table + chart.
3. Click **Edit** to open a draft. Two presets ship out of the box:
   - `production SOL` — convex 11-point, 10% APR at 90% util kink, 45% cap.
   - `stable` — gentler ramp suitable for sUSDC.
4. Tweak any util/rate value cell-by-cell. Validation is applied client-side
   on every keystroke (must satisfy the same invariants klend enforces — see
   below); a violation shows in red and disables the apply button.
5. Click **Simulate + apply** — the panel builds an
   `update_reserve_config(mode = 23, skipValidation = false)` ix, simulates
   first, surfaces any klend rejection, then asks the wallet to sign on success.

The page subtitle, comment block, and ix construction in
[`RateCurvePanel.tsx`](../../packages/frontend-console/src/pages/RateCurvePanel.tsx)
all encode the corrected semantics.

### B. Script — one-shot CLI

[`packages/programs/scripts/update-reserve-config.ts`](../../packages/programs/scripts/update-reserve-config.ts)
is a maintainable wrapper for *any* `update_reserve_config` mode (curve, limits,
EGs, name, oracle, LTV, liq threshold, status, borrow factor, …). It always
simulates first; broadcast only with `--send`.

```bash
cd packages/programs

# Apply the production SOL preset to cSOL (simulate)
npx tsx scripts/update-reserve-config.ts \
  7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg \
  set-curve production-sol-debt

# Same call, broadcast
npx tsx scripts/update-reserve-config.ts \
  7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg \
  set-curve production-sol-debt \
  --send

# Custom curve from a JSON file (must already satisfy klend invariants)
npx tsx scripts/update-reserve-config.ts \
  <reserve> set-curve ./my-curve.json --send

# Other modes the script exposes (see the file header for the full list):
npx tsx scripts/update-reserve-config.ts <reserve> set-deposit-limit 1000000000 --send
npx tsx scripts/update-reserve-config.ts <reserve> set-status 0 --send                 # 0=Active 1=Obsolete 2=Hidden
npx tsx scripts/update-reserve-config.ts <reserve> set-elevation-groups "1,2,3" --send
```

Default `skipValidation = false`. Set true only if you're targeting a fresh
reserve that hasn't accepted deposits yet.

### C. Reserve-replacement (fallback)

The older `replace-reserve-irm.ts` flow (init a fresh reserve with the desired
curve, deprecate the old one) is still in the repo but **no longer required**
for normal curve maintenance. Keep it for cases where you need to rebuild the
reserve from scratch (e.g. you want a different reserve account size, or the
existing reserve is stuck in a state the integrity validator rejects).

---

## klend's curve invariants

`validate_reserve_config_integrity` enforces the following on the
`borrow_rate_curve` field (verified empirically — these are the rules the
console's `validateCurve` function mirrors):

1. **Exactly 11 points**.
2. **First point**: `utilization_rate_bps = 0`.
3. **Last point**: `utilization_rate_bps = 10000` (100%).
4. **Util non-decreasing**: each point's util ≥ the previous. Duplicate utils
   are tolerated but klend treats consecutive identical points as a single
   step (the chart panel collapses them when displaying).
5. **Rate non-decreasing**: each point's rate ≥ the previous.
6. **Convex**: per-segment slope (`Δrate / Δutil`) is monotonically
   non-decreasing across consecutive distinct-util points. A "kink up" is fine
   (slopes 1, 2, 5, 10 …); a "kink down" (slopes 5, 2 …) gets rejected.

The earlier note that "first point must be (0, 0)" was wrong — non-zero base
rates are accepted. For example, the production cSOL curve uses
`(0%, 0.01%)` as point 0 to keep utility computations from short-circuiting at
the origin.

Other invariants the integrity validator enforces (relevant when editing
modes other than 23):

- `ltv_pct ≤ liquidation_threshold_pct ≤ 100`
- `borrow_factor_pct ≥ 100`
- `liquidation_bonus_min ≤ liquidation_bonus_max`
- `elevation_groups[]` entries must each correspond to an EG that exists on
  the lending market (otherwise the validator throws InvalidConfig).
- `protocol_take_rate`, `origination_fee`, `flash_loan_fee`, and
  `host_fixed_interest_rate` modes (4, 5, 6, 47) are restricted to klend's
  global admin and not exposed by the script.

---

## Active reserves on the v3 market

**Market:** `EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E`
(see [`packages/programs/configs/devnet/cssol-market-v3.json`](../../packages/programs/configs/devnet/cssol-market-v3.json) for the canonical record)

| Reserve | Address | EG role | Curve cap |
|---|---|---|---|
| `cSOL` | `7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg` | EG-2 debt (post-2026-05-06 migration) | 45% (production-sol-debt preset) |
| `csSOL` | `eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w` | EG-2 collateral | — (deposit-only) |
| `csSOL-WT` | `94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw` | EG-2 collateral, with-throughput | — |
| `ceUSX` | `88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU` | EG-1 collateral | — |
| `ceUSX-WT` | `GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq` | EG-1 collateral, with-throughput | — |
| `sUSDC` | `78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9` | EG-1 / EG-3 debt | 50% (stable preset) |
| `wSOL` (retired) | `CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8` | none — neutered 2026-05-06 (`status=Hidden`, limits=0) | unchanged from init |

EG-3 / EG-4 (margin pairs) are design-locked but not yet deployed — see
`docs/operations/MARGIN_PAIR.md`.

---

## Governor `set_borrow_rate_curve` instruction

The governor program ships a `set_borrow_rate_curve` ix that validates a curve
and CPIs into klend's `update_reserve_config`. Until this session's discovery,
that instruction was effectively shelved because we believed klend rejected
all runtime updates. **It now works** as long as it forwards
`skip_config_integrity_validation = false` to klend.

If you re-enable that path, double-check the value flows through unchanged in
`programs/governor/src/handlers/set_borrow_rate_curve.rs`. The ix:

- Validates curve monotonicity, convexity, bounds, and 11-point structure.
- CPIs into klend `update_reserve_config` with mode 23.
- Supports authority + admin delegation.
- Emits `BorrowRateCurveUpdated`.

The console UI calls klend directly today (no governor CPI) so we can iterate
without redeploying the governor program. If we eventually want the governor's
event-emission + delegation chain to drive curve updates, just re-enable that
ix and have the console call it instead of the raw klend ix.

---

## Troubleshooting cheat sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| `InvalidConfig (6004)` at handler line 49, log shows `Reserve is used: false` | Sent `skipValidation = true` against a reserve that has any deposits | Resend with `skipValidation = false` |
| `InvalidConfig` with log mentioning `borrow_rate_curve` slopes / monotonicity | Curve violates the 11-point / non-decreasing / convex rules | Fix the curve client-side; the console's `validateCurve` reproduces klend's checks |
| `InvalidConfig` after editing `elevation_groups[]` | An EG id you listed doesn't exist on the lending market yet | Add the EG to the market first (see `migrate-eg2-debt-to-csol.ts` for the reference flow) |
| `ConstraintHasOne` (Anchor 2003) | `reserve.lending_market` doesn't match the lending-market account you passed | Re-derive the market from `usePrograms()` / `cssol-market-v3.json` rather than hard-coding |
| Wallet rejects with "unauthorized signer" | Connected wallet isn't the lending-market owner | Use the keypair at `~/.config/solana/id.json` (the deploy authority) |

---

## Memory snapshot

This finding is recorded in
[`memory/project_klend_inuse_curve_lock.md`](../../../.claude/projects/-home-axtar-1-clearstone-finance/memory/project_klend_inuse_curve_lock.md)
(name kept for backward compatibility; the content reflects the corrected
understanding). Future sessions will load that memory automatically and avoid
re-deriving the inverted-flag mistake.
