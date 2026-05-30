# keeper-cloud

Cloudflare Worker that keeps the csSOL accrual-oracle output fresh.

## What it does

Each cron fire (every 5 min) sends one transaction containing one instruction: `accrual_oracle::refresh`. The accrual-oracle reads SOL/USD from the live Pyth push feed and writes `source_price × accrual_index_e9 / 1e9` into our stable accrual output that klend's csSOL reserve points at.

That's the entire job. No Hermes fetch, no VAA verification, no Wormhole, no per-fire account churn — Pyth's sponsored updater on devnet keeps the source feed (`7UVi…`) fresh; our keeper just rolls our derived output forward.

## What sees what

```
                     Pyth's sponsored updater (free, ~30 s)
                                  │
                                  ▼
        7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE
        (PriceUpdateV2, owner = Pyth Receiver, SOL/USD)
                ▲                       ▲
                │                       │
   wSOL reserve oracle           accrual_oracle::refresh
   (klend reads directly)         (this Worker, 5-min cron)
                                          │
                                          ▼
                                ACCRUAL_OUTPUT (ours)
                                          ▲
                                          │
                            csSOL reserve oracle
                            (klend reads our derived feed)
```

## One-time setup

```bash
# 0. Prereqs:
#    - accrual-oracle program deployed
#    - scripts/setup-cssol-oracle.ts run (writes configs/devnet/cssol-oracle.json)

cd packages/keeper-cloud
pnpm install

# 1. Paste the values from configs/devnet/cssol-oracle.json into wrangler.toml:
#    ACCRUAL_OUTPUT = "<accrualOutput>"
#    ACCRUAL_CONFIG = "<accrualConfig>"

# 2. Upload a devnet signer as a secret. The value is the JSON array
#    your `solana-keygen new` produced (64 numbers). Devnet only — never
#    upload a mainnet key this way. Fund the signer with a few devnet SOL
#    for tx fees.
pnpm secret:keypair

# 3. Deploy
pnpm deploy
```

## Live test

```bash
# Hit the fetch handler for an immediate one-shot with response
curl https://<your-worker-url>/

# Or fire the cron immediately
curl -X POST "https://<your-worker-url>/cdn-cgi/mf/scheduled?cron=*+*+*+*+*"

# Tail logs
pnpm wrangler tail
```

## Local dev

```bash
pnpm dev          # wrangler dev with --test-scheduled enabled
pnpm trigger      # POSTs /__scheduled to fire cron once
```

## Cadence

`*/5 * * * *` is the default. Drop to `*/1 * * * *` for tight stage demos. The minimum useful cadence is bounded by klend's `maxAgePriceSeconds` on the csSOL reserve (currently 600 s) — anything sooner than that is overkill.

## Costs

- Free tier: 100k requests/day; we use ~290/day at 5-min cadence.
- Each fire = 1 signed tx ≈ 5 000 lamports. 5-min cadence ≈ 1.5M lamports/day = 0.0015 SOL/day.

## Mainnet swap

Pyth's stable price feed at `7UVi…` is the **same PDA on mainnet** (it's derived from the feed_id, which is identical across networks). Just swap `SOLANA_RPC_URL`, re-run `setup-cssol-oracle.ts` against mainnet to mint a new accrual output, paste the new addresses into `wrangler.toml`, and redeploy.

## When to actually need a heavier keeper

If you ever want the csSOL reserve to use a feed that **isn't** Pyth-sponsored on the target network, switch to the Pyth `post_update_atomic` flow (post a fresh VAA from Hermes per fire, run refresh, close the ephemeral account). That's the path the previous version of this Worker used; git history preserves it. The accrual-oracle program already accepts both — the source check is just `owner == feed_config.source_program` + `feed_id == feed_config.feed_id`.
