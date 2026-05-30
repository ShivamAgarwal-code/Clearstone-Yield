# `instructions::wrap_native` — Native-asset wrap (cSOL, cUSDC)

Counterpart of [`super::wrap`] for pools whose underlying is a *plain*
SPL token (wSOL, sUSDC) rather than a delta-mint d-token. The
distinction matters because:

- The PDA seeds are different: `[b"native_pool", wrapped_mint]` vs
  `[b"pool", underlying_mint]`. We can't reuse the cUSDY-shaped pool
  layout because two different cUSDY-style pools could share the same
  *wrapped* mint pubkey by coincidence; native pools enforce the
  inverse.
- There's no Jito-vault staking step. The wSOL just sits in a vault.
  (The Jito wrap path lives in [`super::jito`].)

## What lives here

| ix | role | called by |
|---|---|---|
| `wrap_native` | User deposits wSOL/sUSDC → receives cSOL/cUSDC d-tokens 1:1 | end user |
| `unwrap_native` | User burns d-tokens → receives the underlying back 1:1 | end user |
| `mint_wrapped_native` | Bootstrap mint to seed klend reserves before user-facing wrap is live | root or admin |

## How the safety story works

### 1. Same atomicity story as `super::wrap`

`wrap_native`:

1. `token::transfer_checked(user_underlying_ata → pool_vault, amount)`
   (user signs).
2. `delta_cpi::mint_to(d-token, amount)` to user's d-token ATA (pool
   PDA signs as co-authority).

`unwrap_native`:

1. `delta_cpi::burn(d-token, amount)` (user signs).
2. `token::transfer_checked(pool_vault → user_underlying_ata, amount)`
   (pool PDA signs).

If any step fails the whole tx reverts. The 1:1 invariant
(`d_token_supply == pool_vault_balance`) holds by construction.

### 2. Native-pool seed pattern

The pool PDA is `[b"native_pool", wrapped_mint, bump]` rather than
`[b"pool", underlying_mint, bump]`. Reasons:

- The wrapped mint (cSOL, cUSDC) is unique per product, so it's the
  natural primary key.
- It cleanly avoids collisions if a future cUSDY-style pool ever
  shares its underlying mint with a native pool.
- `admin_mint_wt` (a sibling helper in `solstice`) detects the seed
  shape at runtime by re-deriving both possibilities and picking the
  one whose key matches the supplied `pool_config` — so a single
  helper can sign for either pool family.

The `wrap_native` / `unwrap_native` handlers always use the
native-pool seeds (no shape detection needed; the accounts struct
pins it via the seeds-and-bump constraint).

### 3. Whitelist gating

Same as the cUSDY path: every `mint_to` / `burn` checks the user's
delta-mint whitelist PDA. A wallet that wraps wSOL into cSOL must
already be whitelisted on the cSOL MintConfig
(`GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B`); a wallet that
unwraps must still be whitelisted (no quiet exit after KYC revocation).

`mint_wrapped_native` (the bootstrap path) is gated with
`is_authorized` (root or admin) but the destination wallet still
needs to be whitelisted — admins cannot mint d-tokens to a
non-Holder wallet even via the bootstrap hatch.

### 4. wSOL specifics

When the underlying is wSOL, the user has to wrap native SOL into
their wSOL ATA *before* calling `wrap_native` (Solana's standard SOL→wSOL
flow: `SystemProgram.transfer` to the ATA + `sync_native`). The
governor doesn't perform that wrap step itself — it expects the wSOL
to already be in the user's ATA. The frontends include the wrap +
sync_native ixes ahead of the governor call inside the same tx; the
deposit LUT compresses the static accounts so the whole bundle fits
in one v0 tx under the 1232-byte limit.

This split keeps the governor's footprint small and lets non-wSOL
native pools (sUSDC) reuse the same handler without paying for the
wSOL-specific dance.

## Risk surface

- **Same bootstrap supply gap as `super::wrap`** — `mint_wrapped_native`
  inflates supply ahead of vault deposits; close the seed → activate
  → user-wrap window in one governance session.
- **wSOL ATA ownership** — `wrap_native` validates the user's
  underlying ATA via Anchor's token interface (owner == user). A
  caller passing a foreign ATA fails the constraint.
- **Native pool PDA collision** — the seed pair pins the pool to one
  specific wrapped-mint pubkey; two pools can't share an address.
  Confirmed by Anchor's `init` constraint at deploy time and the
  seeds + bump check on every subsequent ix.
- **No Jito staking yield** — by design. The vault holds wSOL idle.
  Yield-bearing variants live in [`super::jito`] (which also adds the
  withdraw-queue lifecycle for unstaking).

## Discriminator stability

The `#[program]` block keeps `wrap_native`, `unwrap_native`, and
`mint_wrapped_native` as one-line wrappers, so their ix discriminators
are unchanged from the pre-refactor binary.
