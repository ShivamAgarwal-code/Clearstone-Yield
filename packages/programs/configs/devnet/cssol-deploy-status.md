# csSOL devnet deploy — complete (2026-04-27)

## Live on-chain state

| Component | Address |
|---|---|
| accrual_oracle program | `8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec` |
| Accrual output (csSOL price feed) | `3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P` |
| FeedConfig PDA (rate=0, source=Pyth Receiver, feed_id=SOL/USD) | `6ZhhrkGkN91zz6qPu4n3YmyMCFA7hoPYpj5jtzvkF1JM` |
| Pyth SOL/USD push feed (live source) | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| Governor csSOL pool (elevation_group=2) | `QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e` |
| Pool authority | `DiDbnkw2tYL8K1M5ndLdSHWaeXr53kcKyDyS7SiuDcFn` |
| csSOL Token-2022 mint | `6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt` |
| Klend lending market | `2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW` |
| Lending-market owner / klend builder | `AhKNmBmaeq6XrrEyGnSQne3WeU4SoN7hSAGieTiqPaJX` |
| csSOL collateral reserve | `Ez1axBhD6M6t1Zmzfz8MQ95Kmuc48BuoYhQEEHEhT4U1` |
| wSOL borrow reserve | `4RvKrQVTdgvGEf75yvZE9JwzG4rZJrbstNcvVoXrkZ8o` |
| Elevation group 2 (lst-sol, debt=wSOL, ltv 90%, lt 92%, max-liq-bonus 100 bps) | registered on market |
| Last refresh tx (sample) | `5zpeaCtUtdM7UBonaDsvW2ujReFVthGTSShwMEsTwdzXYTK2e4N5U1pjbNovDXfHVPLfeeAdRMF9DZu432XMRcch` |
| Final register tx | `545Yzw5gcz6mM4DKZei2JaGLtg4fPndKkVNTN8tsAx6J1mQyW7R18dvxAZVqKboxseFLqLG4dvXRpY9D7VppvUac` |

The accrual oracle wraps the live `7UVi…` Pyth feed with the time-based index
described in `programs/accrual-oracle/src/lib.rs`. With `rate_bps_per_year = 0`
the output equals SOL/USD exactly; the keeper Worker just needs to bump
`publish_time` so klend's `maxAgePriceSeconds` (10 min) doesn't go stale.

## Two-signer split (kept for future runs)

`setup-cssol-market.ts` operates against klend, which permissions a subset of
`UpdateConfigMode` variants to its protocol global admin
(`GLOBAL_ADMIN_ONLY_MODES` in `klend-sdk/classes/reserve.ts`). Our deploy
goes through the path that requires the **lending-market owner = a klend
allowlisted wallet** for steps 1–4; in this devnet that's `AhKNmBma…`
(`~/.config/solana/id.json`). The governor pool was created with authority
`DiDbnkw…` (`~/.config/solana/clearstone-devnet.json`), so the final
`register_lending_market` ix needs that keypair instead.

The script reads `POOL_AUTHORITY_KEYPAIR` to handle this:

```bash
DEPLOY_KEYPAIR=~/.config/solana/id.json \
POOL_AUTHORITY_KEYPAIR=~/.config/solana/clearstone-devnet.json \
  npx tsx scripts/setup-cssol-market.ts
```

When `POOL_AUTHORITY_KEYPAIR` is unset (single-signer environments), the
script falls back to the same wallet that signed klend ops.

## Why earlier runs failed (recorded for reference)

1. **`UpdateBorrowLimitsInElevationGroupAgainstThisReserve` (mode 45)** — was
   wrongly mapped as `UpdateElevationGroups` on the first attempt. Borsh
   rejected the 20-byte payload (expected 256 bytes for the `[u64; 32]`
   array). Fixed: correct mode is **34** (`UpdateElevationGroup`), 20-byte
   `[u8; 20]` array.
2. **`InvalidElevationGroup` on `UpdateDepositLimit`** — phase-2
   integrity check ran while reserves had `elevationGroups[0] == 2` but
   group 2 wasn't yet registered on the market. Fixed by splitting the
   reserve-config flow into phase-1 (basic params, skip=true), market-level
   `UpdateElevationGroup` registration, then phase-2 (group membership +
   limits + final integrity check).
3. **`Invalid max liquidation bonus in elevation group 2`** — group's
   `maxLiquidationBonusBps` was 300, exceeding the reserve's default `0`
   max bonus. Fixed by adding `Update{Min,Max,BadDebt}LiquidationBonusBps`
   modes to phase-1 so the reserve carries 200/500/99 bps before group 2
   registration; group's bonus lowered to 100.
4. **`InvalidSigner` (custom error 6005)** — root cause: I had included
   `UpdateProtocolLiquidationFee` (mode 3) in phase-1. That mode is in
   klend's `GLOBAL_ADMIN_ONLY_MODES` list — only Kamino's protocol global
   admin can call it. klend rejects with `InvalidSigner` regardless of who
   signs. Fixed by removing the mode from phase-1; klend keeps the
   `init_reserve` default for protocol fees.
5. **`ConstraintHasOne` on `register_lending_market`** — the governor pool's
   `authority` (DiDbnkw, set by `initialize_pool`) didn't match the klend
   builder signer (AhKNmBma). Fixed by adding `POOL_AUTHORITY_KEYPAIR`
   support so the script can sign the final governor ix with the right
   keypair.

## Stale on-chain markets (rent burned, not recoverable)

| Run | Market | Reason |
|---|---|---|
| 1 | `5swpy9yxbSciH3k2fSt8qwogSjCHsbwu3AD6vqPHrN11` | wrong mode 45 mapping |
| 2 | `8vX4vjWfj6MZACDfLXLScTBejv1mitQDjRjovwvxMceY` | InvalidElevationGroup |
| 3 | `AkdLqboCXaFefvtEw2mbBqqdAGLubsiqSMZ2taDwW728` | InvalidSigner (DiDbnkw + globalAdmin-only mode 3) |
| 4 | `2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW` | **WORKING — current production market** |

Each stale market holds ~0.04 SOL rent + 2 reserves at ~0.06 SOL each, plus
4 PDA child accounts each. Total burned to stale state: ~0.5 SOL across
runs 1–3. Not recoverable without market `transferLendingMarketOwnership`
+ rent-claw paths that aren't part of the current scripts.

## Keeper Worker — now fully connected

`packages/keeper-cloud` already has the right values baked in via env vars:

```toml
[vars]
ACCRUAL_OUTPUT = "3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"
ACCRUAL_CONFIG = "6ZhhrkGkN91zz6qPu4n3YmyMCFA7hoPYpj5jtzvkF1JM"
PYTH_PRICE_FEED = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
ACCRUAL_ORACLE_PROGRAM = "8GjxQkJ82LrxpKPYkXw8hpbgCt17hDGk2rcYhqmeR3Ec"
```

```bash
cd packages/keeper-cloud
pnpm install
pnpm secret:keypair    # paste devnet signer JSON array; 0.05+ SOL recommended
pnpm deploy            # cron fires every 5 min
curl https://<your-worker>.workers.dev/   # one-shot smoke test
```

Each fire emits one `accrual_oracle::refresh` tx → ~5 000 lamports. Daily
SOL spend at 5-min cadence ≈ 0.0015 SOL.

## Mainnet portability

Pyth's `7UVi…` PDA is identical on mainnet (derived from the network-agnostic
SOL/USD feed_id). To redeploy on mainnet:

1. `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com npx tsx scripts/setup-cssol-oracle.ts`
2. `SOLANA_RPC_URL=… npx tsx scripts/deploy-cssol-governor-devnet.ts`
3. `SOLANA_RPC_URL=… npx tsx scripts/setup-cssol-market.ts`
4. Update `keeper-cloud/wrangler.toml` with the new `ACCRUAL_OUTPUT` /
   `ACCRUAL_CONFIG` and `pnpm deploy`.

The accrual oracle, governor, and delta-mint program IDs are the same across
networks; mainnet just needs them deployed first via `anchor deploy`.

Mainnet klend's `GLOBAL_ADMIN_ONLY_MODES` are the same — the deploy will skip
those modes and they'll keep mainnet defaults, which is the intended behavior
since Kamino governs protocol fees.
