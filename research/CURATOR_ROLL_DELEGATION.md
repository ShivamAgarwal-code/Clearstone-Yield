# CURATOR_ROLL_DELEGATION — v2 Protocol Ticket

> Status: **spec locked, Rust-impl in progress.**
> Target repo: [`clearstone-fixed-yield/periphery/clearstone_curator/`](/home/axtar-1/clearstone-fixed-yield/periphery/clearstone_curator/).
> Closes the v2 permissioning gap identified in [KEEPER_PERMISSIONS.md §4C](../docs/operations/KEEPER_PERMISSIONS.md).

## 1. Goal

Make the auto-roll keeper **permissionless**. Today `reallocate_to/from_market`
requires the curator wallet to sign; this ticket adds a parallel code
path where **any** wallet can crank a rebalance **bounded by a
user-signed delegation**.

Bottom line: users sign once at deposit time, any keeper can serve
the roll later, and the protocol enforces the bounds cryptographically.

## 2. Trust model

| Actor | Before | After |
|---|---|---|
| User | Trusts the curator to roll correctly and pick safe markets. | Trusts the curator only to publish a safe `allocations` set. Binds slippage + expiry on-chain. |
| Curator | Signs every rebalance. Custody-sensitive. | Signs `set_allocations`. Never signs rolls. |
| Keeper | Holds curator key. SPOF. | Any wallet. Paid per crank from vault idle. |

## 3. On-chain surface

### 3.1 Account — `RollDelegation`

```rust
#[account]
pub struct RollDelegation {
    pub vault: Pubkey,            //   32
    pub user: Pubkey,             //   32
    pub max_slippage_bps: u16,    //    2  (ceiling: 1000 = 10%)
    pub expires_at_slot: u64,     //    8
    pub allocations_hash: [u8; 32], //  32  blake3(serialized Vec<Allocation>)
    pub created_at_slot: u64,     //    8
    pub bump: u8,                 //    1
}
//    disc (8) + 115 = 123 bytes
```

PDA seeds: `[b"roll_deleg", vault.key, user.key]`. One delegation
per (vault, user). `init_if_needed` on create so re-signing just
overwrites.

### 3.2 Instructions

| Ix | Signer | Purpose |
|---|---|---|
| `create_delegation(max_slippage_bps, ttl_slots)` | **user** | Creates/updates delegation. Hashes current `vault.allocations`. |
| `close_delegation` | **user** | Closes PDA, refunds rent. Revocation. |
| `crank_roll_delegated(from_index, to_index, min_base_out)` | **anyone** | Performs matured → next rebalance under delegation bounds. |

### 3.3 `create_delegation` handler

```rust
pub fn create_delegation(
    ctx: Context<CreateDelegation>,
    max_slippage_bps: u16,
    ttl_slots: u64,
) -> Result<()> {
    require!(max_slippage_bps <= 1_000, RollDelegationError::SlippageTooWide); // 10% max
    require!(ttl_slots >= 216_000,        RollDelegationError::TtlTooShort);    // ~1 day
    require!(ttl_slots <= 21_600_000,     RollDelegationError::TtlTooLong);     // ~100 days

    let clock = Clock::get()?;
    let d = &mut ctx.accounts.delegation;
    d.vault = ctx.accounts.vault.key();
    d.user = ctx.accounts.user.key();
    d.max_slippage_bps = max_slippage_bps;
    d.expires_at_slot = clock.slot.saturating_add(ttl_slots);
    d.allocations_hash = hash_allocations(&ctx.accounts.vault.allocations);
    d.created_at_slot = clock.slot;
    d.bump = ctx.bumps.delegation;

    emit!(DelegationCreated { vault: d.vault, user: d.user, expires_at_slot: d.expires_at_slot });
    Ok(())
}

fn hash_allocations(allocs: &[Allocation]) -> [u8; 32] {
    use anchor_lang::solana_program::hash::hashv;
    let mut parts: Vec<&[u8]> = Vec::with_capacity(allocs.len());
    let serialized: Vec<Vec<u8>> = allocs
        .iter()
        .map(|a| {
            let mut buf = Vec::with_capacity(50);
            buf.extend_from_slice(a.market.as_ref());
            buf.extend_from_slice(&a.weight_bps.to_le_bytes());
            buf.extend_from_slice(&a.cap_base.to_le_bytes());
            // deployed_base is dynamic — exclude from hash.
            buf
        })
        .collect();
    for s in &serialized { parts.push(s); }
    hashv(&parts).0
}
```

Note: `deployed_base` is excluded from the hash — it moves every roll
and would invalidate delegations immediately. Only the curator-set
whitelist of markets + weights + caps is bound.

### 3.4 `crank_roll_delegated` handler

```rust
pub fn crank_roll_delegated(
    ctx: Context<CrankRollDelegated>,
    from_index: u16,
    to_index: u16,
    min_base_out: u64,   // keeper's floor; must also respect delegation
) -> Result<()> {
    let clock = Clock::get()?;
    let d = &ctx.accounts.delegation;
    let v = &ctx.accounts.vault;

    // 1. Delegation must be live.
    require!(clock.slot < d.expires_at_slot, RollDelegationError::Expired);

    // 2. Allocations must not have drifted since the user signed.
    let current_hash = hash_allocations(&v.allocations);
    require!(current_hash == d.allocations_hash, RollDelegationError::AllocationsDrifted);

    // 3. Delegation's vault matches.
    require_keys_eq!(d.vault, v.key(), RollDelegationError::VaultMismatch);

    // 4. Matured allocation check.
    let from = v.allocations.get(from_index as usize).ok_or(RollDelegationError::IndexOOR)?;
    let to   = v.allocations.get(to_index   as usize).ok_or(RollDelegationError::IndexOOR)?;
    require_keys_eq!(from.market, ctx.accounts.from_market.key(), RollDelegationError::MarketMismatch);
    require_keys_eq!(to.market,   ctx.accounts.to_market.key(),   RollDelegationError::MarketMismatch);
    // from_market.expiration_ts <= now. MarketTwo header reads fine here.
    require!(
        ctx.accounts.from_market.financials.expiration_ts as i64 <= clock.unix_timestamp,
        RollDelegationError::FromMarketNotMatured
    );

    // 5. Slippage floor.
    //    lower_bound = deployed_base * (10_000 - max_slippage_bps) / 10_000
    //    min_base_out supplied by keeper must be >= lower_bound.
    let lower_bound = from.deployed_base
        .saturating_mul((10_000u64).saturating_sub(d.max_slippage_bps as u64))
        / 10_000;
    require!(min_base_out >= lower_bound, RollDelegationError::SlippageBelowDelegationFloor);

    // 6. Execute: reuses reallocate_from + reallocate_to internals.
    //    Pass min_base_out through as the base_out_expected bound.
    run_reallocate_from(ctx.accounts.as_reallocate_from(), from_index, from.deployed_base, min_base_out)?;
    run_reallocate_to(  ctx.accounts.as_reallocate_to(),   to_index,   min_base_out,      0)?;

    // 7. Optional keeper tip — out of vault idle, bounded by delegation param.
    //    v1: skip. v1.1: add tip_bps to delegation, pay tip_bps of base_out to keeper.

    emit!(DelegatedRollCompleted {
        vault: v.key(), user: d.user, keeper: ctx.accounts.keeper.key(),
        from_market: from.market, to_market: to.market, min_base_out,
    });
    Ok(())
}
```

### 3.5 Accounts layout

`CreateDelegation<'info>`:
- `user: Signer` (writable — payer)
- `vault: Account<CuratorVault>` (readonly)
- `delegation: Account<RollDelegation>` (init_if_needed; PDA [b"roll_deleg", vault, user])
- `system_program`

`CloseDelegation<'info>`:
- `user: Signer` (writable — rent recipient)
- `delegation: Account<RollDelegation>` (close = user, constraint = delegation.user == user.key)

`CrankRollDelegated<'info>`:
- `keeper: Signer` (writable — pays gas; no privilege requirement)
- `delegation: Account<RollDelegation>` (readonly)
- `vault`, `base_mint`, `base_escrow`, + all adapter/market accounts
  from `ReallocateFromMarket` **AND** `ReallocateToMarket` merged
  (the ix runs both internally).
- No `curator` signer in this account struct — that's the whole point.

## 4. Invariants

- **I-D1.** Only the user can create, update, or close their delegation.
  Enforced by `has_one = user` + Signer on create/close.
- **I-D2.** `max_slippage_bps <= 1_000`. Hardcoded ceiling prevents a
  phishing prompt from extracting unbounded value.
- **I-D3.** Delegation expires ≤ ~100 days. Prevents stale delegations
  from overhanging a vault indefinitely; users who want persistent
  auto-roll must periodically re-sign.
- **I-D4.** Allocation drift invalidates the delegation
  (`allocations_hash` check). If curator changes the market whitelist,
  every user must re-sign before their position can be rolled.
- **I-D5.** `from_market` must be past maturity at crank time. Keepers
  can't pre-empt yield by rolling early.
- **I-D6.** `min_base_out` supplied by the keeper must meet or exceed
  the delegation's computed floor. User-bounded slippage.
- **I-D7.** A single `crank_roll_delegated` call is atomic across
  `reallocate_from` + `reallocate_to`. No half-rolled state.

## 5. Threat model

| Attack | Mitigation |
|---|---|
| Keeper rolls early for cheap PT | §I-D5 blocks until maturity. |
| Keeper sandwiches the AMM leg | §I-D6 + `min_base_out` check in the inner reallocate bound `actual >= min`. |
| Curator swaps allocations to a bad market, then keeper crank | §I-D4 — delegation's hash no longer matches; ix reverts. |
| Stale delegation replayed after user's funds rotate out | `delegation.user` must match a position in the vault (handler checks `user_pos.shares > 0` before firing). |
| Curator key compromised → attacker replaces allocations with valid-hash set | Out of scope for this ticket; addressed by `CURATOR_SPLIT_AUTHORITY` follow-up (separate `admin` vs `reallocation_authority`). |
| User creates 10k delegations to DoS the keeper's scan | KV cache at the backend-edge layer; keeper batches. Not a protocol concern. |
| Front-running: keeper A builds tx, keeper B lands first | Expected — first valid tx wins. Keepers race for the tip (v1.1). |

## 6. Migration story

Existing curator-signed `reallocate_to/from_market` stay in place.
Delegations are purely additive: operators can run both models
simultaneously. Users who haven't signed a delegation continue to rely
on the curator keeper; users who have signed one get rolled
permissionlessly by any keeper.

No state migration needed.

## 7. Keeper semantics after v2

Keeper pseudocode:

```
for each vault:
  for each user position:
    delegation = fetch(RollDelegation PDA for (vault, user))
    if delegation is None or delegation.expired or delegation.hash_mismatch:
      skip — user hasn't opted in
    if from_market.matured:
      compute min_base_out ≥ delegation.lower_bound
      submit crank_roll_delegated(from, to, min_base_out, signer = keeper)
```

No curator key needed. Failures per-user are isolated (one user's
hash-drift doesn't break another user's roll).

## 8. Fee / tip model (v1.1)

Not in this ticket. Sketch:
- Extend `RollDelegation` with `tip_bps: u16` (≤ 10 bps).
- `crank_roll_delegated` transfers `tip_bps × base_rolled / 10_000` to
  the keeper's `base_dst` ATA at the end of the ix.
- Keeper economics: MEV-tolerant cranking with a small rebate.

## 9. Implementation plan

| Pass | Scope | LOC | Days |
|---|---|---|---|
| **A (this)** | Account + seeds + `create_delegation`, `close_delegation` + `hash_allocations` + unit tests | ~180 | 1 |
| B | `crank_roll_delegated` handler + account struct + integration tests | ~350 | 2 |
| C | SDK delegation builders + frontend hook + deposit-modal "enable auto-roll" checkbox | ~250 | 1 |
| D | Keeper detection + dispatch (delegation-signed fast path, curator-signed fallback) | ~120 | 0.5 |
| E | Audit prep — invariant tests, threat-model coverage, FOLLOWUPS update | ~100 | 1 |

## 10. Open questions (locked or not)

- [x] `allocations_hash` covers market + weight + cap, excludes `deployed_base`. **Locked.**
- [x] Slippage ceiling: 10% (1_000 bps). **Locked** per §I-D2.
- [x] TTL bounds: 1 day–100 days. **Locked** per §I-D3.
- [ ] Tip model — deferred to v1.1.
- [ ] `reallocation_authority` split on curator — separate ticket
      `CURATOR_SPLIT_AUTHORITY`.
- [ ] Batch crank (one tx, N users) — deferred; profile gas before
      committing.

## 11. Success criteria

- Keeper can run with no curator key (env var optional).
- Retail frontend shows "Enable auto-roll" toggle in deposit modal.
- Toggle on → creates delegation + deposits in a single tx.
- After market maturity: keeper cranks without user action, position
  rolls to the curator's next allocation, transaction signed by the
  keeper only.
- User can revoke via `close_delegation` at any time.
