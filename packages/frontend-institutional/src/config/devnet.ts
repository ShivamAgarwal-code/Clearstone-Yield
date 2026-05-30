import { PublicKey } from "@solana/web3.js";

/**
 * Devnet deployment addresses — v3 cssol market layout.
 *
 * Migrated from the legacy v1 (`45FNL648…tc98` market + `BrZYcb…3KJh`
 * governor + `13Su8nR5…QkEn` delta-mint) to the v3 unified market
 * (`EVw8B9…iz2E` + `6xqW3D…tJi` governor + `BKprvL…X1xy` delta-mint).
 *
 * The institutional console only targets v3 — the legacy programs are
 * still on devnet but aren't bound to the v3 market and aren't listed
 * here intentionally.
 */
export interface WrappedToken {
  name: string;
  symbol: string;
  decimals: number;
  price: number;
  underlyingMint: PublicKey;
  wrappedMint: PublicKey;
  pool: PublicKey;
  dmMintConfig: PublicKey;
  oracle: PublicKey;
  klendReserve?: PublicKey;
  elevationGroup?: number;
  isWithdrawTicket?: boolean;
}

export const DEVNET_CONFIG = {
  cluster: "devnet" as const,
  rpc: "https://api.devnet.solana.com",

  programs: {
    deltaMint: new PublicKey("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy"),
    governor: new PublicKey("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi"),
    klend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    mockOracle: new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm"),
    jitoVault: new PublicKey("Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8"),
  },

  // Headline csSOL host pool — owns the csSOL MintConfig + csSOL-WT
  // MintConfig + the withdraw queue.
  pool: {
    poolConfig: new PublicKey("QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e"),
    wrappedMint: new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt"),
    underlyingMint: new PublicKey("So11111111111111111111111111111111111111112"),
    dmMintConfig: new PublicKey("FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2"),
    dmMintAuthority: new PublicKey("Gyv1o28H98zZYnREBmaKq1pJJ5eHqd1wouJ6Km5fCTsT"),
    jitoVault: new PublicKey("EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W"),
    vrtMint: new PublicKey("6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8"),
    vaultStTokenAccount: new PublicKey("25YAVwucokaFEPRNGapx3iBybQpkTN31cDfc9aU3RF3Z"),
    poolVrtAta: new PublicKey("BvBy8orQZPXFwR6fgyCkLoyZfK1TBRteG5g4ipuqrEZp"),
    wtMint: new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva"),
    wtMintConfig: new PublicKey("BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4"),
    wtMintAuthority: new PublicKey("FxoXoyK9nMYWXWjrZYLb88jCoYdTPbZBgAA2UQCRTAKe"),
    poolPendingWsolAccount: new PublicKey("5CMXpXEfy8BTe4DzT9xhc36HXYGNf3wDrr5wV5aoJis1"),
  },

  // cSOL native-wrap pool — collateral side of margin EG-3, debt side of EG-4.
  csolPool: {
    poolConfig: new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ"),
    wrappedMint: new PublicKey("AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf"),
    poolWsolVault: new PublicKey("6fH4CVZ6m9mUBRBdbFT6Tqu4bGr29eC5cvybuA2tYQ3o"),
    dmMintConfig: new PublicKey("GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B"),
  },

  // cUSDC native-wrap pool — KYC-gated 1:1 wrapper around sUSDC.
  // Replaces sUSDC as the debt asset in EG-1 (stables) + EG-3 (margin
  // long SOL) and as the collateral side of EG-4 (margin short SOL)
  // since the 2026-05-07 migration. Deployed via
  // scripts/deploy-cusdc-pool-devnet.ts → configs/devnet/cusdc-pool.json.
  cusdcPool: {
    poolConfig: new PublicKey("5z7ScihUHe2WfHoiNzo4thDU3xes5C8Pj5vTPgXyjwwR"),
    wrappedMint: new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY"),
    underlyingMint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    poolUnderlyingVault: new PublicKey("8YUNGhdWeXXnpRvKRUa9PG29VaZE8iECkjLFLRGkLngM"),
    dmMintConfig: new PublicKey("33jPSysPWwKfaL31duyHNWHAwKEYFjVrtWs9nVG3FmUT"),
  },

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

  // V3 token inventory — what an institutional user actually deposits / borrows.
  tokens: [
    {
      name: "Clearstone csSOL (Jito-staked)",
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
      name: "Clearstone ceUSX (Solstice yield)",
      symbol: "ceUSX",
      decimals: 6,
      price: 1.08,
      underlyingMint: new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt"),
      wrappedMint: new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT"),
      pool: new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj"),
      dmMintConfig: new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD"),
      oracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
      klendReserve: new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"),
      elevationGroup: 1,
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
      name: "Clearstone cSOL (KYC-wrapped wSOL)",
      symbol: "cSOL",
      decimals: 9,
      price: 84,
      underlyingMint: new PublicKey("So11111111111111111111111111111111111111112"),
      wrappedMint: new PublicKey("AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf"),
      pool: new PublicKey("7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ"),
      dmMintConfig: new PublicKey("GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B"),
      oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
      klendReserve: new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg"),
      // EG-3 collateral, EG-4 debt — both EGs registered. Reserve's
      // elevation_groups array still pending phase-2 update.
    },
    {
      // cUSDC — KYC-gated 1:1 wrapper around sUSDC. Replaces the
      // unrestricted sUSDC reserve as the debt asset in EG-1 + EG-3
      // and as the collateral side of EG-4 (post-2026-05-07 migration).
      name: "Clearstone cUSDC (KYC-wrapped sUSDC)",
      symbol: "cUSDC",
      decimals: 6,
      price: 1.0,
      underlyingMint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
      wrappedMint: new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY"),
      pool: new PublicKey("5z7ScihUHe2WfHoiNzo4thDU3xes5C8Pj5vTPgXyjwwR"),
      dmMintConfig: new PublicKey("33jPSysPWwKfaL31duyHNWHAwKEYFjVrtWs9nVG3FmUT"),
      oracle: new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD"),
      klendReserve: new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe"),
    },
  ] as WrappedToken[],

  oracles: {
    csSolOracle:  new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
    wsolOracle:   new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    ceUsxOracle:  new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
    /** USDC Pyth Receiver feed — used by both the deprecated sUsdcReserve
     *  and the new cUsdcReserve since cUSDC is a 1:1 wrapper. */
    usdcOracle:   new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD"),
    /** @deprecated alias of usdcOracle — kept so existing imports compile. */
    sUsdcOracle:  new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD"),
  },

  // V3 lending market.
  market: {
    lendingMarket: new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E"),
    klendGlobalConfig: new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W"),
    csSolReserve:    new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"),
    csSolWtReserve:  new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw"),
    /**
     * cSOL reserve — KYC-wrapped wSOL. Promoted to EG-2 debt asset on
     * 2026-05-06 (was wSOL). Same Pyth oracle as wSOL since cSOL is a
     * 1:1 wrapper. The wsolReserve below stays for the close-old-
     * positions path during the migration window — kept Hidden status,
     * deposit/borrow limits zeroed on-chain so it can't be reactivated.
     */
    cSolReserve:     new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg"),
    /** @deprecated EG-2 debt moved to cSOL on 2026-05-06; this stays
     *  only for inspecting / closing legacy positions. */
    wsolReserve:     new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8"),
    ceUsxReserve:    new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"),
    /**
     * cUSDC reserve — KYC-gated 1:1 wrapper of sUSDC. Promoted to
     * EG-1 + EG-3 debt asset on 2026-05-07 (was sUSDC). Same USDC
     * Pyth feed since cUSDC is a 1:1 wrapper. The sUsdcReserve below
     * stays Hidden in klend so any pre-migration position can still be
     * repaid / withdrawn but no new traffic flows through it.
     */
    cUsdcReserve:    new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe"),
    cUsdcMint:       new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY"),
    /** @deprecated EG-1 + EG-3 debt moved to cUSDC on 2026-05-07; this
     *  stays only for inspecting / closing legacy positions. */
    sUsdcReserve:    new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9"),
    /** sUSDC mint — also the *underlying* asset of cUSDC (preparing
     *  collateral now means wrapping sUSDC → cUSDC). */
    sUsdcMint:       new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
  },

  elevationGroups: {
    stables: 1,
    lstSol: 2,
    marginLongSol: 3,
    marginShortSol: 4,
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
