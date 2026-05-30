# Institutional DeFi Term Sheet Architecture

**Reference template for KYB-gated leveraged staking on Solana (Kamino infrastructure)**

---

## 0. Design philosophy: from bilateral to permissionless-with-credentials

Traditional finance (TradFi) derivatives documentation assumes a **bilaterally negotiated** relationship: two counterparties sign an ISDA Master Agreement, then negotiate each trade as a Confirmation. Every Confirmation is countersigned.

Your wrapper sits in a different reality:

- **The "counterparty" on the other side is a smart-contract protocol** (Kamino, an LST issuer, an oracle), not a negotiating bank desk.
- **The user is gated, not the trade.** Once KYB/KYC passes, the user gets a credential (an attestation, a permissioned wallet, a soulbound token, a Sphere/Bastion-style policy lock) that unlocks access to the contracts. After that, every transaction is self-service, programmatic, and instant.
- **Term sheets must therefore be derivable, not negotiated.** The system has to mint a binding, regulator-grade document automatically at the moment of each transaction, with no human in the loop, while still being defensible as the "Confirmation" that completes the contract.

The architectural answer is to **front-load all negotiable terms into a one-time Master Agreement at onboarding, then deterministically derive every per-transaction Term Sheet from the on-chain transaction state plus a published rulebook.** The user never re-negotiates; the contract auto-completes.

This document specifies that architecture in three layers, then shows how edits work.

---

## 1. Three-layer documentation model

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — MASTER AGREEMENT                                     │
│  Signed once at KYB onboarding. Off-chain wet-signature or      │
│  qualified e-signature. Contains all non-trade terms.           │
│  Analog: ISDA Master Agreement + Schedule + CSA                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ incorporates by reference
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2 — PRODUCT RULEBOOK (versioned)                         │
│  Published reference document. Defines all Floating Rate        │
│  Options, Disruption Events, calculation conventions, fallback  │
│  logic, oracle sources. Updated by governance with notice.      │
│  Analog: 2021 ISDA Interest Rate Derivatives Definitions        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ used by
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3 — TRANSACTION TERM SHEET (auto-derived per txn)        │
│  Generated and hashed at the moment of execution. Records the   │
│  specific economic terms, references the user's Master Agreement│
│  and Rulebook version, and is countersigned by the user's       │
│  on-chain signature on the transaction itself.                  │
│  Analog: ISDA Confirmation / Transaction Supplement             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ may be amended by
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3a — AMENDMENT SUPPLEMENT                                │
│  Subsequent transactions on the same Position emit Supplements  │
│  that reference the parent Term Sheet by hash. Material vs      │
│  immaterial amendment distinction preserved.                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1: Master Agreement (signed once at onboarding)

**Purpose.** Capture every term that doesn't change per-trade, so that subsequent transactions can be fully automated. This is signed once when the user passes KYB and is whitelisted for the protocol.

**Format.** Off-chain PDF, qualified e-signature (eIDAS / DocuSign / equivalent). The hash of the executed Master Agreement is anchored on-chain to the user's permissioned wallet.

### 2.1 Required sections

| Section | Content | TradFi analog |
|---|---|---|
| **Parties** | Issuer entity (your wrapper company) and Client (KYB-verified institution). Includes Client's permissioned wallet address(es). | ISDA Master §1 |
| **Scope** | Lists all Products the Client is authorized to access (e.g. "Leveraged Staking — JitoSOL/SOL", "Leveraged Staking — JitoSOL/USDC"). New products require an addendum. | ISDA Schedule |
| **Incorporation by reference** | "Each Transaction shall be governed by, and the Term Sheet for each Transaction shall be derived in accordance with, the Product Rulebook (version published at the time of the Transaction). The Client acknowledges and accepts the Rulebook as in effect on the Effective Date and as updated from time to time subject to §X (Rulebook Amendments)." | ISDA incorporates 2021 Definitions |
| **Representations & warranties** | Standard non-reliance, sophistication, authority, KYB attestations, sanctions, source-of-funds. Refreshed on each Transaction by deemed repetition. | ISDA §3 |
| **Events of Default & Termination Events** | Bankruptcy, misrepresentation, KYB lapse, sanctions designation, jurisdictional change, oracle failure, protocol pause. | ISDA §5 |
| **Calculation Agent** | Names the Issuer (or a designated third party) as Calculation Agent, with a defined dispute window (e.g. 2 business days for Client to challenge in writing). | ISDA §4.14 |
| **Credit Support / Margining** | References the on-chain collateral mechanics (Kamino LTV, liquidation threshold, oracle price source). The on-chain state IS the CSA. | CSA |
| **Governing law & dispute resolution** | Choice of law (typically English law or NY law for institutional comfort), arbitration seat (LCIA / SIAC), service of process. | ISDA §13 |
| **Rulebook amendment mechanism** | Issuer may amend the Rulebook with N business days' notice; Client may terminate without breakage if they object to a material change before the effective date. | ISDA Protocol mechanics |
| **Term Sheet derivation clause** | **Critical.** "Each Transaction initiated by the Client shall, immediately upon execution, generate a Term Sheet substantially in the form of Annex A, populated from (i) the on-chain transaction state, (ii) the Rulebook in effect, and (iii) the parameters elected by the Client at execution. The Client agrees that such auto-generated Term Sheet, as countersigned by the Client's signature on the underlying transaction, constitutes a binding Confirmation for purposes of this Agreement." | The novel piece — has no direct ISDA analog because TradFi assumes negotiation |
| **Annex A** | Form of Term Sheet (the template in §4 below). | ISDA confirmation form |
| **Annex B** | Form of Amendment Supplement. | — |

### 2.2 The "deemed acceptance" mechanism

This is the legal hinge of the whole system. The Master Agreement must establish that **the user's on-chain signature on a transaction = countersignature on the auto-derived Term Sheet for that transaction.**

Suggested clause language (illustrative, not legal advice — needs counsel review):

> **§X.X Auto-Derivation and Deemed Acceptance.** The parties acknowledge that Transactions under this Agreement are executed by the Client through programmatic interaction with the Protocol. Upon each such execution, the Issuer shall generate a Term Sheet in the form of Annex A, populated deterministically from (a) the on-chain transaction parameters submitted by the Client, (b) the Product Rulebook in effect at the relevant Trade Time, and (c) any Client-specified options offered at the point of execution. The Client agrees that (i) the Client's authenticated cryptographic signature on the underlying on-chain transaction shall constitute the Client's signature on, and acceptance of, the corresponding Term Sheet; (ii) such Term Sheet shall be a Confirmation for all purposes of this Agreement; and (iii) the Client shall be deemed to have repeated each of the Representations in §[3] as of the Trade Time of each Transaction.

Three things make this defensible:

1. **The Term Sheet is fully deterministic** — given the on-chain state and Rulebook version, anyone can independently re-derive the exact same document. There is no Issuer discretion in its content.
2. **The user has a chance to review before signing** — the wrapper UI must show the derived Term Sheet (or at minimum, the material economic terms) before the user signs the transaction, with a hash they can verify. This is the equivalent of "click-through" plus cryptographic non-repudiation.
3. **The Master Agreement is a real off-chain wet/qualified signature** — the auto-derivation only handles the Confirmation layer, never the underlying contract.

---

## 3. Layer 2: Product Rulebook (versioned reference document)

**Purpose.** Single source of truth for all the standardized definitions used by the Term Sheet generator. The Term Sheet itself stays short because it incorporates Rulebook definitions by reference.

**Format.** Published markdown / PDF, semantically versioned (e.g. `v2.3.1`), hash-anchored on-chain. Old versions remain accessible — Term Sheets reference the version active at their Trade Time.

### 3.1 Floating Rate Options (FROs)

This is the most important Rulebook section and the direct analog of ISDA's Floating Rate Matrix. Each FRO is a complete specification of how to read a rate from an on-chain source.

**FRO definition template:**

```
FRO Code:                  KAMINO-SOL-BORROW-APR
Benchmark Name:            Kamino Lend Variable Borrow Rate, SOL Reserve
Observation Source:        Solana mainnet, Kamino program
                           <PROGRAM_ID>, account <RESERVE_PUBKEY>,
                           field `currentBorrowRate`
Observation Method:        Read on-chain at each Reset Date; instantaneous APR
                           expressed as decimal (1e18 fixed point)
Day Count Fraction:        Actual/365 (consistent with Kamino accrual)
Compounding:               Per-slot continuous compounding as implemented
                           by the Kamino program
Reset Frequency:           Per-slot (effectively continuous)
Lookback / Lockout:        None
Disruption Events:         Reserve paused; oracle stale > 60s; program upgraded
                           to incompatible version (see §3.3)
Fallback:                  Last Good Rate, capped at +/- 200 bps from prior
                           Reset, for up to 24h. After 24h: Mandatory Early
                           Termination with Calculation Agent valuation.
Rulebook Section:          §4.2.1
```

**Equivalent for an LST yield leg:**

```
FRO Code:                  JITOSOL-STAKING-APR
Benchmark Name:            JitoSOL Implied Staking + MEV Yield
Observation Source:        Solana mainnet, Jito Stake Pool program
                           <PROGRAM_ID>, account <STAKE_POOL_PUBKEY>;
                           derived from delta of `total_lamports / pool_token_supply`
Observation Method:        Δ(exchange_rate) over period, annualized to Actual/365
Reward Distribution Type:  Reward-bearing (exchange-rate appreciation, not rebasing)
Reset Frequency:           Per epoch (~2 days on Solana)
Lookback:                  1 epoch (rate for period [t-1, t] used for accrual at t)
Disruption Events:         JitoSOL/SOL oracle deviation > 50 bps for > 1h;
                           stake pool paused; epoch failure; slashing event
                           affecting > 0.5% of underlying stake
Fallback:                  See §3.3. Default: suspension of accrual + Calculation
                           Agent valuation at unwind.
Rulebook Section:          §4.2.2
```

The Rulebook should publish a complete FRO matrix covering every benchmark your products use — analogous to ISDA's Floating Rate Matrix providing fully machine-readable electronic codes for floating rate options with associated calculation rules, calendars and offset conventions.

### 3.2 Calculation conventions

- **Day count fractions** (Actual/365, Actual/Actual, 30/360) and which applies to which leg.
- **Business day convention** for any off-chain payment (Modified Following, etc.). Mostly N/A for purely on-chain trades.
- **Time zone** for Trade Time recording (UTC).
- **Rounding** — to which decimal place, and whether truncate or round-half-up.
- **Notional currency vs settlement currency** — e.g. notional in SOL, settlement in USDC.

### 3.3 Disruption Events and consequences

This is your biggest deviation from TradFi and deserves its own section. Define every "thing that can go wrong on-chain" as a named Disruption Event with a defined consequence. Examples:

| Event | Trigger | Consequence |
|---|---|---|
| Oracle Failure | Pyth/Switchboard price deviation > X bps from secondary, or staleness > Ys | Suspend new accruals; existing position frozen at last good values; Calculation Agent determines fair value at resumption or at MET |
| LST De-peg | LST/underlying spot price < Z% of NAV for > T hours | Mandatory Early Termination at Calculation-Agent-determined fair value, defined as <method> |
| Protocol Pause | Kamino governance pauses the relevant Reserve | Position frozen; if pause exceeds 7 days, MET option for either party |
| Slashing | Underlying validators slashed > 0.5% | Notional adjusted by realized loss; user notified; Term Sheet annotated |
| Program Upgrade | Underlying program upgraded to a version not on the Rulebook's allow-list | Suspend new transactions on affected positions; existing positions remain on legacy version per their original Term Sheets until unwound |
| KYB Lapse | User's KYB credential expires or is revoked | No new transactions; existing positions wound down within X days |
| Sanctions Event | Either party becomes sanctioned | Immediate termination; assets handled per applicable law |

These mirror ISDA's Administrator/Benchmark Event triggers and the cessation fallback machinery, where the rate will be determined by interpolating between the next shorter and next longer tenors that are available, and ultimately fallbacks operate upon a permanent cessation — but adapted for protocol-level rather than benchmark-administrator-level events.

### 3.4 Calculation Agent valuation methodology

When MET fires and the parties don't agree on the unwind value, the Calculation Agent values the position. Specify:

- The pricing source hierarchy (e.g. Pyth TWAP > Jupiter quote > manual quote from N dealers).
- The valuation date and time.
- The method (mid-market, liquidation-cost-adjusted, replacement-cost).
- The dispute mechanism (Client has X business days to challenge with supporting evidence).

This is essentially ISDA's Cash Settlement Method election, on-chain-aware. The parties first attempt to mutually agree the Cash Settlement Amount; if they are unable to agree on the amount, then it is determined according to a methodology (a Cash Settlement Method) that the parties elect at the point of trading. The amount determined by the Calculation Agent under any of these methodologies is binding.

---

## 4. Layer 3: Transaction Term Sheet (auto-derived per transaction)

**Purpose.** A binding Confirmation for a single Transaction. Generated automatically at execution, hash-anchored, presented to the user before they sign, and stored permanently as part of the trade record.

### 4.1 Template

```markdown
# TERM SHEET — TRANSACTION CONFIRMATION

**Term Sheet ID:**          0x7a3f...e9b1 (sha256 of canonical contents)
**Generated at (UTC):**     2026-05-05T14:23:11Z
**Trade Time (slot):**      Solana mainnet, slot 312,847,229
**Transaction Signature:**  5xY2...kQ7m (the on-chain tx hash)

---

## 1. Parties and master documentation

**Issuer:**                 [Wrapper Entity Ltd], wallet <ISSUER_PUBKEY>
**Client:**                 [Counterparty Legal Name], permissioned wallet
                            <CLIENT_PUBKEY>, KYB attestation
                            <ATTESTATION_HASH> (verified, expires 2027-03-12)
**Master Agreement:**       Executed 2026-02-14, hash <MA_HASH>
**Product Rulebook:**       Version 2.3.1, hash <RULEBOOK_HASH>
**Product:**                Leveraged Staking — JitoSOL/SOL on Kamino Lend

---

## 2. Position summary

**Position Type:**          Leveraged Liquid Staking, recursive
**Direction:**              Long JitoSOL yield, Short SOL borrow rate
**Strategy:**               Deposit JitoSOL → Borrow SOL → Swap to JitoSOL → Loop
**Target Leverage:**        3.5x
**Effective Date:**         2026-05-05 (Trade Date)
**Scheduled Termination:**  Open-ended, subject to §6 (Termination)

---

## 3. Economic terms

**Initial Principal:**      1,000.00 SOL (equivalent), supplied as JitoSOL
**Initial JitoSOL deposited (gross of loops):**
                            3,420.18 JitoSOL (after recursion)
**Initial SOL borrowed (gross of loops):**
                            2,485.00 SOL
**Initial Net Equity:**     1,000.00 SOL equivalent
**Initial Health Factor:**  1.42 (per Kamino reserve at Trade Time)
**Liquidation Threshold:**  As defined by Kamino JitoSOL collateral factor at the
                            time of liquidation (variable; see Rulebook §3.4)

---

## 4. Floating Rate Options (per Rulebook §4.2)

**Asset Leg (Client receives):**
  FRO:                      JITOSOL-STAKING-APR
  Reset Frequency:          Per epoch
  Day Count:                Actual/365
  At Trade Time:            7.42% APR (informational only; rate is floating)

**Funding Leg (Client pays):**
  FRO:                      KAMINO-SOL-BORROW-APR
  Reset Frequency:          Per slot
  Day Count:                Actual/365
  At Trade Time:            5.18% APR (informational only; rate is floating)

**Indicative Net Carry at Trade Time:**
  +2.24% APR on gross notional, ≈ +7.84% APR on net equity
  (illustrative only; actual returns will vary)

---

## 5. Calculation Agent and disruption events

**Calculation Agent:**      Issuer, with dispute window of 2 business days
                            (per Master Agreement §[X])
**Applicable Disruption Events:** As defined in Rulebook §3.3
**Oracle Sources:**         Pyth (primary), Switchboard (secondary)
**Pricing Pair References:** SOL/USD <FEED_ID>, JitoSOL/SOL <FEED_ID>

---

## 6. Termination

**Optional Early Termination:**
  Either party may unwind, in whole or in part, at any time, subject to
  Kamino's withdrawal mechanics. Partial unwinds generate an Amendment
  Supplement under Rulebook §5 (see Annex B of Master Agreement).

**Mandatory Early Termination Events:**
  - Liquidation by Kamino (the position is closed via on-chain liquidation)
  - Disruption Event with MET consequence (Rulebook §3.3)
  - Termination Event under Master Agreement §[X]

**Settlement Method on MET:**
  Calculation Agent valuation per Rulebook §3.4

---

## 7. Risk disclosure (summary; full disclosure in Master Agreement Annex C)

The Client acknowledges, and represents that it has independently evaluated:
- Liquidation risk if JitoSOL/SOL price ratio declines or borrow rate rises
- Smart contract risk in Kamino, Jito, and oracle programs
- LST de-peg risk and slashing risk on the underlying stake
- Negative carry risk if the Funding Leg exceeds the Asset Leg
- Oracle and protocol-pause risk

Indicative scenario analysis (assumes static other variables):

| Scenario                          | Δ Net Equity (24h) |
|-----------------------------------|--------------------|
| Borrow rate +200 bps              | -0.0192 SOL        |
| JitoSOL yield -200 bps            | -0.0263 SOL        |
| JitoSOL/SOL price -2%             | -0.0684 SOL        |
| JitoSOL/SOL price -5% (near liq.) | -0.1710 SOL        |

This analysis is illustrative and not a representation of expected outcomes.

---

## 8. Acceptance

This Term Sheet is auto-derived under §[X.X] of the Master Agreement.
The Client's cryptographic signature on the on-chain transaction with
signature 5xY2...kQ7m at slot 312,847,229 constitutes the Client's
execution of this Term Sheet.

Term Sheet hash: 0x7a3f...e9b1
Generated by: Issuer Term Sheet Service v1.4.2
```

### 4.2 What's deterministic vs what's elected

For the auto-derivation to be legally clean, every field must come from one of three sources:

1. **On-chain transaction state** (slot, signatures, deposited/borrowed amounts, current rates) — read at Trade Time.
2. **Active Rulebook** (FRO definitions, Disruption Events, Calculation Agent rules) — looked up by hash.
3. **User election at execution** (target leverage, asset selection, slippage tolerance) — captured in the transaction's instruction data.

Nothing else. No Issuer discretion. The Term Sheet generator should be pure: same inputs → same output, byte-for-byte identical.

### 4.3 The user must see it before signing

In the wrapper UI, the term sheet preview must be rendered before the user signs. Minimum viable display:

- Position summary (§2)
- Economic terms (§3)
- FROs and indicative rates (§4)
- Top 2-3 risk scenarios (§7)
- The Term Sheet hash, which the user can verify matches what gets stored

This is the practical equivalent of a counterparty reviewing and countersigning a Confirmation. Without it, the "deemed acceptance" clause is harder to defend.

---

## 5. Edits to positions: the Amendment Supplement model

This is where the master-with-sub-edits architecture you intuited comes in. The pattern is borrowed directly from the ISDA Master Confirmation Agreement + Transaction Supplement model used for credit default swaps, equity swaps, and FX. It works as follows.

### 5.1 What counts as an "edit"?

A user might want to:

1. **Lever up** — borrow more against existing collateral (increases gross notional, may change Health Factor).
2. **Lever down** — partially unwind (decreases gross notional).
3. **Add collateral** — deposit more JitoSOL without changing borrow (improves Health Factor).
4. **Withdraw collateral** — pull JitoSOL out (worsens Health Factor).
5. **Switch the borrow asset** — e.g. roll from SOL borrow to USDC borrow (changes the Funding Leg FRO).
6. **Switch the staked asset** — e.g. roll JitoSOL → mSOL (changes the Asset Leg FRO).
7. **Close the position** — full unwind.

These have different legal characters and need different document treatment.

### 5.2 Three categories of edit

#### Category A — Material economic amendment → Amendment Supplement

Triggers: target leverage change, Asset Leg switch, Funding Leg switch.

The system generates an **Amendment Supplement** that:

- References the parent Term Sheet by its hash.
- Lists every changed field, old value → new value.
- Restates the full economic terms (§3 of the parent template), so the supplement is self-contained when read with the parent.
- Records a new Trade Time, Term Sheet ID (hash), and on-chain transaction signature.
- Notes any settlement consequences (e.g. an unwound portion realized P&L).

The parent Term Sheet's status changes from `ACTIVE` to `AMENDED` and points forward to the supplement. The supplement chains backward to the parent. The chain is hash-linked, so any tampering breaks the chain.

**Crucially, this is treated as one continuous Position for accounting and regulatory purposes**, not as a close-out + new trade. This matters for tax (no realized event on the unchanged portion), for hedge accounting designation if the user has one, and for KYB attestation freshness.

#### Category B — Resize → Stub-style Amendment

Triggers: lever up, lever down, partial unwind.

This is the direct analog of TradFi's partial novation / partial termination. Counterparties can agree to an amendment that reduces the notional amount of the original swap. The remaining portion of the original swap between the original counterparties after such reduction by a partial termination is referred to as the "stub swap." The terms of the original swap, including the terms that define the remaining cash flows, continue to govern the stub swap apart from the reduction in the notional amount.

For your wrapper:

- **Partial unwind** — generate a Stub Supplement that records the reduced notional. The unwound portion has a realized P&L, computed by the Calculation Agent's deterministic method (Rulebook §3.4); the surviving stub keeps its original Trade Date, original FROs, original disruption-event treatment, and just shrinks. The Term Sheet's notional field updates by reference.
- **Lever up** — also a Stub Supplement, but increasing notional. The new portion is treated as freshly added at current rates; the original portion keeps its original entry economics.

This preserves the "single continuous Position with a notional schedule" view, which is exactly how amortizing swaps work in TradFi. It also keeps the audit trail clean: at any point in time, the current state of the Position is the parent Term Sheet plus an ordered list of Stub Supplements.

#### Category C — Collateral movement only → CSA Notice (not a new Term Sheet)

Triggers: add collateral, withdraw collateral (within bounds), top-up to avoid liquidation.

These do not change the economic terms of the Position. In TradFi these are governed by the Credit Support Annex, not the Confirmation. They generate a lightweight **Margin Movement Notice** that:

- References the parent Term Sheet.
- Records the collateral delta and resulting Health Factor.
- Is not a new Confirmation and does not require a new Term Sheet hash.

The on-chain state IS the CSA in your context — Kamino's collateral position is the authoritative record. The Margin Movement Notice is just the human-readable summary for the user's records and for your audit trail.

This distinction matters because it keeps Term Sheet generation cheap: most user actions on a leveraged position are collateral tweaks, and you don't want to generate a fresh Term Sheet for every Health Factor adjustment.

### 5.3 Material vs immaterial: the line

TradFi has spent considerable effort defining where this line sits, and your Rulebook should adopt the same posture. DSIO recognizes that certain amendments are often not a choice of swap counterparties — for example, administrative changes within firms unconnected to the economics of a swap portfolio will inevitably occur and will necessitate amendments. Immaterial amendments to legacy swaps should not require such swaps to be deemed "new" swaps subject to the CFTC Margin Rule.

For your system:

| Edit | Category | Generates |
|---|---|---|
| Change leverage from 3x to 4x | Material | Amendment Supplement (A) |
| Switch borrow from SOL to USDC | Material | Amendment Supplement (A) |
| Switch from JitoSOL to mSOL | Material | Amendment Supplement (A) |
| Lever up by 0.5x | Resize | Stub Supplement (B) |
| Partial unwind 25% | Resize | Stub Supplement (B) |
| Top up collateral | Collateral | Margin Movement Notice (C) |
| Withdraw excess collateral | Collateral | Margin Movement Notice (C) |
| Oracle source upgrade in Rulebook | Immaterial (Rulebook-level) | Rulebook version bump; existing Term Sheets reference old version |
| Calculation Agent dispute address change | Immaterial | Notice only |
| Liquidation by Kamino | Termination | Termination Notice + final settlement statement |

### 5.4 Amendment Supplement template (skeleton)

```markdown
# AMENDMENT SUPPLEMENT

**Supplement ID:**          0x9c12...4d8a (sha256)
**Generated at (UTC):**     2026-06-18T09:11:42Z
**Trade Time (slot):**      slot 318,229,440
**Transaction Signature:**  3qR7...mP9x

**Parent Term Sheet:**      0x7a3f...e9b1 (Term Sheet dated 2026-05-05)
**Status of Parent:**       AMENDED (this Supplement controls from Trade Time)
**Master Agreement:**       Hash <MA_HASH>
**Product Rulebook:**       Version 2.3.1 (unchanged from parent)

---

## 1. Nature of amendment

[ ] Material economic amendment (Category A)
[X] Notional resize (Category B)
[ ] Compound (both A and B)

**Direction of resize:**     Lever up
**Notional change:**         +500 SOL equivalent (gross)
**New gross notional:**      ~3,920 SOL (was ~3,485 SOL)
**New target leverage:**     4.0x (was 3.5x)

---

## 2. Settlement on amended portion

For Category B amendments, the amended portion's realized P&L since the
parent Term Sheet's Trade Time, calculated per Rulebook §3.4:

  Accrued Asset Leg:         +1.84 SOL
  Accrued Funding Leg:       -1.27 SOL
  Net realized:              +0.57 SOL (settled in-kind via JitoSOL appreciation)

The surviving stub continues under the original Term Sheet's terms; the
new portion is added under current Rulebook rates and references.

---

## 3. Restated economic terms

[Full restatement of §3 from parent, with new values]

---

## 4. Restated FROs

[Full restatement of §4 from parent — typically unchanged for Category B]

---

## 5. Other terms unchanged from parent Term Sheet

§1 Parties; §5 Calculation Agent and Disruption Events; §6 Termination;
§7 Risk Disclosure — unchanged.

---

## 6. Acceptance

The Client's signature on transaction 3qR7...mP9x at slot 318,229,440
constitutes acceptance of this Supplement under §[X.X] of the Master
Agreement.

Supplement hash: 0x9c12...4d8a
```

---

## 6. The full audit trail of a Position

Putting it together, the lifetime of a Position looks like:

```
T0  Onboarding:  KYB pass → Master Agreement signed (off-chain) →
                 Hash anchored on-chain to Client wallet
                 [Master Agreement v1.0]

T1  First trade: Client opens leveraged JitoSOL/SOL position at 3.5x
                 → Term Sheet 0x7a3f auto-generated, shown, signed via tx
                 [Position #1, Term Sheet 0x7a3f, status: ACTIVE]

T2  Lever up:    Client increases to 4.0x
                 → Stub Supplement 0x9c12 chained to 0x7a3f
                 [Position #1, controlling: 0x9c12, status: ACTIVE]

T3  Top up:      Client adds collateral
                 → Margin Movement Notice (no new Term Sheet)
                 [Position #1, controlling: 0x9c12, status: ACTIVE]

T4  Switch:      Client switches borrow from SOL to USDC
                 → Amendment Supplement 0x44e5 chained to 0x9c12
                 [Position #1, controlling: 0x44e5, status: ACTIVE]

T5  Partial:     Client unwinds 50%
                 → Stub Supplement 0x88b1 chained to 0x44e5
                 [Position #1, controlling: 0x88b1, status: ACTIVE, half size]

T6  Liquidation: Health Factor breached, Kamino liquidates
                 → Termination Notice; final settlement statement
                 [Position #1, controlling: 0x88b1, status: TERMINATED]
```

Each document is hash-chained to its parent. The full state of the Position at any historical moment is reconstructable from the chain plus the Rulebook version active at each link. This is functionally what TradFi calls **trade lifecycle data** under EMIR / CFTC Part 45 reporting — and your auto-generation pipeline gets it for free as a side effect.

---

## 7. Build checklist

To implement this in your wrapper:

- [ ] Master Agreement template drafted by counsel, with the auto-derivation clause from §2.2.
- [ ] KYB onboarding flow that captures wet/qualified signature and anchors hash on-chain to user wallet.
- [ ] Product Rulebook v1.0 published, with full FRO matrix for every benchmark you reference.
- [ ] Term Sheet generator service: deterministic, pure function of (on-chain state, Rulebook version, user election). Same inputs always produce the same output bytes.
- [ ] UI preview of Term Sheet before signing, with hash display.
- [ ] Term Sheet storage: append-only, hash-linked, retrievable by the Client and by the Issuer's compliance team.
- [ ] Amendment Supplement generator (same shape as Term Sheet generator, with parent-pointer logic).
- [ ] Margin Movement Notice generator (lightweight, for collateral-only events).
- [ ] Disruption Event detector (oracle/protocol monitoring) that triggers the right consequences.
- [ ] Calculation Agent valuation service for MET cases.
- [ ] Audit export: given a Position ID, return the full ordered chain of documents.
- [ ] Rulebook version bump procedure: notice period, opt-out mechanics for objecting clients.

---

## 8. Open questions worth flagging to counsel

- **Choice of law for the Master Agreement.** English or NY law are the institutional defaults. Given Solana-native execution, neither is technically connected to the trades — counsel will want to think about enforceability and jurisdiction over disputes.
- **Form of Master Agreement signature.** eIDAS qualified signatures give the strongest evidentiary value in the EU; DocuSign / wet signatures may be sufficient elsewhere. The on-chain anchoring is supplementary, not a substitute.
- **MiCA / CASP licensing implications.** If the wrapper is offered to EU institutional clients, the structure may fall within MiCA scope depending on how the leveraged position is characterized (custody? portfolio management? CFD-equivalent?). The term sheet wording can affect this characterization.
- **Whether the auto-derivation clause is enforceable in your target jurisdictions.** Most institutional jurisdictions accept "deemed acceptance via electronic signature on a programmatic confirmation" but this should be verified per jurisdiction.
- **MTF/OTF or DLT Pilot Regime overlap.** If volumes scale, your wrapper may start to look like a regulated trading venue under EU rules. The documentation architecture is robust to this — Confirmations are how regulated venues document trades — but the licensing path is separate.

---

*This template is a structural reference, not legal advice. Every clause and definition needs review by qualified counsel in your target jurisdictions before use with clients.*
