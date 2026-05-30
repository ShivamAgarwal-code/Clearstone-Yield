# Fix the per-asset decimals bug in `PositionsPage.tsx`

> **Status: ✅ DONE.** `decimals` field added to `CollateralAsset`, all
> sites converted from `1e6` to `10 ** asset.decimals` (deposit/borrow
> decode, wallet balance read, handleDeposit / handleWithdraw BigInt
> conversion). Surviving `1e6` literals are USDC/ceUSX paths only,
> which are correctly 6-decimal. This file is kept for context — safe
> to delete.

## Symptom

WT collaterals (and any SOL-denominated reserve: `csSOL`, `csSOL-WT`,
`cSOL`) render in the UI with **1000× the correct denomination**, e.g.
a wallet balance of `0.0054 csSOL-WT` displays as `5.40`. The same
bug also corrupts the deposit / withdraw amounts sent on-chain — the
`BigInt` conversion uses `1e6`, so a user typing `5.40` actually
submits `5_400_000` raw lamports (i.e. `0.0054` of a 9-decimal mint
instead of `5.40`). The deposit will then revert at the LTV check
because the value is essentially zero.

## Root cause

[`packages/frontend-institutional/src/pages/PositionsPage.tsx`](src/pages/PositionsPage.tsx)
hardcodes `1e6` everywhere instead of reading the per-asset decimal
count. `DEVNET_CONFIG.tokens` already has the correct value
(`csSOL`, `csSOL-WT`, `cSOL` are `decimals: 9`; `ceUSX`, `ceUSX-WT`,
`sUSDC`, `USDC` are `decimals: 6`), but `COLLATERAL_ASSETS` in
`PositionsPage.tsx` doesn't carry it, so every conversion silently
assumes 6.

## Fix

### 1. Add `decimals` to `CollateralAsset`

```ts
interface CollateralAsset {
  symbol: string;
  mint: PublicKey;
  reserve: PublicKey;
  oracle: PublicKey;
  tokenProgram: PublicKey;
  price: number;
  decimals: number;       // <-- new
  yieldApy?: string;
  pending?: boolean;
  isWithdrawTicket?: boolean;
}
```

### 2. Set the right value on every entry of `COLLATERAL_ASSETS`

| Symbol     | Decimals |
| ---------- | -------- |
| `ceUSX`    | 6        |
| `csSOL`    | 9        |
| `csSOL-WT` | 9        |
| `ceUSX-WT` | 6        |
| `cSOL`     | 9        |
| `sUSDC`    | 6        |

(Cross-check against `DEVNET_CONFIG.tokens[*].decimals` —
they are the source of truth.)

### 3. Replace every literal `1e6` with `10 ** asset.decimals`

Search for `1e6` in `PositionsPage.tsx` and replace at all of these
sites:

- `loadPosition` — the deposit / borrow amount decode
  (`Number(data.readBigUInt64LE(...)) / 1e6` ×2). The reserve being
  read is identifiable via `RESERVE_META[addr]` — extend
  `RESERVE_META` to also store decimals so the decode can find the
  right divisor.
- `loadPosition` — wallet-balance read for each collateral asset
  (`Number(ai.data.readBigUInt64LE(64)) / 1e6`). Use `asset.decimals`.
- `loadPosition` — USDC wallet-balance read. Stays `1e6` (USDC = 6).
- `loadPosition` — reserve `available` decode for the borrow side
  (currently divides by `1e6`; the borrow reserve is sUSDC, so leave
  as is, but add a comment so a future debt-asset switch doesn't
  silently break).
- `handleDeposit` — `BigInt(Math.floor(parseFloat(depositAmt) * 1e6))`.
  Use `asset.decimals`.
- `handleWithdraw` — same `BigInt(...)` conversion.
- `handleBorrow` / `handleRepay` — these only ever touch USDC today,
  so they can stay `1e6`, but add a comment pinning the
  assumption.
- `handleConvertCeusx` / `handleUnwindCeusxWt` — they pass a 6-decimal
  amount (ceUSX is 6); leave as is, but add a comment.

### 4. Fix the table-row formatters

`dep.amount.toFixed(2)` and `walBal.toFixed(2)` in the Collateral
table show too few digits for SOL-denominated assets. Use
`Math.min(4, asset.decimals)` decimal places — 4 for csSOL family,
2 for stables.

## Sanity check after fixing

1. With a wallet that has e.g. `0.05 csSOL`, the Collateral row should
   show `0.0500` deposited and `0.0000` wallet (or the actual amount,
   not 50.0000).
2. Depositing `0.01 csSOL-WT` should raise on-chain `deposited_amount`
   by `10_000_000` (= 0.01 × 10^9), not by `10_000` (= 0.01 × 10^6).
3. The redemption convert flow (`handleConvertCeusx`) is unaffected —
   ceUSX is 6 decimals.

## Tests

There are no automated tests for `PositionsPage` today; verify
manually on devnet against a wallet with mixed-decimal collateral.
