# `instructions::jito` — Jito-vault wrap + csSOL-WT lifecycle

The most consequential domain in the program. Two flows live here:

- **Wrap path** (`wrap_with_jito_vault`): user wSOL → Jito Vault stake
  → pool VRT custody → user csSOL d-token. One ix.
- **Unstake-via-collateral-swap path** (`enqueue_withdraw_via_pool` →
  `mature_withdrawal_tickets` → `redeem_cssol_wt`): three-stage
  redemption that lets a leveraged csSOL position exit the Jito
  epoch lock without sourcing external SOL liquidity. The frontend
  (`OneStepUnwindTab` v2) stitches them inside a single flash-loaned
  klend tx for the convert step plus a separate tx for redeem.

Plus three queue-management helpers: `init_withdraw_queue`,
`close_withdraw_queue`, `import_orphan_ticket`.

## What lives here

| ix | role | called by |
|---|---|---|
| `wrap_with_jito_vault` | wSOL → csSOL via Jito MintTo + delta-mint mint_to | end user |
| `init_withdraw_queue` | One-time create of the pool's `WithdrawQueue` PDA | root authority |
| `close_withdraw_queue` | Close + reclaim rent (used only when migrating layouts) | root authority |
| `import_orphan_ticket` | Adopt a Jito ticket whose pool-side queue entry was lost (e.g. due to a tx failure between the Jito CPI and the queue write) | root authority |
| `enqueue_withdraw_via_pool` | Burn user's csSOL, mint csSOL-WT 1:1, queue a Jito unstake ticket | end user |
| `mature_withdrawal_tickets` | Once Jito's epoch lock has elapsed, burn the ticket and sweep wSOL into `pool_pending_wsol` | ticket originator |
| `redeem_cssol_wt` | Burn user's csSOL-WT, transfer wSOL out of `pool_pending_wsol` (PDA-signed) | end user |

## How the safety story works

### 1. The pool PDA is the Jito vault's `mintBurnAdmin`

At deploy time, `setup-cssol-jito-vault.ts` calls Jito's
`SetSecondaryAdmin` to set the pool PDA as the vault's MintBurnAdmin.
That's the slot Jito requires to be a signer on every `MintTo` /
`BurnWithdrawalTicket` ix.

In `wrap_with_jito_vault`, we therefore `invoke_signed` the Jito
`MintTo` with the pool PDA seeds; without those seeds the pool PDA
cannot sign, and without that signature Jito rejects. Same for
`mature_withdrawal_tickets`'s `BurnWithdrawalTicket`.

The pool PDA is a derived account; nobody holds its private key. The
only way it signs anything is via this program's
`invoke_signed` calls, which always reconstruct the seeds from
on-chain state.

### 2. Per-enqueue base PDA — replay safety + UX

`enqueue_withdraw_via_pool` requires a unique `base` account for each
Jito ticket (Jito derives the ticket PDA from `base`). Earlier
versions used an ephemeral keypair the user generated off-chain,
which caused wallet "suspicious tx" warnings. We replaced it with a
*deterministic* PDA derived from the queue's running mint counter:

```
seeds = [b"wt_base", pool_config, withdraw_queue.total_cssol_wt_minted_le]
```

Properties:
- **Unique per enqueue** — the counter only ever increases.
- **Replay-safe** — re-using a `base` would mean Jito's ticket PDA
  re-init fails (the ticket already exists for that base).
- **No off-chain keypair** — fewer signatures, no key management.
- **Derivable on-chain** — `import_orphan_ticket` uses the same
  derivation to identify a ticket whose queue entry was lost.

### 3. WithdrawQueue accounting

`WithdrawQueue` is a single account per pool, capacity-bounded at
`MAX_WITHDRAW_QUEUE_TICKETS = 120` (= 9789 bytes total, under
Solana's 10240-byte realloc cap). The struct tracks:

- `pending_wsol` — wSOL sitting in `pool_pending_wsol_ata` that has
  matured but not yet been redeemed.
- `total_cssol_wt_minted` / `total_cssol_wt_redeemed` — lifetime
  counters; used as the `base`-PDA nonce and for off-chain analytics.
- `tickets: Vec<WithdrawTicket>` — bounded list of in-flight tickets.

Critical invariants enforced inside the handlers:

- **WT supply ≤ in-flight tickets.** `enqueue` mints WT exactly
  matching the queued ticket; no other path mints WT.
- **Pending wSOL ≥ unredeemed WT supply.** `mature_withdrawal_tickets`
  increments `pending_wsol` only with the actual Jito payout;
  `redeem_cssol_wt` rejects via `RedeemExceedsPending` if the user
  asks for more than is currently matured.
- **Queue cap.** `enqueue` rejects with `WithdrawQueueFull` once the
  vec hits 120 entries; `mature` eagerly drains the head when an
  entry's `redeemed` flag goes true.
- **Per-ticket staker enforcement.** `mature_withdrawal_tickets`
  requires `signer == ticket.staker` (recorded at enqueue time and
  validated against Jito's own `ticket.staker` field by the Jito CPI
  itself, which returns error 1042 on mismatch). So even though the
  ix is *technically* permissionless, only the original ticket owner
  can mature their own ticket — by Jito's design, not just ours.

### 4. CPI signing chain

`wrap_with_jito_vault` does three CPIs in order:

1. **Jito MintTo** with pool PDA as signer — stakes user wSOL,
   mints VRT to the user's VRT ATA. We mint to the user's ATA
   (not the pool's) because Jito requires
   `depositor_vrt_token_account.owner == depositor`.
2. **token transfer_checked** with user as authority — sweeps the
   freshly-minted VRT from user → pool VRT vault. The user signed
   the outer ix, so they're authority; Anchor's
   `transfer_checked` doesn't require a separate authority signature
   beyond the existing tx signature.
3. **delta-mint mint_to** with pool PDA as authority + co_authority
   — mints csSOL to the user's csSOL ATA. delta-mint validates the
   `whitelist_entry` PDA exists for this user.

If any leg fails, the whole tx reverts. There is no partial
state where the user has VRT custody but no csSOL or vice versa.

`enqueue_withdraw_via_pool` follows the same pattern: burn csSOL
(user signs) → transfer VRT pool→user (pool PDA signs) → Jito
EnqueueWithdrawal (user as `staker`, pool PDA as `mint_burn_admin`)
→ delta-mint mint_to(csSOL-WT) (pool PDA signs).

`redeem_cssol_wt`: burn csSOL-WT (user signs) → transfer wSOL pool→user
(pool PDA signs) → decrement queue's `pending_wsol`. The withdraw
queue is updated *before* the wSOL transfer, so a partial-success
state can't drain the pool.

### 5. Refresh-discipline at the klend boundary

`enqueue_withdraw_via_pool` itself has no klend interaction — that's
all in the frontend orchestrator (`OneStepUnwindTab.leveragedUnwind`).
The flash-loaned tx structure that wraps this ix is documented
exhaustively in [`packages/programs/CSSOL_WITHDRAWAL.md`](../../../../CSSOL_WITHDRAWAL.md) — refresh-reserve N-2,
refresh-obligation N-1, etc. From the program's perspective, this ix
just performs its three CPIs atomically; the surrounding refresh
chain is the caller's responsibility and any klend-level error
surfaces as a clean tx revert.

### 6. Orphan recovery

`import_orphan_ticket` exists for one specific failure mode: a tx
that lands the Jito EnqueueWithdrawal but reverts before the queue
write (impossible with the current single-ix design, but kept for
defence-in-depth). It validates that:

- The supplied ticket account is owned by the Jito Vault program.
- Its `vault` field equals the pool's csSOL Jito vault.
- Its `staker` field equals the supplied `staker` arg.

Then appends a queue entry attributing the ticket to that staker.
Root-only because incorrect adoption would let an attacker
back-credit themselves WT against someone else's ticket.

## Risk surface

- **Pool PDA compromise** is the catastrophic case — losing the seed
  derivation logic (i.e. an upgrade introducing a new seed shape) would
  leave the existing Jito vault stranded with a `mintBurnAdmin` that
  doesn't match anything we can sign. Mitigation: seed shape is a
  hard-coded constant; upgrades touching pool seeds require a
  matching Jito `SetSecondaryAdmin` transition first.
- **Queue starvation** — at 120 tickets, new enqueues block until
  matured tickets drain. With Jito's 2-day epoch on mainnet, a busy
  pool could fill the queue. Mitigation: planned `grow_withdraw_queue`
  ix that reallocates in 10240-byte chunks (deferred to v2).
- **Mature-only-by-staker** — by Jito's check, only the original
  ticket creator can mature. If they lose access to their wallet,
  the ticket is stuck until someone with key access calls
  `mature_withdrawal_tickets` (the wSOL still flows into the pool's
  pending pool, not their wallet, so it's not a permanent loss; just
  a delay).
- **Pending wSOL accounting drift** — `pending_wsol` is updated by
  our handler, but the actual wSOL balance in `pool_pending_wsol_ata`
  is the source of truth at redeem time. If the two ever diverge
  (e.g. someone transfers wSOL into the ATA outside our flow), the
  on-chain accounting trends conservative — we only redeem against
  `pending_wsol`, never against the raw balance. Mitigation: the
  `redeem_cssol_wt` constraint reads `pending_wsol` from the queue
  account, not the ATA balance.
- **csSOL-WT outside the gate** — `enqueue_withdraw_via_pool` is the
  only `mint_to` path for csSOL-WT (the MintConfig.authority is the
  pool PDA, only this ix CPIs delta-mint.mint_to with the right
  signer). So the WT supply invariant is structural, not gentlemen's
  agreement.

## Discriminator stability

All seven ix names in the `#[program]` block at `lib.rs` match the
deployed binary. The accounts structs (`WrapWithJitoVault`,
`EnqueueWithdrawViaPool`, `MatureWithdrawalTicket`, `RedeemCsSolWt`,
plus the three queue helpers) keep their original struct names, so
the IDL hashes are byte-identical.
