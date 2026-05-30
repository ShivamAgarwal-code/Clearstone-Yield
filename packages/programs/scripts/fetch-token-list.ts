/**
 * Fetches the CoinGecko Solana token list and converts it to our internal
 * format (keyed by lowercase address).
 *
 * Usage:  npx ts-node scripts/fetch-token-list.ts [--out configs/token-list.json]
 */

import * as fs from "fs";
import * as path from "path";

const COINGECKO_URL = "https://tokens.coingecko.com/solana/all.json";
const DEFAULT_OUT = path.resolve(__dirname, "../configs/token-list.json");

interface CoinGeckoToken {
  chainId: number | null;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
}

interface InternalToken {
  chainId: string;
  decimals: number;
  name: string;
  address: string;
  symbol: string;
  logoURI: string;
  assetGroup: string;
  currencyId: string;
}

async function main() {
  const outArg = process.argv.indexOf("--out");
  const outPath = outArg !== -1 ? process.argv[outArg + 1] : DEFAULT_OUT;

  console.log(`Fetching Solana token list from CoinGecko...`);
  const resp = await fetch(COINGECKO_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

  const data = (await resp.json()) as { tokens: CoinGeckoToken[] };
  console.log(`  Received ${data.tokens.length} tokens`);

  // Convert to our format: keyed by lowercase address
  const list: Record<string, InternalToken> = {};

  for (const t of data.tokens) {
    const key = t.address.toLowerCase();
    list[key] = {
      chainId: "solana",
      decimals: t.decimals,
      name: t.name,
      address: t.address,
      symbol: t.symbol,
      logoURI: t.logoURI || "",
      assetGroup: t.symbol,
      currencyId: `${t.name}::${t.symbol}`,
    };
  }

  const output = {
    chainId: "solana",
    version: "0",
    fetchedAt: new Date().toISOString(),
    count: Object.keys(list).length,
    list,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`  Wrote ${Object.keys(list).length} tokens to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
