# `instructions::admin` — Authority + whitelist plumbing

## What lives here

| ix | role | called by |
|---|---|---|
| `add_admin` | Register an `AdminEntry` PDA tying a wallet to a pool | root authority |
| `remove_admin` | Close an `AdminEntry` PDA, returning rent | root authority |
| `fix_co_authority` | One-time migration: writes `co_authority = pool_pda` onto a MintConfig that pre-dates the field | root authority |
| `add_participant` | Whitelist a wallet on the primary MintConfig BEFORE `activate_wrapping` (delta-mint authority still held by deployer) | root or admin |
| `add_participant_via_pool` | Same, but AFTER activation: pool PDA signs as co_authority | root or admin |
| `add_wt_participant_via_pool` | Sibling that accepts any MintConfig owned by the pool PDA (csSOL-WT, ceUSX-WT, csUSDC-style) | root or admin |
| `add_participant_native_via_pool` | Native-pool counterpart of the via_pool whitelisting | root or admin |
| `self_register` | Permissionless if pool has a Civic gatekeeper network: user proves a valid pass and gets whitelisted as Holder | end user |

## How the safety story works

### 1. Two-tier authority

`AdminEntry` PDA is `[b"admin", pool, wallet]`. `is_authorized(signer,
pool.authority, pool.key, &admin_entry)` returns true iff:

- `signer == pool.authority`, OR
- `admin_entry` is `Some` AND `admin_entry.wallet == signer` AND `admin_entry.pool == pool.key()`.

Anchor validates the AdminEntry's seeds + `has_one = pool` + `has_one =
wallet` before the constraint runs, so the only way to satisfy the
admin branch is to have an actual on-chain entry created by
`add_admin` (which itself is root-only).

`add_admin` and `remove_admin` are root-only — admins cannot
self-elevate or churn the admin set. The admin set is append-only-by-root
+ removable-by-root.

### 2. Whitelist PDA derivation

Every whitelist entry is a delta-mint PDA at `[b"whitelist",
mint_config, wallet]`. The `init` constraint inside delta-mint enforces:

- Account doesn't already exist (no double-whitelist, no replay).
- Address matches the seeds (no impersonation).
- Payer covers rent.

Our governor wrappers (`add_participant_via_pool` etc.) just route the
CPI; the actual gate is in delta-mint and is identical regardless of
which whitelisting path was used.

### 3. The two CPI flavours

- `add_to_whitelist` (used by `add_participant`): authority is the
  signer, payer is also the signer. Used pre-activation when the
  deployer still holds MintConfig authority.
- `add_to_whitelist_with_co_authority` (used by `*_via_pool` ixes): the
  pool PDA signs as `co_authority`, the wallet that calls the governor
  ix pays rent. Required because once `activate_wrapping` transferred
  the MintConfig authority to the pool PDA, only the PDA can sign — but
  PDAs can't pay rent (system-program transfers from data-bearing
  accounts fail).

The `add_wt_participant_via_pool` ix exists specifically because the
primary `add_participant_via_pool` pins `dm_mint_config` to
`pool_config.dm_mint_config` (an Anchor `address = …` constraint), so
WT-style MintConfigs that aren't tracked on PoolConfig need a
constraint-free entrypoint. delta-mint's own
`add_to_whitelist_with_co_authority` still validates `co_authority ==
mint_config.co_authority` inside delta-mint's handler, so passing a
foreign MintConfig still fails — the governor-side relaxation just
moves the check from the constraint expression to the CPI.

### 4. Self-registration via Civic

`self_register` is the only non-authority path. It requires:

- The pool has `gatekeeper_network != Pubkey::default()` (set via
  `set_gatekeeper_network`).
- The supplied `gateway_token` deserialises as a Civic Pass and
  `pass.valid(user, gatekeeper_network)` returns true. The `Pass`
  struct (in `civic_pass.rs`) checks owner, gatekeeper network match,
  expiry, and the inner state byte.

The handler then CPIs into delta-mint with the pool PDA as
co-authority and the user as payer + wallet — same shape as the
admin-driven path, just with a different gating predicate upstream.

### 5. Constant-time name resolution

`AdminEntry` and whitelist PDAs are both fully derived from inputs the
caller passes; there's no on-chain registry or discovery step. This
means there's no race between admin-list reads and writes, and the
authority decision is deterministic per ix.

## Risk surface

- **Root authority compromise** drains the entire admin/whitelist
  surface — root can add admins, transfer MintConfig authority back,
  unfreeze pools, and silently whitelist arbitrary wallets. Mitigated
  by treating the root authority as a multisig/HSM key.
- **Stale Civic passes** — the `Pass` decoder checks the `expiry`
  field, but Civic's mainnet revocation isn't reflected on-chain
  immediately; a recently-revoked pass can still pass `valid()` for up
  to a TTL window. This is the expected Civic-gating envelope, not a
  governor bug.
- **Cross-pool admin reuse** — `AdminEntry` is per-pool, so an admin
  on pool A cannot whitelist on pool B. Verified by the
  `admin_entry.pool == pool.key()` check inside `is_authorized`.
- **delta-mint replay** — the whitelist PDA's `init` constraint
  prevents re-init; once whitelisted, idempotent re-attempts fail (the
  `whitelist-wallet.ts` script catches this and reports
  `"already-present"`).

## Discriminator stability

Same as `pool/`: every `pub fn` name in `lib.rs`'s `#[program]` block
matches the deployed binary, so the IDL hash for these ixes is
unchanged after the refactor.
