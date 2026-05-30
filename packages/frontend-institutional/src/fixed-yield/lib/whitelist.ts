// delta_mint whitelist pre-flight.
//
// Solstice's d-tokens (csSOL, sUSDC, …) are issued by delta-mint, which
// gates every `mint_to` on a `WhitelistEntry` PDA at
// `["whitelist", dm_mint_config, recipient]`. If that PDA doesn't exist
// for the connected wallet, the *upstream* wrap (SOL → csSOL, USDC →
// sUSDC, etc.) reverts with `AccountNotInitialized` (Anchor 3012 = 0xbc4).
//
// Clearstone's `kamino_sy_adapter.mint_sy` doesn't itself touch
// delta-mint — it deposits the underlying d-token into klend. So the
// failure mode is "user can't even get the underlying d-token into
// their wallet", not "Clearstone is broken". Surface this early so
// the user pursues the Solstice-side whitelist flow instead of
// debugging klend.

import { Connection, PublicKey } from "@solana/web3.js";

export const DELTA_MINT_PROGRAM_ID = new PublicKey(
  "BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy"
);

const WHITELIST_SEED = Buffer.from("whitelist");

/**
 * Derive the `WhitelistEntry` PDA for a (dmMintConfig, wallet) pair
 * and check whether it's been initialized. Cheap (1 RPC call).
 *
 * `dmMintConfig` is the delta-mint MintConfig PDA, NOT the SPL mint.
 * For Solstice csSOL: `[Buffer.from("mint_config"), wrappedMintPk]`
 * under the delta_mint program. We don't fetch the wrappedMint itself —
 * if the caller has it, we just check the entry directly.
 */
export async function checkWhitelist(args: {
  connection: Connection;
  dmMintConfig: PublicKey;
  wallet: PublicKey;
}): Promise<{ entry: PublicKey; initialized: boolean }> {
  const [entry] = PublicKey.findProgramAddressSync(
    [WHITELIST_SEED, args.dmMintConfig.toBuffer(), args.wallet.toBuffer()],
    DELTA_MINT_PROGRAM_ID
  );
  const info = await args.connection.getAccountInfo(entry, "confirmed");
  return { entry, initialized: info !== null };
}
