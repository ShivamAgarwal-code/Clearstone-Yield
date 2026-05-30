# `instructions/` — domain modules + audit memos

Six domains, each in its own folder with `mod.rs` (the Rust handlers +
accounts structs) and `README.md` (a short audit memo: how the code
works, what authority gates it, where the invariants live, and what
the residual risks are).

| folder | scope | LOC (mod.rs) |
|---|---|---|
| [`pool/`](pool/README.md)         | Pool lifecycle: init, freeze, klend wiring, IRM curve, EG, gatekeeper, activate wrapping. | ~558 |
| [`admin/`](admin/README.md)       | Authority management + whitelist plumbing (incl. Civic self-register). | ~510 |
| [`wrap/`](wrap/README.md)         | Plain `wrap` / `unwrap` / `mint_wrapped` (cUSDY-style 1:1 custody). | ~287 |
| [`wrap_native/`](wrap_native/README.md) | Native-asset variant (cSOL / cUSDC) — different pool seed shape, no Jito staking. | ~292 |
| [`jito/`](jito/README.md)         | Jito-vault wrap + the csSOL-WT redemption chain (enqueue → mature → redeem) + queue helpers. | ~995 |
| [`solstice/`](solstice/README.md) | Solstice eUSX → ceUSX-WT unlock + redeem, plus the bootstrap-only `admin_mint_wt`. | ~463 |

`lib.rs` keeps the `#[program]` block (33 ixes) as one-line wrappers
delegating into these modules. Anchor ix discriminators
(`sha256("global:<name>")[..8]`), accounts struct discriminators, event
log discriminators, and error variant numbers are all unchanged from
the deployed binary — verified by re-deploying the rebuilt program at
the existing program ID and checking `target/idl/governor.json`
preserves shape (33 ixes, 3 accounts, 11 events, 11 errors).

## How the audits read

Each `README.md` is structured the same way so they're skimmable as a
set:

1. **What lives here** — table of ixes + intended caller.
2. **How the safety story works** — numbered list of the
   *structural* defences (authority predicate, PDA derivation, CPI
   signer chain, invariant check, etc.).
3. **Risk surface** — bulleted list of residual risks not eliminated by
   the structural defences (operator key compromise, protocol-level
   trust, etc.) + mitigations.
4. **Discriminator stability** — explicit note that the refactor
   preserves the IDL.

## Cross-cutting invariants the audits assume

These are common across multiple domains and so aren't repeated in each
README:

- **Pool PDA cannot sign except via this program.** The pool PDA's
  private key is unknown by construction; every CPI that uses it as a
  signer must `invoke_signed` with the correct seed pair. The seeds
  live in `state::PoolConfig::bump` + the underlying mint, both
  Anchor-validated.
- **Whitelist PDAs are init-only.** delta-mint's `init` constraint on
  every whitelist PDA prevents double-init / replay; once a wallet is
  whitelisted, it stays so until explicitly closed.
- **`Active` status gates user-facing ixes.** `wrap`, `unwrap`,
  `wrap_with_jito_vault`, `enqueue_withdraw_via_pool`, etc. all open
  with `require!(pool.status == PoolStatus::Active, …)`. `Frozen` is a
  one-way valve until root unfreezes it.
- **`is_authorized(signer, pool.authority, pool.key, &admin_entry)`**
  is the single privilege predicate. Used by every root-or-admin ix.
  Defined in `lib.rs` and exported pub for the instruction modules to
  reference inside their `#[account(constraint = …)]` expressions.

## When to update an audit memo

Trigger an update whenever the underlying ix changes:

- A new account is added/removed from a `#[derive(Accounts)]` struct.
- An authority predicate changes (new role, different signer chain).
- A CPI is added or its signer seeds change.
- A new invariant is enforced (or an old one is relaxed).
- An on-chain dependency upgrades (e.g. a Jito or delta-mint program
  upgrade that changes the CPI shape).

The README is the canonical handoff to anyone reviewing a PR that
touches the module — if the diff doesn't update the audit, the review
should bounce.
