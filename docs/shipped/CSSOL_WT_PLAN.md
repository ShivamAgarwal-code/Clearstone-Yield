# csSOL-WT — Tokenized Unstake Receipt Plan

Institutional unwind path that lets leveraged csSOL positions exit during the Jito vault's epoch-locked withdrawal window without sourcing external SOL liquidity to repay borrows. csSOL-WT is a Token-2022 KYC-gated receipt minted 1:1 against csSOL queued for unstaking; it lives as a klend reserve in the same eMode 2 group as csSOL (90% LTV, 92% liquidation threshold) so an obligation can collateral-swap csSOL ↔ csSOL-WT atomically.

For the design rationale + adversarial-unwind deterrent, see the architecture memo in [`/home/axtar-1/.claude/projects/-home-axtar-1-clearstone-finance/memory/project_cssol_wt_unstake_receipt.md`](file:///home/axtar-1/.claude/projects/-home-axtar-1-clearstone-finance/memory/project_cssol_wt_unstake_receipt.md). This document is the implementation status + deployment runbook.

---

## Quick state

| Phase | Status |
|---|---|
| 1. On-chain governor program | ✅ deployed sig `4cAsnFbafSm…` (and earlier sigs as we iterated) |
| 2. Reserve config json | ✅ landed |
| 3. Setup scripts (mint / queue / pending-wSOL) | ✅ landed + run on devnet |
| 4. csSOL-WT oracle setup script | ✅ landed; repo currently falls back to csSOL oracle because `configs/devnet/cssol-wt-oracle.json` is absent |
| 5. Klend reserve registration script | ✅ implemented + produced `configs/devnet/cssol-wt-deployed.json`; address/market split needs cleanup |
| 6. Bootstrap seed script | ⚠️ still stub — reserve can exist, but seeded flash-liquidity is not automated |
| 7. Frontend playground unwind tab | ✅ landed with countdown timer + "yours" badge + leveraged flash-loan card |
| 8. Keeper-cloud cron — vault state-tracker cranker | ✅ deployed, deletes the manual-crank step |
| 9. SBF build + deploy | ✅ done |
| 10. Enqueue end-to-end on devnet | ✅ verified — 2 live tickets in queue |
| 11. Mature + redeem end-to-end | ⏳ awaiting epoch unlock (~2 days from `slot_unstaked`) |
| 12. Klend csSOL-WT reserve + leveraged-unwind UX | ⚠️ implemented in repo, but needs live verification and config reconciliation before treating as production-ready |

The v0 enqueue path is **fully functional**. The leveraged-position unwind via flash-loan collateral swap is now present in the repo (`OneStepUnwindTab.tsx`), but should be treated as **integration-stage** until the reserve address/market split is resolved, the WT reserve has confirmed flash-borrowable liquidity, and the full flashBorrow → deposit WT → withdraw csSOL → enqueue → flashRepay transaction is verified end-to-end.

---

## Architecture (resolved through devnet iteration)

The original sketch had `pool_pda` as Jito staker; that broke because `pool_pda` is an Anchor-managed account with data, and Jito's `EnqueueWithdrawal` uses `staker` as the rent funder for the new ticket PDA — `system_program::transfer` rejects `from` accounts that carry data. The resolved split-signer pattern:

| Jito role | Our account | Why |
|---|---|---|
| `staker` (W, signer) | **user wallet** | Funds the ticket PDA's rent (system-owned, no data) AND owns the source VRT ATA |
| `base` (RO, signer) | **governor-derived `wt_base` PDA** at seeds `[b"wt_base", pool_pda, withdraw_queue.total_cssol_wt_minted_le]` | Lets one user have multiple in-flight tickets without an extra wallet-visible signer; the governor signs it with `invoke_signed` |
| `burn_signer` (RO, signer) | **pool PDA** | Matches `vault.mint_burn_admin` (set at vault init) — the gated permission to burn VRT through the vault |

Inside `governor::enqueue_withdraw_via_pool`:

```
1. Token-2022 burn X csSOL from user (user signs)
2. SPL Token transfer X VRT: POOL_VRT_ATA → user_vrt_ata (pool PDA signs as authority)
3. Jito EnqueueWithdrawal CPI:
   - staker = user (signed via outer ix)
   - base = governor `wt_base` PDA (signed via invoke_signed)
   - burn_signer = pool PDA (signed via invoke_signed)
   - stakerVrtTokenAccount = user_vrt_ata
   - vault_staker_withdrawal_ticket = derived [seed, vault, base.pubkey]
   - vault_staker_withdrawal_ticket_token_account = canonical ATA(VRT, ticket_pda, off-curve)
4. delta-mint mint_to X csSOL-WT to user (pool PDA signs)
5. Append { ticket_pda, staker=user, amount, slot, redeemed=false } to WithdrawQueue
```

**Critical pre-conditions for the ix to succeed (all handled by frontend):**

- The user's csSOL-WT ATA must exist (idempotent ATA create).
- The user's VRT ATA must exist (idempotent ATA create).
- The ticket's VRT ATA at `getATA(VRT_MINT, ticket_pda, allowOwnerOffCurve=true)` must be **pre-created** as an SPL Token account. Jito's handler does `spl_token::transfer_checked` into it but doesn't allocate it — so we must allocate + initialize via the canonical ATA program before invoking.
- The Jito vault's per-epoch state tracker must be cranked (Initialize+Close `VaultUpdateStateTracker`). Otherwise EnqueueWithdrawal/BurnWithdrawalTicket reject with error 1020 ("Vault update is needed"). The keeper-cloud Worker does this automatically every cron fire (idempotent — skips if already cranked for the current epoch). Manual fallback: `scripts/crank-vault-update.ts`.

**Maturation (`mature_withdrawal_tickets`)** is **NOT permissionless**. The original sketch had pool_pda as Jito's `staker`, which would have allowed any cranker. With user as staker, Jito enforces `ticket.staker == provided_staker_account` — only the original creator can mature their own ticket. The governor program also stores `staker` in `WithdrawTicket` and verifies it against `ctx.accounts.user.key()` at the start of `mature_withdrawal_tickets`.

After Jito's `BurnWithdrawalTicket` returns wSOL to the user's wSOL ATA, the same governor ix then `transfer_checked`s the wSOL into `pool_pending_wsol_account` (the protocol's pooled redemption pool) — user signs the sweep via the outer ix's signature. Net effect: the wSOL transits the user's wallet for one CPI but ends up in the pool; user later calls `redeem_cssol_wt(amount)` to pull from the pool.

**Redemption (`redeem_cssol_wt`)** is permissionless across the pool. Any csSOL-WT holder burns N WT to receive N wSOL from `pool_pending_wsol_account`. The pool is fungible — your matured ticket's wSOL can be redeemed by another user before yours, and you'd then need to wait for someone else's ticket to mature. This is the intended pool-side liquidity model.

**Stranded ticket recovery.** If a ticket gets created on-chain but doesn't make it into our queue (layout migrations, partial-success orphans), the pool authority can call `import_orphan_ticket(staker, amount)` with the orphan's PDA. The ix validates ticket ownership (Jito Vault) + vault binding + staker match against the on-chain ticket bytes, then records the entry in the queue.

**Layout migrations.** `close_withdraw_queue` (UncheckedAccount-based, doesn't deserialize) drains rent → authority and reassigns to system program; re-run `init_withdraw_queue` afterwards. Used during the `staker` field addition + queue-cap bumps.

---

## Capacity

`MAX_WITHDRAW_QUEUE_TICKETS = 120` per pool (from 32 originally). Bounded by Solana's `MAX_PERMITTED_DATA_INCREASE = 10240` byte cap on Anchor's init flow. Total account size at 120: 9789 bytes. To go higher we'd need a chunked `grow_withdraw_queue` ix that reallocs in 10240-byte increments — deferred as v2.

| Constraint | Value |
|---|---|
| Per-ticket size | 81 bytes (Pubkey + Pubkey + u64 + u64 + bool) |
| Queue overhead | 69 bytes (8 disc + 32 pool + 8 + 8 + 8 + 4 vec_len + 1 bump) |
| Max tickets | 120 |
| Account size at max | 9789 bytes |
| Rent at max | ~0.068 SOL (one-time) |

---

## What's implemented

### On-chain — `packages/programs/programs/governor/src/lib.rs`

Six new ixes, one new account, three new errors, three new events:

| Ix | What it does |
|---|---|
| `init_withdraw_queue` | One-shot per pool. Creates `WithdrawQueue` PDA at seeds `[b"withdraw_queue", pool_pda]`; pool authority pays. |
| `close_withdraw_queue` | Pool-authority-only. UncheckedAccount-based (bypasses Anchor deserialization) so it works across layout migrations — drains rent → authority, zeroes data, reassigns to system program. |
| `enqueue_withdraw_via_pool(amount)` | User-facing. Burns `amount` csSOL via Token-2022 `burn` (user signs), transfers VRT pool→user_vrt_ata transiently (pool PDA signs), CPIs Jito `EnqueueWithdrawal` with split-signer pattern (user as staker, governor `wt_base` PDA as base, pool PDA as burn_signer), CPIs `delta_mint::mint_to` to deliver csSOL-WT, appends `{ticket, staker=user, amount, slot, redeemed=false}` to the queue. No client-side ephemeral signer is required in the current implementation. |
| `mature_withdrawal_tickets` | **NOT permissionless** — must be called by the original ticket's staker (verified against the queue entry AND Jito's own `ticket.staker == provided_staker` check). CPIs Jito `BurnWithdrawalTicket` (pool PDA signs as burn_signer), then sweeps the matured wSOL from user's wSOL ATA → pool's `pool_pending_wsol_account` (user signs the sweep). Marks the queue entry `redeemed = true` and head-compacts. |
| `redeem_cssol_wt(amount)` | Permissionless. Burns user's csSOL-WT via Token-2022 `burn`, transfers `amount` wSOL from the pending pool to the user's wSOL ATA (pool PDA signs the transfer). |
| `import_orphan_ticket(staker, amount)` | Pool-authority-only recovery path. Reads an on-chain Jito ticket's bytes directly (UncheckedAccount), validates owner+vault+staker, and adds a queue entry. Used to re-register tickets stranded across program upgrades or partial-success orphans. |

**State:**

```rust
pub struct WithdrawQueue {
    pub pool_config: Pubkey,
    pub pending_wsol: u64,                // matured-but-unredeemed
    pub total_cssol_wt_minted: u64,
    pub total_cssol_wt_redeemed: u64,
    pub tickets: Vec<WithdrawTicket>,     // bounded at MAX_WITHDRAW_QUEUE_TICKETS = 120
    pub bump: u8,
}

pub struct WithdrawTicket {
    pub ticket_pda: Pubkey,
    pub staker: Pubkey,                   // = ticket creator; required for mature gating
    pub cssol_wt_amount: u64,
    pub created_at_slot: u64,
    pub redeemed: bool,
}
```

**Errors:** `WithdrawQueueFull`, `TicketNotFound`, `RedeemExceedsPending`, `Unauthorized` (reused).
**Events:** `EnqueueWithdrawEvent`, `MatureTicketEvent`, `RedeemCsSolWtEvent`.
**Jito disc constants:** `JITO_VAULT_ENQUEUE_WITHDRAWAL_DISC = 12`, `JITO_VAULT_BURN_WITHDRAWAL_TICKET_DISC = 14`.

### Reserve config

[`packages/programs/configs/delta_csSOL_WT_reserve.json`](packages/programs/configs/delta_csSOL_WT_reserve.json) — mirror of `delta_csSOL_reserve.json` with two changes:

- `borrowLimit: "1000000000000"` (>0; required for klend's flash-loan path)
- `flashLoanFee: "0"` (verified zero on csSOL + wSOL reserves on-chain)

### Setup / Deployment Scripts

| Script | What it does |
|---|---|
| [`scripts/setup-cssol-wt-mint.ts`](packages/programs/scripts/setup-cssol-wt-mint.ts) | Creates Token-2022 csSOL-WT mint, initializes second delta-mint MintConfig, whitelists deployer, transfers MintConfig authority to pool PDA. Idempotent. |
| [`scripts/init-withdraw-queue.ts`](packages/programs/scripts/init-withdraw-queue.ts) | Calls `governor::init_withdraw_queue`. |
| [`scripts/init-cssol-wt-oracle.ts`](packages/programs/scripts/init-cssol-wt-oracle.ts) | Allocates separate accrual-oracle output for csSOL-WT pricing; binds to same Jito vault as csSOL via `set_vault`. v1 pricing = identical to csSOL; min-of-backing-per-share floor is a v2 oracle upgrade. **Repo note:** `configs/devnet/cssol-wt-oracle.json` is currently absent, so `setup-cssol-wt-reserve.ts` falls back to the csSOL accrual output. |
| [`scripts/init-pool-pending-wsol.ts`](packages/programs/scripts/init-pool-pending-wsol.ts) | Creates pool's `pending_wsol` *non-ATA* token account (fresh keypair-derived to avoid colliding with legacy pool wSOL ATA). Owner = pool PDA, mint = NATIVE_MINT. |
| [`scripts/crank-vault-update.ts`](packages/programs/scripts/crank-vault-update.ts) | Manual fallback — Initializes + Closes the per-epoch `VaultUpdateStateTracker` so EnqueueWithdrawal/BurnWithdrawalTicket aren't gated. The keeper-cloud Worker now does this automatically every cron fire; this script is the manual escape hatch. |
| [`scripts/setup-cssol-wt-reserve.ts`](packages/programs/scripts/setup-cssol-wt-reserve.ts) | Implemented reserve registration flow: initializes csSOL-WT reserve, applies reserve config, re-registers eMode 2, and writes `configs/devnet/cssol-wt-deployed.json`. |
| [`scripts/extend-lut-cssol-wt.ts`](packages/programs/scripts/extend-lut-cssol-wt.ts) | Idempotently extends the deposit LUT with static csSOL-WT accounts needed by the leveraged-unwind v0 transaction. |
| [`scripts/bootstrap-cssol-wt-seed.ts`](packages/programs/scripts/bootstrap-cssol-wt-seed.ts) | Still a stub. This is the missing automated step for treasury-minting/depositing csSOL-WT seed liquidity into the WT reserve. |

### Frontend playground

| File | What |
|---|---|
| [`packages/frontend-playground/src/lib/cssolWt.ts`](packages/frontend-playground/src/lib/cssolWt.ts) | Raw web3.js ix builders for all 3 user-facing governor ixes + `decodeWithdrawQueue` (decodes the full ticket list with `staker` field) + Jito Config / ticket-account decoders for the countdown + helper PDA derivations, including `withdrawBasePda`. |
| [`packages/frontend-playground/src/tabs/OneStepUnwindTab.tsx`](packages/frontend-playground/src/tabs/OneStepUnwindTab.tsx) | Three-stage UX (Enqueue / Mature / Redeem) with: per-ticket countdown timer (extrapolated from Jito Config's `epoch_length`), "yours" badge based on `staker` field, Mature button gated by both `unlocked` AND `isMine`. Current implementation also includes a leveraged-unwind card that builds flashBorrow → deposit WT collateral → withdraw csSOL collateral → enqueue → flashRepay in one v0 transaction. |
| `addresses.ts` + `vite-env.d.ts` + `App.tsx` | New env vars, new tab in `TABS[]`. |

### Keeper-cloud

[`packages/keeper-cloud/src/index.ts`](packages/keeper-cloud/src/index.ts) — extended `runOnce` with a `crankVaultUpdate` pass that fires after the oracle refresh. Initializes + Closes the per-epoch `VaultUpdateStateTracker` for the csSOL Jito vault. Idempotent — checks if the tracker for the current epoch already exists and skips. Gated behind `JITO_VAULT_PROGRAM` + `JITO_VAULT_CONFIG` + `CSSOL_VAULT` env vars; leaving any unset disables the cranking pass.

The previous design ("permissionless mature pass that cranks every live ticket") was removed when maturation became user-initiated (see Architecture section above for the staker-as-user signer chain that forced this).

---

## Live devnet state

| Component | Address |
|---|---|
| Governor program | `6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi` |
| csSOL-WT mint (Token-2022) | `8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva` |
| csSOL-WT MintConfig | `BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4` (authority = pool PDA) |
| csSOL-WT MintAuthority PDA | `FxoXoyK9nMYWXWjrZYLb88jCoYdTPbZBgAA2UQCRTAKe` |
| WithdrawQueue PDA | `EgWUrxvEmZj16BhhC2TGty4V1z76PcTcSPgZgCtGrs9J` (120-slot, 2 imported orphan tickets at last refresh) |
| Pool pending-wSOL account (non-ATA) | `5CMXpXEfy8BTe4DzT9xhc36HXYGNf3wDrr5wV5aoJis1` |
| Legacy csSOL-WT reserve output | `EMEYkeJo7NjNhbXHXLJaEgvP7qq6ipPVu5VuTiCBVE5w` in market `2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW` (`configs/devnet/cssol-wt-deployed.json`, `.env.local`) |
| v2 unified-market csSOL-WT reserve | `FHDGQyNFHurXKPHPBBC1b3orGSuJqkdpgz9vwr9pHfQU` in market `En6zW3ne2rf7jWZt7tCs98ixUvEqLM4siAuuigtTiDSi` (`configs/devnet/cssol-market-v2.json`, `addresses.ts` fallback) |
| Deposit LUT | `BYhbgSt3QKJp8mduKnjsHiy4EubxRYsU2xxZzpojEF7y` |
| Keeper Worker | `https://clearstone-keeper-sol-oracle.achim-d87.workers.dev` (fires every 5 min: oracle refresh + vault-update crank) |

**Important config note:** the repo currently has a market/reserve split. `addresses.ts` defaults to the v2 unified market and WT reserve, while `.env.local` overrides `VITE_CSSOL_WT_RESERVE` to the legacy WT reserve. `OneStepUnwindTab.tsx` also still hardcodes the legacy market for obligation PDA derivation. Reconcile this before relying on leveraged unwind.

**Verified end-to-end flows:**
- Enqueue: csSOL burn → VRT pool→user transit → Jito EnqueueWithdrawal → ticket created → csSOL-WT minted → queue entry persisted with staker
- Per-ticket countdown timer in UI extrapolated from Jito Config `epoch_length`
- "yours" badge correctly identifies the ticket creator from the queue's `staker` field

**Pending end-to-end flows (awaiting epoch unlock):**
- Mature: needs the current ticket's epoch lock (~2-4 days) to expire, then user clicks Mature in the UI
- Redeem: depends on a successful Mature
- Leveraged unwind: UI and instruction builder exist, but needs a live transaction against the intended market/reserve, plus confirmed flash-borrowable WT liquidity.

---

## Remaining work (v1 backlog)

### Klend csSOL-WT reserve + leveraged-unwind UX

This is no longer pure backlog. The repo contains the reserve setup script, LUT extension script, and leveraged-unwind UI. Remaining work is integration hardening:

**1. Reconcile market/reserve config.** Pick the intended target for playground/devnet:
- Legacy market `2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW` + WT reserve `EMEYkeJo7NjNhbXHXLJaEgvP7qq6ipPVu5VuTiCBVE5w`, currently in `configs/devnet/cssol-wt-deployed.json` and `.env.local`.
- v2 unified market `En6zW3ne2rf7jWZt7tCs98ixUvEqLM4siAuuigtTiDSi` + WT reserve `FHDGQyNFHurXKPHPBBC1b3orGSuJqkdpgz9vwr9pHfQU`, currently in `configs/devnet/cssol-market-v2.json` and `addresses.ts` fallback.

`OneStepUnwindTab.tsx` currently hardcodes the legacy market in the obligation PDA derivation, so moving to v2 requires plumbing `KLEND_MARKET` through that path.

**2. [`scripts/bootstrap-cssol-wt-seed.ts`](packages/programs/scripts/bootstrap-cssol-wt-seed.ts)** remains a stub. Implement treasury mint + reserve deposit so `flashBorrow(cssol_wt_reserve, X)` has actual available liquidity. The script header already sketches the intended steps.

**3. Confirm LUT contents.** `scripts/extend-lut-cssol-wt.ts` exists and adds the static WT reserve/mint/config/pending-wSOL accounts. After config reconciliation, re-run it against the chosen market/reserve and verify `DEPOSIT_LUT` resolves all static accounts used by the v0 transaction.

**4. Verify leveraged-unwind live.** The UI currently builds this sequence:

```
ComputeBudget(setComputeUnitLimit + setComputeUnitPrice)
ATA idempotents (user wSOL, user csSOL-WT, user VRT, ticket VRT)
flashBorrow(cssol_wt_reserve, X)                              ← zero fee, verified
refresh_reserve(csSOL) + refresh_reserve(cssol_wt_reserve)
refresh_obligation([csSOL])
deposit_obligation_collateral(cssol_wt_reserve, X)
withdraw_obligation_collateral(csSOL, X)
governor::enqueue_withdraw_via_pool(X)                        ← burns X csSOL, mints X csSOL-WT to user
flashRepay(cssol_wt_reserve, X, borrow_ix_idx=N)
```

### Risks still to verify

- **`flashRepay.borrowInstructionIndex` introspection across CPI boundaries.** klend uses sysvar-instructions to look up the matching borrow ix at a specified outer-position index. The governor + delta-mint CPIs sitting between `flashBorrow` and `flashRepay` should not shift the index (CPIs don't append to the outer ix list), but worth a thin POC tx before committing the full UX.
- **Reserve liquidity.** Until the seed script is implemented or the WT reserve is otherwise funded, the leveraged unwind may assemble but fail at flash borrow.
- **Market mismatch.** Old-market obligation derivation + v2 reserve addresses will produce invalid-account failures.

### Smaller v2 enhancements (not gating anything)

- **Better csSOL-WT oracle.** Currently mirrors csSOL price via `refresh_with_vault`. Full design has `min(csSOL_price × (1 − epoch_discount), pool.pending_wsol / cssol_wt_supply)` so adversarial unwinds get re-priced if the pool drains. Requires an `accrual_oracle` upgrade with a new variant ix that reads `WithdrawQueue`. ~150 LOC + redeploy.
- **Chunked queue grow.** Add a `grow_withdraw_queue` ix that reallocs the queue PDA in 10240-byte increments, lifting the 120-slot cap to arbitrary size. Useful only if the institutional pool grows past ~120 simultaneous in-flight tickets.
- **Programmatic vault-tracker cranking inside `enqueue` / `mature_withdrawal_tickets`.** Currently the keeper-cloud cron handles this every 5 min. Folding it into the user-facing ixes would remove the keeper dependency at the cost of higher per-tx CU. Not worth it while the keeper is reliable.

---

## Architecture in one paragraph

User has X csSOL — either free in their wallet or deposited as klend collateral. They want to exit. They call `governor::enqueue_withdraw_via_pool(X)`, which: (a) Token-2022-burns X csSOL from the user; (b) transfers X VRT pool→user_vrt_ata transiently (pool PDA signs); (c) CPIs Jito `EnqueueWithdrawal` with the user as staker (signed by the outer wallet signature), a governor-derived `wt_base` PDA as base (signed via `invoke_signed`), and pool PDA as burn_signer (also signed via `invoke_signed`) — Jito creates a fresh `VaultStakerWithdrawalTicket` whose VRT custody account was pre-allocated as a canonical ATA before the call; (d) CPIs `delta_mint::mint_to` to deliver X csSOL-WT (Token-2022, KYC-gated) to the user; (e) records `{ticket_pda, staker=user, X, slot, redeemed=false}` in the pool's `WithdrawQueue` PDA. After Jito's vault epoch unlock window (`epoch_length × 2` ≈ 2-4 days on the standard config), the same user calls `governor::mature_withdrawal_tickets` — only they can, because Jito enforces `ticket.staker == provided_staker_account` and we cross-check against the queue's stored staker. That ix CPIs Jito `BurnWithdrawalTicket` (pool PDA signs as burn_signer), wSOL flows briefly through the user's wSOL ATA, then the same governor ix sweeps it into `pool_pending_wsol_account`. The user (or any csSOL-WT holder) then calls `governor::redeem_cssol_wt(X)` whenever they want — burns X WT and pays out X wSOL from the pool's pending pool. For leveraged positions (csSOL serving as klend collateral against a wSOL borrow), the playground now attempts to wrap the same `enqueue_withdraw_via_pool` call inside a klend flash-loan against the csSOL-WT reserve: `flashBorrow(WT) → deposit_collateral(WT) → withdraw_collateral(csSOL) → enqueue → flashRepay(WT)` — same single signature, csSOL collateral atomically swapped for csSOL-WT collateral, LTV preserved throughout, no external SOL needed. Treat that leveraged path as integration-stage until market/reserve config and WT seed liquidity are confirmed. The csSOL-WT reserve is intended to be configured identically to csSOL inside eMode 2 (same 90% LTV); the deterrent against adversarial unwind is oracle-side rather than LTV-haircut-based.

---

## Cross-references

- Architecture spec + risk analysis: [`memory/project_cssol_wt_unstake_receipt.md`](file:///home/axtar-1/.claude/projects/-home-axtar-1-clearstone-finance/memory/project_cssol_wt_unstake_receipt.md)
- Forward-flow runbook: [`JITO_INTEGRATION_PLAN.md`](JITO_INTEGRATION_PLAN.md)
- Klend market config docs: [`packages/programs/KLEND_MARKET_CONFIG.md`](../../packages/programs/KLEND_MARKET_CONFIG.md)
- Oracle config docs: [`packages/programs/ORACLE_CONFIG.md`](../../packages/programs/ORACLE_CONFIG.md)
- Existing 1-sig deposit UX: [`packages/frontend-playground/src/tabs/OneStepDepositTab.tsx`](../../packages/frontend-playground/src/tabs/OneStepDepositTab.tsx)
