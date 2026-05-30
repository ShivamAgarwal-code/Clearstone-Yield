# Shipped Implementation Plans

Historical record of implementation plans that have **landed on-chain** or
in production code. Kept for context (why we chose this design, what
trade-offs we made) and as a reference for anyone modifying the relevant
subsystem. The runtime source of truth lives in the linked code.

| Plan | Subsystem | Reference |
|---|---|---|
| [CSSOL_WT_PLAN.md](CSSOL_WT_PLAN.md) | csSOL-WT withdraw-ticket token + EG-2 unwind | governor `enqueue_withdraw_via_pool`, frontend `OneStepUnwindTab`. Live on devnet. |
| [GOVERNOR_ESCROW_ROLE.md](GOVERNOR_ESCROW_ROLE.md) | M-KYC-0 — `ParticipantRole::Escrow` for program-owned custody PDAs | governor + delta-mint `Escrow` variant; CPIs at `add_escrow_with_co_authority`. |
| [JITO_INTEGRATION_PLAN.md](JITO_INTEGRATION_PLAN.md) | KYC-gated Jito vault wrapper (csSOL ↔ VRT) | governor `wrap_with_jito_vault`, scripts `init-cssol-jito-vault.ts`. |
| [CREDIT_TRADE_PLAN.md](CREDIT_TRADE_PLAN.md) | Leveraged credit-trade UX for institutions | frontend `CreditTradeTab.tsx`, `CreditTradeEusxPanel.tsx`. |

When a plan here meaningfully diverges from the live behaviour, prefer
updating the relevant runbook in [`../operations/`](../operations/) or
the user-facing flow doc in [`../../packages/programs/`](../../packages/programs/)
(e.g. `CSSOL_WITHDRAWAL.md`) and link back to the plan as historical
context.
