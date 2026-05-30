# ceUSX Withdrawal — Solstice YieldVault Unstake via Collateral Swap

This document covers the architecture and on-chain flow for unwinding a
leveraged ceUSX position back to USDC while keeping the user leveraged
through Solstice's asynchronous unlock window.

The pattern mirrors [CSSOL_WITHDRAWAL.md](CSSOL_WITHDRAWAL.md) — only
the underlying redemption-source differs: Jito's epoch-locked unstake
becomes Solstice's pending-unlock PDA + separate `Withdraw` claim ix,
and there's an extra `RequestRedeem`/`ConfirmRedeem` step at the end
to convert the claimed USX into USDC. The collateral-swap mechanics
inside klend are identical.

## Asset map

| Asset | Mint | Token program | Role |
|---|---|---|---|
| USDC (sUSDC) | `8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g` | SPL Token | Solstice devnet USDC; debt asset on the credit-trade obligation |
| USX | `7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS` | SPL Token | Solstice stablecoin (1:1 backed); transient between Solstice ixes |
| eUSX | `Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt` | SPL Token | Yield-bearing USX (~10% APY mainnet, 1:1 on devnet) |
| `ceUSX` | `8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT` | Token-2022 | KYC-wrapped eUSX; user collateral |
| **`ceUSX-WT`** | `DoHMuKFU4b2co2CBBcNjVzWf6yL3KG5H2N9FxkfFFN6A` | Token-2022 | KYC-wrapped *pending* Solstice unlock; placeholder collateral during the wait |

Both ceUSX and ceUSX-WT live in elevation group 1 (Stables, 90% LTV /
92% liq) on the v3 klend market. Klend's `max_reserves_as_collateral
= 2` for that group means the obligation can briefly hold both during
the swap.

## Why the WT exists

Solstice's YieldVault has an **asynchronous unlock pattern** —
fundamentally different from a sync token redeem:

1. `Lock(amount_usx)` — synchronous: pulls USX from user, mints eUSX
   1:1
2. `Unlock(amount_eusx)` — burns eUSX from user's ATA, **does not**
   mint USX. Instead it credits the user's pending-unlock PDA with the
   amount and an unlock-after timestamp/slot.
3. `Withdraw()` — **separate ix**, callable after the wait period.
   No amount arg (claims the full pending). Mints USX from the vault's
   USX vault into the user's USX ATA, closes the pending PDA.

This means Unlock + Withdraw can't be in the same tx — there's
necessarily a wait between them. We discovered the wait empirically by
running an Unlock and observing that the user's USX balance stayed at
zero until the Withdraw ix landed at a later slot.

Without the WT, a leveraged user would have to deleverage (repay debt
→ withdraw ceUSX → unwrap → unlock → wait → claim → redeem) before
the unlock window opens. The ceUSX-WT collateral swap lets them stay
leveraged through the wait by replacing their ceUSX collateral with an
equivalent ceUSX-WT collateral that represents the queued Solstice
claim.

## Architecture

```
┌──────────────────────┐
│  cSOL host pool      │  Acts as MintConfig.authority for ceUSX-WT
│  (governor program)  │  (ceUSX-WT has no dedicated pool — reuses the
│  7LrzKp9…CeFbX       │   stables-side cSOL pool, same idiom as csSOL-WT
│                      │   reusing the csSOL pool for its own MintConfig)
└─────────┬────────────┘
          │
          ├─ enqueue_eusx_unlock_via_pool ─┐
          │                                 │
          │  CPI Solstice.Unlock(amount)    │   (13-account list from sample)
          │  CPI delta-mint.mint_to(WT)     │
          │                                 ▼
          │                       ┌──────────────────────────┐
          │                       │ user pending-unlock PDA  │
          │                       │ (writable, async timer)  │
          │                       └─────────┬────────────────┘
          │                                 │  matures at
          │                                 │  unlock_after timestamp/slot
          │                                 ▼
          └─ redeem_ceusx_wt
             Burn user's ceUSX-WT
             CPI Solstice.Withdraw  → user's USX ATA fills
             (then user signs Solstice RequestRedeem + ConfirmRedeem
              top-level in the same tx → USDC)
```

## Klend reserves in the v3 market

| Reserve | Address | Token program | Role |
|---|---|---|---|
| ceUSX | `88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU` | Token-2022 | EG-1 collateral |
| sUSDC | `78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9` | SPL Token | EG-1 debt |
| **ceUSX-WT** | `GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq` | Token-2022 | EG-1 collateral (atomic swap target) |

EG-1 config:
- `ltv_pct = 90`, `liquidation_threshold_pct = 92`
- `max_reserves_as_collateral = 2`
- `debt_reserve = sUSDC`
- `collateral = [ceUSX, ceUSX-WT]`
- mode-45 per-collateral borrow caps for ceUSX-WT (slot index `EG-1
  group_id - 1 = 0`) = `u64::MAX`

## Convert: ceUSX → ceUSX-WT (atomic, single tx)

User has X ceUSX collateral, Y sUSDC debt. They click **Convert** to
queue a Solstice unlock. The flow has TWO governor CPIs (legacy
governor for ceUSX→eUSX; new governor for the atomic CPI bundle):

```
1. ComputeBudget
2. ATA creates                          ← eUSX, USX, ceUSX-WT ATAs
3. klend.flash_borrow_reserve_liquidity(ceUSX-WT, X)
4. klend.deposit_obligation_collateral(ceUSX-WT, X)   ← obligation now [ceUSX, ceUSX-WT]
5. klend.refresh chain
6. klend.withdraw_obligation_collateral_and_redeem(ceUSX, X)
                                        ← obligation back to [ceUSX-WT] only
7. legacy_governor.unwrap(ceUSX → eUSX, X)
                                        ← burns ceUSX, transfers eUSX from
                                          legacy eUSX pool to user
8. governor.enqueue_eusx_unlock_via_pool(X)
                                        ├ runtime check: ceUSX-WT MintConfig.authority
                                        │  == cSOL pool PDA (this pool)
                                        ├ CPI Solstice.Unlock (disc 0x1513d02bed3eff57)
                                        │   - 13 accounts incl. user signer, vault state,
                                        │     vault eUSX vault, eUSX/USX mints, two
                                        │     per-vault config PDAs, two per-user PDAs
                                        │     (pending unlock + redeemable tracker), Token,
                                        │     System
                                        │   - effect: burns user's eUSX, queues amount in
                                        │     pending-unlock PDA
                                        └ CPI delta-mint.mint_to(ceUSX-WT, X) to user
                                          - signed by cSOL pool PDA (MintConfig authority)
9. klend.flash_repay_reserve_liquidity(ceUSX-WT, X)    ← uses freshly-minted WT
```

After this tx the user holds:
- 0 ceUSX, 0 eUSX (burned through the chain)
- X ceUSX-WT in klend collateral (replacing the burned ceUSX)
- Y sUSDC debt (unchanged)
- A pending-unlock PDA on Solstice with X queued USX
- Health factor ≈ unchanged (ceUSX-WT and ceUSX share EG-1 config)

## Wait state

Unlike csSOL's deterministic epoch boundary (Jito), Solstice's
pending-unlock PDA has a `unlock_after` field whose semantics we don't
have an IDL for. Empirically:

- Devnet: an Unlock submitted on day N had not matured by day N+1
  (manual `Withdraw` call hadn't been triggered to verify, but USX was
  not yet in the wallet)
- Mainnet: likely 24h+ to align with regulated stablecoin redemption
  windows

The user is leveraged the entire time via the ceUSX-WT collateral. The
`pending_unlock_pda` is per-user and Solstice-owned — we don't poke it
directly except to read the queued amount + maturity for UI display.

## Unwind: ceUSX-WT → USX → USDC → debt repay (atomic, single tx)

After the user's pending-unlock PDA has matured:

```
1. ComputeBudget
2. ATA creates                          ← USX, USDC ATAs
3. klend.flash_borrow_reserve_liquidity(sUSDC, Y)         ← borrow to repay debt
4. klend.repay_obligation_liquidity(sUSDC, Y)
5. klend.refresh chain
6. klend.withdraw_obligation_collateral_and_redeem(ceUSX-WT, X)
                                                          ← user receives ceUSX-WT
7. governor.redeem_ceusx_wt(X)
                                        ├ Token-2022 burn ceUSX-WT from user
                                        └ CPI Solstice.Withdraw (disc 0xb712469c946da122)
                                          - 8 accounts incl. user signer, vault state,
                                            USX mint, user's pending PDA, user USX ATA,
                                            vault USX vault, Token program
                                          - no amount arg (claims full pending)
                                          - effect: vault USX → user USX ATA
8. solstice.RequestRedeem(amount, user) [from API]        ← top-level user-signed
9. solstice.ConfirmRedeem(user) [from API]                ← top-level user-signed
                                                            (turns USX → USDC,
                                                            sUSDC lands in user ATA)
10. klend.flash_repay_reserve_liquidity(sUSDC, Y)         ← uses redeemed USDC
11. (optional) closeAccount(user wSOL ATA)
```

Net effect: user paid Y sUSDC of debt + walked away with `(X - Y)`
sUSDC margin.

## Key invariants

1. **WT supply ≤ in-flight Solstice queued USX.** Every ceUSX-WT is
   minted inside `enqueue_eusx_unlock_via_pool` paired 1:1 with a
   Solstice `Unlock` CPI for the same amount, in the same ix. No other
   path can mint ceUSX-WT for users — the MintConfig.authority is the
   cSOL pool PDA, which only signs delta-mint.mint_to inside this ix.
   (`admin_mint_wt` is a bootstrap-only sibling, gated to root or admin
   authority on the cSOL pool, used once to seed the klend reserve.)
2. **No "uncovered" WT.** A user trying to call `redeem_ceusx_wt`
   without a matured pending-unlock PDA fails inside the Solstice
   `Withdraw` CPI — Solstice's program enforces the wait/maturity
   check. The governor adds nothing on top.
3. **No queue PDA needed on the governor side.** Unlike csSOL where
   the governor's `withdraw_queue` tracks each ticket so anyone can
   `mature_withdrawal_tickets` permissionlessly, Solstice manages the
   per-user pending PDA itself. The governor stays stateless re:
   pending unlocks.

## Differences vs csSOL flow

| Concern | csSOL (Jito) | ceUSX (Solstice) |
|---|---|---|
| Wait mechanism | Jito epoch boundary (~minutes devnet, ~1–2 days mainnet) | Solstice unlock_after (read from pending PDA, exact length unknown) |
| Ticket ownership | Custom Jito `VaultStakerWithdrawalTicket` PDA per enqueue (governor uses deterministic `base` PDAs) | Solstice's per-user pending-unlock PDA (one per user, shared across all their unlocks) |
| Queue tracking | governor `withdraw_queue` PDA (120-ticket cap) | none — Solstice tracks state on its own PDA |
| Maturity ix | `mature_withdrawal_tickets` (permissionless reaper, transfers wSOL to pool) | none — `Withdraw` is the maturity-and-claim ix in one |
| Final asset | wSOL (1 step from ticket) | USDC (3 steps: Withdraw → RequestRedeem → ConfirmRedeem) |
| Unwind ix count | 1 governor ix (`redeem_cssol_wt`) | 1 governor ix (`redeem_ceusx_wt`) + 2 top-level Solstice API ixes |

## Address reference

- Governor program: `6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi`
- Delta-mint program: `BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy`
- Legacy governor program (eUSX `unwrap`):
  `BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh`
- Legacy delta-mint program (eUSX MintConfig):
  `13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn`
- cSOL pool PDA (ceUSX-WT MintConfig host):
  `7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ`
- Solstice USX program: `usxTTTgAJS1Cr6GTFnNRnNqtCbQKQXcUTvguz3UuwBD`
- Solstice YieldVault program:
  `euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr`
- YieldVault state (devnet): `6qaXkxV8mKV13MP4VoLcBVstR94xhB8u8ctjCt8RWXgM`
- v3 klend market: `EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E`

## Discriminators (extracted from on-chain samples — see /tmp/usx-idl/samples/)

| Ix | Program | Disc (hex LE) | Args |
|---|---|---|---|
| `Lock` | YieldVault | `0x1513d02bed3eff57` | u64 amount |
| `Unlock` | YieldVault | `0x659b28159ebd38cb` | u64 amount |
| `Withdraw` (claim) | YieldVault | `0xb712469c946da122` | none |
| `RequestMint` | USX | `0x82261b452ed38791` | u64 amount |
| `ConfirmMint` | USX | `0x0d5d451bcb5b9516` | none |
| `RequestRedeem` | USX | `0x69312c26cff121ad` | u64 amount |
| `ConfirmRedeem` | USX | `0x5565733915c3a64e` | none |

## Source

- Rust ixes: [`programs/governor/src/lib.rs`](programs/governor/src/lib.rs)
  - `enqueue_eusx_unlock_via_pool` (Solstice `Unlock` + ceUSX-WT mint)
  - `redeem_ceusx_wt` (ceUSX-WT burn + Solstice `Withdraw`)
  - `admin_mint_wt` (bootstrap-only seed-mint for klend reserve init)
- Setup scripts:
  - [`scripts/setup-ceusx-wt-mint.ts`](scripts/setup-ceusx-wt-mint.ts) — Token-2022 mint + MintConfig with cSOL pool PDA as authority
  - [`scripts/setup-ceusx-wt-reserve.ts`](scripts/setup-ceusx-wt-reserve.ts) — klend reserve + EG-1 wiring + mode-45 per-collateral cap
  - [`scripts/seed-ceusx-wt.ts`](scripts/seed-ceusx-wt.ts) — one-shot bootstrap mint via `admin_mint_wt`

## Open work

- Frontend builders (`eusxConvertWt.ts`) for the convert + unwind tx
  assembly
- Solstice-flow LUT extension to compress the ~30 static accounts
  (vault state, mints, programs, sysvars) so both txs fit under 1232
  bytes
- `CreditTradeEusxPanel` Convert/Wait/Unwind 3-step UI mirroring
  `CreditTradeTab` close mechanic
- ceUSX-WT accrual oracle keeper (currently the reserve uses the ceUSX
  oracle directly as a fallback — fine on devnet at 1:1, needs a
  pool-backing-discount oracle for mainnet liquidation safety)
- End-to-end devnet test; expect to debug Solstice CPI account
  orderings on first run since we don't have an IDL
