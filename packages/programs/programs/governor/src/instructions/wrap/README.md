# `instructions::wrap` — Plain wrap / unwrap (cUSDY-style)

The cUSDY pattern: pool holds the underlying SPL token in a vault, mints
a 1:1 KYC-gated d-token to the user. No staking, no Jito, no
redemption queue.

The Jito-vault wrapping flow lives in [`super::jito`]; native-asset
wrapping (cSOL / cUSDC) lives in [`super::wrap_native`]; this module
is for "give us underlying, get d-tokens" exposures where the
underlying is itself an SPL token (USDY, etc.).

## What lives here

| ix | role | called by |
|---|---|---|
| `wrap` | User deposits underlying → receives d-tokens 1:1 | end user |
| `unwrap` | User burns d-tokens → receives underlying back 1:1 | end user |
| `mint_wrapped` | Bootstrap mint: pool authority can mint d-tokens directly to seed klend reserves before user-facing wrapping is enabled | root or admin |

## How the safety story works

### 1. Atomicity and the 1:1 invariant

`wrap` is a single ix that does:

1. `token::transfer_checked(user_underlying_ata → pool_vault, amount)`
   (user signs).
2. `delta_cpi::mint_to(d-token, amount)` to user's d-token ATA (pool
   PDA signs as co-authority; whitelist PDA validated).

`unwrap` does the inverse:

1. `delta_cpi::burn(d-token, amount)` from user's ATA (user signs).
2. `token::transfer_checked(pool_vault → user_underlying_ata, amount)`
   (pool PDA signs as authority on the vault).

Both legs run in the same ix; if either fails, the whole tx reverts.
The supply invariant (`total_d_tokens == pool_vault_balance`) is
maintained by construction.

### 2. The mint_to / burn whitelist gate

Both `mint_to` and `burn` in delta-mint check `whitelist_entry` for the
participating wallet. So:

- `wrap` fails if the user is not whitelisted as Holder on the
  MintConfig.
- `unwrap` *also* fails on burn if the user is not whitelisted —
  intentional, so a wallet whose KYC has been revoked can't drain its
  d-tokens out of the gated mint without first re-onboarding.
- `mint_wrapped` fails if the *destination* is not whitelisted; admins
  cannot accidentally airdrop d-tokens to unverified wallets.

### 3. Vault custody

The `pool_vault` is a regular SPL token account whose `owner` is the
pool PDA. `wrap` transfers in (user signs), `unwrap` transfers out
(pool PDA signs via `[b"pool", underlying_mint, bump]`). The address
constraint `address = pool_config.<vault_field>` ensures the vault
the user passes is the canonical one, not a foreign account.

### 4. mint_wrapped is bootstrap-only

`mint_wrapped` lets the pool authority mint d-tokens *without* a
matching underlying deposit. It exists to seed klend reserves before
user-facing `wrap` is enabled, and is gated by `is_authorized` (root
or admin). The d-token supply temporarily exceeds vault custody during
this seeding window, but:

- It's only callable by root/admin.
- The implementation uses the same `mint_to` CPI as `wrap`, so the
  whitelist + co-authority checks still apply (the destination wallet
  must be a Holder).
- Once user-facing wrapping is live, the seeded klend liquidity is
  matched by user deposits and the invariant rebalances.

There is no `burn_wrapped` admin equivalent — supply only goes up via
this path; coming back down requires a normal user `unwrap` (which has
full vault backing) or the bootstrap recipient to itself unwrap (which
would consume seed underlying that the pool holds).

### 5. Status check

Every ix begins with
`require!(pool.status == PoolStatus::Active, GovernorError::PoolNotActive)`,
so a frozen pool can't be wrapped/unwrapped.

## Risk surface

- **Bootstrap supply gap** — between `mint_wrapped` (admin mints
  d-tokens for seeding) and the first user `wrap`, the d-token supply
  exceeds the vault balance by the seed amount. If klend collateral
  is liquidated against those seed d-tokens during this window, the
  liquidator ends up holding d-tokens with no underlying redemption
  path. Mitigation: deploy + seed + activate-wrapping in a single
  governance window, not days apart.
- **Token-2022 transfer hooks on the underlying** — `wrap` uses
  `transfer_checked` which respects Token-2022 transfer hooks. If the
  underlying mint has a hook that blocks the pool vault as a
  destination, `wrap` fails (clean rejection, not a partial state).
- **Frozen pool** — `Frozen` status pauses wrap *and* unwrap; users
  can't exit during a freeze. This is intentional (gives the
  authority headroom for incident response), but worth surfacing in
  any consumer doc.

## Discriminator stability

`pub fn wrap`, `pub fn unwrap`, `pub fn mint_wrapped` in `lib.rs`'s
`#[program]` block keep their original signatures; the wrappers just
delegate to `instructions::wrap::*`. IDL ix hashes are byte-identical
to the deployed binary.
