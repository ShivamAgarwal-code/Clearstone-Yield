# Compliance and traceability — Clearstone Fusion

> **Last updated:** 2026-05-07
> **Owner:** founder
> **Status:** living document; revise after each regulator conversation

**Headline.** Clearstone Fusion is sellable today wherever a licensed institution
already carries the regulated activity: **green in the EU/EEA via the bank's
existing CASP authorisation under MiCA + its CRR/CRD or EMI licence; green in
Switzerland via FINMA-licensed banks under the DLT Act; green in the UAE
through ADGM/VARA/DFSA; yellow in Singapore (institutional-only), Hong Kong
(regime crystallising in 2026), and the UK (gateway opens Sep 2026, in force
Oct 2027); yellow in the US pending CLARITY Act passage; red anywhere we go
direct-to-retail without a licensed wrapper.** Traceability is not the hard
problem — Solana has mature indexers (Helius, Solscan), banks already buy
Chainalysis/TRM/Elliptic, Travel Rule is commoditised through Notabene/Sumsub.
**Clearstone's compliance job-to-be-done is the glue layer**: signed audit
exports, sanctions screening checkpoints, Travel Rule attachments, and
DAC8/CARF/1099-DA-shaped reporting wired into the bank's existing stack.

---

## At-a-glance verdict matrix

| Jurisdiction | Verdict | Customer license needed | Timing | Key caveat |
|---|---|---|---|---|
| **EU (MiCA + DORA + AMLR)** | GREEN | CASP under MiCA + EMI/CRR if holding client money or issuing EMTs | MiCA in force 30 Dec 2024; grandfathering ends **1 Jul 2026** | Member-state deadlines diverge (DE/AT/IE end-2025; NL/PL mid-2025; FR/LU/MT/EE full 18 months) |
| **Switzerland (FINMA + DLT Act)** | GREEN | FINMA banking, securities-firm, fintech, or DLT trading-facility licence | DLT Act fully in force; FINMA Guidance 01/2026 on custody live | Custodial staking → banking licence; segregated client custody required |
| **UAE (VARA + ADGM + DFSA + CBUAE)** | GREEN | VARA / FSRA / DFSA + CBUAE federal layer for DeFi/stablecoin | Cabinet Resolution 111/2025 transition to **Sep 2026** | ADGM = institutional default; VARA = retail-facing |
| **Liechtenstein (TVTG → MiCAR)** | GREEN | TVTG registration → MiCAR CASP by 1 Jul 2026 (simplified upgrade) | Live | Cleanest "Swiss-bank-into-EU" passport route |
| **Singapore (MAS DTSP)** | YELLOW | DTSP licence under FSMA (institutional-only for lending/staking) | Live since **30 Jun 2025**, no soft-landing | Retail lending/staking *prohibited*; accredited-investor only |
| **Hong Kong (SFC ASPIRe)** | YELLOW | SFC Type 1/7 + AMLO VATP today; new VA dealer & custodian regime in 2026 | Custodian/dealer law targeted 2026 | Use existing Type-1+VATP stack until then |
| **UK (FCA)** | YELLOW | MLR 2017 cryptoasset registration today; full FSMA gateway authorisation Oct 2027 | Authorisation applications **Sep 2026** | Staking, lending, DeFi explicitly in scope; Consumer Duty applies |
| **US (federal + state)** | YELLOW | State MTLs + FinCEN MSB; SEC/CFTC framework awaiting CLARITY Act | CLARITY passed House Jul 2025; Senate vote spring 2026 | Atkins SEC has dropped enforcement-first posture; OFAC lifted Tornado Cash Mar 2025 |
| **Direct-to-retail anywhere without a licensed wrapper** | **RED** | n/a | n/a | The whole product thesis is *sell to licensed institutions* — don't fight this |

---

## Part A · Jurisdictions

### EU — MiCA + DORA + AMLR

**Verdict: GREEN, conditional on the bank's CASP scope.**

MiCA fully entered application on **30 December 2024**, with a transitional
"grandfathering" window that ends **1 July 2026**
([Elvinger Hoss](https://elvingerhoss.lu/insights/publications/mica-end-transitional-period-1-july-2026)).
After that date, providing crypto-asset services in the EU without a MiCAR
authorisation is a breach of EU law
([CryptoImpactHub](https://www.cryptoimpacthub.com/the-mica-countdown-what-every-crypto-business-needs-to-know-before-july-2026/)).

The relevant CASP services for Clearstone's bank customers are *custody and
administration of crypto-assets* (savings/credit-trade balances), *execution
of orders* and *reception and transmission of orders* (credit-trade flows),
*portfolio management* (yield products routed to Kamino), and *advice*
(institutional desk). **CRR-licensed credit institutions get a simplified
notification under Art. 60 MiCAR** instead of full CASP authorisation — this
is the path AMINA-class banks should use
([Dechert](https://www.dechert.com/knowledge/onpoint/2025/1/application-of-second-part-of-mica---regulation-of-casps-and-oth.html)).
EMIs get a parallel simplified path for stablecoin/EMT services.

Member-state deadlines for the transitional regime are **not uniform**: Germany,
Austria, and Ireland use 12-month windows ending 2025; Netherlands and Poland
closed mid-2025; France, Malta, Luxembourg, and Estonia adopted the full
18 months ending July 2026
([Sumsub](https://sumsub.com/blog/crypto-regulations-in-the-european-union-markets-in-crypto-assets-mica/)).
Home-state regulator runs the show: BaFin (DE), AMF (FR), CSSF (LU), MFSA
(MT), CNMV (ES), FMA (AT). The CASP passport is real — one authorisation,
EEA-wide service.

**DORA has been in force since 17 January 2025** and explicitly captures CASPs
([Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2025/01/cybersecurity-in-the-financial-sector-eus-digital-operational-resilience-act-takes-effect)).
For Clearstone this matters as a **vendor**: when a bank designates Clearstone
as a critical ICT provider, third-party-risk obligations kick in (incident
reporting, exit plans, ICT register entries, threat-led pen tests). Penalties
reach 2% of global turnover ([IBM](https://www.ibm.com/think/topics/digital-operational-resilience-act)).

**AMLR/AMLD6 + AMLA**: the regulation applies from **10 July 2027**, but AMLA
(Frankfurt) starts selecting directly-supervised entities in 2026
([B4 Finance](https://www.b4finance.com/blog/amla-amlr-6amld-major-compliance-reforms-to-anticipate-in-2026)).
All MiCAR CASPs become "obliged entities" — and the €1,000 occasional-transaction
threshold is **eliminated for crypto** ([Moody's](https://www.moodys.com/web/en/us/kyc/resources/insights/a-review-of-amla-and-amlr-2026.html)).

### Switzerland — FINMA + DLT Act

**Verdict: GREEN. The cleanest jurisdiction for near-term GTM, given AMINA.**

The DLT Blanket Act has been fully in force since 2021 and gives crypto-based
assets enhanced segregation rights in insolvency. **FINMA Guidance 01/2026**
(12 Jan 2026) is the current authoritative position on custody — mandating
client-asset segregation, key-management standards, and a "Crypto-assets
Resolution Package" for any regulated custodian
([Borel Barbey](https://www.borel-barbey.ch/en/finma-has-published-guidance-01-2026-on-the-custody-of-crypto-based-assets/)).

**FINMA's staking position is the live operational concern.** FINMA splits
staking into custodial vs non-custodial; **custodial staking that pools client
assets is treated as accepting public deposits and requires a banking licence**
([Crypto Valley Journal](https://cryptovalleyjournal.com/focus/legal-and-compliance/finma-justifies-controversial-staking-practice-with-swiss-dlt-law/),
[Global Legal Insights 2026](https://www.globallegalinsights.com/practice-areas/blockchain-cryptocurrency-laws-and-regulations/switzerland/)).
For Clearstone's csSOL/JitoSOL credit-trade product: if the bank is the
custodian, it needs **either a banking licence or individually-segregated
direct staking**. AMINA already has the licence — fine. A non-bank Swiss
fintech customer would hit a wall.

The first DLT-trading-facility licence in Switzerland went to **BX Digital AG
in March 2025** ([Chambers 2025](https://practiceguides.chambers.com/practice-guides/blockchain-2025/switzerland/trends-and-developments)) —
the Swiss MTF equivalent for tokenised securities. AML lives under the AMLA
+ FINMA AMLO; the **CHF 1,000 threshold for unverified crypto transfers** is
stricter than the EU's zero-threshold TFR.

### UK — FCA cryptoasset regime

**Verdict: YELLOW today, GREEN once Oct 2027 hits.**

The UK is mid-transition. Today, firms register with the FCA under the **MLR
2017 cryptoasset registration regime** (AML-only). The new full FSMA gateway
is a substantive prudential and conduct regime: **draft SI expected to be
approved in 2026, FCA authorisation gateway opens September 2026, regime in
force October 2027**
([Norton Rose Fulbright](https://www.nortonrosefulbright.com/en/knowledge/publications/8d8b8337/the-uk-regime-for-cryptoassets-draft-rules-and-legislation),
[The Block](https://www.theblock.co/post/397711/uk-fca-seeks-fresh-feedback-on-crypto-rules)).

The FCA's **CP25/40** consultation explicitly captures **crypto lending,
borrowing, and staking** ([Winston & Strawn](https://www.winston.com/en/insights-news/uk-crypto-regulation-moves-forward-lending-staking-and-defi-key-takeaways-from-fca-cp2540)) —
binding constraints for Clearstone-style products: explicit retail consent
before staking, key-features documents, capital to absorb staking losses,
and **separate wallets for staked assets**.

**DeFi position:** "DeFi activities that are truly decentralised will not be
covered… DeFi that involves the proposed regulated activities, and where there
is a clear controlling person(s) carrying on an activity, will be covered"
([FCA](https://www.fca.org.uk/news/press-releases/fca-consults-guidance-uk-future-crypto-regime)).
**Clearstone is a controlled-person stack** — the bank operator IS the
controlling person — so we are in scope, not exempt. The financial promotions
regime (in force October 2023) already binds anyone marketing crypto to UK
retail; FCA-authorised firms can self-approve their own promotions
([FCA](https://www.fca.org.uk/news/press-releases/fca-seeks-feedback-proposals-uk-crypto-rules)).

### US — federal + state

**Verdict: YELLOW. Political winds favourable; statute not yet in force.**

Status as of May 2026:

- **CLARITY Act passed the House in July 2025**, 294–134 ([Latham](https://www.lw.com/en/us-crypto-policy-tracker/legislative-developments)).
  Treasury Secretary Bessent has signalled a **spring-2026 signing timeline**
  ([K&L Gates](https://www.klgates.com/Crypto-in-2026-The-Democratization-of-Digital-Assets-1-29-2026)).
  CLARITY would give the **CFTC exclusive jurisdiction over digital-commodity
  spot markets** while the SEC retains "investment contract asset" oversight
  ([Arnold & Porter](https://www.arnoldporter.com/en/perspectives/advisories/2025/08/clarifying-the-clarity-act)).
- **Senate** is working two parallel drafts: the Banking Committee's
  *Responsible Financial Innovation Act of 2025* (Sep 2025 discussion draft)
  and the Agriculture Committee's *Digital Commodity Intermediaries Act*
  (advanced 29 Jan 2026) ([The Bulldog](https://www.thebulldog.law/senate-crypto-market-structure-bill-advances-what-december-vote-means-for-your-business)).
- **SEC under Chair Paul Atkins** (sworn in 21 April 2025) has explicitly
  reversed Gensler-era "regulation by enforcement" and withdrawn multiple
  crypto enforcement actions ([Reed Smith](https://www.reedsmith.com/articles/digital-asset-trump-administration-developments-emergence-fit21/)).
- **OFAC lifted the Tornado Cash sanctions on 21 March 2025** following the
  Fifth Circuit's *Van Loon v. Treasury* ruling that immutable smart contracts
  are not "property" under IEEPA ([Treasury](https://home.treasury.gov/news/press-releases/sb0057),
  [Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2024/12/federal-appeals-court-tosses-ofac-sanctions-on-tornado-cash-and-limits-federal-governments-ability-to-police-crypto-transactions)).
  **Precedent-setting for protocol design** — pure code without a controlling
  person is harder for OFAC to reach. Doesn't help operators.

Until CLARITY is law, US bank customers operate under the **status-quo stack**:
state-by-state money transmitter licences (NY BitLicense as gold standard),
FinCEN MSB registration, OCC interpretive letters (1170/1174 reaffirming
crypto custody is permissible for national banks), and BSA AML. **Practical
advice: wait for CLARITY signing, or launch via a national-bank trust charter
(Anchorage-style) that already clears the activity.**

### UAE — VARA + ADGM + DFSA + CBUAE

**Verdict: GREEN. Jurisdiction selection matters more than anywhere else.**

The UAE has a **four-headed regulator stack** ([Defy](https://www.getdefy.co/en/resources/blog/uae-crypto-compliance)):

- **VARA** — Dubai mainland, retail-facing; finalised the Custody Services
  Rulebook in March 2025 (95% cold-storage minimum, mandatory third-party
  audits).
- **FSRA / ADGM** — Abu Dhabi Global Market, **institutional-grade default**.
- **DFSA / DIFC** — common-law jurisdiction, asset-manager friendly.
- **CBUAE** — federal, **mandatory for DeFi operators, stablecoin issuers, and
  DEX builders regardless of emirate** ([Neoslegal](https://neoslegal.co/uae-crypto-licensing-regulations-2026/)).

**Cabinet Resolution No. 111 of 2025** expanded the virtual-asset definition to
cover tokenised securities and RWAs from January 2026, with a one-year
transition window to **September 2026** ([Databird](https://www.databirdjournal.com/posts/uaes-federal-decree-law-no-6-of-2025-the-end-of-the-just-code-defense-for-defi-and-the-dawn-of-comprehensive-crypto-regulation)).
Licensing takes **8–12 months**. For Clearstone's institutional desk: **ADGM**.
For a retail-savings bank partner: **VARA** (Dubai mainland) or **DFSA** (DIFC
asset manager).

### Singapore — MAS DTSP regime

**Verdict: YELLOW. Institutional-only; MAS is hostile to retail DeFi yield.**

The **DTSP regime under the FSMA went live 30 June 2025 with no transitional
period** ([MAS](https://www.mas.gov.sg/news/media-releases/2025/mas-clarifies-regulatory-regime-for-digital-token-service-providers)).
Licences are granted **only in "exceptional cases"**. The binding constraint:
**"lending and staking of retail customer tokens are prohibited, though these
remain permitted for institutional and accredited investors"** ([Reed Smith](https://www.reedsmith.com/articles/mas-finalises-clarifies-regulatory-regime-digital-token-service-providers/),
[Hacken](https://hacken.io/discover/singapore-crypto-license/)).
Translation: Clearstone's **institutional-trading-desk surface is fine in
Singapore**; the **retail-savings surface is structurally blocked** unless
gated to accredited investors only. SGD 250k base capital; Travel Rule applies.

### Hong Kong — SFC ASPIRe + AMLO VATP

**Verdict: YELLOW. Custodian and dealer regimes crystallise in 2026.**

Existing regime: **SFC Type 1/7 + AMLO VATP**. The SFC published the **ASPIRe
roadmap** in early 2025 ([FinTech & Blockchain Law Watch](https://www.fintechlawblog.com/2025/04/11/hong-kong-sfcs-new-roadmap-to-develop-hong-kong-as-a-global-virtual-asset-hub-aspire/)).
The FSTB and SFC consulted in mid-2025 on **two new licensing regimes** — VA
dealing (incl. OTC) and VA custody — with **legislation targeted for 2026**
([CoinDesk](https://www.coindesk.com/policy/2025/12/25/hong-kong-regulators-target-2026-legislation-for-virtual-asset-dealer-and-custodian-rules)).
Capital floors: HK$5m paid-up share capital (HK$10m for custodians), HK$3m
liquid capital, 12 months opex in excess liquid ([Sidley](https://www.sidley.com/en/insights/newsupdates/2025/07/hong-kong-poised-to-expand-licensing-regime-to-cover-virtual-asset-dealers-and-custodians)).
Until 2026 legislation lands, sell into HK banks via their existing
SFC + VATP stack.

### Liechtenstein — TVTG → MiCAR

**Verdict: GREEN — and structurally interesting as a Swiss-bank-into-EU bridge.**

Liechtenstein implemented MiCAR domestically via the EEA-MiCA Implementation
Act, effective February 2025 ([FMA Liechtenstein](https://www.fma-li.li/en/supervision-regulation/fintech/micar)).
Existing TVTG-registered TT service providers can run under TVTG during a
transitional window ending **1 July 2026** ([Legal500](https://www.legal500.com/developments/thought-leadership/micar-transition-watch-why-liechtensteins-tvtg-vasps-should-prepare-for-an-30-june-2026-cut-off-and-what-to-do-now/)),
and **TVTG-registered firms get a simplified accelerated upgrade to MiCAR
authorisation** ([Beaumont CM](https://beaumont-capitalmarkets.co.uk/featured_item/liechtenstein-fintech-regulation-micar-tvtg-2025-26)).

Why this matters: **a FINMA-licensed Swiss bank cannot directly passport into
the EU**. A Liechtenstein-domiciled subsidiary CAN. Several Swiss financial
groups already use Liechtenstein as their EEA-passport hub
([Finews](https://www.finews.com/news/english-news/62951-liechtenstein-finews-ch-tvtg-micar-crypto)) —
a credible structural play for AMINA-style customers wanting EU distribution
without re-licensing 27 times.

---

## Part B · Traceability & reporting

### On-chain audit trail

Solana gives us natively: deterministic, signed, replayable state transitions;
mature explorers (Solana Explorer, Solscan after Etherscan acquired it in
2024, Solana FM, Helius XRay — see [Helius's 2026 review](https://www.helius.dev/blog/top-solana-block-explorers));
and indexer infrastructure via [Helius](https://www.helius.dev/) (used by
Phantom, Jupiter, Coinbase, Bitwise) for historical APIs, gRPC streaming, and
webhooks. Cryptographically the audit trail is *better* than a traditional
bank ledger — most auditors don't yet know how to evaluate it.

What banks already have: **Chainalysis Reactor** (Santander, Coinbase, Revolut;
$34B+ frozen/recovered; FedRAMP-cleared for US federal use), **TRM Labs**
(FedRAMP High since Dec 2024; cross-chain AI), **Elliptic** (Bitget adopted
Navigator + Lens specifically for MiCA + Travel Rule in 2025) — see
[Allium's 2025 platform review](https://www.allium.so/blog/top-blockchain-intelligence-platforms-for-risk-compliance-and-public-sector-teams-in-2025/).

**Clearstone's job**: not to compete. Be the **export glue** — emit
schema-versioned audit exports (tx hashes, principal flows, oracle prices at
execution, KYB attestations, fee splits, reserve config diffs) that drop into
the bank's existing Reactor / Bitwave / Cryptio pipeline. Every credit trade,
every yield rebase, every reserve config change should reconcile against
on-chain state in <60 seconds.

### Sanctions / OFAC screening

Two checkpoints, not one:

1. **Deposit-time KYC + sanctions screen.** Standard for any bank — Refinitiv
   World-Check, LexisNexis Bridger, Sumsub KYT. The bank's job; Clearstone's
   whitelist PDA is the on-chain receipt.
2. **On-chain interaction screen.** Before signing deposit/withdrawal/borrow,
   route the counterparty wallet through Chainalysis or TRM real-time risk
   APIs and gate execution on a configurable risk threshold. This is what
   blocks a KYC'd user from withdrawing to a Garantex-affiliated address
   ([TRM on Garantex/Grinex/A7A5](https://www.trmlabs.com/resources/blog/garantex-grinex-and-the-a7a5-token-a-deep-dive-into-sanctions-evasion-networks)).

The **Tornado Cash + Garantex one-two is the binding case-law backdrop.**
Tornado Cash: Fifth Circuit ruled (Nov 2024) that **immutable code itself
isn't sanctionable property**; OFAC delisted in March 2025
([Treasury](https://home.treasury.gov/news/press-releases/sb0057)). Garantex:
OFAC re-designated the operator entity, the successor (Grinex), the
executives, the affiliated A7A5 ruble-stablecoin (Aug 2025), with DOJ
indictments unsealed against executives in March 2025
([Treasury](https://home.treasury.gov/news/press-releases/sb0225)).

**Implication for protocol design:** the **operator entity** (the bank, or
Clearstone-Ops where Clearstone runs the keeper) is the sanctionable surface,
not the smart-contract code. Make every privileged action have a clear
human-or-entity controller, run real-time sanctions screening at that gate,
and log the screen result. Pure-code governance carve-outs do not protect
operators.

### Travel Rule

**EU TFR is in full force as of 30 December 2024**, with **zero threshold** —
every CASP-to-CASP transfer requires originator + beneficiary information
regardless of size ([EBA Guidelines](https://www.eba.europa.eu/sites/default/files/2024-07/6de6e9b9-0ed9-49cd-985d-c0834b5b4356/Travel%20Rule%20Guidelines.pdf),
[Notabene EU](https://notabene.id/world/eu)). FATF Recommendation 16 sets the
global baseline; FinCEN's $3,000 US threshold is the laggard.

Provider landscape (commoditised): **Notabene** — protocol-agnostic, supports
TRP / IVMS101 / TRUST / GTR; their [2025 report](https://notabene.id/post/state-of-crypto-travel-rule-2025report)
shows 100% of surveyed VASPs commit to compliance and 15% now block
withdrawals pending beneficiary confirmation (up from 2.9% in 2024).
**Sumsub Travel Rule** bundles with KYC/KYT. **GTR** is Asia-heavy, **TRP**
UK-origin (ING-backed), **TRUST** US-led (Coinbase). Switzerland's parallel
regime under FINMA AMLO is covered by the same providers.

**Clearstone's job**: route every wallet-to-wallet transfer through the bank's
existing Travel Rule provider (an Anchor instruction can verify a Notabene
attestation hash before authorising withdrawal). Don't build the plumbing.

### Tax reporting — DAC8, 1099-DA, CARF

Three converging frameworks, all live in 2026:

**EU DAC8** — Reportable Crypto-Asset Service Providers (RCASPs) must collect
EU-resident user data from **1 January 2026** and exchange with member-state
tax authorities by **30 September 2027** for tax year 2026
([European Commission](https://taxation-customs.ec.europa.eu/taxation/tax-transparency-cooperation/administrative-co-operation-and-mutual-assistance/directive-administrative-cooperation-dac/dac8_en),
[Deloitte Malta](https://www.deloitte.com/mt/en/services/tax/perspectives/tax-alerts/Gearing-up-for-crypto-asset-tax-reporting-requirements-in-2026--.html)).
RCASP scope is broad — CASPs, custodians, and **certain DeFi platforms that
facilitate transactions**. Clearstone's bank customer is unambiguously in scope.

**US Form 1099-DA** — IRS broker reporting; **gross proceeds since 1 Jan 2025**,
**basis reporting from 1 Jan 2026** for "covered" assets (acquired and held
in same broker account) ([IRS instructions](https://www.irs.gov/instructions/i1099da)).
Applies to brokers taking possession — custodial savings products and the
institutional desk are clearly in scope; non-custodial DeFi-only flows are
not (post the IRS DeFi-broker rule rollback). For US bank customers: emit
per-trade 1099-DA-shaped exports as table stakes.

**CARF (OECD)** — global FATCA-equivalent. **48 jurisdictions committed for
the 2026 reporting period, ~52 by January 2026 including the UK** ([OECD
commitments](https://www.oecd.org/content/dam/oecd/en/networks/global-forum-tax-transparency/commitments-carf.pdf),
[Sumsub](https://sumsub.com/media/news/global-crypto-tax-data-collection-under-carf/)).
First exchange in 2027 for 2026 data. EU implements CARF via DAC8 (data shape
harmonised); UK, Switzerland, Singapore, UAE, Hong Kong implement directly.

**Clearstone's job**: ship a **DAC8/CARF/1099-DA-aligned export schema** out
of the operator console — per-customer, per-tax-year, with the cost-basis
tracking CARF Article 7 requires. Expensive to build from scratch; high-value
sales point.

### Audit-firm acceptance

What Big-4 / specialised firms need to sign off on:

- **Reserve attestations.** Armanino was the proof-of-reserves first-mover
  pre-FTX, retreated post-FTX with most of the Big 4. Current consensus:
  **Merkle-tree liabilities + signed control of on-chain reserves at
  attestation timestamp** ([Accounting Today](https://www.accountingtoday.com/list/tech-news-pioneering-crypto-audits)).
  For Clearstone's products the on-chain reserve is *transparent by
  construction* — the audit shifts from "do reserves exist?" to "are they
  properly classified and is access control adequate?".
- **Subledger tooling.** Bitwave (SOC 1 + SOC 2 Type 2) and Cryptio
  (US GAAP + IFRS, deep ERP integrations) are the two institutional defaults
  ([TRES Finance](https://tres.finance/crypto-audit/top-crypto-audit-companies-compared/));
  Lukka and SonarX show up at large asset managers. Banks have these — we
  provide the export.
- **Internal controls.** SOC 2 Type 2 on Clearstone's keeper, console, and
  programs is **table stakes** for any institutional sale. Plan to commission
  by Q4 2026.
- **Big-4 receptivity.** Most won't sign full audits on retail crypto entities
  but **will sign on a regulated bank's crypto-services line** if controls
  map to the bank's existing audit scope. Yet another reason the
  bank-customer wrapper is the right posture.

---

## Open questions / known unknowns

1. **MiCA "advice" boundary for the institutional desk.** Are AI-driven
   credit-trade suggestions in the institutional console "investment advice"
   under MiFID II + MiCAR Art. 60? **Need ESMA Q&A or EU counsel** before
   launching the AI co-pilot.
2. **Switzerland custodial-staking treatment of csSOL.** FINMA splits at
   "individually segregated" — does the LST mint mechanism qualify? Likely
   yes, but **needs a FINMA enquiry letter via AMINA** before onboarding
   Swiss retail end users.
3. **US: is Clearstone a "broker" under 1099-DA?** Final regs apply to brokers
   "taking possession". The keeper has signing authority over reserves.
   **Likely the bank is the broker, not Clearstone, but needs a US tax
   counsel opinion** (Davis Polk / S&C tier).
4. **DAC8 DeFi-platform scope.** Recital language sweeps in "certain DeFi
   platforms that facilitate transactions". Does Clearstone's keeper meet
   that test even when serving a single licensed bank? **Need an EU tax
   counsel opinion** (Loyens & Loeff / Arendt would be the obvious calls).
5. **Liechtenstein-as-passporting-bridge for Swiss banks — has anyone done
   this with a DeFi-backed product specifically?** Several Swiss groups have
   the structural capability but no launched DeFi-backed reference today.
   **Needs conversations with FMA Liechtenstein and AMINA's group treasurer.**

---

## Appendix · Sources

**EU (MiCA, DORA, AMLR, TFR, DAC8)** —
[Elvinger Hoss on the 1 Jul 2026 transition end](https://elvingerhoss.lu/insights/publications/mica-end-transitional-period-1-july-2026) ·
[CryptoImpactHub MiCA countdown](https://www.cryptoimpacthub.com/the-mica-countdown-what-every-crypto-business-needs-to-know-before-july-2026/) ·
[Sumsub on member-state deadline divergence](https://sumsub.com/blog/crypto-regulations-in-the-european-union-markets-in-crypto-assets-mica/) ·
[Dechert on the CRR Art. 60 simplified path](https://www.dechert.com/knowledge/onpoint/2025/1/application-of-second-part-of-mica---regulation-of-casps-and-oth.html) ·
[Mayer Brown on DORA in force](https://www.mayerbrown.com/en/insights/publications/2025/01/cybersecurity-in-the-financial-sector-eus-digital-operational-resilience-act-takes-effect) ·
[IBM DORA penalties](https://www.ibm.com/think/topics/digital-operational-resilience-act) ·
[B4 Finance on AMLR/AMLA 2026](https://www.b4finance.com/blog/amla-amlr-6amld-major-compliance-reforms-to-anticipate-in-2026) ·
[Moody's on AMLR crypto threshold](https://www.moodys.com/web/en/us/kyc/resources/insights/a-review-of-amla-and-amlr-2026.html) ·
[EBA Travel Rule Guidelines (final)](https://www.eba.europa.eu/sites/default/files/2024-07/6de6e9b9-0ed9-49cd-985d-c0834b5b4356/Travel%20Rule%20Guidelines.pdf) ·
[Notabene EU Travel Rule guide](https://notabene.id/world/eu) ·
[European Commission DAC8 page](https://taxation-customs.ec.europa.eu/taxation/tax-transparency-cooperation/administrative-co-operation-and-mutual-assistance/directive-administrative-cooperation-dac/dac8_en) ·
[Deloitte Malta DAC8 alert](https://www.deloitte.com/mt/en/services/tax/perspectives/tax-alerts/Gearing-up-for-crypto-asset-tax-reporting-requirements-in-2026--.html).

**Switzerland** —
[Borel Barbey on FINMA Guidance 01/2026](https://www.borel-barbey.ch/en/finma-has-published-guidance-01-2026-on-the-custody-of-crypto-based-assets/) ·
[Crypto Valley Journal on FINMA staking position](https://cryptovalleyjournal.com/focus/legal-and-compliance/finma-justifies-controversial-staking-practice-with-swiss-dlt-law/) ·
[Chambers Blockchain 2025 Switzerland](https://practiceguides.chambers.com/practice-guides/blockchain-2025/switzerland/trends-and-developments) ·
[Global Legal Insights 2026 Switzerland](https://www.globallegalinsights.com/practice-areas/blockchain-cryptocurrency-laws-and-regulations/switzerland/).

**UK** —
[FCA on future crypto regime](https://www.fca.org.uk/news/press-releases/fca-consults-guidance-uk-future-crypto-regime) ·
[FCA on UK crypto rules feedback](https://www.fca.org.uk/news/press-releases/fca-seeks-feedback-proposals-uk-crypto-rules) ·
[Norton Rose Fulbright UK regime](https://www.nortonrosefulbright.com/en/knowledge/publications/8d8b8337/the-uk-regime-for-cryptoassets-draft-rules-and-legislation) ·
[The Block on Oct 2027 rollout](https://www.theblock.co/post/397711/uk-fca-seeks-fresh-feedback-on-crypto-rules) ·
[Winston & Strawn on FCA CP25/40](https://www.winston.com/en/insights-news/uk-crypto-regulation-moves-forward-lending-staking-and-defi-key-takeaways-from-fca-cp2540).

**US** —
[Latham US Crypto Policy Tracker](https://www.lw.com/en/us-crypto-policy-tracker/legislative-developments) ·
[Reed Smith on FIT21 re-emergence](https://www.reedsmith.com/articles/digital-asset-trump-administration-developments-emergence-fit21/) ·
[K&L Gates 2026 outlook](https://www.klgates.com/Crypto-in-2026-The-Democratization-of-Digital-Assets-1-29-2026) ·
[Arnold & Porter on CLARITY](https://www.arnoldporter.com/en/perspectives/advisories/2025/08/clarifying-the-clarity-act) ·
[The Bulldog on Senate market structure](https://www.thebulldog.law/senate-crypto-market-structure-bill-advances-what-december-vote-means-for-your-business) ·
[Treasury — Tornado Cash delisting](https://home.treasury.gov/news/press-releases/sb0057) ·
[Mayer Brown on Fifth Circuit Tornado Cash ruling](https://www.mayerbrown.com/en/insights/publications/2024/12/federal-appeals-court-tosses-ofac-sanctions-on-tornado-cash-and-limits-federal-governments-ability-to-police-crypto-transactions) ·
[Treasury Garantex/Grinex/A7A5 sanctions](https://home.treasury.gov/news/press-releases/sb0225) ·
[IRS Form 1099-DA instructions (2026)](https://www.irs.gov/instructions/i1099da).

**UAE** —
[Defy UAE 2026 compliance guide](https://www.getdefy.co/en/resources/blog/uae-crypto-compliance) ·
[Neoslegal UAE Licensing 2026](https://neoslegal.co/uae-crypto-licensing-regulations-2026/) ·
[Databird on Federal Decree Law No. 6 / 2025](https://www.databirdjournal.com/posts/uaes-federal-decree-law-no-6-of-2025-the-end-of-the-just-code-defense-for-defi-and-the-dawn-of-comprehensive-crypto-regulation).

**Singapore** —
[MAS DTSP regulatory regime release](https://www.mas.gov.sg/news/media-releases/2025/mas-clarifies-regulatory-regime-for-digital-token-service-providers) ·
[Reed Smith on MAS DTSP final regime](https://www.reedsmith.com/articles/mas-finalises-clarifies-regulatory-regime-digital-token-service-providers/) ·
[Hacken Singapore licensing playbook](https://hacken.io/discover/singapore-crypto-license/).

**Hong Kong** —
[CoinDesk on 2026 dealer/custodian legislation](https://www.coindesk.com/policy/2025/12/25/hong-kong-regulators-target-2026-legislation-for-virtual-asset-dealer-and-custodian-rules) ·
[Sidley on HK licensing expansion](https://www.sidley.com/en/insights/newsupdates/2025/07/hong-kong-poised-to-expand-licensing-regime-to-cover-virtual-asset-dealers-and-custodians) ·
[FinTech Law Watch on ASPIRe](https://www.fintechlawblog.com/2025/04/11/hong-kong-sfcs-new-roadmap-to-develop-hong-kong-as-a-global-virtual-asset-hub-aspire/).

**Liechtenstein** —
[FMA Liechtenstein MiCAR page](https://www.fma-li.li/en/supervision-regulation/fintech/micar) ·
[Legal500 on TVTG / 1 Jul 2026 cut-off](https://www.legal500.com/developments/thought-leadership/micar-transition-watch-why-liechtensteins-tvtg-vasps-should-prepare-for-an-30-june-2026-cut-off-and-what-to-do-now/) ·
[Beaumont CM on TVTG → MiCAR upgrade](https://beaumont-capitalmarkets.co.uk/featured_item/liechtenstein-fintech-regulation-micar-tvtg-2025-26) ·
[Finews on Liechtenstein as Swiss passporting hub](https://www.finews.com/news/english-news/62951-liechtenstein-finews-ch-tvtg-micar-crypto).

**Traceability, Travel Rule, audit** —
[Allium top blockchain intelligence platforms 2025](https://www.allium.so/blog/top-blockchain-intelligence-platforms-for-risk-compliance-and-public-sector-teams-in-2025/) ·
[TRM Labs Garantex/Grinex/A7A5 deep dive](https://www.trmlabs.com/resources/blog/garantex-grinex-and-the-a7a5-token-a-deep-dive-into-sanctions-evasion-networks) ·
[Notabene 2025 Travel Rule report](https://notabene.id/post/state-of-crypto-travel-rule-2025report) ·
[Helius platform overview](https://www.helius.dev/) ·
[Helius — top Solana block explorers (2026)](https://www.helius.dev/blog/top-solana-block-explorers) ·
[TRES Finance — top crypto audit companies](https://tres.finance/crypto-audit/top-crypto-audit-companies-compared/) ·
[Accounting Today — pioneering crypto audits](https://www.accountingtoday.com/list/tech-news-pioneering-crypto-audits) ·
[OECD CARF jurisdiction commitments](https://www.oecd.org/content/dam/oecd/en/networks/global-forum-tax-transparency/commitments-carf.pdf) ·
[Sumsub on CARF 48-country rollout](https://sumsub.com/media/news/global-crypto-tax-data-collection-under-carf/).
