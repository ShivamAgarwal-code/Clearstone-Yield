import { PublicKey, Connection } from "@solana/web3.js";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/**
 * V3 unified klend market. Replaces the legacy v1 `45FNL648…tc98` —
 * see `frontend-institutional/src/config/devnet.ts` and
 * `docs/operations/MARGIN_PAIR.md` for the migration story.
 */
const MARKET = new PublicKey("EVw8B9WC2AX5ScCwkYJF2mZz6RdHLQZtoDeKChdMiz2E");

/**
 * Every klend reserve registered in the v3 market that an institutional
 * obligation might reference. `findObligationReserves` scans an
 * obligation's raw bytes for these so `RefreshObligation` always gets
 * the right `remaining_accounts` list — both deposit and borrow slots
 * have to be passed (klend's `expected_remaining_accounts` counts
 * deposits + borrows; missing one trips InvalidAccountInput / 6006).
 */
const KNOWN_RESERVES = [
  new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"), // csSOL (EG-2 collateral)
  new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw"), // csSOL-WT (EG-2 collateral)
  new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8"), // wSOL (legacy — kept so close-old-positions path can refresh)
  new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg"), // cSOL (EG-2 debt; EG-3 collateral)
  new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"), // ceUSX (EG-1 collateral)
  new PublicKey("GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq"), // ceUSX-WT (EG-1 collateral; transient during Solstice unlock)
  new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe"), // cUSDC (EG-1 debt; EG-3 debt; EG-4 collateral) — post 2026-05-07 migration
  new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9"), // sUSDC (legacy — Hidden in klend post-migration; kept so refresh_obligation finds any straggler positions)
];

export const OB_ID = 3;

/** Klend supports up to 256 obligations per wallet, distinguished by a
 *  single-byte `id` seed. PositionsPage owns OB_ID=3 ("Manage"); the
 *  credit-trade panel owns OB_ID=0 (klend's default). Same wallet, same
 *  market, two parallel positions. The dual-obligation note in
 *  PositionsPage surfaces this so users don't misread "0 collateral"
 *  on one tab as "no position anywhere". */
export const CREDIT_TRADE_OB_ID = 0;

export function getObligationPda(wallet: PublicKey, id: number = OB_ID): PublicKey {
  const [obPda] = PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([id]), wallet.toBuffer(), MARKET.toBuffer(),
     PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    KLEND
  );
  return obPda;
}

/**
 * Find all reserve addresses present in an obligation's data, in
 * deposit-first order (deposits at offsets 96-1183, borrows at
 * 1208-2207 in klend's Obligation layout). Returns them so the caller
 * can pass them as `remaining_accounts` to `RefreshObligation`,
 * `BorrowObligationLiquidity`, `RepayObligationLiquidity` (when
 * `obligation.elevation_group > 0`), etc.
 */
export function findObligationReserves(data: Buffer): PublicKey[] {
  const found: { pubkey: PublicKey; offset: number }[] = [];

  for (const reserve of KNOWN_RESERVES) {
    const buf = reserve.toBuffer();
    for (let i = 64; i < data.length - 32; i++) {
      if (data.subarray(i, i + 32).equals(buf)) {
        found.push({ pubkey: reserve, offset: i });
      }
    }
  }

  // Sort by offset — deposits live before borrows in the obligation,
  // so this naturally produces the order klend expects.
  found.sort((a, b) => a.offset - b.offset);
  return found.map(f => f.pubkey);
}

// Deposits live in the [96, 1184) byte range; borrows start at 1208.
// Required as the writable trailing remaining_accounts on borrow / repay
// when `obligation.elevation_group > 0` (klend's check at
// lending_operations.rs:2835 throws InvalidAccountInput / 6006 if missing).
export function findObligationDepositReserves(data: Buffer): PublicKey[] {
  const found: { pubkey: PublicKey; offset: number }[] = [];
  for (const reserve of KNOWN_RESERVES) {
    const buf = reserve.toBuffer();
    for (let i = 96; i < 1184; i++) {
      if (data.subarray(i, i + 32).equals(buf)) {
        found.push({ pubkey: reserve, offset: i });
        break;
      }
    }
  }
  found.sort((a, b) => a.offset - b.offset);
  return found.map(f => f.pubkey);
}

/** Re-export for callers that just want the canonical v3 market pubkey. */
export const KLEND_MARKET = MARKET;
