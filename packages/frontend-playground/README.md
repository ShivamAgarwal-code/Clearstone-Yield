# frontend-playground

**Developer-only** UI for exercising on-chain flows. Not a product; not a
landing page; not for institutions or retail. Each tab targets a single
flow against the deployed devnet stack.

## Tabs

| # | Tab | Status |
|---|---|---|
| 1 | **Jito Restaking** — deposit SOL, receive VRT from our gated Jito Vault | ✅ live |
| 2 | csSOL Wrap — SOL → wSOL → csSOL through `governor::wrap` | TODO |
| 3 | Klend Deposit — csSOL → elevation group 2 collateral | TODO |
| 4 | Jito Bundles — submit wrap+tip as an atomic Bundle | TODO |
| 5 | Klend Monitor — live klend ix stream, ShredStream-shaped | TODO |

Each tab is `src/tabs/<Tab>.tsx`. Adding a new flow = drop a file there
and append it to the `TABS` array in `src/App.tsx`.

## Run

```bash
pnpm install
pnpm --filter frontend-playground dev
# → http://localhost:3009
```

Vite env vars (optional overrides for non-default deploys):

```
VITE_RPC_URL=https://api.devnet.solana.com
VITE_JITO_VAULT_PROGRAM=Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8
VITE_CSSOL_VAULT=EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W
VITE_CSSOL_VRT_MINT=6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8
VITE_CSSOL_VAULT_ST_TOKEN_ACCOUNT=25YAVwucokaFEPRNGapx3iBybQpkTN31cDfc9aU3RF3Z
```

## Gotchas

- Our Jito Vault has `mintBurnAdmin = governor pool PDA`. The Deposit
  button only succeeds if the connected wallet currently holds that role.
  For dev testing, rotate via `SetSecondaryAdmin` (see
  [`packages/programs/scripts/poc-cssol-vault-mint.ts`](../programs/scripts/poc-cssol-vault-mint.ts) for the
  pattern, including auto-restoration of the gate after the deposit).
