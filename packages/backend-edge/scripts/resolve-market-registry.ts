/**
 * Resolve a fully-populated `MARKET_REGISTRY` JSON entry from a
 * (vault, market) pair on devnet/mainnet.
 *
 * Operators run this when a new fixed-yield market lands. It reads
 * every PDA the retail UI / SDK needs straight off-chain (no manual
 * pubkey copying), prints a `MarketRegistryEntry` object suitable for
 * `wrangler secret put MARKET_REGISTRY`.
 *
 *   pnpm tsx scripts/resolve-market-registry.ts \
 *     --rpc https://devnet.helius-rpc.com/?api-key=… \
 *     --core DZmP7zaBrc6FdJc842aeexnGV5YwPucg2Jv8p6Szh6hW \
 *     --label "csSOL · 90d (seed5)" \
 *     --base-symbol csSOL \
 *     --base-decimals 9 \
 *     --kyc-gated true \
 *     --vault FWvEaLFdmwRZBAGAcNhrCgFboaETqt2qQVoyusPu12nj \
 *     --market ER2Z72XMzXLugYPXTLPs4mhhtAFN5nFAVaGPR458acHC \
 *     --base-mint 6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt \
 *     --base-vault HRwvxef9aXEyKSTLkz8jq4xL8MMKvjfiU85Y8Ku8ojwx \
 *     --kamino-klend KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD \
 *     --kamino-reserve Ez1axBhD6M6t1Zmzfz8MQ95Kmuc48BuoYhQEEHEhT4U1 \
 *     --kamino-market 2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW \
 *     --kamino-coll-mint Ej1j2SQLjdxY3BEu16tsiEYzXqiMAqbWJ7k83upasTWy \
 *     --kamino-pyth 3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P \
 *     --kamino-token-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
 *
 * Pipe multiple invocations into a JSON array for the env var. The base
 * vault (the adapter-owned account holding wrapped underlying) lives
 * outside the vault/market accounts — caller passes it from the SY
 * adapter setup output.
 */

import { Connection, PublicKey } from "@solana/web3.js";

interface CliArgs {
  rpc: string;
  core: string;
  id?: string;
  label: string;
  baseSymbol: string;
  baseDecimals: number;
  kycGated: boolean;
  vault: string;
  market: string;
  baseMint: string;
  baseVault: string;

  // Optional kamino bundle. Pass these together to add the
  // wrapper_buy_pt_kamino account block to the registry entry. Without
  // them, the entry omits `accounts.kamino` and retail falls back to
  // the (broken-for-kamino-vaults) generic strip+sell_yt path.
  kaminoKlend?: string;
  kaminoReserve?: string;
  kaminoMarket?: string;
  kaminoCollMint?: string;
  kaminoPyth?: string;
  kaminoTokenProgram?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Record<string, string> = {};
  // Convert kebab-case flag names to camelCase keys so the parser is
  // ergonomic on the CLI side. e.g. `--kamino-klend X` → `out.kaminoKlend`.
  const toCamel = (s: string) =>
    s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  for (let i = 2; i < argv.length; i += 2) {
    const k = toCamel(argv[i].replace(/^--/, ""));
    out[k] = argv[i + 1];
  }
  const need = (k: keyof CliArgs) => {
    const v = out[k as string];
    if (!v) throw new Error(`missing --${k as string}`);
    return v;
  };
  return {
    rpc: need("rpc"),
    core: need("core"),
    id: out.id,
    label: need("label"),
    baseSymbol: need("baseSymbol"),
    baseDecimals: Number(need("baseDecimals")),
    kycGated: need("kycGated") === "true",
    vault: need("vault"),
    market: need("market"),
    baseMint: need("baseMint"),
    baseVault: need("baseVault"),
    kaminoKlend: out.kaminoKlend,
    kaminoReserve: out.kaminoReserve,
    kaminoMarket: out.kaminoMarket,
    kaminoCollMint: out.kaminoCollMint,
    kaminoPyth: out.kaminoPyth,
    kaminoTokenProgram: out.kaminoTokenProgram,
  };
}

function pkAt(buf: Buffer, off: number): string {
  return new PublicKey(buf.subarray(off, off + 32)).toBase58();
}

async function main() {
  const args = parseArgs(process.argv);
  const conn = new Connection(args.rpc, "confirmed");
  const vaultPk = new PublicKey(args.vault);
  const marketPk = new PublicKey(args.market);
  const corePk = new PublicKey(args.core);

  const [vaultInfo, marketInfo] = await conn.getMultipleAccountsInfo(
    [vaultPk, marketPk],
    "confirmed",
  );
  if (!vaultInfo) throw new Error(`vault ${args.vault} not found`);
  if (!marketInfo) throw new Error(`market ${args.market} not found`);

  const vault = Buffer.from(vaultInfo.data);
  const mkt = Buffer.from(marketInfo.data);

  // Vault layout — see backend-edge/src/fixed-yield.ts:538-555.
  // 8 disc + 32 curator + 2 fee_bps + 1 reentrancy = 43, then 8 pubkeys
  // (sy_program through address_lookup_table) at offsets 43, 75, 107…
  const syProgram = pkAt(vault, 43);
  const syMint = pkAt(vault, 75);
  const mintYt = pkAt(vault, 107);
  const mintPt = pkAt(vault, 139);
  // escrow_yt at 171 — not part of MarketAccountsDto.
  const escrowSy = pkAt(vault, 203);
  const yieldPosition = pkAt(vault, 235);
  const vaultAlt = pkAt(vault, 267);

  // MarketTwo layout — see backend-edge/src/fixed-yield.ts:577-596.
  const marketAlt = pkAt(mkt, 43);
  const mintLp = pkAt(mkt, 171);
  const marketEscrowPt = pkAt(mkt, 203);
  const marketEscrowSy = pkAt(mkt, 235);
  const tokenFeeTreasurySy = pkAt(mkt, 267);

  // PDAs.
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority"), vaultPk.toBuffer()],
    corePk,
  );
  const [coreEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    corePk,
  );

  const id = args.id ?? `${args.baseSymbol.toLowerCase()}-${marketPk.toBase58().slice(0, 6)}`;

  const accounts: Record<string, unknown> = {
    syProgram,
    // syMarket = the SY adapter's per-market metadata. Not stored on
    // the vault — caller knows it (it's the SyMetadata pubkey from
    // setup-kyc-kamino-stack output).
    syMarket: process.argv.includes("--sy-market")
      ? process.argv[process.argv.indexOf("--sy-market") + 1]
      : "11111111111111111111111111111111",
    syMint,
    baseVault: args.baseVault,
    vaultAuthority: vaultAuthority.toBase58(),
    yieldPosition,
    mintPt,
    mintYt,
    escrowSy,
    vaultAlt,
    coreEventAuthority: coreEventAuthority.toBase58(),
    mintLp,
    marketEscrowPt,
    marketEscrowSy,
    marketAlt,
    tokenFeeTreasurySy,
  };

  // Optional kamino bundle. The two PDAs (liquidity_supply and
  // lending_market_authority) are derived from canonical klend seeds;
  // they're not stored on chain so they must be derived rather than
  // read. Same seeds the retail klend.ts helper uses.
  if (
    args.kaminoKlend &&
    args.kaminoReserve &&
    args.kaminoMarket &&
    args.kaminoCollMint &&
    args.kaminoPyth
  ) {
    const klendPk = new PublicKey(args.kaminoKlend);
    const reservePk = new PublicKey(args.kaminoReserve);
    const marketPkKlend = new PublicKey(args.kaminoMarket);
    const [liqSupply] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_liq_supply"), reservePk.toBuffer()],
      klendPk,
    );
    const [lma] = PublicKey.findProgramAddressSync(
      [Buffer.from("lma"), marketPkKlend.toBuffer()],
      klendPk,
    );
    const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
    const tokenProgramKamino = args.kaminoTokenProgram ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    accounts.kamino = {
      klendReserve: reservePk.toBase58(),
      klendLiquiditySupply: liqSupply.toBase58(),
      klendCollateralMint: args.kaminoCollMint,
      klendProgram: klendPk.toBase58(),
      tokenProgramKamino,
      realKlend: {
        klendLendingMarket: marketPkKlend.toBase58(),
        klendLendingMarketAuthority: lma.toBase58(),
        klendInstructionSysvar: SYSVAR_INSTRUCTIONS,
        // klend's liquidity-side token program — same as the
        // adapter's underlying token program for these stacks (csXXX
        // d-tokens). Token-2022 for csSOL, classic SPL for csUSDC.
        klendLiquidityTokenProgram: tokenProgramKamino,
        klendPythOracle: args.kaminoPyth,
        klendSwitchboardPrice: null,
        klendSwitchboardTwap: null,
        klendScopePrices: null,
      },
    };
  }

  const entry = {
    id,
    label: args.label,
    baseSymbol: args.baseSymbol,
    baseDecimals: args.baseDecimals,
    kycGated: args.kycGated,
    vault: args.vault,
    market: args.market,
    baseMint: args.baseMint,
    accounts,
  };

  console.log(JSON.stringify(entry, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
