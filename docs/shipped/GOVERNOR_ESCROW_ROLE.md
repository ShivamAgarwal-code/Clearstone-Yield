# M-KYC-0 — Add `ParticipantRole::Escrow` to governor + delta-mint

> **Scope:** external repo `github.com/1delta-DAO/clearstone-finance`, paths
> `packages/programs/programs/governor/` and `packages/programs/programs/delta-mint/`.
> This is the blocker PR for the clearstone-fixed-yield KYC pass-through work
> (see [KYC_PASSTHROUGH_PLAN.md](KYC_PASSTHROUGH_PLAN.md) §3.4 / §4.4).

## Why

Clearstone core owns PDAs — `escrow_sy`, `token_fee_treasury_sy`, `yield_position`'s SY
ATA — that must be allowed to *hold* a KYC-gated d-token so users can strip / trade
PT/YT on top. Today the governor has two `ParticipantRole` variants:

| Role | Can receive minted d-tokens? | Intent |
|---|---|---|
| `Holder` | yes | KYC'd end-user wallet |
| `Liquidator` | no (calls `add_liquidator` under the hood) | bot that ingests collateral |

A clearstone core escrow is neither. It can hold tokens (so it needs to be on the
whitelist), but it must NOT be eligible for `mint_to` — the authority-mint side of the
pipeline stays pointed at real users only. Adding a third variant avoids overloading
`Liquidator` semantics for a non-liquidator account, and makes the intent audit-legible.

## Deliverable

Two small PRs, landed in order:

1. `delta-mint` — accept a new `WhitelistEntry` role value, reject `mint_to` when that
   role is set. ~15 LOC.
2. `governor` — add `ParticipantRole::Escrow`, route it through the same delta-mint
   CPI as `Holder` (whitelist PDA created, destination eligible to *hold* the mint).
   ~8 LOC.

No migration. Existing `Holder` / `Liquidator` entries keep their semantics.

## Prerequisites

- `anchor --version` ≥ 0.31.1 (same as clearstone-fixed-yield).
- Local validator or test-ledger with solana-cli ≥ 2.0.
- `pnpm install` at repo root succeeds.
- `pnpm --filter programs build` currently passes against `main`.

Capture the current program ids before touching anything — they must not change:

```bash
anchor keys list | tee /tmp/preexisting-ids.txt
# expect: governor = BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh
#         delta_mint = <whatever is declared>
```

Do NOT regenerate keypairs. `declare_id!` stays untouched.

---

## Step 1 — delta-mint: add `Escrow` role, reject `mint_to`

### 1.1 Locate the role enum

File: `packages/programs/programs/delta-mint/src/lib.rs`
(or wherever the `WhitelistEntry` struct and its role field live — grep for
`add_to_whitelist` to find it if the layout differs).

Look for the existing role enum, which today probably looks like:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum WhitelistRole {
    Holder,
    Liquidator,
}
```

### 1.2 Add the `Escrow` variant

**Append** (do not reorder) the new variant:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum WhitelistRole {
    Holder,
    Liquidator,
    /// Program-owned custody PDA (e.g. clearstone_core escrow_sy, token_fee_treasury_sy).
    /// Eligible to HOLD the mint; NOT eligible for `mint_to`.
    Escrow,
}
```

**Append, do not insert.** The enum is `AnchorSerialize`-derived, so existing
`WhitelistEntry` PDAs on-chain would reindex if you insert before `Holder` or
`Liquidator`. Anchor's `InitSpace` uses the max variant size, so `WhitelistEntry::INIT_SPACE`
doesn't change — no realloc needed.

### 1.3 Reject `mint_to` for `Escrow`

Find the `mint_to` handler. It currently looks something like:

```rust
pub fn mint_to(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
    let entry = &ctx.accounts.whitelist_entry;
    require!(
        entry.role == WhitelistRole::Holder,
        DeltaMintError::InvalidRole,
    );
    // ... existing mint logic ...
}
```

Leave this **as-is**. `Escrow` is not `Holder`, so the existing check already rejects
it — this is deliberate. Do not widen the check to `Holder | Escrow`.

If the current implementation matches on the role instead of comparing to `Holder`,
make `Escrow` fall through to the reject arm:

```rust
match entry.role {
    WhitelistRole::Holder => { /* existing mint path */ }
    WhitelistRole::Liquidator | WhitelistRole::Escrow => {
        return err!(DeltaMintError::InvalidRole);
    }
}
```

### 1.4 Tests

Add to `packages/programs/tests/delta-mint.ts` (or create if it doesn't exist):

```ts
it("rejects mint_to into an Escrow-role whitelist entry", async () => {
  const escrowPda = Keypair.generate().publicKey;
  await program.methods
    .addToWhitelist({ escrow: {} })  // new role variant
    .accounts({ wallet: escrowPda, /* ... */ })
    .rpc();

  // Attempt to mint_to against the escrow entry.
  const tx = program.methods
    .mintTo(new BN(1_000_000))
    .accounts({ whitelistEntry: deriveWhitelistPda(escrowPda), /* ... */ })
    .rpc();

  await expect(tx).rejects.toThrow(/InvalidRole/);
});

it("permits a plain token transfer INTO an Escrow-role account", async () => {
  // After add_to_whitelist(Escrow, pda), a regular transfer_checked from a
  // Holder's ATA to the escrow account should succeed. This is the core
  // property clearstone_core relies on.
});
```

Idiomatic name for the instruction that whitelists Escrow PDAs: it's still
`add_to_whitelist`, just with a different role discriminant. Keep the instruction
shape unchanged.

### 1.5 Rebuild + assert id unchanged

```bash
pnpm --filter programs build
anchor keys list | diff - /tmp/preexisting-ids.txt
# must be empty
```

---

## Step 2 — governor: route `Escrow` through `add_participant` paths

### 2.1 Locate the role enum and handlers

File: `packages/programs/programs/governor/src/lib.rs` (confirmed exists at this
path on `main`, per planning pass).

The role enum currently lives around line 1029:

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ParticipantRole {
    Holder,
    Liquidator,
}
```

And three handlers consume it:
- `add_participant` — non-activated pools, line ~149.
- `add_participant_via_pool` — activated pools (authority transferred to pool PDA),
  line ~110.
- (no third handler uses the role today; confirm with grep.)

### 2.2 Add the variant

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ParticipantRole {
    Holder,
    Liquidator,
    /// Program-owned custody PDA from an integrating protocol (e.g. clearstone_core
    /// escrow_sy / token_fee_treasury_sy). Whitelisted identically to `Holder` in
    /// delta-mint but semantically a non-user — documented for audit legibility.
    Escrow,
}
```

Again: **append**, don't reorder.

### 2.3 Extend the match arms

In `add_participant`:

```rust
match role {
    ParticipantRole::Holder | ParticipantRole::Escrow => {
        delta_cpi::add_to_whitelist(CpiContext::new(cpi_program, cpi_accounts))?;
    }
    ParticipantRole::Liquidator => {
        delta_cpi::add_liquidator(CpiContext::new(cpi_program, cpi_accounts))?;
    }
}
```

Identical change in `add_participant_via_pool`:

```rust
match role {
    ParticipantRole::Holder | ParticipantRole::Escrow => {
        delta_cpi::add_to_whitelist_with_co_authority(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
        )?;
    }
    ParticipantRole::Liquidator => {
        delta_cpi::add_to_whitelist_with_co_authority(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[seeds])
        )?;
    }
}
```

**Important caveat.** At the delta-mint boundary, `Holder` and `Escrow` both CPI
`add_to_whitelist` — but delta-mint must store the role as `Escrow`, not `Holder`,
so step 1.3's `mint_to` rejection fires. If delta-mint's `add_to_whitelist` takes a
role parameter today, pass `Escrow` through. If it hardcodes `Holder`, add a
role parameter in step 1 (extends scope; note it in the PR).

Check which is the case by grepping delta-mint for `WhitelistEntry { role: `. If
the role is hardcoded, add the parameter; if it's already a parameter, just
plumb `Escrow` through from governor.

### 2.4 Tests

Add to `packages/programs/tests/governor.ts`:

```ts
it("add_participant(Escrow) creates a whitelist entry that CAN receive transfers but CANNOT be minted to", async () => {
  const escrowPda = Keypair.generate().publicKey;
  await governorProgram.methods
    .addParticipant({ escrow: {} })
    .accounts({ wallet: escrowPda, /* governor + delta-mint accounts */ })
    .rpc();

  // Part 1: holder → escrow transfer succeeds (proves whitelist entry exists).
  await transferChecked({
    from: holderAta,
    to: escrowAta,
    mint: dTokenMint,
    amount: 1_000,
    decimals,
  });

  // Part 2: mint_to(escrow_entry) rejects.
  await expect(
    deltaMintProgram.methods
      .mintTo(new BN(1_000))
      .accounts({ whitelistEntry: escrowEntryPda, /* ... */ })
      .rpc()
  ).rejects.toThrow(/InvalidRole/);
});

it("add_participant_via_pool(Escrow) same behavior on activated pools", async () => {
  // Mirror of the above, but after activate_wrapping has transferred mint
  // authority to the pool PDA. This is the path clearstone_sy_adapter will
  // hit, since pools in production have wrapping activated.
});
```

### 2.5 Existing call-site compatibility

Grep the repo for `ParticipantRole::Holder` / `ParticipantRole::Liquidator` after
the variant lands; ensure no exhaustive `match` without a wildcard is missing
the new arm. With `#[derive(Clone, Copy, PartialEq, Eq)]` and no wildcard arms,
rustc will catch these at compile time.

### 2.6 Rebuild + assert id unchanged

```bash
pnpm --filter programs build
anchor keys list | diff - /tmp/preexisting-ids.txt
# must be empty
```

---

## Step 3 — Release

1. Tag both programs' crate versions. Suggested: bump patch (`0.1.1` → `0.1.2`).
2. Commit a changelog entry noting the new variant — on-chain layout is
   backward-compatible, but downstream IDL consumers should regenerate TS types.
3. Push a tag `vX.Y.Z-escrow-role` so clearstone-fixed-yield can Cargo-pin against it:

   ```toml
   # clearstone-fixed-yield/reference_adapters/kamino_sy_adapter/Cargo.toml
   governor = { git = "https://github.com/1delta-DAO/clearstone-finance", tag = "vX.Y.Z-escrow-role", features = ["cpi", "no-entrypoint"] }
   delta_mint = { git = "https://github.com/1delta-DAO/clearstone-finance", tag = "vX.Y.Z-escrow-role", features = ["cpi", "no-entrypoint"] }
   ```

4. Notify the clearstone-fixed-yield workstream: M-KYC-3 (wiring the real CPI in
   kamino_sy_adapter's `init_sy_params`) can now proceed — swap the
   `WhitelistRequestedEvent` emit loop (at
   [kamino_sy_adapter/src/lib.rs:103](reference_adapters/kamino_sy_adapter/src/lib.rs#L103))
   for a `governor::cpi::add_participant_via_pool(role: Escrow)` CPI, one per PDA.

---

## Out of scope for this PR

- Batch whitelist instruction (`add_participants_batch`) — KYC_PASSTHROUGH_PLAN.md
  §3.4 v2, deferred.
- Removing `Escrow` entries (use existing `remove_from_whitelist`; role check on
  remove side should allow `Escrow` alongside `Holder` and `Liquidator` — confirm).
- Migration tooling — there are no pre-existing `Escrow` entries to migrate.

## PR checklist

- [ ] delta-mint: `WhitelistRole::Escrow` variant appended (not inserted).
- [ ] delta-mint: `mint_to` rejects `Escrow`.
- [ ] delta-mint: unit test proves reject + token-transfer-in works.
- [ ] governor: `ParticipantRole::Escrow` variant appended.
- [ ] governor: `add_participant` + `add_participant_via_pool` route Escrow →
      `add_to_whitelist` (not `add_liquidator`).
- [ ] governor: integration test covers both pre- and post-activation paths.
- [ ] `anchor keys list` unchanged vs. pre-PR snapshot.
- [ ] IDLs regenerated; TS types re-exported.
- [ ] Tag cut for clearstone-fixed-yield to Cargo-pin against.
