# csSOL Withdrawal — Jito Vault Unstake via Collateral Swap

This document covers the architecture and on-chain flow for unwinding a
leveraged csSOL position back to native SOL while keeping the user
leveraged through Jito's epoch-locked unstake window.

The naive way to exit a leveraged csSOL position would be: repay debt
first, withdraw csSOL collateral, enqueue a Jito withdrawal, wait for
the epoch, then redeem to wSOL. That forces the user to deleverage
during the wait. Our flow keeps the position leveraged the entire time
by representing the pending Jito ticket as a tradable klend collateral
asset (`csSOL-WT`) and atomically swapping `csSOL → csSOL-WT` inside
klend's obligation via a flash-loan trick.

## Asset map

| Asset | Mint | Token program | Role |
|---|---|---|---|
| `wSOL` | `So11111111111111111111111111111111111111112` | SPL Token | Native; debt asset on the credit-trade obligation |
| Jito VRT | from vault config | SPL Token | Pool's internal LST exposure; never user-facing |
| `csSOL` | `6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt` | Token-2022 | KYC-wrapped Jito VRT exposure; user collateral |
| **`csSOL-WT`** | `8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva` | Token-2022 | KYC-wrapped *pending* Jito unstake; placeholder collateral during the epoch wait |

The trick: csSOL and csSOL-WT both sit in elevation group 2 (LST/SOL,
90% LTV / 92% liq) on the v3 klend market. Klend's
`max_reserves_as_collateral = 2` for that group means the obligation
can briefly hold both during a single tx — that's the window in which
the swap happens.

## Architecture

```
┌──────────────────────┐
│  csSOL host pool     │  PDA seeded [b"pool", wSOL_mint], owns:
│  (governor program)  │   - csSOL MintConfig.authority
│  QoR6KX…D9e          │   - csSOL-WT MintConfig.authority
│                      │   - withdraw_queue PDA (ticket bookkeeping)
│                      │   - pool_pending_wsol ATA (matured wSOL)
└─────────┬────────────┘
          │
          ├─ enqueue_withdraw_via_pool ─┐
          │                              │
          │  CPI Jito.EnqueueWithdrawal  │
          │  CPI delta-mint.mint_to(WT)  │
          │  Append to withdraw_queue    │
          │                              ▼
          │                    ┌───────────────────┐
          │                    │ Jito ticket PDA   │
          │                    │ (epoch-locked)    │
          │                    └─────────┬─────────┘
          │                              │  matures at
          │                              │  unstake_epoch + 2
          │                              ▼
          ├─ mature_withdrawal_tickets ──┐
          │                              │
          │  CPI Jito.BurnWithdrawalTicket  → wSOL into pool_pending_wsol
          │  Mark queue entry redeemed
          │
          └─ redeem_cssol_wt
             Burn user's csSOL-WT
             Transfer pool_pending_wsol → user wSOL ATA
```

## Klend reserves in the v3 market

| Reserve | Address | Token program | Role |
|---|---|---|---|
| csSOL | `eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w` | Token-2022 | EG-2 collateral |
| wSOL | `CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8` | SPL Token | EG-2 debt |
| **csSOL-WT** | `94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw` | Token-2022 | EG-2 collateral (atomic swap target) |

EG-2 config:
- `ltv_pct = 90`, `liquidation_threshold_pct = 92`
- `max_reserves_as_collateral = 2`
- `debt_reserve = wSOL`
- `collateral = [csSOL, csSOL-WT]`
- mode-45 per-collateral borrow caps for csSOL-WT against wSOL = `u64::MAX`

## Convert: csSOL → csSOL-WT (atomic, single tx)

User has X csSOL collateral, Y wSOL debt. They click **Convert** to
start the Jito unstake. The bridge asset is **wSOL** (the *output*
asset of the position) — not csSOL-WT. Routing through wSOL means we
don't need pre-seeded flash inventory on the WT reserve; klend's wSOL
reserve has orders of magnitude more flash-borrowable liquidity, and
any klend depositor can permissionlessly grow it.

```
1. ComputeBudget                                      ← CU price + 1.4M limit
2. ATA creates                                        ← user wSOL ATA, csSOL-WT ATA, ticket VRT ATA, …
3. klend.flash_borrow_reserve_liquidity(wSOL, Y)
4. klend.refresh chain                                ← N-2/N-1 for repay
5. klend.repay_obligation_liquidity(wSOL, Y)          ← obligation: [csSOL], 0 debt
6. klend.refresh chain                                ← N-2/N-1 for withdraw
7. klend.withdraw_obligation_collateral_and_redeem(csSOL, X)
                                                      ← obligation: [csSOL-X] (or empty if full)
8. governor.enqueue_withdraw_via_pool(X)
                                                      ├ burns X csSOL from user (Token-2022)
                                                      ├ transfers X VRT pool→user (PDA-signed)
                                                      ├ CPI Jito.EnqueueWithdrawal
                                                      │   - staker = user (system-owned, funds ticket rent)
                                                      │   - base PDA = [b"wt_base", pool, queue.total_minted]
                                                      │     (different per-enqueue, signed via invoke_signed)
                                                      │   - burn_signer = pool_pda (vault's mint_burn_admin)
                                                      ├ CPI delta-mint.mint_to(csSOL-WT, X) to user
                                                      └ append ticket to withdraw_queue (pool PDA)
9. klend.refresh chain                                ← N-2/N-1 for deposit_collateral
10. klend.deposit_obligation_collateral(csSOL-WT, X)  ← obligation: [csSOL-X, WT] (or [WT])
11. klend.request_elevation_group(2)                  ← only if EG was dropped (rare)
12. klend.refresh chain                               ← N-2/N-1 for borrow
13. klend.borrow_obligation_liquidity(wSOL, Y)        ← obligation: [..., WT], debt=Y
14. klend.flash_repay_reserve_liquidity(wSOL, Y)
```

After this tx the user holds:
- 0 csSOL (burned)
- X csSOL-WT in klend collateral (replacing the burned csSOL)
- Y wSOL debt (unchanged)
- Health factor ≈ unchanged because csSOL and csSOL-WT have identical
  EG-2 config

Notes on the refresh discipline:
- klend's repay/borrow handler requires every obligation deposit reserve
  appended as remaining_accounts when EG > 0 (mirrors klend SDK
  `addRepayIx` action.ts:1577). Same rule for `borrow`.
- klend's `refresh_obligation` expects deposits + borrows in its
  remaining_accounts — passing only deposits trips InvalidAccountInput
  (6006). The borrow slot persists with zero amount until the borrow ix
  in step 13 overwrites it, so all post-repay refreshes must still
  include `[wSOL]` as the borrow reserve.
- After every klend ix that writes a reserve (flash_borrow / repay /
  withdraw / deposit / borrow), that reserve must be re-refreshed before
  the next refresh_obligation that iterates it — otherwise klend trips
  ReserveStale (6009).
- klend does NOT drop the elevation group when the borrow slot survives
  at zero balance, so `request_elevation_group` only fires when the
  obligation was actually dropped out of EG-2 (currently a no-op, kept
  for resilience against future klend versions).

## Wait state

The Jito ticket lives at a per-enqueue PDA seeded by the governor's
`base` PDA + the queue nonce. Its `unstake_epoch + 2` is when Jito
allows the burn. While waiting:

- The user can't withdraw their csSOL-WT collateral (LTV would
  collapse) — the position stays leveraged
- The csSOL-WT oracle prices it at `min(csSOL_price * (1 - epoch_discount),
  pool.pending_wsol_total / cssol_wt_supply * SOL_USD)` so an
  adversarial epoch-buying attack drops the WT mark and triggers normal
  liquidation
- Anyone can call `mature_withdrawal_tickets` once an entry is
  redeemable; it CPIs `Jito.BurnWithdrawalTicket` (pool PDA signs as
  `staker` + `burn_signer`), and the matured wSOL flows into
  `pool_pending_wsol` — pool-wide, not per-user

## Unwind: csSOL-WT → wSOL → debt repay (atomic, single tx)

After at least one matched ticket has matured (`pool.pending_wsol > 0`):

```
1. ComputeBudget
2. ATA creates                          ← user wSOL ATA
3. klend.flash_borrow_reserve_liquidity(wSOL, Y)         ← borrow to repay debt
4. klend.repay_obligation_liquidity(wSOL, Y)
5. klend.refresh chain
6. klend.withdraw_obligation_collateral_and_redeem(csSOL-WT, X)
                                                          ← user receives csSOL-WT
7. governor.redeem_cssol_wt(X)
                                        ├ checks pool.pending_wsol >= X
                                        ├ burns X csSOL-WT from user
                                        ├ transfers X wSOL pool→user (PDA-signed)
                                        └ withdraw_queue.pending_wsol -= X
8. klend.flash_repay_reserve_liquidity(wSOL, Y)         ← uses claimed wSOL
9. (optional) closeAccount(user wSOL ATA)               ← residual returns native SOL
```

Net effect: user paid Y wSOL of debt + walked away with `(X - Y)` wSOL
margin (or however much equity remained).

## Key invariants

1. **WT supply ≤ in-flight Jito tickets.** Every WT is minted inside
   `enqueue_withdraw_via_pool` paired 1:1 with a Jito ticket PDA in the
   queue. No other path can mint csSOL-WT; the MintConfig.authority is
   the pool PDA, only this ix CPIs delta-mint.mint_to.
2. **Pending wSOL ≥ in-flight WT supply.** As tickets mature,
   `pool.pending_wsol` grows; as users redeem, it shrinks. The
   `redeem_cssol_wt` ix gates on `pending_wsol >= amount` — a user
   trying to unwind before their ticket matures fails fast.
3. **Queue cap.** `MAX_WITHDRAW_QUEUE_TICKETS = 120`, total account
   size 9789 bytes (under Anchor's 10240-byte realloc cap). At cap,
   new enqueues reject until matured tickets are reaped.

## Whitelisting

csSOL and csSOL-WT live under separate delta-mint MintConfigs. A wallet
whitelisted on csSOL still needs a separate whitelist entry on the
csSOL-WT MintConfig before `enqueue_withdraw_via_pool` can mint them
csSOL-WT. The pool PDA is the WT MintConfig's `co_authority`, so
whitelisting flows through the governor's
`add_wt_participant_via_pool` ix:

```bash
DEPLOY_KEYPAIR=$HOME/.config/solana/clearstone-devnet.json \
  DM_MINT_CONFIG=<wt_mint_config> \
  npx tsx scripts/whitelist-wallet.ts <wallet>
```

The script auto-routes to `add_wt_participant_via_pool` when
`DM_MINT_CONFIG` is set; without it, it uses the primary
`add_participant_via_pool` (which is pinned to the csSOL MintConfig).
The unwind tab surfaces a banner when the connected wallet's WT
whitelist entry is missing.

## Per-enqueue PDA: the `base` keypair pattern

Jito's `EnqueueWithdrawal` ix needs a `base` account whose pubkey is
unique per enqueue (the ticket PDA is `find(["VaultStakerWithdrawalTicket",
vault, base])`). The csSOL governor uses a **deterministic `base` PDA**:

```rust
seeds = [b"wt_base", pool_config, withdraw_queue.total_cssol_wt_minted.to_le_bytes()]
```

This replaces the v1 ephemeral-keypair pattern (where the user
generated a fresh keypair off-chain and signed with it). The
deterministic PDA means:
- No off-chain keypair gymnastics
- Replay-safe (the nonce advances on every successful enqueue)
- The governor can `invoke_signed` for it without requiring the user
  to know its private key (it has none)

## Address reference

- Governor program: `6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi`
- Delta-mint program: `BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy`
- csSOL pool PDA (host): `QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e`
- Jito Vault program: `Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8`
  - `MintTo` disc: `11`
  - `EnqueueWithdrawal` disc: `12`
  - `BurnWithdrawalTicket` disc: `14`
- v3 klend market: `EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E`
- LUT (compresses static accounts for the open/unwind txs):
  `GsQd5QNJUoSgxeUYKiyciiyoXNo4ozNJsxN1Fp1rXG9y`

## Source

- Rust ixes: [`programs/governor/src/lib.rs`](programs/governor/src/lib.rs)
  - `enqueue_withdraw_via_pool` (line ~1009)
  - `mature_withdrawal_tickets` (line ~1202)
  - `redeem_cssol_wt` (line ~1322)
- Setup scripts:
  - [`scripts/setup-cssol-wt-mint.ts`](scripts/setup-cssol-wt-mint.ts) — Token-2022 mint + MintConfig
  - [`scripts/setup-cssol-wt-reserve.ts`](scripts/setup-cssol-wt-reserve.ts) — klend reserve + EG-2 wiring
  - [`scripts/init-cssol-wt-oracle.ts`](scripts/init-cssol-wt-oracle.ts) — accrual oracle keeper
  - [`scripts/init-credit-trade-lut.ts`](scripts/init-credit-trade-lut.ts) — LUT for the open/unwind txs
