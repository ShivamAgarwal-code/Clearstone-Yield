# Jupiter Offerbook — Integration Assessment

Evaluation of **Jupiter Offerbook** as a second credit channel for cUSDY (KYC-gated, Token-2022 wrapped USDY). Assessed from the perspective of a team that already operates a cUSDY market on Kamino Lend V2.

**Bottom line:** Offerbook is a fundamentally different shape (P2P term loans, no liquidation) from the Kamino pool model. It eliminates oracle-manipulation and liquidation-cascade risk — attractive for regulated use — but the KYC-recipient problem is *restructured*, not solved, and several integration details are not publicly documented as of April 2026.

---

## 1. Mechanism

Permissionless, time-based **P2P lending marketplace**. Offer → accept → fixed-term accrual → repay-or-default-claim. **No price-based liquidation, no margin call, no forced closure during the loan.**

| Parameter | Value |
|---|---|
| Loan duration | **3 days, fixed** at launch (longer terms "planned") |
| Offer lifetime (lend) | 24 hours |
| Offer lifetime (borrow) | 1–7 days (borrower-chosen) |
| Partial fills | Allowed, except NFT collateral |
| Interest | Full 3-day interest owed regardless of early repayment |
| Default | Lender signs a claim tx at any time after maturity to pull the escrowed collateral |

Offers cannot be edited — only renewed.

## 2. Asset Support

| Side | Assets |
|---|---|
| Debt (borrow/lend) | **USDC only** at launch |
| Collateral | Any Jupiter "verified" SPL token, **xStocks** (RWAs), **NFTs** |

**Token-2022 support is unverified.** The companion `jupiter-lend` codebase handles both classic SPL and Token-2022 (`crates/library/src/token/spl.rs`), suggesting infra-level awareness, but **no public statement on confidential-transfer or transfer-hook compatibility for Offerbook specifically**. This is the single biggest blocker for a cUSDY integration and must be probed on-chain or confirmed with Jupiter directly.

Note: `ConfidentialTransfer` and `TransferHook` are mutually exclusive extensions in Token-2022. cUSDY uses the confidential-transfer path, so KYC is enforced at the mint/whitelist layer — matching the Kamino V2 design assumption.

## 3. Permissionlessness

- Any wallet can post an offer against any collateral asset from the allowed set.
- No per-market curator (unlike Morpho/Kamino V2 vaults). "Permissionless at the user layer, curated at the asset layer" — asset eligibility is gated by Jupiter's verified-tokens list.
- **Protocol fees** (charged by Jupiter, not a curator):
  - Initiation: **25% of projected interest**, prepaid by borrower
  - Repayment: **10% of interest**, deducted from lender's payout
  - Default/claim: **0.1% of collateral value** (NFTs/RWAs exempt)

## 4. Collateral Handling on Default — Critical for cUSDY

Collateral sits in an Offerbook-managed escrow PDA during the loan. On default, **the lender signs a transaction to pull the collateral into their own wallet**.

This is the same structural problem as Kamino V2 liquidation — the collateral's ultimate recipient must be eligible to hold it — but with a different counterparty:

| Protocol | Recipient on default/liquidation |
|---|---|
| Kamino V2 | Liquidator bot → mitigated via `add_liquidator` role |
| Offerbook | **The lender directly** |

Implications for cUSDY as collateral:

- The lender (not a liquidator bot) becomes the direct recipient → the lender **must be KYC-whitelisted on the cUSDY mint**.
- Offerbook has no visibility into Holder/Liquidator roles and no known hook for unwinding a wrapped asset on claim.
- Mitigation options:
  1. Restrict cUSDY offers to a KYC'd lender set via **off-chain UX gating** (we accept only offers from whitelisted lenders).
  2. Route the claim through a **custom unwind program** that exchanges cUSDY for an unrestricted form at claim time.
  3. Require lender KYC proof before offer acceptance (off-chain).

No public evidence Offerbook special-cases transfer hooks or mint-level whitelists on the claim path.

## 4a. Position & Collateral Tokenization

**Nothing on Offerbook is tokenized.** Confirmed against the FAQ and cross-checked against the RainFi lineage.

| Entity | Representation | Transferable? |
|---|---|---|
| Lender position | PDA keyed to lender wallet | No |
| Borrower position / debt | PDA keyed to borrower wallet | No |
| Collateral (SPL) | Raw SPL balance held in escrow PDA's token account | No (locked for loan term) |
| Collateral (NFT) | Raw NFT mint held in escrow PDA | No (locked for loan term) |
| Loan note / receipt | **None issued** | N/A |
| Lender share receipt (jToken-style) | **None issued** | N/A |

No promissory-note NFT, no fungible receipt token, no assignment instruction, no secondary market for loans. Loans are "fixed and immutable" once accepted — repay early or let default trigger, no third option. This matches the **RainFi parent design** (PDA-state-based, not note-NFT-based), unlike NFTfi on Ethereum, which does mint promissory-note NFTs.

**Contrast with Jupiter Lend** (the pool product, distinct from Offerbook): Jupiter Lend issues fungible **jTokens** as transferable share receipts — composable, usable as collateral elsewhere. Offerbook issues nothing. Any composability intuition from Jupiter Lend does **not** carry over to Offerbook.

### Implications for cUSDY as collateral

- **Good:** No tokenized lender-position means no secondary market where a non-KYC'd party could acquire a claim on cUSDY collateral. The KYC enforcement surface is smaller than it would be on a loan-note protocol.
- **Unchanged:** The lender is still the direct claim recipient on default (§4). The absence of a position-transfer rail means there's no extra gating surface to build — but also no rail on which to reroute the claim through a KYC-aware custodian.
- **Operational:** Lender capital is illiquid for the full 3-day term once an offer is filled. No early-exit for the lender. For institutional lenders this is a hard constraint, not a nuance.

**Unverified:** Whether an undocumented `close_loan` / `transfer_authority` instruction exists in the program — only on-chain IDL extraction can rule this out. Tracked under Open Item #2.

---

## 5. Oracles

**None used in the loan path.** Offer expiration (24h / 1–7d) is the mechanism for stale-price risk. Loans are never liquidated based on price. This is a structural property, not an omission — and it is the main reason Offerbook is interesting for regulated use.

## 6. SDK / On-chain Program / Source Availability

| Item | Status (verified 2026-04-18) |
|---|---|
| Mainnet deployment | **Live** |
| **Devnet deployment** | **No.** No network toggle on the app. Not listed in Jupiter's devnet portal ([devnet.jup.ag](https://devnet.jup.ag/)). Not in the developer-docs product list. No public roadmap statement about devnet plans. |
| Program ID (mainnet) | **Not publicly documented** |
| Public IDL | Not published |
| SDK | No `@jup-ag/offerbook*` or `offerbook-sdk` npm package; Offerbook is absent from Jupiter's CLI |
| **Source code on GitHub** | **No.** [github.com/jup-ag](https://github.com/jup-ag) (183 repos) has zero Offerbook/lending/p2p/rain repos. [github.com/rain-fi](https://github.com/rain-fi) exists but has **zero public repos** — the RainFi source Jupiter inherited was never published. |
| App | [offerbook.jup.ag](https://offerbook.jup.ag/) |
| User docs | [docs.jup.ag/user-docs/earn/offerbook/faq](https://docs.jup.ag/user-docs/earn/offerbook/faq) — user-facing only |

Origins: codebase derived from **RainFi**, the P2P NFT-lending protocol Jupiter acquired at Breakpoint 2025 (230k+ historical loans). Notably, Jupiter Lend (the pool product, separate from Offerbook) was explicitly announced as "fully open source" at Breakpoint 2025 — **Offerbook was not given that designation**, and still isn't.

**Blockers for programmatic integration** (compounding):
1. No devnet → no safe integration environment; testing requires mainnet-with-real-USDC.
2. No source → no audit-your-own-review path; we can't read the program to verify Token-2022 handling or claim-path semantics.
3. No IDL/SDK → instruction layout must be reverse-engineered from mainnet txs or obtained directly from Jupiter under NDA.

This is a materially worse integration posture than Kamino V2 (open source, full SDK, docs). Track all three as hard open items.

## 7. Governance / Upgradeability

- **Upgrade authority is not publicly disclosed.** No statement that the program is immutable / authority renounced.
- Jupiter Lend has been audited 4× by OtterSec and ran a Code4rena contest in Feb 2026 — but that contest targeted **Jupiter Lend, not Offerbook**. Offerbook's audit status specifically is unclear.
- Jupiter DAO exists but on-chain voting is paused through end-of-2025 ("governance restructuring"). No documented DAO control over Offerbook parameters.
- Working assumption: **Jupiter team controls the upgrade authority and fee parameters.** Treat as centrally upgradeable until proven otherwise.

## 8. Comparison vs. Pool Lending (Kamino V2 / Morpho)

| Dimension | Offerbook (P2P) | Kamino V2 / Morpho (Pool) |
|---|---|---|
| Pricing | Bilateral, offer-matched | Utilization curve |
| Liquidation | None — time-based default only | Oracle + auction/keeper |
| Oracle risk | **Zero** | High (Pyth / Switchboard) |
| Capital efficiency | Low (fully collateralised, fixed term, idle until matched) | High |
| Duration | 3d fixed | Perpetual |
| Asset breadth | Wide (NFTs, RWAs, long-tail) | Limited to pool-listed assets |
| KYC collateral fit | Lender is recipient → eligibility problem | Liquidator is recipient → eligibility problem |

### When Offerbook makes sense for cUSDY

- As a **complementary fixed-term product**, not a primary credit channel — the 3-day USDC-only constraint limits it to a term-loan desk rather than always-on liquidity.
- As a **regulator-friendly venue** — no oracles, no liquidations, no forced sale of client collateral under market stress.
- For **RWA-style instruments** where the underlying is not meant to trade minute-to-minute.

### When it doesn't

- Perpetual / revolving credit.
- Debt in assets other than USDC.
- Any flow that assumes an active market-maker will take the offer within hours.

## 9. Launch Status (April 2026)

- **Live on Solana mainnet.** Announced 31 Jan 2026; launched shortly after.
- No standalone TVL breakout for Offerbook on DefiLlama yet — aggregated into Jupiter. Adoption data is effectively unknown in public sources.
- Jupiter raised **$35M from ParaFi** (Feb 2026), the team's first outside investment, partly to back credit-layer expansion.

---

## Open Items Before Integration

These must be resolved before a production cUSDY integration on Offerbook:

| # | Item | Blocking for |
|---|---|---|
| 1 | **Token-2022 extension support** — does Offerbook accept a mint with the ConfidentialTransfer extension as collateral? | Everything |
| 2 | **Program ID + IDL** — obtain from Jupiter or extract from mainnet | Programmatic integration |
| 3 | **Claim-path behaviour with a KYC-gated mint** — does the claim transfer succeed if the lender is not whitelisted? What's the failure mode? | Liquidation risk / stuck positions |
| 4 | **Upgrade authority composition** — who can change the program and under what threshold? | Sovereignty assessment |
| 5 | **Offerbook-specific audit status** — is the program audited independently of Jupiter Lend? | Risk review |
| 6 | **Lender-side KYC gating** — off-chain allowlist vs. custom claim-unwind program — pick one | Product design |

## Recommendation

Offerbook is a **secondary channel, not a Kamino replacement**. The model is attractive for regulated / RWA products precisely because it sidesteps oracles and liquidations, but the three-day term, USDC-only debt, and undocumented program surface make it unsuitable as the primary venue.

Proposed next step: **run an on-chain probe** — attempt to post a test offer with a trivial Token-2022 confidential-transfer mint as collateral on mainnet (small notional), observe whether Offerbook accepts the mint at offer-creation time and whether the claim path succeeds to a pre-whitelisted lender wallet. Result is binary and cheap to discover.

---

## Sources

- [Jupiter Offerbook app](https://offerbook.jup.ag/)
- [Jupiter Docs — Offerbook FAQ](https://docs.jup.ag/user-docs/earn/offerbook/faq)
- [Jupiter Developers — Lend](https://developers.jup.ag/docs/lend)
- [jup-ag GitHub org](https://github.com/jup-ag)
- [Code4rena — 2026-02-jupiter-lend contest](https://github.com/code-423n4/2026-02-jupiter-lend)
- [Solana Compass — Breakpoint 2025 keynote](https://solanacompass.com/learn/breakpoint-25/breakpoint-2025-keynote-jupiter)
- [Blockhead — Jupiter / ParaFi $35M](https://www.blockhead.co/2026/02/04/jupiter-secures-first-ever-outside-investment-with-35m-parafi-capital-deal/)
- [Phemex — Offerbook launch coverage](https://phemex.com/news/article/jupiter-unveils-permissionless-p2p-lending-platform-on-solana-57184)
- [DefiLlama — Jupiter](https://defillama.com/protocol/jupiter)
- [RareSkills — Token-2022 extension interactions](https://rareskills.io/post/token-2022)
