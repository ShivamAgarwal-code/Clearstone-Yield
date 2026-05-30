# Auto-roll Keeper — Permissioning

Design + operator guide for the service that cranks curator-vault
reallocations at each market maturity.

## TL;DR

- **Current on-chain design** gates `reallocate_to_market` and
  `reallocate_from_market` on `curator: Signer<'info>`. The keeper
  **must** hold the curator wallet's private key.
- **User-signed permissioning is NOT supported** without an on-chain
  change. The practical answers are (a) run the keeper with a
  curator hot-key and rotate it, or (b) ship a new ix that accepts
  a user-signed `RollDelegation` PDA. §5 below sketches (b).
- Ship v1 as (a); (b) is a protocol-upgrade ticket.

## 1. Current permissioning

From [clearstone_curator/src/lib.rs](/home/axtar-1/clearstone-fixed-yield/periphery/clearstone_curator/src/lib.rs):

```rust
pub struct ReallocateToMarket<'info> {
    #[account(mut)]
    pub curator: Signer<'info>,
    #[account(mut, has_one = curator, …)]
    pub vault: Box<Account<'info, CuratorVault>>,
    …
}
```

`has_one = curator` means only the wallet set as `vault.curator` at
`initialize_vault` time can call reallocate. `set_allocations`,
`harvest_fees` are gated the same way. `deposit`/`withdraw` require
only the user's signature. `mark_to_market` takes no signer.

**Consequence for the keeper:** whatever process calls reallocate
**must** sign with the curator keypair.

## 2. v1 operational model — curator hot-key

Run a lightweight keeper that holds a hot-key designated as curator:

```
operator
   │
   │  `initialize_vault` sets curator = HOT_KEY.pubkey
   │
   ▼
keeper process (this package)
   │  loads HOT_KEY from env/file
   │  polls backend-edge for maturities
   │  when a market matures:
   │     1. reallocate_from_market(matured_index, ...)
   │     2. reallocate_to_market(next_index, ...)
   │  signs with HOT_KEY, submits to RPC
   ▼
on-chain vault (clearstone_curator)
```

### Risk mitigations

- **Key rotation.** Curator key can be rotated by calling a bespoke
  `transfer_curator_authority` ix (not yet shipped — see §6 TODO).
  Meanwhile, treat HOT_KEY as short-lived: rotate monthly by
  redeploying the vault with a fresh curator.
- **Cold custody escalation.** Multisig the curator via Squads — the
  signer is a PDA of the multisig program. The keeper then holds a
  *proposer* key and the roll requires quorum. More latency,
  far less custody risk.
- **Action narrowness.** The keeper service here only ever calls
  `reallocate_from_market` and `reallocate_to_market` with on-chain
  state it can verify. Even with a compromised HOT_KEY, attacker
  options are bounded by:
  - `allocations` vec (set by `set_allocations` — also curator-signer,
    so attacker can also edit this).
  - The actual PT-market state on Kamino/clearstone_core.

The real blast radius of a compromised curator key: attacker can
`set_allocations` to a market they control, then `reallocate_to_market`
there. Mitigation: `set_allocations` itself should be on a different
key than the reallocation keeper. Current program doesn't split these;
add a `reallocation_authority` field as a v2 upgrade.

## 3. Operator deployment

### 3.1 Environment

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
CURATOR_KEYPAIR=/path/to/curator-hot-key.json
EDGE_URL=https://clearstone-edge.workers.dev
POLL_INTERVAL_SEC=60
```

### 3.2 Runtime

- One long-running process per curator. CPU/memory negligible.
- Deploy targets: Fly.io machine, a `systemd` unit, AWS Lambda (with a
  scheduler), a Kubernetes CronJob. Any of these work; the service is
  stateless.
- Log collection: stdout → whatever log aggregator. Every roll emits a
  structured `auto_roll.completed` event with `{vault, signature, matured_market, next_market, shares_rolled, slippage_bps}`.

### 3.3 Failure modes

| Failure | Detection | Retry |
|---|---|---|
| RPC rate-limit | `429` / `500` | exponential backoff, 30s–10m |
| Slippage bound hit | `0x…_SlippageExceeded` | skip this tick, re-try next poll |
| Curator key missing | process boot | fail fast with clear error |
| Stale blockhash | `BlockhashNotFound` | always fetch fresh before send |
| Market not yet matured | handler check | keeper filters client-side |

## 4. "Can the keeper use user-signed permission?"

**Short answer: not today.**

The three possible paths:

### Option A — Curator = Squads multisig (viable now, no code)

Operators replace the curator hot-key with a Squads multisig PDA.
Users don't sign anything, but the keeper has to propose each roll
and assemble quorum offline. Higher latency, much better custody
story. Zero on-chain change.

Good for institutional-tier vaults. Bad UX for retail "deposit and
forget."

### Option B — Session-key delegation (off-chain auth only)

Users sign a "sign-in with Solana" token at deposit time. An off-chain
keeper service accepts the token as proof that user X opted into
auto-roll. The on-chain signer is still the curator, but the *off-chain
keeper operator* uses user sigs to gate which positions roll.

This doesn't strengthen the protocol — the curator can still reroll
anyone's position. It's only useful if the operator wants a paper trail
of user intent, not a trustless enforcement.

Skippable for v1 given the curator-vault design already assumes users
opted in by depositing.

### Option C — User-signed `RollDelegation` PDA (proper fix, requires on-chain upgrade)

Add a new permissioning layer:

```rust
#[account]
pub struct RollDelegation {
    pub vault: Pubkey,
    pub user: Pubkey,
    /// Max slippage (bps) the user is willing to accept on any single roll.
    pub max_slippage_bps: u16,
    /// Last block this delegation is valid for.
    pub expires_at_slot: u64,
    /// Optional hash of the curator's `allocations` at signing time —
    /// if the curator changes allocations after the user signs, the
    /// delegation no longer applies.
    pub allocations_hash: [u8; 32],
}

/// Permissionless crank. Anyone pays gas; user-signed delegation
/// bounds what the crank can do.
pub fn crank_roll_delegated(
    ctx: Context<CrankRollDelegated>,
    from_index: u16,
    to_index: u16,
    min_base_out: u64,
) -> Result<()> {
    // 1. Delegation PDA is valid + not expired.
    // 2. Current allocations hash matches delegation.allocations_hash.
    // 3. Matured market in from_index; allocations[from_index] & [to_index] agree.
    // 4. Run reallocate_from + reallocate_to math bounded by min_base_out.
    // 5. Optional: pay a small crank tip to the keeper from idle.
}
```

User flow:
1. Deposit into curator vault (unchanged).
2. Sign a `RollDelegation` with their max-slippage + expiry.
3. Any keeper — run by the project, a third party, or the user
   themselves — can crank at maturity.

Properties this buys:
- **Permissionless keepers.** No single custody SPOF.
- **User-bounded slippage.** Curator can't sandwich the user.
- **Revocable.** User can close the delegation account any time.
- **Composable.** Keepers can batch multiple users' rolls into one tx.

Cost: ~200 LOC Rust in clearstone_curator + audit pass. Not this
ticket — open as `CURATOR_ROLL_DELEGATION` follow-up.

## 5. Recommended shipping order

1. **v1 (this PR).** Curator hot-key keeper. Production-usable with
   short key-rotation windows and Squads-multisig-as-curator for
   institutional tier.
2. **v1.5.** Split `curator` into `admin` + `reallocation_authority`
   on-chain — trivially contains a reallocation-key compromise to the
   reallocation scope only.
3. **v2.** Ship `RollDelegation` + `crank_roll_delegated`. Keeper
   becomes a permissionless bounty-paid service.

## 6. TODOs opened by this doc

- `CURATOR_TRANSFER_AUTHORITY` — new ix to rotate curator key without
  redeploying the vault.
- `CURATOR_SPLIT_AUTHORITY` — distinct `admin` vs
  `reallocation_authority` fields.
- `CURATOR_ROLL_DELEGATION` — v2 permissioning per §4C.
