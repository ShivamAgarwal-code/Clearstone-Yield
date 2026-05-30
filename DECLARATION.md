# Declaration — Clearstone Finance

This document declares the **baseline** against which this submission should be judged:
what was pre-existing before the hackathon, what is external / third-party, and what was
built from scratch by the Clearstone Finance team.

> Clearstone Finance is a rebrand of the project originally developed under the working
> name `delta-stablehacks` during the hackathon. All work in this repository was produced
> by the submitting team within the hackathon window — the rename is cosmetic (branding,
> domains, UI copy, logos). Program identifiers, architecture, and tests are unchanged
> from the submitted version.

## 1. Scope of Judging

Everything inside this repository is in scope for judging **except** the items listed as
"External / Pre-existing" in §3. The baseline for originality, effort, and engineering
depth is measured against the pre-hackathon state described in §2.

## 2. Pre-Hackathon Baseline (written by us, before the event)

The team entered the hackathon with **zero Clearstone-specific code**. No program, test,
SDK, or frontend module listed in §4 existed prior to the hackathon start.

Engineering background the team brought in (skills, not code):

- Solana / Anchor program development
- Token-2022 extension familiarity (confidential transfers, transfer hooks)
- DeFi lending mechanics (CDP-style positions, oracle-driven liquidations)
- React / TypeScript / Vite frontend tooling
- General KYC / compliance workflow knowledge

No private libraries, prior audits, or carry-over code from earlier projects are
embedded in this repo.

## 3. External / Pre-existing Dependencies (NOT authored by us)

These components are consumed as-is and should **not** be credited to the team:

| Component | Role | Source |
|---|---|---|
| **Kamino Lend V2** | Lending engine — markets, reserves, liquidation, IRM | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` (audited, live) |
| **Pyth Network** | Price oracles (USDY/USD, USDC/USD) | Pyth pull-oracle feeds on mainnet |
| **Ondo USDY** | Underlying yield-bearing asset wrapped as collateral | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` |
| **Solstice USX / eUSX** | Alternative yield-bearing collateral (devnet integration) | Solstice Finance programs + `instructions.solstice.finance` API |
| **Civic Pass** | KYC identity gateway used by the retail UI | Civic gateway program on Solana |
| **SPL Token-2022** | Mint standard with confidential-transfer extension | Solana Program Library |
| **Anchor 0.30.1** | Program framework | coral-xyz/anchor |
| **Solana Wallet Adapter, React, Vite, Fastify, wrangler** | Standard tooling | npm / crates.io |

Integration *glue* to these systems (CPI calls, instruction builders, SDK wrappers,
config JSONs) **is** our work and is in scope — the underlying protocols are not.

## 4. Work Produced During the Hackathon (in scope for judging)

All of the following was written by the team during the hackathon window:

### Solana Programs — [packages/programs/programs/](packages/programs/programs/)

- **delta-mint** — KYC-gated Token-2022 mint with role-based whitelist
  (Holder / Liquidator), PDA-controlled mint authority, confidential-transfer
  extension enabled.
- **governor** — Pool orchestrator. Single entry-point for pool lifecycle,
  participant management, and market registration via CPI into delta-mint.
- **mock-oracle** — Test-only oracle for devnet / local flows.

### Tests — [packages/programs/tests/](packages/programs/tests/)

- Unit tests against local validator (`delta-mint.ts`).
- Mainnet-fork tests proving full flow with real Kamino + Pyth state:
  `kamino-market.fork.ts`, `governor.fork.ts`, `kamino-full-flow.fork.ts`.

### Reserve Configurations — [packages/programs/configs/](packages/programs/configs/)

- `delta_usdy_reserve.json` — cUSDY collateral reserve (95% LTV, 97% liq.
  threshold, Pyth oracle, borrow-disabled).
- `usdc_borrow_reserve.json` — USDC borrow reserve with tuned IRM curve.

### SDK — [packages/calldata-sdk-solana/](packages/calldata-sdk-solana/)

TypeScript calldata builder for governor + delta-mint instructions, used by
both frontends and backends.

### Backends

- [packages/backend-compliance/](packages/backend-compliance/) — KYC /
  compliance service (provider-agnostic interface with swappable providers —
  see `PROVIDER_SWAP.md`). Fastify-based.
- [packages/backend-edge/](packages/backend-edge/) — Cloudflare Worker
  deployment of the edge-facing API.

### Frontends

- [packages/frontend-retail/](packages/frontend-retail/) — Retail / consumer
  entry point with Civic-gated KYC and a devnet faucet server
  (`faucet-server.ts`).
- [packages/frontend-institutional/](packages/frontend-institutional/) —
  Institutional desk UI (treasury-style position management).
- [packages/frontend-console/](packages/frontend-console/) — Operator console
  for pool lifecycle, whitelist admin, and market registration.

### Documentation

- [README.md](README.md) — Architecture, flow, addresses, test coverage.
- [docs/operations/KAMINO_INTEGRATION.md](docs/operations/KAMINO_INTEGRATION.md) — Market creation, reserve
  config, and liquidation reference.
- [docs/operations/IRM_NOTES.md](docs/operations/IRM_NOTES.md) — Interest-rate model notes.
- [docs/SOLSTICE_INTEGRATION.md](docs/SOLSTICE_INTEGRATION.md) — eUSX
  yield-bearing collateral integration.
- [docs/COLLATERAL_DEPOSIT.md](docs/COLLATERAL_DEPOSIT.md) — Deposit flow.
- [packages/backend-compliance/COMPLIANCE.md](packages/backend-compliance/COMPLIANCE.md),
  [RESEARCH.md](packages/backend-compliance/RESEARCH.md),
  [PROVIDER_SWAP.md](packages/backend-compliance/PROVIDER_SWAP.md).

## 5. Deployed Program IDs (for verification)

| Program | Address | Network |
|---|---|---|
| delta-mint | `3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY` | mainnet-beta / devnet |
| governor | `2TaDoLXG6HzXpFJngMvNt9tY29Zovah77HvJZvqW96sr` | mainnet-beta / devnet |

Judges can confirm authorship by matching the on-chain program binaries against
the source under [packages/programs/programs/](packages/programs/programs/) and
by reviewing the git history (77 commits, all by the team).

## 6. AI / Tooling Disclosure

Standard developer tooling was used (IDE assistants, LLM code assistants, Copilot,
Claude Code). All AI-assisted output was reviewed, tested, and integrated by the
team; no component was accepted blindly. No generated code was used for the
cryptographic primitives or CPI-boundary logic without manual review.

## 7. Attestation

The submitting team attests that:

1. The work described in §4 was produced **during the hackathon window**, by the
   submitting team.
2. No portion of §4 was copied from a prior personal or commercial codebase.
3. All external dependencies are either open-source (used within their licenses)
   or consumed via public APIs / on-chain programs as declared in §3.
4. The rebrand from `delta-stablehacks` to `clearstone-finance` is a
   post-submission naming change only and does not affect the technical
   substance of what is being judged.
