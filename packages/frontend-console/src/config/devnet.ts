import { PublicKey } from "@solana/web3.js";

/**
 * Devnet deployment addresses — v3 cssol market layout.
 *
 * Migrated from the legacy v1 (`5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb`)
 * + legacy governor (`BrZYcb…3KJh`) layout to the v3 unified market
 * (`EVw8B9…iz2E`) + new csSOL governor (`6xqW3D…tJi`) + new delta-mint
 * (`BKprvL…X1xy`).
 *
 * The legacy programs / pools still exist on-chain but are NOT bound to
 * the v3 market — keeping a foot in both deployments would just confuse
 * the IDL load and the constraint checks; the console targets v3 only.
 *
 * Updated by the deployment pipeline (`pnpm deploy:all:devnet`).
 */
export interface WrappedToken {
  /** Human-readable display name. */
  name: string;
  /** Ticker shown in dropdowns. */
  symbol: string;
  /** Mint decimals. */
  decimals: number;
  /** Fallback display price if the oracle isn't reachable. */
  price: number;
  /** Underlying mint that gets locked / unwrapped. */
  underlyingMint: PublicKey;
  /** KYC-gated wrapper mint (Token-2022). */
  wrappedMint: PublicKey;
  /** Governor PoolConfig PDA — `[b"pool", underlyingMint]` for cUSDY-style,
   *  `[b"native_pool", wrappedMint]` for the cSOL/cUSDC family. */
  pool: PublicKey;
  /** delta-mint MintConfig — pool PDA is the authority post-activation. */
  dmMintConfig: PublicKey;
  /** Pyth feed for the underlying or its accrual proxy. */
  oracle: PublicKey;
  /** Klend reserve address, if registered in the market. Optional because
   *  some wrappers (e.g. csSOL-WT) ship before their reserve lands. */
  klendReserve?: PublicKey;
  /** Optional klend elevation group the reserve belongs to. */
  elevationGroup?: number;
  /** Cosmetic / diagnostic flag — true when the wrapper is a withdraw-ticket
   *  variant (csSOL-WT, ceUSX-WT, …). Affects the panels' role gating. */
  isWithdrawTicket?: boolean;
  /** When true, the underlying is a delta-mint d-token rather than a plain
   *  SPL token (e.g. ceUSX wrapping eUSX). The wrap path then has to chain
   *  two delta-mint CPIs; the console surfaces this in WrapPanel. */
  underlyingIsKycWrapped?: boolean;
}

export const DEVNET_CONFIG = {
  cluster: "devnet" as const,
  rpc: "https://api.devnet.solana.com",

  // Programs
  programs: {
    /** New csSOL-stack delta-mint. The legacy `13Su8nR5…QkEn` is still on
     *  devnet (it owns the eUSX pools predating csSOL) but isn't bound to
     *  the v3 market. */
    deltaMint: new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy"),
    /** New csSOL governor — owns the v3 market's PoolConfigs + WT MintConfigs. */
    governor: new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi"),
    /** Klend (Kamino Lend V2). Same on devnet + mainnet. */
    klend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    /** Mock-oracle program (used by OraclePanel for ad-hoc Pyth-shaped feeds). */
    mockOracle: new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm"),
    /** Jito Vault — same address on devnet + mainnet. Referenced by csSOL flow. */
    jitoVault: new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8"),
  },

  // Primary csSOL host pool (the new governor's "headline" pool — owns the
  // csSOL MintConfig + the csSOL-WT MintConfig + the withdraw queue).
  pool: {
    poolConfig: new PublicKey("QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e"),
    wrappedMint: new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt"), // csSOL
    underlyingMint: new PublicKey("So11111111111111111111111111111111111111112"), // wSOL (Jito-vault wrapped)
    dmMintConfig: new PublicKey("FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2"),
    dmMintAuthority: new PublicKey("Gyv1o28H98zZYnREBmaKq1pJJ5eHqd1wouJ6Km5fCTsT"),
    /** csSOL-specific extras — the wrap path stakes underlying through Jito. */
    jitoVault: new PublicKey("EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W"),
    vrtMint: new PublicKey("6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8"),
    vaultStTokenAccount: new PublicKey("25YAVwucokaFEPRNGapx3iBybQpkTN31cDfc9aU3RF3Z"),
    poolVrtAta: new PublicKey("BvBy8orQZPXFwR6fgyCkLoyZfK1TBRteG5g4ipuqrEZp"),
    /** csSOL-WT side. Same pool PDA owns this MintConfig as a secondary
     *  (managed via the new `add_wt_participant_via_pool` ix). */
    wtMint: new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva"),
    wtMintConfig: new PublicKey("BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4"),
    wtMintAuthority: new PublicKey("FxoXoyK9nMYWXWjrZYLb88jCoYdTPbZBgAA2UQCRTAKe"),
    poolPendingWsolAccount: new PublicKey("5CMXpXEfy8BTe4DzT9xhc36HXYGNf3wDrr5wV5aoJis1"),
  },

  // cSOL "native wrap" pool — KYC-gated wSOL wrapper used as collateral
  // in the upcoming SOL/USDC margin-pair EGs. Already deployed; klend
  // reserve registration is pending. See docs/operations/MARGIN_PAIR.md.
  csolPool: {
    poolConfig: new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ"),
    wrappedMint: new PublicKey("AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf"),
    poolWsolVault: new PublicKey("6fH4CVZ6m9mUBRBdbFT6Tqu4bGr29eC5cvybuA2tYQ3o"),
    dmMintConfig: new PublicKey("GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B"),
  },

  // Solstice devnet tokens (NOT Circle — these are Solstice-specific mints).
  // sUSDC is the v3 market's debt asset for EG-1 (and the long-SOL EG-3).
  solstice: {
    usdt: new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft"),
    usdc: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    usx: new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS"),
    eusx: new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt"),
    usdg: new PublicKey("HLwjxqGBrZPN7hehv7e9RXnqBr4AHJ9YMczFpw9AZu7r"),
    yieldVaultProgram: new PublicKey("euxU8CnAgYk5qkRrSdqKoCM8huyexecRRWS67dz2FVr"),
    api: "https://instructions.solstice.finance/v1/instructions",
    apiKey: "SET_VIA_ENV_VAR",
  },

  // Wrapped tokens enumerated for the panel dropdowns. v3 inventory:
  // csSOL + csSOL-WT (Jito-staked SOL flow), ceUSX + ceUSX-WT (Solstice
  // eUSX flow), plus the test cSOL wrapper that's already deployed but
  // not yet a klend reserve. Legacy tUSDY/tEUR/tGOLD/USX entries from
  // v1 are not wired into v3 — use the legacy console build for those.
  tokens: [
    {
      name: "Clearstone csSOL",
      symbol: "csSOL",
      decimals: 9,
      price: 84,
      underlyingMint: new PublicKey("So11111111111111111111111111111111111111112"),
      wrappedMint: new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt"),
      pool: new PublicKey("QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e"),
      dmMintConfig: new PublicKey("FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2"),
      oracle: new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
      klendReserve: new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"),
      elevationGroup: 2,
    },
    {
      name: "csSOL Withdraw Ticket",
      symbol: "csSOL-WT",
      decimals: 9,
      price: 84,
      // The "underlying" is morally csSOL itself (a WT is created by burning
      // csSOL inside `enqueue_withdraw_via_pool`), but for panel purposes we
      // pin to the Jito vault's underlying so the wrap-path UI doesn't break.
      underlyingMint: new PublicKey("So11111111111111111111111111111111111111112"),
      wrappedMint: new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva"),
      pool: new PublicKey("QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e"),
      dmMintConfig: new PublicKey("BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4"),
      oracle: new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
      klendReserve: new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw"),
      elevationGroup: 2,
      isWithdrawTicket: true,
    },
    {
      name: "Clearstone ceUSX",
      symbol: "ceUSX",
      decimals: 6,
      price: 1.08,
      underlyingMint: new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt"), // eUSX
      wrappedMint: new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT"),
      pool: new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj"),
      dmMintConfig: new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD"),
      oracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
      klendReserve: new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"),
      elevationGroup: 1,
      underlyingIsKycWrapped: false,
    },
    {
      name: "ceUSX Withdraw Ticket",
      symbol: "ceUSX-WT",
      decimals: 6,
      price: 1.0,
      underlyingMint: new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt"),
      wrappedMint: new PublicKey("DoHMuKFU4b2co2CBBcNjVzWf6yL3KG5H2N9FxkfFFN6A"),
      pool: new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ"),
      dmMintConfig: new PublicKey("852Tq2XMRxkNPGQ7sEQoi2dWZrK3sHmbLZ3QDapEEYng"),
      oracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
      klendReserve: new PublicKey("GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq"),
      elevationGroup: 1,
      isWithdrawTicket: true,
    },
    {
      name: "Clearstone cSOL",
      symbol: "cSOL",
      decimals: 9,
      price: 84,
      underlyingMint: new PublicKey("So11111111111111111111111111111111111111112"),
      wrappedMint: new PublicKey("AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf"),
      pool: new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ"),
      dmMintConfig: new PublicKey("GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B"),
      oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
      klendReserve: new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg"),
      // EG-3 (collateral) and EG-4 (debt) — both EGs registered on-chain.
      // Reserve's elevation_groups array still pending phase-2 update so
      // request_elevation_group(3 or 4) won't validate yet from a user obligation.
    },
  ] as WrappedToken[],

  // Oracles (Pyth Receiver `PriceUpdateV2` accounts — accepted by klend
  // via discriminator check). The csSOL/csSOL-WT oracle is the
  // accrual-output account driven by the keeper-cloud worker.
  oracles: {
    csSolOracle: new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
    wsolOracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    ceUsxOracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
    sUsdcOracle: new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD"),
  },

  // V3 unified klend market — replaces the legacy `45FNL648…tc98` market.
  // Hosts both the Stables EG-1 (ceUSX collateral / sUSDC debt) and
  // LST/SOL EG-2 (csSOL + csSOL-WT collateral / wSOL debt). Margin EG-3
  // and EG-4 are declared in the market config but not yet registered
  // (see docs/operations/MARGIN_PAIR.md).
  market: {
    lendingMarket: new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E"),
    klendGlobalConfig: new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W"),
    csSolReserve: new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"),
    csSolWtReserve: new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw"),
    wsolReserve: new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8"),
    ceUsxReserve: new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"),
    ceUsxWtReserve: new PublicKey("GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq"),
    /** @deprecated Legacy unrestricted sUSDC reserve. Replaced by the
     *  KYC-gated `cUsdcReserve` below as the EG-1 + EG-3 debt asset on
     *  2026-05-07. Kept for read-only display and close-old-position
     *  flows; will be flipped to status=Hidden once retail traffic is
     *  fully on cUSDC. */
    sUsdcReserve: new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9"),
    sUsdcMint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    /** cSOL reserve — KYC-wrapped wSOL, EG-2 debt asset since
     *  2026-05-06. Was the upcoming margin EG-3/EG-4 collateral; is
     *  now the live debt asset for the LST/SOL EG. */
    cSolReserve: new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg"),
    /** cUSDC reserve — KYC-gated 1:1 wrapper of sUSDC. Live debt
     *  asset for EG-1 (stables) + EG-3 (margin long SOL) and the
     *  collateral side of EG-4 (margin short SOL) since the
     *  2026-05-07 migration. Same Pyth USDC feed as sUSDC since cUSDC
     *  is a 1:1 wrapper. */
    cUsdcReserve: new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe"),
    cUsdcMint: new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY"),
    /** wSOL native mint — used by the SOL-side LendingPanel for ATA
     *  derivation (the panel is a wSOL-pair lending demo, not USDC). */
    wsolMint: new PublicKey("So11111111111111111111111111111111111111112"),
  },

  // Elevation groups that the v3 market exposes. The numeric IDs flow
  // through `set_elevation_group` (see governor::pool) and into klend's
  // `request_elevation_group` ix.
  elevationGroups: {
    stables: 1,        // ceUSX collateral, sUSDC debt, 90/92
    lstSol: 2,         // csSOL + csSOL-WT collateral, wSOL debt, 90/92
    // EG-3 + EG-4 are registered on-chain (margin-egs-deployed.json,
    // 2026-05-04). User-side request_elevation_group(3|4) still gates on
    // the per-reserve `elevation_groups` arrays being updated — phase-2
    // patch pending. The console's Elevation panel surfaces them as live.
    marginLongSol: 3,  // cSOL collateral, sUSDC debt, 65/85 — registered
    marginShortSol: 4, // sUSDC collateral, cSOL debt, 65/85 — registered
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
