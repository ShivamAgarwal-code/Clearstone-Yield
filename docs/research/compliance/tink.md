# Tink as KYC for a demo on-ramp

## TL;DR
**Viable for a demo, not for production crypto KYC.** Tink (Visa-owned, 2022) is an
open-banking platform, not a document/liveness KYC vendor like Sumsub/Onfido/Jumio.
Its "KYC" product pulls bank-verified identity (name, address, IBAN, account
ownership) from the user's connected bank — useful as a *signal* layer, but
regulators expect document + biometric + sanctions screening on top for a real
crypto on-ramp.

For a **demo**, the free Console + Demo Bank sandbox is genuinely good: realistic
test users, real flow, no real bank credentials.

## What Tink "KYC" actually is
- Open-banking-backed identity verification, not a document/selfie check.
- User picks bank → SCA → Tink returns pre-verified name, address, IBAN, account
  holder, balances, transactions.
- Marketed under `tink.com/solutions/kyc` as "Get customers approved faster" —
  positioned as a complement to traditional KYC, not a replacement.
- Coverage: EU + UK, ~3,400+ banks. No US/global KYC.

## Demo-fit assessment
| Need | Fits? |
|---|---|
| Show a connected-bank → identity-verified → on-ramp flow on stage | Yes |
| Free dev access without enterprise contract | Yes — `console.tink.com` |
| Sandbox with realistic test data and no real creds | Yes — Demo Bank |
| Stand-alone KYC for a regulated EU crypto on-ramp | No — needs doc + liveness + sanctions on top |
| US users | No |
| PEP / sanctions screening built-in | No (would pair with NameScan / ComplyAdvantage / Sumsub) |

## Sandbox surface (free tier)
- `console.tink.com` — create app, get client_id/secret, configure redirect URI.
- `demo.tink.com` — playground UI to see flows.
- **Demo Bank** — simulated bank with seeded users, balances, txs; lets the full
  end-user flow run without connecting a real bank.
- Tink Link (hosted UI) is the fastest integration — drop-in iframe/redirect that
  handles bank picker + SCA, then calls our backend with a code to exchange for
  data via the Tink API.

## Recommended demo shape
1. User clicks "Verify with bank" on the on-ramp screen.
2. Tink Link → Demo Bank → SCA prompt (test creds).
3. Backend exchanges code → calls Tink to fetch identity + IBAN.
4. We display "✓ Verified as {name} — IBAN {iban}" and unlock the demo on-ramp.
5. The actual on-ramp (fiat → cUSDC mint, etc.) is mocked or runs on devnet.

This is honest as a demo because the only thing we'd need to swap for production
is layering a real KYC vendor (Sumsub, Onfido, Veriff) on top — the bank-link
half stays the same.

## Watch-outs
- Tink **requires a registered legal entity** to graduate from sandbox to prod;
  not just a hobby project — fine for the demo, blocking for go-live.
- "KYC via open banking" is **not yet accepted** by most EU crypto regulators
  (MiCA expects doc + biometric). Position the demo as "enhanced onboarding
  signal," not "this is our compliance stack."
- Sandbox does not include sanctions/PEP screening — if the demo needs to *show*
  that, mock it or wire NameScan's free tier.

## Sources
- [Tink KYC solution page](https://tink.com/solutions/kyc/)
- [Tink Docs](https://docs.tink.com/)
- [Tink Demo Bank](https://docs.tink.com/entries/articles/demo-bank)
- [Visa completes Tink acquisition](https://ffnews.com/newsarticle/visa-completes-acquisition-of-tink/)
- [Open banking for crypto — Yapily](https://www.yapily.com/blog/open-banking-in-crypto-streamlining-payments-and-kyc)
- [2025 crypto KYC data-verification guide — KYC-Chain](https://kyc-chain.com/data-verification-kyc-us/)
