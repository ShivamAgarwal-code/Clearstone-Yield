// Account derivation + balance reads.
//
// Mirrors the helpers in `tests/fixtures.ts` / `tests/clearstone-fusion-flash.ts`
// without the test-side conveniences. Keep these one function per
// concern so the page handlers can compose them piecemeal.
//
// Token-program detection: SPL classic (TokenkegQ…) vs Token-2022
// (TokenzQdBNb…) is not a free choice — it's owned by the mint. Any
// ATA / mint_to / transfer must use whichever program owns the mint.
// For Solstice USDC (Token-2022) the auto-detect below picks the right
// program; for the test SPL-classic mints in fixtures it picks classic.

import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  TokenAccountNotFoundError,
} from "@solana/spl-token";

/** Resolve the SPL token program that owns a mint. */
export async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found on-chain`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`mint ${mint.toBase58()} owner ${info.owner.toBase58()} is not a known SPL token program`);
}

/** Derive the user's ATA for a mint using the right token program. */
export async function userAta(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ ata: PublicKey; tokenProgram: PublicKey }> {
  const tokenProgram = await detectTokenProgram(connection, mint);
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    /* allowOwnerOffCurve */ false,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return { ata, tokenProgram };
}

/** Read an ATA balance; returns 0n when the ATA hasn't been created. */
export async function ataBalance(
  connection: Connection,
  ata: PublicKey
): Promise<bigint> {
  try {
    const acct = await getAccount(connection, ata);
    return acct.amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError) return 0n;
    throw e;
  }
}

/** Bundled read: every balance the LP/Buy-PT pages need at once. */
export interface PositionBalances {
  base: bigint;
  sy: bigint;
  pt: bigint;
  yt: bigint;
  lp: bigint;
}

export async function readPosition(args: {
  connection: Connection;
  owner: PublicKey;
  baseMint: PublicKey;
  syMint: PublicKey;
  ptMint: PublicKey;
  ytMint: PublicKey;
  lpMint: PublicKey;
}): Promise<PositionBalances> {
  const [base, sy, pt, yt, lp] = await Promise.all(
    [
      args.baseMint,
      args.syMint,
      args.ptMint,
      args.ytMint,
      args.lpMint,
    ].map(async (m) => {
      const { ata } = await userAta(args.connection, args.owner, m);
      return ataBalance(args.connection, ata);
    })
  );
  return { base, sy, pt, yt, lp };
}

/**
 * SY-CPI remaining-accounts builder. Reads `market.cpi_accounts` +
 * the market's ALT and produces the deduplicated AccountMeta list
 * core's strip / merge / trade_pt sub-CPIs need. Mirror of
 * `syCpiExtras` in tests/clearstone-fusion-flash.ts.
 *
 * Returns `[]` if the market has empty cpi_accounts (shouldn't happen
 * for a live market). Caller appends this to `.remainingAccounts(...)`
 * on whichever Anchor methods builder it's about to invoke.
 */
export async function syCpiRemainingAccounts(args: {
  connection: Connection;
  /** Pre-fetched MarketTwo account (or vault) — pass via
   *  `program.account.marketTwo.fetch(pk)`. */
  cpiAccounts: {
    getSyState: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
    depositSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
    withdrawSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
  };
  alt: PublicKey;
}): Promise<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]> {
  const altResp = await args.connection.getAddressLookupTable(args.alt);
  const altState = altResp.value;
  if (!altState) throw new Error(`alt ${args.alt.toBase58()} not found`);
  const seen = new Map<number, { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>();
  for (const list of [
    args.cpiAccounts.getSyState,
    args.cpiAccounts.depositSy,
    args.cpiAccounts.withdrawSy,
  ]) {
    for (const ctx of list) {
      const idx = ctx.altIndex;
      const pubkey = altState.state.addresses[idx];
      if (!pubkey) continue;
      const prev = seen.get(idx);
      seen.set(idx, {
        pubkey,
        // PDA-signed at the inner SY CPI via signer_seeds; outer-tx
        // is_signer=true would force web3.js to demand a real keypair
        // signature for an account that's only ever PDA-signed.
        isSigner: false,
        isWritable: ctx.isWritable || (prev?.isWritable ?? false),
      });
    }
  }
  return [...seen.values()];
}
