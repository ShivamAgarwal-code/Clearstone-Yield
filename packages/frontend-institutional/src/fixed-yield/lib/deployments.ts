// Canonical devnet handles for the demo UI.
//
// Mirrors the live `kaminoStack` block in clearstone-fixed-yield's
// `deployments/devnet.json` (lastUpdated 2026-04-26). If the on-chain
// state moves — e.g., the maturity rolls or a fresh canonical stack is
// stood up — update both files in lockstep. The UI checks staleness
// only via the `lastUpdated` field surfaced in the Setup tab.
//
// Override at runtime: paste a new JSON blob into the Setup tab to swap
// any field. Useful when running against a local validator or a forked
// stack.

import { PublicKey } from "@solana/web3.js";

export interface CanonicalStack {
  cluster: string;
  rpcUrl: string;
  lastUpdated: string;
  programs: {
    clearstone_core: PublicKey;
    clearstone_router: PublicKey;
    clearstone_curator: PublicKey;
    clearstone_solver_callback: PublicKey;
    clearstone_fusion: PublicKey;
    generic_exchange_rate_sy: PublicKey;
    kamino_sy_adapter: PublicKey;
  };
  /** Live Kamino-backed PT/YT stack on Solstice USDC. */
  kaminoStack: {
    baseMint: PublicKey;
    syMetadata: PublicKey;
    syMint: PublicKey;
    klendReserve: PublicKey;
    klendCollateralMint: PublicKey;
    klendPyth: PublicKey;
    poolEscrow: PublicKey;
    collateralVault: PublicKey;
    curatorVault: PublicKey;
    ptVault: PublicKey;
    vaultAuthority: PublicKey;
    mintPt: PublicKey;
    mintYt: PublicKey;
    ammMarket: PublicKey;
    mintLp: PublicKey;
    marketAlt: PublicKey;
  };
}

/**
 * Non-delta-mint TEST stack from `deployments/devnet.json::canonicalStack`.
 * Bound to a plain SPL test USDC (mint authority = AhKNm…); klend-side
 * reserve uses mock_klend, no governor / delta_mint whitelisting in
 * the path. Useful when Solstice's wallet-whitelist gate is blocking
 * you from sourcing the live kaminoStack's underlying.
 */
export const DEVNET_TEST_STACK: CanonicalStack = {
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  lastUpdated: "2026-04-25",
  programs: {
    clearstone_core: new PublicKey("DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW"),
    clearstone_router: new PublicKey("DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW"),
    clearstone_curator: new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm"),
    clearstone_solver_callback: new PublicKey("27UhEF34wbyPdZw4nnAFUREU5LHMFs55PethnhJ6yNCP"),
    clearstone_fusion: new PublicKey("9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J"),
    generic_exchange_rate_sy: new PublicKey("HA1T2p7DkktepgtwrVqNBK8KidAYr5wvS1uKqzvScNm3"),
    kamino_sy_adapter: new PublicKey("29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd"),
  },
  // canonicalStack handles; the kaminoStack-shaped fields below are
  // mapped from the canonicalStack equivalents (klendReserve / klendPyth
  // / collateralVault aren't part of canonicalStack — populated as
  // sentinels and ignored when the SY adapter is generic_exchange_rate_sy).
  kaminoStack: {
    baseMint: new PublicKey("2tboZ672zptawbXLUrcqfF7YkkS1kzDS4ewwxtjuog1G"),
    syMetadata: new PublicKey("3yyrgJCEnNZQbN3eHoP246viEfrngHU6R7wrRJttW1U9"), // = syMarket
    syMint: new PublicKey("AeS5fqx1tSiTHMhuCzKzrXgKz24qApVqU8mM9i47jGQr"),
    klendReserve: new PublicKey("11111111111111111111111111111111"),
    klendCollateralMint: new PublicKey("11111111111111111111111111111111"),
    klendPyth: new PublicKey("11111111111111111111111111111111"),
    poolEscrow: new PublicKey("2feAkSKmHyq23KYcczNt1P3Dq8qn9H1BUv1qeLmbGL7z"),
    collateralVault: new PublicKey("11111111111111111111111111111111"),
    curatorVault: new PublicKey("Fv8WuFXpDNmCq5Hnky7NAhf1adeMjUqLBiVsUHwYaSzR"),
    ptVault: new PublicKey("3GxRCCqtSjf9NpMdqFbTsSKdnc7yseppyKoTfuUvoKtz"),
    vaultAuthority: new PublicKey("33jAGhS5g2Ar5G381y8Sc9efMcDoqeeifDW3oahQM51T"),
    mintPt: new PublicKey("E95GtsvrpJWsHFN3do6itmXw73m1owRkEnCLS7FB7rwD"),
    mintYt: new PublicKey("Hh2igJmzyXAG8Htjx5c8jKmDLnbRFMUxUH6TL1QPgCTM"),
    ammMarket: new PublicKey("9DtXvD662X8RBUK5GeEsSxWPpWYz9DwQ1efmzF53Virz"),
    mintLp: new PublicKey("EpctHDaEaCfuwr18on7hd9K1NaPTqdRk2jWjWDdTG2sh"),
    marketAlt: new PublicKey("CNWub9Mz2FpcbukLoSuqCBSMTsHSk7h8xw73W5WHczma"),
  },
};

export const DEVNET_DEFAULT: CanonicalStack = {
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  lastUpdated: "2026-04-26",
  programs: {
    clearstone_core: new PublicKey("DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW"),
    clearstone_router: new PublicKey("DenU4j4oV4wCMCsytrfYuFwAumTE1abFAPmpYDpjWmsW"),
    clearstone_curator: new PublicKey("831zw8r2fGwRB1QpuRU3gZHZBFYYHBHeG7RbKUz9ssGm"),
    clearstone_solver_callback: new PublicKey("27UhEF34wbyPdZw4nnAFUREU5LHMFs55PethnhJ6yNCP"),
    clearstone_fusion: new PublicKey("9ShSnLUcWeg5BZzokj8mdo9cNHARCKa42kwmqSdBNM6J"),
    generic_exchange_rate_sy: new PublicKey("HA1T2p7DkktepgtwrVqNBK8KidAYr5wvS1uKqzvScNm3"),
    kamino_sy_adapter: new PublicKey("29tisXppYM4NcAEJfzMe1aqyuf2M7w9StTtiXBHxTKxd"),
  },
  kaminoStack: {
    baseMint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    syMetadata: new PublicKey("7F6vSabYg9eke3iPbzsBigX9FL2e9JZS2rZN57V9Sja2"),
    syMint: new PublicKey("2vyiNved2xwKortbH1fERsWPjZLijtiJBaqoqT96EsGX"),
    klendReserve: new PublicKey("AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb"),
    klendCollateralMint: new PublicKey("74Wcd7VSUjK4wABMF15Kc4fYqiPDNj4NmE9MMSUR3AJv"),
    klendPyth: new PublicKey("EN2FsFZFdpiFAWpKDZqeJ2PY8EyE7xzz9Ew8ZQVhtHCJ"),
    poolEscrow: new PublicKey("8cubBJT1WYyEUSfPWEcoy84EptgoCsjdy5uKqJt5S4VY"),
    collateralVault: new PublicKey("DVaaxn11tDrVXuAYBfqfuRtnRVEH6RJFEmVg68eJp6Ac"),
    curatorVault: new PublicKey("BDe2V5UxMEpJjb4H5UbLPK5UAsi1jUaUs2zx62YiCrZo"),
    ptVault: new PublicKey("DJhsAvfH67DRHvZSYMjHMQchVd77zTSCq62BNXEqu8ze"),
    vaultAuthority: new PublicKey("9aVE4b6RasHNN6uzPHqfUVZrbgMpyvu3eGTdUCyebWWA"),
    mintPt: new PublicKey("5yKkeK83FNECQLEr37rQqaWANEkAJSnTQCgigWDCcwvm"),
    mintYt: new PublicKey("FhosjjdpHjYzzkw6swjQC5wc8t3D751txxJgo38ZmBq8"),
    ammMarket: new PublicKey("HJmpC6EK8EfJyEwoSEwwgieKR1uPQbb755zq5gDjouZB"),
    mintLp: new PublicKey("52m4zmeCqY91cBdzMYMLhigVT1yiLTPKHd1NFrSep1Q4"),
    marketAlt: new PublicKey("365QNLt7jPou6v9zT1b2fdR65FwV2j3KeQLNEzvx6Mzv"),
  },
};

const STORAGE_KEY = "clearstone-ui-stack-override";
const ACTIVE_KEY = "clearstone-ui-active-stack";

/**
 * Built-in stacks the UI can switch between without a JSON paste.
 * Add a new entry per KYC underlying as you stand them up:
 *   csSOL: <output of setup-kyc-kamino-stack.ts for SOL>
 *   csUSDC: <output for USDC>
 *
 * The Setup tab surfaces a picker keyed by these names. The single-
 * stack `kaminoStack` shape on each entry stays unchanged so all
 * existing consumers (Sourcing/LP/BuyPt) keep working without changes.
 */
export const BUILTIN_STACKS: Record<string, CanonicalStack> = {
  "Solstice USDC (live)": DEVNET_DEFAULT,
  "Test SPL USDC (canonical)": DEVNET_TEST_STACK,
  // KYC stacks land here once the operator scripts have been run:
  // "csSOL": { ...DEVNET_DEFAULT, kaminoStack: { ...csSOL handles } },
  // "csUSDC": { ...DEVNET_DEFAULT, kaminoStack: { ...csUSDC handles } },
};

const DEFAULT_ACTIVE_KEY = "Solstice USDC (live)";

export function loadActiveKey(): string {
  try {
    const k = localStorage.getItem(ACTIVE_KEY);
    if (k && k in BUILTIN_STACKS) return k;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_ACTIVE_KEY;
}

export function saveActiveKey(key: string): void {
  if (!(key in BUILTIN_STACKS)) {
    throw new Error(`unknown stack key: ${key}`);
  }
  localStorage.setItem(ACTIVE_KEY, key);
}

export function loadStack(): CanonicalStack {
  // Priority order:
  //   1. JSON override (Setup-tab paste). Wins regardless of active key.
  //   2. Active built-in stack (picker selection).
  //   3. DEVNET_DEFAULT.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return inflate(JSON.parse(raw));
  } catch {
    /* fall through */
  }
  return BUILTIN_STACKS[loadActiveKey()] ?? DEVNET_DEFAULT;
}

export function saveStack(stack: CanonicalStack): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deflate(stack), null, 2));
}

export function clearStackOverride(): void {
  localStorage.removeItem(STORAGE_KEY);
}

function deflate(s: CanonicalStack): unknown {
  const flat = (obj: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k,
        v instanceof PublicKey ? v.toBase58() : v,
      ])
    );
  return {
    cluster: s.cluster,
    rpcUrl: s.rpcUrl,
    lastUpdated: s.lastUpdated,
    programs: flat(s.programs as unknown as Record<string, unknown>),
    kaminoStack: flat(s.kaminoStack as unknown as Record<string, unknown>),
  };
}

function inflate(raw: unknown): CanonicalStack {
  const r = raw as Record<string, unknown>;
  const inflateMap = <T extends Record<string, PublicKey>>(
    section: Record<string, unknown>
  ): T => {
    const out: Record<string, PublicKey> = {};
    for (const [k, v] of Object.entries(section)) {
      out[k] = new PublicKey(v as string);
    }
    return out as T;
  };
  return {
    cluster: r.cluster as string,
    rpcUrl: r.rpcUrl as string,
    lastUpdated: r.lastUpdated as string,
    programs: inflateMap(r.programs as Record<string, unknown>) as CanonicalStack["programs"],
    kaminoStack: inflateMap(r.kaminoStack as Record<string, unknown>) as CanonicalStack["kaminoStack"],
  };
}
