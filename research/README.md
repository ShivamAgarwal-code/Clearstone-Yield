# Research

Forward-looking exploration: product specs that aren't built yet,
assessments of external systems we might integrate, and design notes
that haven't crystallised into shipping code. Once a doc here lands
on-chain, move it into [`../docs/shipped/`](../docs/shipped/) and link
the runtime artifacts.

| Doc | Status | Topic |
|---|---|---|
| [FIXED_YIELD_PLAN.md](FIXED_YIELD_PLAN.md) | proposed product | Fixed-rate savings via permissionless Pendle-style PT/YT split on Clearstone. |
| [CURATOR_ROLL_DELEGATION.md](CURATOR_ROLL_DELEGATION.md) | spec locked, Rust impl in progress | Permissionless auto-roll keeper for v2 curator vaults; closes the gap in `KEEPER_PERMISSIONS.md §4C`. |
| [OFFERBOOK.md](OFFERBOOK.md) | assessment, not committed | Jupiter Offerbook as a second credit channel for cUSDY. |
| [JITO_LST.md](JITO_LST.md) | early notes, partly superseded | Original brain-dump on combining SPL Stake Pool + Token-2022 for KYC-gated LSTs. The csSOL stack ended up using Jito Restaking instead — see [`../docs/shipped/JITO_INTEGRATION_PLAN.md`](../docs/shipped/JITO_INTEGRATION_PLAN.md). |
