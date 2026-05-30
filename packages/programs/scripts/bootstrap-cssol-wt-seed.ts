/**
 * bootstrap-cssol-wt-seed.ts — Mints initial csSOL-WT to the treasury
 * and deposits it as flash-borrowable liquidity in the csSOL-WT klend
 * reserve.
 *
 * STATUS: stub. Run AFTER scripts/setup-cssol-wt-reserve.ts has been
 * implemented and a `cssol-wt-deployed.json` exists with the reserve
 * address.
 *
 * Why a seed: klend's flashBorrow path requires the reserve to have
 * actual liquidity. At day 0 the reserve is empty. We mint N csSOL-WT
 * as treasury seed, deposit into the reserve, and then *every*
 * collateral-swap (borrow → user mints WT → repay) rotates the seed
 * in place — the seed never leaves the reserve.
 *
 * Treasury cost: rent on the seeded amount + a corresponding VRT
 * reservation (the seed's backing must be tracked so a treasury
 * runaway can't drain pool VRT — out of scope for v1, but pencil it
 * into the WithdrawQueue.pending_wsol accounting before scaling).
 *
 * To implement when picking this up:
 *
 *   const SEED_AMOUNT = 10_000n * 1_000_000_000n; // 10k csSOL-WT
 *
 *   1. delta_mint.mint_to(SEED_AMOUNT) → treasury csSOL-WT ATA.
 *      (treasury must already be whitelisted on the csSOL-WT MintConfig.)
 *
 *   2. klend::deposit_reserve_liquidity(
 *        liquidityAmount = SEED_AMOUNT,
 *        reserve = cssolWtReserve,
 *        userSourceLiquidity = treasuryCssolWtAta,
 *        userDestinationCollateral = treasuryCssolWtCollateralAta,
 *      )
 *      Pre-create the collateral ATA (cToken) if needed.
 *
 *   3. The treasury holds the cTokens — in a v2 we'd lock them in a
 *      time-locked program-owned vault to prevent treasury keys
 *      pulling the seed. For v1, just notarize the address in
 *      cssol-pool.json::seedHolder.
 *
 * Verification: after this runs, klend's csSOL-WT reserve should report
 * ~SEED_AMOUNT `liquidity.available_amount`, and the very first user
 * collateral-swap will draw from this seed for its flashBorrow.
 */

import { Connection } from "@solana/web3.js";

async function main() {
  console.error(
    "bootstrap-cssol-wt-seed.ts is a stub — depends on setup-cssol-wt-reserve.ts " +
    "having produced cssol-wt-deployed.json. See header for implementation steps.",
  );
  void new Connection;
  process.exit(2);
}

main();
