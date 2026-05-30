# `instructions::solstice` — Solstice (eUSX / USX) unlock + redeem

The eUSX-flavoured counterpart to [`super::jito`]: takes a leveraged
ceUSX position through a Solstice YieldVault unlock window, mints a
KYC-gated withdraw-ticket token (ceUSX-WT) so the position can be
collateral-swapped inside klend during the unlock period, then redeems
the ticket back into USX once Solstice's pending-unlock entry has
matured.

The downstream USX → USDC redemption (`RequestRedeem` / `ConfirmRedeem`)
and the klend flash-repay live in the frontend, NOT in this module —
keeping account counts manageable.

## What lives here

| ix | role | called by |
|---|---|---|
| `enqueue_eusx_unlock_via_pool` | Burn user's eUSX via Solstice `Unlock`, queue USX in Solstice's pending-unlock PDA, mint ceUSX-WT 1:1 to user | end user |
| `redeem_ceusx_wt` | Burn user's ceUSX-WT, claim the matured Solstice queue entry via `Withdraw`, USX lands in user's USX ATA | end user |
| `admin_mint_wt` | Bootstrap-only: pool authority can mint any WT-style mint owned by this pool (used to seed klend reserves before user-facing ixes ship) | root or admin |

## How the safety story works

### 1. Manual CPI to Solstice

Solstice's YieldVault doesn't expose a typed Anchor SDK we trust, so we
hand-roll the two CPIs:

- `Unlock` — disc `0x1513d02bed3eff57`, 13 accounts. Burns user's eUSX,
  queues USX in `user_pending_unlock_pda`. Account list pinned to the
  on-chain sample `samples/yieldvault_Unlock.json`.
- `Withdraw` — disc `0xb712469c946da122`, 8 accounts. Claims the full
  pending-unlock balance, mints USX into `user_usx_ata`. No amount arg
  (Solstice claims the entire pending entry).

The user signs the outer tx, so when Solstice asks for a `user`
signer, the signature is already in the meta header — we just pass
the `AccountMeta::new(user.key, true)` and the runtime forwards the
existing signature.

### 2. MintConfig authority validation (the runtime check)

`enqueue_eusx_unlock_via_pool` and `admin_mint_wt` both CPI into
delta-mint's `mint_to` with the pool PDA as authority. delta-mint
validates `mint_config.authority == authority_signer` inside its own
handler, but we *also* read the MintConfig bytes ourselves before the
CPI:

```rust
let mc_data = ctx.accounts.dm_mint_config.try_borrow_data()?;
require!(mc_data.len() >= 40, GovernorError::InvalidPoolStatus);
let stored_authority = Pubkey::try_from(&mc_data[8..40])
    .map_err(|_| GovernorError::Unauthorized)?;
require_keys_eq!(
    stored_authority,
    ctx.accounts.pool_config.key(),
    GovernorError::Unauthorized
);
```

Why double-check what delta-mint already validates? Two reasons:

1. **Cleaner error code.** A misconfigured caller (wrong WT MintConfig)
   gets our `Unauthorized` rather than delta-mint's CPI error code.
2. **Defence in depth.** If delta-mint is ever upgraded with a bug
   that loosens the authority check, our handler still fails closed.

### 3. Pool PDA seed shape detection

`admin_mint_wt` and `enqueue_eusx_unlock_via_pool` both work for two
pool families:

- Standard `[b"pool", underlying_mint, bump]` (cUSDY-style, csSOL).
- Native `[b"native_pool", wrapped_mint, bump]` (cSOL, cUSDC).

The handler re-derives the standard shape and compares against the
caller-supplied `pool_config.key()`; if it matches, use the standard
seeds, else use the native seeds. This means the same ix handles
both shapes without forcing the caller to know which one. The
`invoke_signed` call uses the seeds that *actually* derive to the
provided pool key, so a caller can't pass a foreign pool config —
`invoke_signed` would fail address derivation.

### 4. ceUSX-WT supply matches Solstice queued USX

The `enqueue_eusx_unlock_via_pool` ix is *atomic* across both legs:
the Solstice `Unlock` CPI and the delta-mint `mint_to(ceUSX-WT)` run
in the same handler. So:

- Either both succeed (ceUSX-WT supply ↑, Solstice queued USX ↑ by
  the same amount).
- Or both fail (no state change).

There's no path where ceUSX-WT exists without a matching Solstice
queue entry. The `redeem_ceusx_wt` ix burns ceUSX-WT (user signs)
*before* calling `Withdraw`; Solstice's `Withdraw` either succeeds
(USX lands in user) or fails (the full tx reverts, including the WT
burn). So the inverse invariant also holds.

### 5. admin_mint_wt is the bootstrap escape hatch

`admin_mint_wt` exists to seed klend reserves with WT-style tokens
before the production user-facing ix is deployed (e.g. seeding
`csSOL-WT-reserve` so the v1 unwind flow had liquidity). It's
authority-gated by `is_authorized` — only root or admin can call.

Same MintConfig-authority check as `enqueue_eusx_unlock_via_pool`,
same pool-PDA-as-authority signing pattern. The single difference is
the input MintConfig is caller-supplied (not pinned to
`pool_config.dm_mint_config`), allowing it to mint for csSOL-WT
or future WT mints owned by the same pool PDA.

The handler will be removed once production WT-issuance ixes for
each new mint exist — until then, admins can effectively mint
`u64::MAX` of any WT they own, which is why this is bootstrap-only.

## Risk surface

- **Solstice protocol risk** — we trust Solstice's YieldVault to
  honour `Unlock` (debit eUSX, queue USX) and `Withdraw` (claim queued
  USX). If Solstice freezes withdrawals or upgrades to an
  incompatible disc/account list, our flow breaks. Mitigation: the
  CPI account ordering is sourced from a fixed on-chain sample, so a
  Solstice ix-shape change surfaces as a clean tx revert (not a wrong
  outcome); we keep the sample under version control to detect drift.
- **Solstice oracle drift** — Solstice's USX peg depends on its own
  oracle. If USX depegs, ceUSX-WT redemption produces less USX than
  expected, and the user's klend obligation may be undercollateralized
  vs the original sUSDC borrow. This is Solstice's risk surface, not
  ours; documented for downstream.
- **`admin_mint_wt` overmint** — root/admin can mint arbitrary
  amounts of any pool-owned WT mint. Mitigation: same multisig/HSM
  treatment as the rest of the root authority surface; this is not a
  decentralised gate.
- **MintConfig confusion** — passing a foreign MintConfig that
  happens to have the pool PDA as authority would let admins mint
  for it. Mitigation: in production, only the deployer's pool PDAs
  hold authority over the WT MintConfigs we care about; verified by
  the `setup-cssol-wt-mint.ts` deploy script's transfer-authority
  step.

## Discriminator stability

`enqueue_eusx_unlock_via_pool`, `redeem_ceusx_wt`, and `admin_mint_wt`
in the `#[program]` block are all unchanged thin wrappers over the
extracted handlers. Anchor ix discriminators for these three are
byte-identical to the deployed binary.
