import { PublicKey } from "@solana/web3.js";

/**
 * Retail devnet config — v3 lending-market only.
 *
 * Post-2026-05-07: the retail USDC track has been migrated from the
 * unrestricted sUSDC reserve to the KYC-gated cUSDC reserve. Both
 * tracks now mirror the same shape (native asset → KYC wrapper →
 * klend reserve):
 *   * USDC track  → cUSDC reserve. User holds Solstice USDC (sUSDC)
 *                   in their wallet; DepositCard wraps to cUSDC via
 *                   `wrap_native` before `deposit_reserve_liquidity`.
 *   * SOL  track  → cSOL reserve  (KYC-wrapped wSOL via the v3 native pool)
 * Both tracks share the v3 lending market so the unified KycGate (now
 * covering cSOL + cUSDC pools) gates everything retail can do on chain.
 *
 * The legacy sUSDC reserve (`78kkPN…BFy9`) is kept as
 * `market.legacySUsdcReserve` for read-only display + close-old-position
 * paths. It's still Active in klend at deploy time but slated for
 * status=Hidden once retail traffic is fully on cUSDC.
 */

export const DEVNET_CONFIG = {
  cluster: "devnet" as const,
  rpc: "https://api.devnet.solana.com",

  // v3 governor + delta-mint. The retail flow only talks to the v3
  // programs now — v1 was carrying the deprecated dtUSDY pool +
  // selfRegister flow, both of which have been removed.
  programs: {
    deltaMint: new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy"),
    governor: new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi"),
    klend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    mockOracle: new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm"),
  },

  // cSOL native-wrap pool (v3). Used by the retail SOL deposit flow:
  // wrap_native turns a user's wSOL into cSOL (KYC-gated via this
  // pool's MintConfig whitelist), and the resulting cSOL is then
  // deposited as liquidity into the cSOL klend reserve under the v3
  // market. All addresses pulled from
  // `packages/programs/configs/devnet/cssol-market-v3.json` and the
  // institutional `DEVNET_CONFIG.csolPool`.
  csolPool: {
    poolConfig: new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ"),
    wrappedMint: new PublicKey("AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf"),
    poolWsolVault: new PublicKey("6fH4CVZ6m9mUBRBdbFT6Tqu4bGr29eC5cvybuA2tYQ3o"),
    dmMintConfig: new PublicKey("GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B"),
  },

  // cUSDC native-wrap pool — KYC-gated 1:1 wrapper around sUSDC.
  // Symmetric to `csolPool`: retail USDC deposits flow as
  //   user sUSDC → wrap_native → cUSDC → deposit_reserve_liquidity → cUSDC reserve
  // Pinned from `packages/programs/configs/devnet/cusdc-pool.json`
  // (deployed 2026-05-07 via `scripts/deploy-cusdc-pool-devnet.ts`).
  cusdcPool: {
    poolConfig: new PublicKey("5z7ScihUHe2WfHoiNzo4thDU3xes5C8Pj5vTPgXyjwwR"),
    wrappedMint: new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY"),
    /** Pool-owned ATA holding the underlying sUSDC reserves (1:1 backed). */
    poolUnderlyingVault: new PublicKey("8YUNGhdWeXXnpRvKRUa9PG29VaZE8iECkjLFLRGkLngM"),
    dmMintConfig: new PublicKey("33jPSysPWwKfaL31duyHNWHAwKEYFjVrtWs9nVG3FmUT"),
  },

  // Solstice devnet tokens (use these for USDC/USDT — NOT Circle mints)
  solstice: {
    usdt: new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft"),
    usdc: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    usx: new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS"),
    eusx: new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt"),
    api: "https://instructions.solstice.finance/v1/instructions",
    apiKey: "SET_VIA_ENV_VAR",
  },

  // USDC on devnet — the user-facing "USDC" symbol now resolves to the
  // KYC-gated cUSDC wrapper mint (Token-2022). The underlying that the
  // wallet actually holds before depositing is still Solstice USDC,
  // exposed below as `usdcUnderlying` so the DepositCard can read the
  // user's sUSDC balance, wrap it via `wrap_native`, then deposit cUSDC.
  // Decimals match (6) so amount math doesn't change.
  usdc: {
    /** cUSDC mint — Token-2022. Held only transiently inside a deposit
     *  tx; the user's wallet shows sUSDC as their "USDC" balance. */
    mint: new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY"),
    decimals: 6,
  },

  // Underlying that suppliers actually hold + spend before the wrap.
  // FaucetCard mints into this, DepositCard reads the wallet balance
  // from this, and `wrap_native` sources liquidity from this ATA.
  usdcUnderlying: {
    mint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    decimals: 6,
    symbol: "sUSDC",
  },

  // wSOL — native SOL wrapped via SPL associated-token-account convention.
  // Same address on every cluster.
  wsol: {
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    decimals: 9,
  },

  // Civic gatekeeper network — same Uniqueness network the v3 cSOL
  // pool's `gatekeeper_network` is bound to (set 2026-05-06 via
  // `setup-civic-csol.ts`). One Civic ceremony seeds the cSOL
  // whitelist; USDC supply has no whitelist requirement.
  civic: {
    gatekeeperNetwork: new PublicKey("ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6"),
  },

  // v3 KYC-gated lending market. Hosts:
  //   * sUSDC reserve  — USDC supply track (no KYC for suppliers)
  //   * cSOL reserve   — SOL supply track (cSOL whitelist required at
  //                       wrap_native; supply on the reserve itself is
  //                       not gated, but you can't get cSOL without
  //                       the whitelist)
  //   * csSOL + WT     — institutional collateral track (not retail)
  //   * ceUSX + WT     — institutional KYC-wrapped USDC collateral
  //                       (institutional only — see PreparePage)
  market: {
    lendingMarket: new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E"),
    /** Retail USDC track lands on the v3 cUSDC reserve since the
     *  2026-05-07 migration. The reserve's underlying is the cUSDC
     *  Token-2022 mint, which is itself a 1:1 wrapper of Solstice USDC
     *  (sUSDC). DepositCard wraps before deposit; WithdrawCard unwraps
     *  after redeem. */
    usdcReserve: new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe"),
    /** Same Pyth USDC feed sUSDC pegged to — cUSDC is 1:1 vs sUSDC. */
    usdcOracle:  new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD"),
    /** @deprecated Legacy unrestricted sUSDC reserve. Slated for
     *  status=Hidden once retail traffic is fully on cUSDC; kept here
     *  for read-only display + close-old-position flows. */
    legacySUsdcReserve: new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9"),
  },

  // SOL lending market — same v3 lendingMarket as `market` above.
  // Kept as a separate block so the SolDepositCard / SolWithdrawCard
  // imports stay scoped to SOL-side fields without leaking the USDC
  // reserve handle.
  marketSol: {
    lendingMarket: new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E"),
    /** EG-2 debt asset since 2026-05-06; the retail SOL deposit flow
     *  wraps SOL → cSOL → DepositReserveLiquidity into this reserve. */
    cSolReserve: new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg"),
    cSolOracle:  new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    /** @deprecated Retired 2026-05-06 (status=Hidden, deposit_limit=0).
     *  Kept so the SolWithdrawCard can still service legacy depositors. */
    wsolReserve: new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8"),
    wsolOracle:  new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    cssolReserve: new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"),
    cssolOracle:  new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
