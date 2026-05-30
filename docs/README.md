# /docs

Reference docs for live subsystems. Co-located with code so they stay
in lockstep with what's actually deployed. Forward-looking and
exploratory material lives in [`../research/`](../research/) instead.

```
docs/
├── operations/                 ← operator playbooks (live)
│   ├── KAMINO_INTEGRATION.md
│   ├── KEEPER_PERMISSIONS.md
│   └── IRM_NOTES.md
├── shipped/                    ← historical implementation plans (landed)
│   ├── CSSOL_WT_PLAN.md
│   ├── GOVERNOR_ESCROW_ROLE.md
│   ├── JITO_INTEGRATION_PLAN.md
│   └── CREDIT_TRADE_PLAN.md
├── COLLATERAL_DEPOSIT.md       ← deposit flow walkthrough
├── KAMINO_ELEVATION_GROUPS.md  ← eMode reference
└── SOLSTICE_INTEGRATION.md     ← USX/eUSX integration notes
```

Top-level `*.md` files (`ARCHITECTURE.md`, `DECLARATION.md`, `DEPLOY.md`,
`README.md`) are the project entry points and stay outside this tree.
