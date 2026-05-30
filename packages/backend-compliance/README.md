# KYC/KYB Backend Service

REST API for institutional onboarding. Approved wallets are written to the
`delta-mint` on-chain whitelist so they can interact with the permissioned
DeFi vault.

---

## Architecture

```
packages/backend/src/
├── index.ts                        ← Fastify app entry point + plugins
├── config.ts                       ← Env-var config
├── types.ts                        ← Shared TypeScript types
├── db/
│   └── store.ts                    ← KycStore interface + in-memory impl
├── middleware/
│   └── entra-auth.ts               ← requireEntraAuth / requireEntraAdmin preHandlers
├── services/
│   ├── kyc.service.ts              ← Business logic + KycProvider interface
│   ├── entra.service.ts            ← Microsoft Entra B2C JWT validation
│   ├── blockchain.service.ts       ← Solana/Anchor whitelist calls
│   ├── kyt.service.ts              ← Know Your Transaction screening
│   ├── risk.service.ts             ← Risk scoring + deposit caps
│   ├── travel-rule.service.ts      ← FATF Travel Rule messaging
│   └── signing.service.ts          ← Transaction signing (local / Fireblocks)
└── routes/
    ├── auth.routes.ts              ← Entra identity linking (/auth/*)
    ├── kyc.routes.ts               ← KYC management (/kyc/*)
    ├── kyt.routes.ts               ← KYT screening (/kyt/*)
    ├── travel-rule.routes.ts       ← Travel rule (/travel-rule/*)
    ├── audit.routes.ts             ← Audit trail (/audit/*)
    └── risk.routes.ts              ← Risk assessment (/risk/*)
```

### Layer boundaries

| Layer | File | Responsibility |
|---|---|---|
| **API** | `routes/*.ts` | Parse HTTP, call service, map errors |
| **Auth** | `middleware/entra-auth.ts` | Validate Entra JWTs, enforce roles |
| **KYC Service** | `services/kyc.service.ts` | Business rules, state transitions |
| **Entra Service** | `services/entra.service.ts` | OIDC token validation via JWKS |
| **Blockchain** | `services/blockchain.service.ts` | Solana PDAs, instruction building, tx |
| **DB** | `db/store.ts` | In-memory persistence (swappable) |

---

## Onboarding Flow

```
User authenticates with Amina's Entra B2C tenant
         ↓
POST /auth/link-wallet  (Bearer token + walletAddress)
  → JWT validated against Entra's JWKS endpoint
  → name/email extracted from token claims automatically
  → KYC record created with entraSubjectId linked
  → status: "pending"
         ↓
Compliance officer reviews (VaultAdmin role in Entra)
POST /kyc/approve
  → KYT screening (Chainalysis-compatible)
  → Risk controls (OFAC, deposit caps)
  → On-chain add_to_whitelist transaction
  → status: "approved"
         ↓
Wallet can deposit to the vault
```

---

## Setup

### 1. Prerequisites

- Node.js 20+, pnpm
- Solana CLI (`solana --version`)
- An Anchor program deployed — `delta-mint` at `3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY`
- Microsoft Entra B2C tenant (free at portal.azure.com — 50k MAU/month free)

### 2. Generate keypairs (devnet)

```bash
solana-keygen new --outfile admin-keypair.json
solana airdrop 2 $(solana-keygen pubkey admin-keypair.json) --url devnet
cat admin-keypair.json   # copy byte array → ADMIN_KEYPAIR_JSON
```

### 3. Configure .env

```bash
cp packages/backend/.env.example packages/backend/.env
# Fill in: ADMIN_KEYPAIR_JSON, WRAPPED_MINT_ADDRESSES, ENTRA_* vars
```

### 4. Microsoft Entra B2C setup

1. Go to [portal.azure.com](https://portal.azure.com) → search "Azure AD B2C"
2. Create tenant → note your `tenantName` and `tenantId` (GUID)
3. App registrations → New registration → note the `clientId`
4. User flows → New user flow → "Sign up and sign in" → name it `signupsignin`
5. App roles → add role `VaultAdmin` → assign it to compliance officers

Set in `.env`:
```
ENTRA_TENANT_NAME=yourtenantname
ENTRA_TENANT_ID=<guid>
ENTRA_CLIENT_ID=<guid>
ENTRA_POLICY=B2C_1_signupsignin
ENTRA_FLAVOR=b2c
```

For local dev without a real tenant:
```
ENTRA_MOCK=true
```

### 5. Install & run

```bash
pnpm install
pnpm --filter backend dev     # hot-reload dev server on :3001
pnpm --filter backend test    # run unit tests (no Solana RPC needed)
```

---

## API Reference

### POST /auth/link-wallet ⭐ Primary onboarding endpoint

Links a verified Entra identity to a Solana wallet. Name and email are pulled
from the JWT claims automatically — no form needed. Creates a KYC record with
`status: "pending"` for compliance review.

```bash
curl -X POST http://localhost:3001/auth/link-wallet \
  -H "Authorization: Bearer <entra_token>" \
  -H "Content-Type: application/json" \
  -d '{ "walletAddress": "So11111111111111111111111111111111111111112" }'
```

Response `200`:
```json
{
  "success": true,
  "data": {
    "walletAddress": "So11111111111111111111111111111111111111112",
    "entraSubjectId": "abc-123-immutable-sub",
    "kycStatus": "pending",
    "message": "Registered. Pending compliance review."
  }
}
```

---

### GET /auth/me

Returns the KYC record for the authenticated Entra user.

```bash
curl http://localhost:3001/auth/me \
  -H "Authorization: Bearer <entra_token>"
```

---

### GET /auth/identity/:walletAddress

Returns the Entra identity linked to a wallet (admin / audit).

```bash
curl http://localhost:3001/auth/identity/So11111111111111111111111111111111111111112
```

---

### POST /kyc/approve 🔒 Requires VaultAdmin role

Approve a wallet. Triggers KYT screening, risk checks, and an on-chain
`add_to_whitelist` transaction.

```bash
curl -X POST http://localhost:3001/kyc/approve \
  -H "Authorization: Bearer <vault_admin_token>" \
  -H "Content-Type: application/json" \
  -d '{ "walletAddress": "So11111111111111111111111111111111111111112" }'
```

Response `200` — includes Solana tx signature for audit:
```json
{
  "success": true,
  "data": {
    "status": "approved",
    "whitelistResults": [
      { "mintAddress": "...", "signature": "5J7xP...", "whitelistEntryAddress": "..." }
    ]
  }
}
```

---

### POST /kyc/reject 🔒 Requires VaultAdmin role

Reject a wallet. No on-chain transaction; status updated in DB.

```bash
curl -X POST http://localhost:3001/kyc/reject \
  -H "Authorization: Bearer <vault_admin_token>" \
  -H "Content-Type: application/json" \
  -d '{ "walletAddress": "So11111111111111111111111111111111111111112" }'
```

---

### POST /kyc/submit 🔒 Requires VaultAdmin role

Manual onboarding — registers a wallet without an Entra token. For edge cases
only. Normal users should use `POST /auth/link-wallet`.

---

### GET /kyc/status/:walletAddress

Check current KYC status (public).

```bash
curl http://localhost:3001/kyc/status/So11111111111111111111111111111111111111112
```

---

### GET /kyc/list

List all KYC records (admin utility, unprotected — add auth in production).

---

### GET /health

```bash
curl http://localhost:3001/health
# { "status": "ok", "timestamp": "..." }
```

---

## On-chain Flow

When `/kyc/approve` is called:

1. Backend derives `mint_config` PDA: `["mint_config", wrappedMint]`
2. Backend derives `whitelist_entry` PDA: `["whitelist", mintConfig, wallet]`
3. Checks the entry doesn't already exist (duplicate guard)
4. Builds `add_to_whitelist` instruction with the admin keypair as signer
5. Sends and confirms transaction on devnet
6. Stores the tx signature in the KYC record

The `whitelist_entry` account is checked on-chain by `delta-mint`'s `mint_to`
instruction before minting wrapped tokens.

---

## Replacing the Mock KYC Provider

See [PROVIDER_SWAP.md](./PROVIDER_SWAP.md) for integrating Persona, Jumio,
Sumsub, or Onfido without touching the blockchain layer.

---

## Security Notes

- Admin keypair **never leaves the backend**. Frontend users never sign whitelist transactions.
- `/kyc/approve` and `/kyc/reject` require a valid Entra JWT with the `VaultAdmin` app role.
- Wallet address validation rejects malformed base58 before any DB writes.
- One Entra identity can only be linked to one wallet address (enforced in service layer).
- Duplicate whitelist entries are blocked both in DB and on-chain.
- Rate limiting (30 req/min by default) applied globally.
- `ENTRA_MOCK=true` must never be set in production — it bypasses all JWT verification.
