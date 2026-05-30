# Compliance — slide row reference

> **Last updated:** 2026-05-08
> **Companion to:** the deck's *Sellable today* slide
> ([packages/frontend-deck/src/slides/index.tsx → ComplianceSlide](../../../packages/frontend-deck/src/slides/index.tsx))
> **Deeper legal analysis:** [compliance-and-traceability.md](./compliance-and-traceability.md)

The slide compresses the compliance map into a single table. This document
is the **plain-language expansion** for each row — what to say when a non-
specialist reader asks *"and what does that actually mean?"*. The wording
matches what the slide now says (we deliberately stripped the regulatory
jargon — `grandfathering`, `CASP`, `DLT-TF`, `wrapper` — so the slide is
parseable by a generalist audience). The longer reference terms still live
in [compliance-and-traceability.md](./compliance-and-traceability.md) for
follow-up questions.

---

## What the slide shows

**Headline.** *Sellable today, where licensed institutions exist.*

**Subtitle.** Clearstone provides the rails. The bank's licence covers the
regulated activity — **MiCA (EU), FINMA (Swiss), VARA (UAE), FCA (UK)**.
Selling to retail without a licensed bank or fintech partner isn't possible,
anywhere.

**Verdict legend.**

| Chip | Meaning |
|------|---------|
| 🟢 **GREEN** | Sellable today |
| 🟡 **YELLOW** | Sellable today, rules updating |
| 🔴 **RED** | Blocked — needs a licensed partner |

**Table columns.** Jurisdiction · Verdict · Customer licence · Timing · Key
caveat. Six rows: four green markets we'd ship into immediately (EU,
Switzerland, UAE, Liechtenstein), one yellow row consolidating four
jurisdictions in transition (SG / UK / US / HK), and one red row for the
structural product decision *not* to sell direct-to-retail.

**One-line read.** Clearstone is a B2B vendor. Every regulated jurisdiction
has a licensed-institution path; none have a sellable retail-direct path.

---

## 🟢 EU — *MiCA · DORA · AMLR*

- **Customer licence — bank or e-money licence.**
  The bank or fintech selling the product holds a credit-institution licence
  (CRR/CRD) or an E-Money Institution licence. Either of those gives access
  to a *simplified notification* under Art. 60 MiCAR — they do **not** need
  a separate Crypto-Asset Service Provider authorisation
  ([Dechert on the Art. 60 simplified path](https://www.dechert.com/knowledge/onpoint/2025/1/application-of-second-part-of-mica---regulation-of-casps-and-oth.html)).
  DORA layers on operational-resilience obligations
  ([Mayer Brown on DORA](https://www.mayerbrown.com/en/insights/publications/2025/01/cybersecurity-in-the-financial-sector-eus-digital-operational-resilience-act-takes-effect));
  AMLR consolidates anti-money-laundering rules at EU level. (Internal note:
  "CASP authorisation" is the standalone crypto licence; banks and EMIs skip
  it via the Art. 60 fast-track.)
- **Timing — MiCA mandatory from Jul 2026.**
  MiCA entered full application on **30 December 2024**, with an 18-month
  transitional period (the legal term-of-art is "grandfathering"). After
  **1 July 2026** every firm providing crypto services in the EU must hold
  a MiCAR authorisation or fall under a bank/EMI Art. 60 notification
  ([Elvinger Hoss on the 1 Jul 2026 transition end](https://elvingerhoss.lu/insights/publications/mica-end-transitional-period-1-july-2026)).
  Operating without one after that date is a breach of EU law
  ([CryptoImpactHub MiCA countdown](https://www.cryptoimpacthub.com/the-mica-countdown-what-every-crypto-business-needs-to-know-before-july-2026/)).
- **Caveat — each EU country has its own deadline.**
  Member states set their own end-dates within the 18-month window: Germany,
  Austria, and Ireland closed end-2025; Netherlands and Poland mid-2025;
  France, Luxembourg, Malta, and Estonia run the full window to Jul 2026
  ([Sumsub on member-state deadline divergence](https://sumsub.com/blog/crypto-regulations-in-the-european-union-markets-in-crypto-assets-mica/)).
  Plan country-by-country, don't assume a single EU on-ramp.
- *Talking point:* "Your bank or e-money licence already covers the
  regulated activity. We're the rails inside it — built to be notified under
  Art. 60 MiCAR before the July 2026 deadline."

## 🟢 Switzerland — *FINMA · DLT Act*

- **Customer licence — banking, securities, or DLT licence.**
  An AMINA-class FINMA-licensed bank already holds the licence that covers
  issuance, custody, and trading of tokenised assets. The Swiss DLT Act
  added a fourth licence type — DLT trading facility — but for a bank
  customer it adds nothing on top of the banking licence.
- **Timing — DLT Act live · FINMA guidance live.**
  The DLT Act has been fully in force for several years; **FINMA Guidance
  01/2026** (published Jan 2026) codifies the operating rules for crypto
  custody and staking-as-a-service
  ([Borel Barbey on FINMA Guidance 01/2026](https://www.borel-barbey.ch/en/finma-has-published-guidance-01-2026-on-the-custody-of-crypto-based-assets/)).
  Both rulebooks are settled — there is no pending reform to wait for.
- **Caveat — bank-custodied staking needs a banking licence.**
  FINMA distinguishes pass-through staking (the user controls the wallet —
  no banking activity) from custody-based staking (the bank holds the SOL
  and stakes on the user's behalf — *that* is treated as accepting public
  deposits and requires the banking licence)
  ([Crypto Valley Journal on FINMA staking position](https://cryptovalleyjournal.com/focus/legal-and-compliance/finma-justifies-controversial-staking-practice-with-swiss-dlt-law/),
  [Global Legal Insights 2026](https://www.globallegalinsights.com/practice-areas/blockchain-cryptocurrency-laws-and-regulations/switzerland/)).
  Product design follows this distinction.
- *Talking point:* "FINMA already wrote the staking rulebook. We're built
  to it — the staking flow follows the pass-through pattern by default."

## 🟢 UAE — *VARA · ADGM · DFSA*

- **Customer licence — local crypto licence (VARA / FSRA / DFSA).**
  Three doors, all viable
  ([Defy on the UAE four-headed regulator stack](https://www.getdefy.co/en/resources/blog/uae-crypto-compliance)):
  - **VARA** — Dubai mainland; retail-permitted; full Virtual Asset
    Service Provider regime.
  - **ADGM FSRA** — Abu Dhabi free zone; institutional default; six-week
    regulatory-sandbox path.
  - **DFSA** — DIFC free zone; TradFi-style oversight; cleanest for asset
    managers.
- **Timing — federal crypto law · live by Sep 2026.**
  UAE Cabinet Resolution 111/2025 sets a federal Virtual Asset law with a
  transition window extending through **September 2026**. Issuers and
  platforms have until then to align with the relevant rulebook
  ([Databird on Federal Decree-Law No. 6 of 2025](https://www.databirdjournal.com/posts/uaes-federal-decree-law-no-6-of-2025-the-end-of-the-just-code-defense-for-defi-and-the-dawn-of-comprehensive-crypto-regulation)).
- **Caveat — use ADGM (Abu Dhabi) for fastest institutional path.**
  For a B2B product like Clearstone, ADGM's Financial Services Permission
  regime is the cleanest — no retail exposure, no per-product approval
  cycle, six-week sandbox onboarding
  ([Neoslegal on UAE crypto licensing 2026](https://neoslegal.co/uae-crypto-licensing-regulations-2026/)).
- *Talking point:* "ADGM is the fastest institutional door in the region.
  We've already mapped the controls."

## 🟢 Liechtenstein — *local law → EU MiCA*

- **Customer licence — crypto licence (upgrades to EU MiCA).**
  Liechtenstein passed the **Token & Trusted Technology Service Providers
  Act (TVTG)** in 2020 — the world's first DLT-specific statute
  ([FMA Liechtenstein MiCAR page](https://www.fma-li.li/en/supervision-regulation/fintech/micar)).
  Firms registered under TVTG get a simplified upgrade path into MiCAR (the
  EU framework) by July 2026.
- **Timing — fast-track upgrade by Jul 2026.**
  Same Jul 2026 deadline as the rest of the EU/EEA, but reduced-friction
  transition for existing TVTG registrants
  ([Legal500 on the TVTG → MiCAR cut-off](https://www.legal500.com/developments/thought-leadership/micar-transition-watch-why-liechtensteins-tvtg-vasps-should-prepare-for-an-30-june-2026-cut-off-and-what-to-do-now/),
  [Beaumont CM on the simplified upgrade](https://beaumont-capitalmarkets.co.uk/featured_item/liechtenstein-fintech-regulation-micar-tvtg-2025-26)).
- **Caveat — easiest path from Switzerland into the EU.**
  A FINMA-licensed Swiss bank cannot directly passport into the EU. A
  Liechtenstein-domiciled subsidiary can. For a Swiss-headquartered bank
  that wants EU reach, the Liechtenstein subsidiary is faster than applying
  for direct DE / FR / LU MiCAR authorisation
  ([Finews on Swiss-into-EU via Liechtenstein](https://www.finews.com/news/english-news/62951-liechtenstein-finews-ch-tvtg-micar-crypto)).
- *Talking point:* "If you're a Swiss bank and you want EU passporting,
  this is the door."

## 🟡 SG · UK · US · HK — *rules being updated*

A consolidated row for four jurisdictions that are **sellable today
through a local bank's licence** but will get a cleaner regulatory home as
2026–2027 reforms land.

- **Singapore — MAS DTSP** (live since Jun 2025).
  Digital Token Service Provider licence under the Financial Services and
  Markets Act
  ([MAS press release](https://www.mas.gov.sg/news/media-releases/2025/mas-clarifies-regulatory-regime-for-digital-token-service-providers)).
  Important caveat: **retail lending and staking are explicitly prohibited;
  institutional and accredited-investor flows remain permitted**
  ([Reed Smith on the MAS DTSP regime](https://www.reedsmith.com/articles/mas-finalises-clarifies-regulatory-regime-digital-token-service-providers/),
  [Hacken on Singapore crypto licensing](https://hacken.io/discover/singapore-crypto-license/)).
- **United Kingdom — FCA cryptoasset regime.**
  Today the firm registers under the Money Laundering Regulations 2017.
  **The FCA's full FSMA cryptoasset gateway opens for applications Sep
  2026 and is fully in force Oct 2027**
  ([Norton Rose Fulbright on the UK regime](https://www.nortonrosefulbright.com/en/knowledge/publications/8d8b8337/the-uk-regime-for-cryptoassets-draft-rules-and-legislation),
  [The Block on the Oct 2027 rollout](https://www.theblock.co/post/397711/uk-fca-seeks-fresh-feedback-on-crypto-rules)).
  Staking, lending, and DeFi are explicitly in scope; the FCA's Consumer
  Duty applies
  ([Winston & Strawn on FCA CP25/40](https://www.winston.com/en/insights-news/uk-crypto-regulation-moves-forward-lending-staking-and-defi-key-takeaways-from-fca-cp2540)).
- **United States — federal + state.**
  State Money Transmitter Licences (NY BitLicense is the gold standard)
  plus FinCEN Money Services Business registration today. **The CLARITY
  Act passed the House Jul 2025, 294–134**
  ([Latham US Crypto Policy Tracker](https://www.lw.com/en/us-crypto-policy-tracker/legislative-developments));
  the Senate market-structure bill advanced 29 Jan 2026
  ([The Bulldog on the Senate vote](https://www.thebulldog.law/senate-crypto-market-structure-bill-advances-what-december-vote-means-for-your-business)).
  Once enacted, CLARITY would give the CFTC exclusive jurisdiction over
  digital-commodity spot markets
  ([Arnold & Porter on CLARITY](https://www.arnoldporter.com/en/perspectives/advisories/2025/08/clarifying-the-clarity-act),
  [K&L Gates on Crypto in 2026](https://www.klgates.com/Crypto-in-2026-The-Democratization-of-Digital-Assets-1-29-2026)).
  SEC under Chair Paul Atkins (sworn 21 Apr 2025) has explicitly dropped
  the Gensler-era enforcement-first posture
  ([Reed Smith on the Trump-administration digital-asset shift](https://www.reedsmith.com/articles/digital-asset-trump-administration-developments-emergence-fit21/)).
- **Hong Kong — SFC ASPIRe + AMLO VATP.**
  Type 1 / Type 7 SFO licences combined with a Virtual Asset Trading
  Platform licence work today
  ([FinTech & Blockchain Law Watch on the ASPIRe roadmap](https://www.fintechlawblog.com/2025/04/11/hong-kong-sfcs-new-roadmap-to-develop-hong-kong-as-a-global-virtual-asset-hub-aspire/));
  **a new dedicated VA dealer + custodian regime is targeted for 2026**
  ([CoinDesk on Hong Kong's 2026 legislation target](https://www.coindesk.com/policy/2025/12/25/hong-kong-regulators-target-2026-legislation-for-virtual-asset-dealer-and-custodian-rules),
  [Sidley on the expanded HK regime](https://www.sidley.com/en/insights/newsupdates/2025/07/hong-kong-poised-to-expand-licensing-regime-to-cover-virtual-asset-dealers-and-custodians)).
- **Caveat — sellable today through a local bank's licence.**
  None of these markets *block* the product today; each requires a licensed
  partner using the current framework. The pending reforms create upside
  (a cleaner home), not new gating.
- *Talking point:* "Today through the bank's existing licence; cleaner
  once CLARITY (US) and the FCA's FSMA gateway (UK) land in 2026–27."

## 🔴 Direct-to-retail — *no licensed partner*

- **Customer licence — none.**
  No bank, fintech, or asset manager carries the regulated activity.
- **Timing — n/a.**
- **Caveat — not viable, needs a licensed partner.**
  Without a licensed partner, every regulator on this slide treats the
  offering as an unlicensed financial service. This is a **structural
  product decision**, not a compliance limitation. Clearstone does not
  go direct-to-consumer.
- *Talking point:* "We're not a retail brand. The bank is — we're their
  rails."

---

## Why the slide simplifies the regulatory vocabulary

The deck audience includes founders, partners, and investors who are not
EU compliance specialists. Earlier drafts of the slide used the regulator's
own terms-of-art (`grandfathering`, `CASP`, `EMI/CRR`, `DLT-TF`,
`Cabinet 111/2025`, `TVTG → MiCAR`). Each is precise but opaque on first
read. The current copy substitutes the equivalent plain-language phrase:

| Slide before | Slide now | Why |
|---|---|---|
| `Grandfathering ends Jul 2026` | `MiCA mandatory from Jul 2026` | "Grandfathering" is term-of-art for the transitional carve-out. The plain version states the consequence directly. |
| `CASP + EMI/CRR` | `Bank or e-money licence` | Names the licence the customer actually holds, not the regulation that authorises it. |
| `Banking / securities / DLT-TF` | `Banking, securities, or DLT licence` | "DLT-TF" abbreviates "trading facility"; expanding it loses nothing. |
| `Cabinet 111/2025 → Sep 2026` | `Federal crypto law · live by Sep 2026` | The decree number means nothing without context; the date is the actionable part. |
| `TVTG → MiCAR CASP` | `Crypto licence (upgrades to EU MiCA)` | TVTG is jurisdiction-specific shorthand. The plain version explains the upgrade path. |
| `Existing local stack` | `Existing local licence` | "Stack" is engineer-speak. |
| `regimes in transition` | `rules being updated` | Same fact, no Latin abstraction. |
| `no licensed wrapper` | `no licensed partner` | "Wrapper" is fintech jargon for a regulated entity carrying the activity for an unlicensed back-end. "Partner" is the same thing in plain English. |
| `carries the activity` | `covers the regulated activity` | "Carries" is regulator-speak for "is the licensed entity responsible for." |

Specialists in the audience can still find the original terms in the
deeper reference doc; generalists no longer need a footnote to read the
slide.

---

## What to read next

- **Full legal analysis** with regulator quotes, transition timelines, and
  open questions: [compliance-and-traceability.md](./compliance-and-traceability.md)
- **Commercial thesis** (why banks buy and don't build, why retail is
  already KYC'd, the Stablehacks adoption playbook):
  [commercial-thesis.md](../commercial/commercial-thesis.md)
- **Slide source code** (the table data this doc expands on):
  [packages/frontend-deck/src/slides/index.tsx](../../../packages/frontend-deck/src/slides/index.tsx)
