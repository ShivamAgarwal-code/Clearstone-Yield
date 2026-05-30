# Compliance & Regulatory Summary

This section summarizes the **key regulatory constraints**, compares our design to **Aave Horizon**, and explains how these requirements impact our architecture.

---

## 1. Regulatory Rules (KYC, KYT, Travel Rule)

### Core Requirements

Institutional DeFi systems must comply with:

- **KYC / KYB** → identify borrowers (institutions)
- **AML / KYT** → monitor source of funds
- **Auditability** → trace all activity for regulators

### Travel Rule

Defined by the Financial Action Task Force (FATF), the Travel Rule requires:

- Identity data to be shared **between regulated entities (VASPs)** during transfers

**Important constraint:**
- Blockchains (e.g., Solana) do NOT carry identity data
- Travel Rule is enforced **off-chain between institutions**, not in smart contracts

**Implication for our system:**
- Not required for:
  - permissionless lenders (non-VASPs)
- Required for:
  - institutional counterparties (handled by custodians / backend systems)

**Sources:**
- FATF Travel Rule guidance  
- TRISA / OpenVASP specifications for implementation  

---

## 2. Comparison to :contentReference[oaicite:0]{index=0} Horizon

### What Horizon Does

**Aave Horizon** is a permissioned institutional lending market:

- Borrowers:
  - Must be **KYC’d institutions**
  - Must be approved to use RWA collateral
- Lenders:
  - Can be **permissionless stablecoin providers**
- Compliance:
  - Enforced via **off-chain KYC + on-chain allowlists**
  - Token-level transfer restrictions enforce permissions

---

### Comparison

| Feature | Horizon | Our Vault |
|--------|--------|----------|
| Borrowers | KYC required | KYC required (whitelist PDA) |
| Lenders | Permissionless | Permissionless |
| Identity source | Issuer allowlist | Backend → on-chain whitelist |
| Compliance enforcement | Token restrictions | Program-level checks |
| Travel Rule | Off-chain | Off-chain |

**Key insight:**
> Horizon uses a hybrid model: **permissioned borrowers + permissionless liquidity** — same as our design.

---

## 3. Impact on Our Architecture

### What we MUST implement

#### ✅ 1. Borrower KYC/KYB
- Only verified institutions can:
  - borrow
  - interact with restricted functions
- Enforced via:
  - `WhitelistEntry` PDA

---

#### ✅ 2. KYT (Liquidity Screening)

Since lenders are permissionless:

- We must ensure **clean funds at pool level**
- Implement:
  - risk scoring
  - blacklist / sanctions filtering
  - deposit validation

---

#### ✅ 3. Auditability

- Track:
  - deposits
  - risk scores
  - whitelist decisions
- Enables:
  - regulatory inspection
  - institutional trust

---

#### ✅ 4. Custody / Compliance Layer

In production:

- Integrate with:
  - :contentReference[oaicite:1]{index=1} or similar
- Handles:
  - key management
  - Travel Rule compliance
  - institutional workflows

---

### What we DO NOT implement

- ❌ On-chain Travel Rule logic  
- ❌ Per-lender identity tracking  
- ❌ Fully permissioned liquidity  

---

## Final Design Summary

Our system follows the emerging institutional DeFi pattern:

> **Permissioned borrowers + permissionless liquidity + compliance at the pool level**

- KYC ensures **known counterparties**
- KYT ensures **clean liquidity**
- Smart contracts enforce **access + rules**
- Off-chain systems handle **regulatory communication (Travel Rule)**

This aligns closely with real-world systems like **Aave Horizon**, while remaining feasible within a hackathon environment.