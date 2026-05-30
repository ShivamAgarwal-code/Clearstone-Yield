# Protocol Sovereignty — Who Can Shut Down Our Market?

Assessment of how much control the host protocol's governance / admin retains over a permissionlessly-created market after we deploy into it. Specifically: **can Kamino / Save / Marginfi governance shut down, pause, override, or redirect value from a market we own?**

**Scope:** cUSDY (Token-2022, KYC-gated) as collateral on a permissionless market.

**Legend:** **[V]** verified from source / official docs · **[I]** inferred, needs on-chain confirmation.

---

## 1. Kamino Lend V2

Program: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`

### Control surface

| Dimension | Finding |
|---|---|
| **Program upgradeability** | Upgradeable. Kamino uses a Squads multisig per Squads' public case list. Current upgrade-authority address and signer composition **[I]** — must verify via `solana program show`. Any upgrade can introduce new admin paths. |
| **Global admin (`GlobalConfig` PDA)** | Narrow scope in current code: `global_admin`, `pending_admin`, `fee_collector`. Two-step admin rotation (`update_global_config` → `apply_pending_admin`). **No global-pause / emergency-mode field at `GlobalConfig` level [V].** |
| **Market ownership** | Per-market `lending_market_owner` — freely transferable at init to our Squads multisig **[V]**. Each market also has its own `emergency_council`, `risk_authority`, `borrow_disabled`, `emergency_mode` — all settable by us at creation. |
| **Reserve-config overrides** ⚠️ | `update_reserve_config` is normally gated by `lending_market_owner`. **BUT** `is_allowed_signer_to_update_reserve_config()` has a branch: if the update mode is flagged `global_admin_only` AND the signer is `global_config.global_admin`, the global admin can update that reserve-config mode on markets it doesn't own. **The exact set of global-admin-only modes is the key unknown [I]** — plausibly includes protocol-take-rate, fee split, possibly oracle. |
| **Emergency pause** | Per-market `emergency_mode`, toggleable by the market owner **or** by the `emergency_council` field on the market. The council is set at init — if we point it at our own multisig, Kamino governance has no pause path. **[V]** |
| **Oracle swap** | Oracle lives in the reserve config. If oracle-related modes are in the `global_admin_only` set, Kamino's global admin can re-point our oracle. **[I] — highest verification priority.** |
| **Fee sweeping** | `redeem_fees` / `withdraw_protocol_fees` flow to `global_config.fee_collector` (Kamino's address). Protocol take-rate on your reserve is in `ReserveConfig`; if that mode is global-admin-only, Kamino can raise its cut on your reserve unilaterally. |

### Can they shut down our market?

- **Pause:** Only if we set `emergency_council` to a Kamino address. Self-mitigated.
- **Force-close:** No direct shutdown primitive. No "force-liquidate arena" equivalent found in klend.
- **Degradation vectors:** (a) global-admin-only reserve-config modes (oracle, fees, rates — scope unknown), (b) program upgrade authority can redefine anything.

### Sovereignty: **MODERATE–HIGH** at the state level, contingent on program upgrade hygiene.

### Must-verify before production

1. `solana program show KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` — confirm upgrade authority is a Squads multisig, threshold ≥ 3-of-N, signers are credibly neutral.
2. Enumerate `is_update_reserve_config_mode_global_admin_only()` in `programs/klend/src/utils/validation.rs` — list every mode that the global admin can force-update on our reserve. Oracle, protocol-take-rate, and liquidation-bonus modes are the ones to worry about.
3. At market init, set `emergency_council` and `risk_authority` to **our own multisig**, never the Kamino default.

---

## 2. Save Finance (formerly Solend)

### Control surface

| Dimension | Finding |
|---|---|
| **Program upgradeability** ⚠️ | Upgradeable. Historical public data (2023) shows upgrade authority as an EOA (`2Fwvr3MKhHhqakgjjEWcpWZZabbRCetHjukHi1zfKxjk`); Squads' own case study notes Solend "temporarily transfers the upgrade authority to a software key to perform program deployments" — **worst upgrade-key hygiene of the three [I] — needs current-state verification**. An upgrade can rewrite the entire admin surface. |
| **Global admin** | Historical Solend program has `lending_market.owner` per market; no well-documented cross-market global-config admin. Save docs do not describe a global pause. **[I]** |
| **Market ownership** | Pool owner is set at creation; Save docs explicitly say you can transfer to an individual / multisig / DAO, **irreversibly**. No documented Save-team override. **[V]** |
| **Reserve-config overrides** | Pool owner configures reserves, outflow limits, LTV. No documented protocol override. **[I]** — code-level verification pending. |
| **Emergency pause** | No protocol-wide pause for permissionless pools documented. Save says explicitly it **does not run liquidators on permissionless pools** and does not reimburse losses — signals a hands-off posture. **[V]** |
| **Oracle swap** | Pool owner configures oracles. Save disclaims oracle risk to the creator. |
| **Fee sweeping** | Pool owner sets fees and receives the protocol-fee share. Not documented that Save sweeps from external pools. |

### Can they shut down our market?

- **Pause:** No documented primitive.
- **Force-close:** No documented primitive.
- **Upgrade authority is the real risk:** if the key is hot / EOA-custodied, a single key compromise — or a single team decision — can replace the entire program.

### Sovereignty: **HIGH in docs, LOW effective** due to program-upgrade custody weakness.

---

## 3. Marginfi — The Arena ❌

### Control surface

| Dimension | Finding |
|---|---|
| **Program upgradeability** | `marginfi-v2` is upgradeable; mrgnlabs uses Squads per public case study. |
| **Global admin** | Each `MarginfiGroup` has an `admin`; Arena creates one group per token pair. `global_fee_admin` / `global_fee_wallet` plumbing exists at program level for protocol fees. No single cross-group admin in normal flow. |
| **Group / market ownership** | Group creator becomes `admin`. Admin adds banks, collects bank fees, withdraws insurance, tunes emissions. Delegate admins possible for curve/limit/emode. `ArenaSettingCannotChange` makes the arena flag sticky. |
| **Reserve / bank control** | Group admin (+ delegates) changes bank params. **User funds cannot be withdrawn by the group admin** in normal flow **[V]**. |
| **Emergency pause** 🚨 | **Arena is being sunset.** A permissioned instruction `start_deleverage` / `end_deleverage` has been added — an arena-only, **permissioned liquidation** used to unwind banks being sunset. Runs even on healthy accounts and earns no profit (receivership semantics). Mrgnlabs announced liquidators would be turned off after Aug 31 and funds returned OTC. **This is a concrete historical precedent of protocol governance forcibly unwinding permissionless markets.** |
| **Oracle swap** | Oracle on bank config, set by admin. Freeze semantics prevent further changes. |
| **Fee sweeping** | Global fee admin receives protocol share. Protocol take configured at program level. |

### Can they shut down our market?

**Yes — and they have already done it to other Arena markets.** The `start_deleverage` instruction is a permissioned, protocol-controlled unwind path that runs on healthy positions. Any regulated product built on Arena is one governance action away from forced liquidation.

### Sovereignty: **LOW.** Disqualified for a regulated product.

---

## Comparison Matrix

Sovereignty score 1–5 (higher = more sovereign). Scores reflect **what the protocol's governance can override on a market we own**, not general protocol quality.

| Dimension | Kamino V2 | Save | Marginfi Arena |
|---|---|---|---|
| Program upgrade key hygiene | 3 (Squads MS [I]) | **1** (EOA historically) | 3 (Squads MS) |
| Global admin scope over our market | 3 (narrow, some reserve modes) | 5 (none documented) | 2 (global fee admin + sunset path) |
| Market-owner transferable to our MS | 5 | 5 | 4 (sticky arena flag) |
| Reserve-config sovereignty | 3 (global-admin-only modes exist) | 4 [I] | 3 |
| Emergency pause override risk | 4 (per-market council, self-set) | 5 | **1** (forced-deleverage precedent) |
| Oracle-swap sovereignty | 3 [I] | 4 | 4 |
| Fee-sweep protection | 3 | 4 | 3 |
| **Weighted score (regulated product)** | **3.4** | **3.7 docs / 2.5 effective** | **2.1** |

---

## Recommendation

For cUSDY (Token-2022, KYC-gated):

1. **Kamino V2** is the strongest of the three **at the state level**, provided two verifications pass:
   - Upgrade authority is a credibly-neutral multisig with reasonable threshold.
   - The set of `global_admin_only` reserve-config modes does not include oracle re-pointing.
   Set `emergency_council` and `risk_authority` to our multisig at market init — do **not** accept Kamino defaults.

2. **Save** reads sovereign in docs but its historical program-upgrade key hygiene is the weakest; worth a fresh on-chain check of the current upgrade authority before taking it seriously as a second venue.

3. **Marginfi Arena** is **disqualified** for regulated use: the forced-deleverage precedent is a binary dealbreaker, regardless of the rest of the surface.

No protocol whose program is upgradeable is ever fully sovereign. The mitigation is signer composition, threshold, and credible neutrality — not protocol choice alone.

---

## Verification checklist

Before production on any of these:

- [ ] `solana program show <program_id>` — upgrade authority, last upgraded slot
- [ ] Resolve upgrade authority → confirm Squads multisig, pull threshold + signers
- [ ] Enumerate every admin instruction in the program's IDL — grep for `admin`, `global`, `emergency`, `freeze`, `pause`, `deleverage`
- [ ] For Kamino: enumerate `UpdateReserveConfigMode` variants with `global_admin_only == true`
- [ ] Market init: set all optional admin/council fields to our multisig, never defaults
- [ ] Bookmark governance forums (gov.kamino.finance, Save, marginfi) and subscribe to upgrade-proposal notifications

## Sources

- [Kamino-Finance/klend](https://github.com/Kamino-Finance/klend)
- [Kamino klend-sdk — Kamino Manager README](https://github.com/Kamino-Finance/klend-sdk/blob/master/README_KAMINO_MANAGER.md)
- [Introducing Kamino Lend V2 — governance forum](https://gov.kamino.finance/t/introducing-kamino-lend-v2/58)
- [Squads — Kamino/Marginfi/Solend case study](https://squads.xyz/blog/solana-multisig-program-upgrades-management)
- [Save — Managing a Pool](https://docs.save.finance/permissionless-pools/managing-a-pool)
- [Save — Permissionless Pool Risks](https://docs.save.finance/permissionless-pools/risks)
- [Marginfi — The Arena user guide](https://docs.marginfi.com/the-arena)
- [mrgnlabs/marginfi-v2](https://github.com/mrgnlabs/marginfi-v2)
- [Neodyme — Solana upgrade-authority risks](https://neodyme.io/en/blog/solana_upgrade_authority/)
