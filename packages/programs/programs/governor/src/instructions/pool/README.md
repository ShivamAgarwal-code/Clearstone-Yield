# `instructions::pool` — Pool lifecycle

## What lives here

| ix | role | called by |
|---|---|---|
| `initialize_pool` | Create a non-native (cUSDY-style) pool: pool PDA, MintConfig, oracle wiring, klend reserve placeholders | deployer |
| `register_lending_market` | Bind a klend market + collateral/borrow reserves post-init; flips `status = Active` | root authority |
| `set_pool_status` | Manual freeze toggle (`Active` ↔ `Frozen`) | root authority |
| `set_gatekeeper_network` | Wire / disable Civic gating for `self_register`. Includes the v1→v2 PoolConfig realloc dance | root authority |
| `set_elevation_group` | Stamp the pool's klend EG (0/1/2/3/4 today). Includes the v2→v3 PoolConfig realloc dance | root authority |
| `set_borrow_rate_curve` | Push an 11-point IRM curve into the collateral or borrow klend reserve via `update_reserve_config` (mode 1) | root authority |
| `activate_wrapping` | Hand MintConfig authority off to the pool PDA — required before `wrap` / `unwrap` / `wrap_with_jito_vault` can sign | root authority |
| `initialize_native_pool` | Sibling of `initialize_pool` for native-asset wrappers (cSOL, cUSDC). Different PDA seeds (`b"native_pool" + wrapped_mint`) | deployer |
| `activate_wrapping_native` | Native-pool counterpart of `activate_wrapping` | root authority |

## How the safety story works

### 1. Authority discipline

Every mutating ix is gated with one of two patterns:

- **Root-only** (`register_lending_market`, `set_pool_status`,
  `set_gatekeeper_network`, `set_elevation_group`, `activate_wrapping`,
  `activate_wrapping_native`): accounts struct uses `has_one = authority`
  on `pool_config`, so Anchor enforces `signer == pool_config.authority`
  at constraint-check time.
- **Root-or-admin** (`set_borrow_rate_curve`): explicit
  `is_authorized(signer, pool.authority, pool.key, &admin_entry)` call
  in the constraint expression. `admin_entry: Option<Account<AdminEntry>>`
  is validated by Anchor against its PDA seeds, then the helper checks
  `admin_entry.wallet == signer && admin_entry.pool == pool.key()`.

There is no path that skips both checks; `is_authorized` is the only
predicate, and it requires the signer to *be* the root or be a
pre-approved admin tied to this specific pool.

### 2. PDA-derived state

`pool_config` and `withdraw_queue` are derived PDAs:
- `[b"pool", underlying_mint]` for non-native pools
- `[b"native_pool", wrapped_mint]` for native pools
- `[b"withdraw_queue", pool_config]` for the Jito-flow queue

Anchor enforces the seeds at `#[account(seeds = …, bump = pool_config.bump)]`,
so a caller can't substitute a foreign pool config; the address is
deterministic from the underlying mint, and re-init is blocked by the
`init` constraint.

### 3. CPI signing

`activate_wrapping*` and `set_borrow_rate_curve` CPI into delta-mint or
klend with the pool PDA as the signer. The handler reconstructs the
seed pair and passes it to `CpiContext::new_with_signer` — the signer
seeds are the *only* way the PDA can authorise an external write, and
they're never derived from caller-controlled input.

### 4. Account-shape migrations

`set_gatekeeper_network` and `set_elevation_group` were added after the
original PoolConfig layout shipped, so they include an in-handler
realloc when the existing account is still at the old size. The new
fields are appended at the end (Anchor preserves trailing bytes as
defaults) — the realloc only ever *grows*, never shrinks, and the
discriminator is unchanged.

### 5. Invariants checked at runtime

- `BorrowRateCurve::validate` (in `state.rs`) is run before any klend
  CPI. It enforces: 11 points, monotone-increasing utilization, monotone
  borrow rate, first point at 0% util, last at 100%, borrow rate
  capped at 50% APR (5000 bps). klend's own `update_reserve_config`
  rejects malformed curves, but we also reject them client-side so a
  failure surfaces as our `InvalidCurve` instead of klend's opaque
  6XXX code.
- `PoolStatus` transitions are gated: `register_lending_market`
  requires `Initializing → Active`; `wrap` / `unwrap` /
  `wrap_with_jito_vault` require `Active`. `Frozen` is one-way until
  the root flips it back.
- `register_lending_market` validates that the supplied reserve
  pubkeys are not equal (no degenerate same-asset config).

## Risk surface

- **Root-authority compromise** dominates the threat model — every
  config write is gated on it, including the MintConfig authority
  transfer in `activate_wrapping`. Mitigation = same as for the klend
  pool authority (multisig / hardware-key / Squads). On devnet it's the
  deployer keypair `AhKNm…aJX`.
- **Klend EG mismatch** — `set_elevation_group` stamps a u8 onto the
  pool but klend enforces nothing here; the reserves themselves carry
  EG configs and klend rejects mismatches at borrow time. So a wrong
  value is a footgun, not a vault drain.
- **Borrow-curve update during live debt** — klend's
  `update_reserve_config` re-quotes existing borrows at the new curve;
  pool authority can effectively retro-rate-hike. This is intended
  governance behaviour but worth documenting for users.

## Discriminator stability

The `#[program]` block in `lib.rs` keeps thin one-liner wrappers with
the same `pub fn <name>(…)` signatures as the deployed binary, so
`sha256("global:<name>")[..8]` is byte-identical and clients (the SDK,
keeper, frontends) keep working without recompilation.
