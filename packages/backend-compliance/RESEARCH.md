# KYC / KYB Architecture Decision

## Overview

This project implements a **permissioned DeFi vault on Solana** that requires participants (e.g. borrowers, institutions) to be **KYC/KYB verified** before interacting with the protocol.

A key architectural question was:

> *How should KYC/KYB verification be integrated into an on-chain Solana program?*

---

## Key Finding: KYC Providers Are Off-Chain

Most industry-standard KYC/KYB providers (e.g. Persona, Jumio, Onfido, Sumsub) operate entirely **off-chain**.

They:

* Verify user identity (documents, biometrics, business ownership)
* Perform AML / sanctions checks
* Return results via **API or webhook**

They do **not**:

* Deploy smart contracts
* Write to blockchain
* Maintain on-chain identity state

### Implication

There is **no native on-chain representation of KYC status** provided by these services.

Therefore:

> The application itself must act as the bridge between off-chain identity verification and on-chain enforcement.

---

## Standard Flow (Industry Pattern)

The canonical architecture for integrating KYC into blockchain systems is:

```
KYC Provider → Backend → On-Chain Program → Access Control
```

### Step-by-step

1. User submits KYC/KYB information to a provider
2. Provider verifies identity and sends result (API/webhook)
3. Backend processes the result
4. Backend writes approval state on-chain
5. Smart contract enforces access using that state

---

## Our Approach: Self-Managed On-Chain Whitelist

We implemented a **custom whitelist system** using a Solana PDA (`WhitelistEntry`) as the on-chain source of truth.

### Flow

```
[KYC Provider (mock or real)]
        ↓
[Backend Service]
        ↓
[Governor Program → WhitelistEntry PDA]
        ↓
[Vault / Lending Logic]
```

### Key Properties

* Only approved wallets are written to the whitelist
* Smart contracts enforce access by checking whitelist entries
* KYC data remains **off-chain** (privacy + compliance)
* On-chain state is minimal: only wallet approval status

---

## Why a Custom Solution?

### 1. Provider-Agnostic Design

Since all major KYC providers are off-chain APIs, they are interchangeable.

By building a **self-managed whitelist**, we:

* Avoid vendor lock-in
* Can switch providers without changing on-chain logic
* Maintain full control over access rules

---

### 2. Separation of Concerns

We explicitly separate:

| Layer            | Responsibility           |
| ---------------- | ------------------------ |
| KYC Provider     | Identity verification    |
| Backend          | Decision + orchestration |
| On-chain Program | Enforcement              |

This improves:

* Maintainability
* Auditability
* Upgrade flexibility

---

### 3. Regulatory Alignment

This architecture matches how institutional systems are designed:

* Regulated entities must be **identified off-chain**
* Smart contracts must enforce **permissioned access**
* Systems must support **auditability and traceability**

---

### 4. Hackathon Practicality

For development purposes:

* We use a **mock KYC/KYB backend**
* This simulates real provider behavior
* The architecture remains identical to production

In production:

* The mock layer is replaced by a real provider
* No changes required to the smart contracts

---

## Special Case: On-Chain Identity Providers

There are exceptions where KYC status exists **on-chain**.

### Example: Civic

Civic provides:

* A deployed Solana program
* "Gateway Tokens" representing verified identity
* On-chain verification via program checks

### Alternative Flow (Civic)

```
[Civic Verification]
        ↓
[Civic Program → Gateway Token]
        ↓
[Our Program verifies token]
```

### Implications

* No backend whitelist write required
* KYC state is externalized to another on-chain program
* Our program becomes a **consumer of identity state**, not the owner

---

## Supporting Multiple Verification Modes

To support both approaches, the system can be extended with:

```
VerificationMode:
- SelfManaged (default)
- ExternalProvider (e.g. Civic)
```

This allows:

* Backward compatibility
* Modular identity integration
* Future extensibility

---

## Final Decision

We chose:

> **Self-managed whitelist with modular KYC backend**

### Rationale

* Works with all existing KYC providers
* Simple and reliable for hackathon scope
* Matches real-world institutional architecture
* Allows future integration with on-chain identity systems (e.g. Civic)

---

## Summary

* KYC/KYB providers are **off-chain services**
* On-chain identity must be **explicitly written or verified**
* Our `WhitelistEntry PDA` is the **source of truth for access control**
* Backend acts as the **bridge between identity and blockchain**
* Architecture is **modular, extensible, and production-aligned**

---

## Next Steps

* Multi-sig control over whitelist (Fireblocks integration)
* Role-based approval workflow
* Specific rules per user
* On-chain auditability (events + metadata)
* KYT monitoring integration
* Modular verification modes (self-managed + external)

---
