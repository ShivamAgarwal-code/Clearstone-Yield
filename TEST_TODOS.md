Test-side TODOs, ranked by value / effort
Unblock-with-zero-wait (can start now, no deploys needed)
1. SDK coverage gaps — ~21 builders untested, 12 covered

The 21 tests we have hit delegation builders + decoders. Still uncovered:

Module	Builders without unit tests
fixed-yield/curator.ts	buildCuratorDeposit, buildCuratorWithdraw, curatorVaultPda, curatorBaseEscrowPda, curatorUserPositionPda
fixed-yield/curator-admin.ts	buildReallocateToMarket, buildReallocateFromMarket, buildMarkToMarket
fixed-yield/builders.ts (router wrappers)	buildWrapperStrip, buildWrapperMerge, buildWrapperBuyPt, buildWrapperSellPt, buildWrapperBuyYt, buildWrapperSellYt
fixed-yield/tx.ts	packV0Tx, buildZapInToPtV0Tx, buildZapOutToBaseV0Tx
fixed-yield/zap.ts	buildZapInToPt (the strip+sell_yt composer), buildZapOutToBase
Same pattern as the existing delegation tests: hand-built fixture pubkeys, assert discriminator, account order, writability, arg serialization. ~30 min per module, ~3 hr total.

Value: high — these are the builders the frontend + keeper actually call. A wrong byte here = silent on-chain failure at the first invocation.

2. Backend HTTP-handler tests — 0 tests on route logic, 29 on decoders

fixed-yield.ts has route handlers (GET /markets, /vaults, /curator-vaults, /vaults/:id/positions/:user, etc.) that stitch decoders + RPC calls. Untested end-to-end.

Fastest path: hono's app.request() method accepts a URL + Request object, mocks the RPC, asserts JSON shape. ~2 hrs for all 6 routes.

3. Keeper scanDelegations + derivation logic — 2 untested fns

The 13 keeper tests cover pure decision logic. Untested:

scanDelegations(conn) — parses getProgramAccounts output
deriveCrankAccountsFor(conn, vault, marketPk) — reads MarketTwo header bytes
Both need a mocked Connection. Use a jest.fn() or hand-rolled stub that returns fixture data. ~1 hr.

Value: medium — these run on the hot path once a real vault is live.

Unblock-with-tier-2-deploy (queued; needs deployed programs)
4. Run the fork's tests/clearstone-roll-delegation.ts against anchor test

Typechecks clean; 9 tests live (create/close/bounds/has_one/hash-rebind), 8 .skip(). Needs:

Tier 2 deployed, OR
a local validator with the curator + delta_mint + governor .so preloaded
The skipped 8 additionally need market-init fixtures (see #6 below).

Value: very high — first time any of the delegation flow would run on-chain, in any form.

5. Decoder-against-real-dump regression tests (backend)

Once any curator vault or market is initialized on devnet, solana account <pda> --output json gives a real byte dump. Feed that to decodeCuratorVaultHeader / decodeMarketPtPrice / decodeRollDelegation and assert parity with anchor.account.X.fetch(). Catches layout drift that hand-rolled fixtures miss.

~1 hr per decoder, 4 decoders.

Value: very high — guards against the exact silent-failure mode that offset decoders are prone to.

Multi-day (scoped as separate ticket)
6. Full-market integration harness — flip the 8 .skip() blocks to .it()

The crank_roll_delegated invariant matrix in tests/clearstone-roll-delegation.ts needs:

setupMarket fully working in the fork's fixture harness (currently gated on mock-klend + adapter init + AMM seeding)
Clock-warp via solana-program-test or a special clock-override ix on devnet (doesn't exist)
Covers: AllocationsDrifted, Expired, FromMarketNotMatured, NothingToRoll, SlippageBelowDelegationFloor, DeployedBaseDrift, non-curator keeper happy path, revoked-delegation.

Multi-day. Sits in AUDIT_SCOPE.md as deferred-but-documented.

Nice-to-have, lower priority
7. Frontend component/hook tests

Zero test coverage on retail UI. Low invariant risk (UI bugs are visible) but would be nice:

useFixedYieldMarkets / useCuratorVaults / useRollDelegation hooks with mocked fetch
MarketCard / SavingsAccountCard / DepositPtModal snapshot tests
TermDepositsApp end-to-end via Testing Library
Add @testing-library/react + vitest, ~3-4 hrs.

8. Automated deploy smoke-test

Wrap DEPLOY.md §Post-deploy verification in a scripts/smoke-devnet.sh or node script:

solana program show for every pinned ID
anchor idl fetch for every program
Assert the IDL schemas contain expected instructions
~30 min. Low value (we do these manually anyway) but useful for CI.

Recommendation — what to knock out while waiting for funds
SDK coverage gaps (#1) — ~3 hrs, highest-confidence win, zero infra dependency. Start with curator-admin since those are keeper-hot-path.
Keeper fn tests (#3) — ~1 hr, round out keeper coverage.
Backend HTTP-handler tests (#2) — ~2 hrs if you care about API contract stability.
Everything else needs deployed programs or a major harness build-out.

Want me to start with #1? I'd take the 3 curator-admin builders first (reallocate_to/from_market, mark_to_market) since those are what the keeper signs today.