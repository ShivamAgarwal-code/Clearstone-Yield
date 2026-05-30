import { ReactNode, useEffect, useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction, NATIVE_MINT,
} from "@solana/spl-token";
import { getObligationPda, findObligationReserves, findObligationDepositReserves, OB_ID, KLEND_MARKET } from "../lib/obligation";
import {
  ObligationSwitcher,
  type ObligationCatalogEntry,
} from "../components/ObligationSwitcher";
import { useObligationCatalog } from "../hooks/useObligationCatalog";
import ElevationGroupPicker, { getElevationOption } from "../components/ElevationGroupPicker";
import BalanceIcon from "../components/BalanceIcon";
import { TxActionButtons, shortSig } from "../components/TxActionButtons";
import {
  buildConvertCeusxIxes,
  buildUnwindCeusxWtIxes,
} from "../lib/lib/redeemCeusx";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  KeyValue,
  PageHeader,
  SectionHeader,
  Snackbar,
  Stat,
  StatLabel,
  TokenAmountInput,
  TokenSymbol,
  cn,
} from "@clearstone/design-system";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = KLEND_MARKET;

// USDC borrow leg — flipped on 2026-05-07 from the unrestricted sUSDC
// reserve to the KYC-gated cUSDC wrapper. EG-1 (stables) + EG-3 (margin
// long SOL) now have cUSDC as their debt asset on-chain.
//
// The legacy sUSDC reserve / mint are kept below as `LEGACY_*` so that
// `findObligationReserves` can still surface any straggler position
// against the deprecated reserve (it's Hidden in klend, so repay /
// withdraw still work but no new traffic flows through it).
const USDC_RESERVE = new PublicKey("3mPkFWN81i6ToGs5WJwSb9RTfbfkvEzZfLfSnb2DFjxe");
const USDC_ORACLE  = new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD");
const USDC_MINT    = new PublicKey("4qU4eyXH4PR8Cf4jeKv4EUmMXrqg5Are7kugdjhP1EnY");

// Legacy sUSDC reserve — DEPRECATED. Kept only so any pre-migration
// obligation row still renders and the user can repay / withdraw it.
// Don't use these for new deposits / borrows — klend rejects them.
const LEGACY_SUSDC_RESERVE = new PublicKey("78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9");
const LEGACY_SUSDC_MINT    = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");

// Legacy wSOL reserve — retired as the EG-2 debt asset on 2026-05-06,
// replaced by cSOL (KYC-wrapped variant). Kept here only so the page
// can still display + repay legacy obligations that haven't been
// closed yet. New positions (post-migration) borrow cSOL.
const WSOL_RESERVE = new PublicKey("CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8");
const WSOL_ORACLE = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// cSOL is the live EG-2 debt asset. Token-2022 mint with delta-mint
// whitelist gating. Same Pyth feed as wSOL since cSOL is a 1:1 wrapper.
const CSOL_RESERVE = new PublicKey("7dRBLGfkzKBAR1MmGM3HfHQXufter8pC3cA3rPfzGYTg");
const CSOL_ORACLE  = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const CSOL_MINT    = new PublicKey("AX66E5UvhdndwBfdebrW2YeGbsQhRndsPfNWGd16xBhf");

/**
 * Borrow-leg metadata — every reserve a wallet might hold debt against
 * on the v3 market, indexed by reserve pubkey. Today: sUSDC (EG-1 +
 * EG-3 debt), cSOL (EG-2 debt as of 2026-05-06, EG-4 debt), and wSOL
 * (legacy — kept for closing legacy obligations only). Used by the
 * asset-aware repay path and by the live borrow-rate decoder so the
 * page reads the *correct* reserve regardless of which obligation is
 * selected.
 */
interface BorrowLegMeta {
  symbol: string;
  mint: PublicKey;
  oracle: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

const BORROW_LEGS: Record<string, BorrowLegMeta> = {
  [USDC_RESERVE.toBase58()]: {
    // cUSDC — Token-2022 mint (delta-mint KYC wrapper). The repay flow
    // derives the user's cUSDC ATA off this; must use Token-2022 or the
    // ATA derivation lands on the wrong address. EG-1 + EG-3 debt asset
    // post 2026-05-07 migration.
    symbol: "cUSDC", mint: USDC_MINT, oracle: USDC_ORACLE,
    tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6,
  },
  [CSOL_RESERVE.toBase58()]: {
    symbol: "cSOL", mint: CSOL_MINT, oracle: CSOL_ORACLE,
    // cSOL is a Token-2022 mint (delta-mint wrapper). The repay flow
    // derives the user's cSOL ATA off this — must use Token-2022 or
    // the ATA derivation lands on the wrong address.
    tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 9,
  },
  [WSOL_RESERVE.toBase58()]: {
    // Read-only legacy entry — shows up if a wallet still holds
    // wSOL-denominated debt from before the migration. New
    // obligations don't borrow wSOL anymore.
    symbol: "wSOL", mint: WSOL_MINT, oracle: WSOL_ORACLE,
    tokenProgram: TOKEN_PROGRAM_ID, decimals: 9,
  },
  [LEGACY_SUSDC_RESERVE.toBase58()]: {
    // Read-only legacy entry — surfaces if a wallet held sUSDC debt
    // before the cUSDC migration on 2026-05-07. The reserve is Hidden
    // in klend so new borrows are blocked, but repay / withdraw stay
    // open and the entry here gives the row enough metadata to render.
    symbol: "sUSDC", mint: LEGACY_SUSDC_MINT, oracle: USDC_ORACLE,
    tokenProgram: TOKEN_PROGRAM_ID, decimals: 6,
  },
};

interface CollateralAsset {
  symbol: string;
  mint: PublicKey;
  reserve: PublicKey;
  oracle: PublicKey;
  tokenProgram: PublicKey;
  price: number;
  /** Mint decimals — must match the on-chain SPL mint. klend reads
   *  these from the liquidity mint account at init_reserve and uses
   *  them for every liquidity-side amount, so the UI must agree or
   *  deposits/withdraws scale wrong (e.g. 9-decimal csSOL treated as
   *  6 silently divides amounts by 1000×). */
  decimals: number;
  yieldApy?: string;
  /** Single-line caption rendered under the data cells in the row card.
   *  Should describe the asset in human-readable terms ("KYC Solana ·
   *  Jito-restaking", "KYC USD Coin · ~10% APY") so every row carries
   *  a consistent secondary line — symbols alone (csSOL, ceUSX-WT) read
   *  as opaque tickers without it. The caption sits below the numeric
   *  cells but stops short of the action buttons, so it never
   *  collides with the Withdraw/Supply column. */
  subtitle?: string;
  /** True for collaterals that are *accepted by an EG* but not yet
   *  wired into this UI — the row renders for awareness, but the
   *  Supply / Withdraw buttons are replaced by a "Coming soon" chip. */
  pending?: boolean;
  /** Withdraw-ticket placeholder mint (csSOL-WT / ceUSX-WT). These
   *  can never be supplied directly — the mint authority gates
   *  transfers to the convert flow (Jito enqueue / Solstice unlock).
   *  The row renders so the user sees the WT collateral they hold
   *  during the unlock window, but Supply is suppressed in favour of
   *  a chip pointing at the redemption flow that issues them. */
  isWithdrawTicket?: boolean;
}

const COLLATERAL_ASSETS: CollateralAsset[] = [
  {
    symbol: "ceUSX", mint: new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT"),
    reserve: new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"),
    oracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.08, decimals: 6, yieldApy: "~10%",
    subtitle: "KYC USD Coin · ~10% APY",
  },
  {
    symbol: "csSOL", mint: new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt"),
    reserve: new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"),
    oracle: new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 84, decimals: 9, yieldApy: "Jito-restaking",
    subtitle: "KYC Solana · Jito-restaking",
  },
  // csSOL-WT — wallet-token sibling of csSOL, used as the collateral
  // pair in EG-2. Same oracle as csSOL since it tracks the same SOL
  // value. Wired up against the v3 market's csSolWtReserve. Marked as
  // a withdraw-ticket so the UI suppresses the Supply button — the
  // mint authority is the cSOL pool PDA and direct user deposits are
  // gated behind delta-mint's whitelist; the only legitimate path is
  // the (planned) csSOL convert flow which deposits WT atomically.
  {
    symbol: "csSOL-WT",
    mint: new PublicKey("8vmVcN9krv8edY8GY75hMLvkSSjANjkmYeZUux2a4Sva"),
    reserve: new PublicKey("94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw"),
    oracle: new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 84, decimals: 9, yieldApy: "Jito-restaking · WT",
    subtitle: "KYC Solana · withdraw ticket (Jito unstake pending)",
    isWithdrawTicket: true,
  },
  // ceUSX-WT — placeholder collateral issued only by the redemption
  // convert flow (governor::enqueue_eusx_unlock_via_pool). Same EG-1
  // membership and oracle as ceUSX. We list it so `findObligationReserves`
  // produces a deposit row during the unlock window and the redemption
  // panel's Stage 2 button can fire.
  {
    symbol: "ceUSX-WT",
    mint: new PublicKey("DoHMuKFU4b2co2CBBcNjVzWf6yL3KG5H2N9FxkfFFN6A"),
    reserve: new PublicKey("GCBFhWVCAN7rXxupwcZVLL5TBmifpagMe9eRWXbfEKSq"),
    oracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.00, decimals: 6, yieldApy: "Solstice unlock pending",
    subtitle: "KYC USD Coin · withdraw ticket (Solstice unlock pending)",
    isWithdrawTicket: true,
  },
  // cSOL — Kamino's collateral SOL receipt; accepted in EG-3 (Margin
  // long SOL). EG-3 is itself pending deployment, so this row is for
  // awareness only. Addresses are placeholders until the reserve is
  // launched on devnet.
  {
    symbol: "cSOL",
    mint: PublicKey.default,
    reserve: PublicKey.default,
    oracle: PublicKey.default,
    tokenProgram: TOKEN_PROGRAM_ID, price: 84, decimals: 9, yieldApy: "—",
    subtitle: "KYC Solana · margin-long collateral (EG-3 pending)",
    pending: true,
  },
  // wSOL collateral deliberately removed from the supply selector —
  // the wSOL reserve was retired 2026-05-06 (status=Hidden, deposit_
  // limit=0, EG-2 membership cleared). Existing legacy wSOL positions
  // still surface via `findObligationDepositReserves` (which scans the
  // raw obligation bytes for any reserve pubkey, not this UI list)
  // so a user with a stranded wSOL deposit can still see + withdraw
  // it via the position rows. New supplies should land on cSOL.
  // cUSDC as collateral — accepted by EG-4 (Margin short SOL). cUSDC's
  // reserve config has elevationGroups[0]=4, registering it as the EG-4
  // collateral. Full EG-4 borrow flow (debt = cSOL) lights up as soon
  // as the cSOL reserve's `borrow_limit_against_this_collateral_in_
  // elevation_group[3]` is set non-zero. Until then this row is
  // depositable but the EG-4 borrow side may still bounce.
  {
    symbol: "cUSDC",
    mint: USDC_MINT,
    reserve: USDC_RESERVE,
    oracle: USDC_ORACLE,
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.00, decimals: 6, yieldApy: "—",
    subtitle: "KYC USD Coin · margin-short collateral (EG-4)",
  },
];

const RESERVE_ORACLES: Record<string, PublicKey> = {};
COLLATERAL_ASSETS.forEach(a => {
  if (a.pending) return;
  RESERVE_ORACLES[a.reserve.toBase58()] = a.oracle;
});
RESERVE_ORACLES[USDC_RESERVE.toBase58()] = USDC_ORACLE;
// Borrow-leg oracles also have to be in the map — refresh_reserve in the
// repay flow needs the oracle for *whichever* reserve carries the debt.
RESERVE_ORACLES[CSOL_RESERVE.toBase58()] = CSOL_ORACLE;
RESERVE_ORACLES[WSOL_RESERVE.toBase58()] = WSOL_ORACLE;
// Legacy sUSDC reserve uses the same USDC oracle as cUSDC. Required so
// any straggler obligation with sUSDC debt can still be refresh'd before
// repay (same oracle map; klend rejects refresh_reserve without it).
RESERVE_ORACLES[LEGACY_SUSDC_RESERVE.toBase58()] = USDC_ORACLE;

const RESERVE_META: Record<string, { symbol: string; price: number; decimals: number }> = {};
COLLATERAL_ASSETS.forEach(a => {
  if (a.pending) return;
  RESERVE_META[a.reserve.toBase58()] = { symbol: a.symbol, price: a.price, decimals: a.decimals };
});
RESERVE_META[USDC_RESERVE.toBase58()]        = { symbol: "cUSDC", price: 1.00, decimals: 6 };
RESERVE_META[CSOL_RESERVE.toBase58()]        = { symbol: "cSOL",  price: 84,   decimals: 9 };
RESERVE_META[WSOL_RESERVE.toBase58()]        = { symbol: "wSOL",  price: 84,   decimals: 9 };
RESERVE_META[LEGACY_SUSDC_RESERVE.toBase58()] = { symbol: "sUSDC", price: 1.00, decimals: 6 };

const DISC = {
  init_user_metadata: Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]),
  init_obligation: Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]),
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refresh_obligation: Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]),
  deposit_reserve_liquidity_and_obligation_collateral: Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]),
  borrow_obligation_liquidity: Buffer.from([121, 127, 18, 204, 73, 245, 225, 65]),
  repay_obligation_liquidity: Buffer.from([145, 178, 13, 225, 76, 240, 147, 72]),
  withdraw_obligation_collateral_and_redeem_reserve_collateral: Buffer.from([75, 93, 93, 220, 34, 150, 218, 196]),
  // sha256("global:request_elevation_group")[..8] — verified against
  // lib/lib/klend.ts:REQUEST_ELEVATION_GROUP_DISC.
  request_elevation_group: Buffer.from([36, 119, 251, 129, 34, 240, 7, 147]),
};

interface Deposit { reserve: string; symbol: string; amount: number; valueUsd: number; }
interface Borrow { reserve: string; symbol: string; amount: number; valueUsd: number; }

/** Klend renders the supplied-USDC reserve as `sUSDC`; the underlying
 *  asset is plain USDC so the icon should match. Other tokens map to
 *  themselves. */
function iconSymbolFor(symbol: string): TokenSymbol {
  if (symbol === "sUSDC") return "USDC";
  if (symbol === "wSOL") return "SOL";
  return symbol as TokenSymbol;
}
interface PositionData {
  address: string;
  deposits: Deposit[];
  borrows: Borrow[];
  /** Klend obligation `elevation_group` (u8 at offset 2285). 0 = none. */
  elevationGroup: number;
  totalCollateralUsd: number;
  totalBorrowUsd: number;
  healthFactor: number | null;
  ltvPct: number;
  liqThreshPct: number;
  walletBalances: Record<string, number>;
  usdcBalance: number;
  maxBorrow: number;
  availableLiquidity: number;
  liquidationPrice: number | null;
  borrowAPR: number | null;
  /** Symbol of the obligation's active debt asset (sUSDC / wSOL).
   *  Drives the Repay form's labels so the user repays whatever the
   *  obligation actually owes — not always "USDC". */
  debtSymbol: string;
  /** Wallet balance of the debt asset, in token units. Repay form uses
   *  this for the "wallet has X" hint and the MAX cap. */
  debtBalance: number;
  /** Per-leg liquidity + APR snapshot for the Available-to-borrow strip.
   *  Pre-computed for every borrow leg the market exposes so the page
   *  can render both rows (sUSDC + wSOL) without an extra RPC per
   *  render. The `activeBorrow*` fields above remain — they track
   *  whichever leg drives the obligation's debt-side stats. */
  legs: Record<string, { available: number; apr: number | null }>;
}

export default function PositionsPage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [position, setPosition] = useState<PositionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  // Status toast shape:
  //   - `msg`  : short heading ("Borrowed 12 USDC", "Borrow failed: …")
  //   - `type` : drives the Snackbar accent
  //   - `sig`  : optional tx signature for success toasts. When present,
  //              the bottom Snackbar renders a truncated `sig=…` detail
  //              line plus the Explorer / Copy-sig action cluster, so
  //              the user never has to fish a signature out of plain
  //              prose. Mirrors the credit-trade panel's shape so every
  //              tx flow surfaces results identically.
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error"; sig?: string } | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  const [depositAsset, setDepositAsset] = useState<CollateralAsset | null>(null);
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrawAsset, setWithdrawAsset] = useState<CollateralAsset | null>(null);
  const [borrowAmt, setBorrowAmt] = useState("");
  const [repayAmt, setRepayAmt] = useState("");
  const [showBorrow, setShowBorrow] = useState(false);
  const [showRepay, setShowRepay] = useState(false);
  const [showMarketParams, setShowMarketParams] = useState(false);
  // EG the page is currently previewing — filters the Collateral table
  // below. Defaults to whatever the obligation is in on-chain; resets
  // whenever a fresh `position` lands so a successful switch sticks.
  const [selectedEg, setSelectedEg] = useState<number>(0);
  useEffect(() => {
    if (position) setSelectedEg(position.elevationGroup);
  }, [position?.elevationGroup]);

  // Redemption panel — local UI state for the ceUSX → USDC unwind flow.
  // The Solstice API key is shared with PreparePage's mint flow and read
  // from the same env var; users without it get a Configure CTA.
  const [redeemAmt, setRedeemAmt] = useState("");
  const [showRedeem, setShowRedeem] = useState(false);
  const solsticeApiKey = import.meta.env.VITE_SOLSTICE_API_KEY ?? "";

  // Active obligation id. Klend allows up to 256 obligations per
  // (wallet, market) — the page treats them as a flat numbered list
  // and dispatches behavior (Borrow visibility, repay asset, EG hints)
  // off the obligation's *data*, not off any "lending vs credit-trade"
  // dichotomy. Default of 3 matches the historical "lending" id; gets
  // auto-overridden on first load if a different id has activity.
  const [selectedObligationId, setSelectedObligationId] = useState<number>(OB_ID);

  // Obligation catalog — pulled from the shared `useObligationCatalog`
  // hook so this tab and the credit-trade tab render the same pill
  // shape (existence + collateralUsd + EG, EG-pair icon, formatted
  // USD label). Bumping `catalogNonce` after a tx confirms forces a
  // re-probe so a brand-new deposit surfaces in the pills immediately.
  const [catalogNonce, setCatalogNonce] = useState(0);
  const { catalog: obligationCatalog } = useObligationCatalog({
    selected: selectedObligationId,
    probeCount: 16,
    nonce: catalogNonce,
  });
  const refreshCatalog = useCallback(() => setCatalogNonce((n) => n + 1), []);

  // First-load auto-select: if the wallet has obligations and the
  // current selection is empty while another id has activity, switch
  // to the first non-empty one. Driven off the hook's catalog so the
  // jump happens once the probe lands rather than waiting on the
  // page's heavier loadPosition pass.
  const [didAutoSelect, setDidAutoSelect] = useState(false);
  useEffect(() => {
    if (didAutoSelect || obligationCatalog.length === 0) return;
    const selectedSummary = obligationCatalog.find((e) => e.id === selectedObligationId)?.summary;
    if (selectedSummary?.exists) { setDidAutoSelect(true); return; }
    const firstPopulated = obligationCatalog.find((e) => e.summary.exists);
    if (firstPopulated && firstPopulated.id !== selectedObligationId) {
      setSelectedObligationId(firstPopulated.id);
    }
    setDidAutoSelect(true);
  }, [didAutoSelect, obligationCatalog, selectedObligationId]);

  // Pick the next unused id when the user clicks "+ New". Lowest
  // unused id wins so the catalog stays compact.
  const nextUnusedId = (cat: ObligationCatalogEntry[]): number => {
    const used = new Set(cat.filter(e => e.summary.exists).map(e => e.id));
    for (let i = 0; i < 256; i++) if (!used.has(i)) return i;
    return 0;
  };

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // `loadPosition` accepts an `isCancelled` predicate so the useEffect
  // wrapping it (below) can flip a flag when the user switches
  // obligations mid-load. Without this, two overlapping loads can race:
  // the slower one's `setPosition(…)` lands AFTER the faster one's,
  // leaving the UI showing data for the *previous* obligation while
  // the pill says the new one. Action handlers also call `loadPosition`
  // post-tx — they pass `() => false` to opt out of cancellation since
  // they want their reload to land regardless of any pending fetch.
  const loadPosition = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!publicKey) return;
    setLoading(true);
    // Snapshot the obligation id we're loading FOR. Used in two places:
    //   1) inside `isCancelled`-equivalent guards before each setState
    //      so a tx-handler reload doesn't write stale data either.
    //   2) the early-return on selection change (cancelled token).
    const targetObId = selectedObligationId;
    // Re-probe the obligation catalog in parallel with the heavier
    // active-obligation read below. After deposits/withdraws the pill
    // amounts surface as soon as the next slot lands.
    refreshCatalog();
    try {
      // Catalog (existence + collateralUsd + EG) is owned by
      // `useObligationCatalog`; the selection-side auto-jump runs in
      // its own effect above. Here we just need the active obligation's
      // raw account data for the rest of the page (LTV, deposits, debt
      // breakdown, refresh-reserves remaining-accounts list, etc.).
      const obPda = getObligationPda(publicKey, selectedObligationId);
      const info = await connection.getAccountInfo(obPda);

      const walletBalances: Record<string, number> = {};
      for (const asset of COLLATERAL_ASSETS) {
        if (asset.pending) {
          walletBalances[asset.symbol] = 0;
          continue;
        }
        try {
          const ata = getAssociatedTokenAddressSync(asset.mint, publicKey, false, asset.tokenProgram);
          const ai = await connection.getAccountInfo(ata);
          walletBalances[asset.symbol] = ai ? Number(ai.data.readBigUInt64LE(64)) / 10 ** asset.decimals : 0;
        } catch { walletBalances[asset.symbol] = 0; }
      }
      let usdcBalance = 0;
      try {
        // cUSDC ATA — Token-2022 program required for the right derivation.
        const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const ui = await connection.getAccountInfo(usdcAta);
        // cUSDC = 6 decimals — pinned literal (matches the underlying sUSDC).
        if (ui) usdcBalance = Number(ui.data.readBigUInt64LE(64)) / 1e6;
      } catch {}

      // Pick the borrow reserve from the active obligation's debts. If
      // it has no debt (or no obligation yet), default to sUSDC for the
      // lending obligation and wSOL for the credit-trade obligation —
      // those are the canonical borrow legs of EG-1 and EG-2 respectively
      // and let the page show a sensible "what you'd pay if you borrowed"
      // even before the first borrow.
      // Default to sUSDC for lending obligations; wSOL when the
      // obligation is in EG-2 (LST/SOL — wSOL debt only). Overridden
      // by the per-borrow-row scan below if the obligation already
      // carries debt.
      const obligationEgPreview = info && info.data.length > 2285 ? info.data[2285] : 0;
      // EG-2 → cSOL (post-migration). EG-1 / EG-3 / no EG → sUSDC.
      // Legacy obligations that still hold wSOL debt fall through the
      // borrows[] scan below and override this default to WSOL_RESERVE.
      let activeBorrowReserve: PublicKey = obligationEgPreview === 2 ? CSOL_RESERVE : USDC_RESERVE;
      if (info) {
        // Walk borrows[] (offset 1208, 80-byte stride per slot) and pick
        // the first non-zero entry. This catches the credit-trade
        // obligation's wSOL debt automatically.
        for (let off = 1208; off + 32 <= info.data.length && off < 2208; off += 80) {
          const reserveBytes = info.data.subarray(off, off + 32);
          for (const addr of Object.keys(BORROW_LEGS)) {
            if (reserveBytes.equals(new PublicKey(addr).toBuffer())) {
              activeBorrowReserve = new PublicKey(addr);
              break;
            }
          }
        }
      }
      const activeBorrowMeta = BORROW_LEGS[activeBorrowReserve.toBase58()]
        ?? BORROW_LEGS[USDC_RESERVE.toBase58()];

      // Decode every borrow leg's reserve state in one batch so the
      // Available-to-borrow strip can render all rows (sUSDC + wSOL)
      // side-by-side without a second RPC. Returns null per leg if its
      // reserve account is unavailable.
      const decodeLeg = (
        rd: Buffer | undefined,
        decimals: number,
      ): { available: number; apr: number | null; availableRaw: number; utilBps: number } => {
        if (!rd || rd.length < 5008) return { available: 0, apr: null, availableRaw: 0, utilBps: 0 };
        const availableRaw = Number(rd.readBigUInt64LE(224));
        const sfLo = rd.readBigUInt64LE(232);
        const sfHi = rd.readBigUInt64LE(240);
        const borrowed = Number((sfLo + (sfHi << 64n)) >> 60n);
        const total = availableRaw + borrowed;
        const util = total > 0 ? borrowed / total : 0;
        const utilBpsLocal = Math.round(util * 10000);
        const CURVE_OFF_LOCAL = 4920;
        const pts: { u: number; r: number }[] = [];
        for (let i = 0; i < 11; i++) {
          const u = rd.readUInt32LE(CURVE_OFF_LOCAL + i * 8);
          const r = rd.readUInt32LE(CURVE_OFF_LOCAL + i * 8 + 4);
          pts.push({ u, r });
          if (u >= 10000) break;
        }
        let rateBps = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          if (utilBpsLocal >= pts[i].u && utilBpsLocal <= pts[i + 1].u) {
            const t = pts[i + 1].u === pts[i].u ? 0 : (utilBpsLocal - pts[i].u) / (pts[i + 1].u - pts[i].u);
            rateBps = pts[i].r + t * (pts[i + 1].r - pts[i].r);
            break;
          }
        }
        if (utilBpsLocal >= (pts[pts.length - 1]?.u ?? 10000)) rateBps = pts[pts.length - 1]?.r ?? 0;
        return {
          available: availableRaw / 10 ** decimals,
          apr: rateBps / 10000,
          availableRaw,
          utilBps: utilBpsLocal,
        };
      };

      const legAddrs = Object.keys(BORROW_LEGS).map((s) => new PublicKey(s));
      const legInfos = await connection.getMultipleAccountsInfo(legAddrs);
      const legs: PositionData["legs"] = {};
      legAddrs.forEach((addr, i) => {
        const meta = BORROW_LEGS[addr.toBase58()];
        const decoded = decodeLeg(legInfos[i] ? Buffer.from(legInfos[i]!.data) : undefined, meta.decimals);
        legs[meta.symbol] = { available: decoded.available, apr: decoded.apr };
      });

      // Active leg's headline numbers (drive the existing single-asset
      // Available-to-borrow row when only one leg is rendered).
      const reserveInfo = legInfos[legAddrs.findIndex((a) => a.equals(activeBorrowReserve))];
      let availableLiquidity = 0;
      let borrowAPR: number | null = null;
      if (reserveInfo && reserveInfo.data.length >= 5008) {
        const rd = reserveInfo.data;
        const available = Number(rd.readBigUInt64LE(224));
        const sfLo = rd.readBigUInt64LE(232);
        const sfHi = rd.readBigUInt64LE(240);
        const borrowed = Number((sfLo + (sfHi << 64n)) >> 60n);
        availableLiquidity = available / 10 ** activeBorrowMeta.decimals;
        const total = available + borrowed;
        const util = total > 0 ? borrowed / total : 0;
        const CURVE_OFF = 4920;
        const pts: { u: number; r: number }[] = [];
        for (let i = 0; i < 11; i++) {
          const u = rd.readUInt32LE(CURVE_OFF + i * 8);
          const r = rd.readUInt32LE(CURVE_OFF + i * 8 + 4);
          pts.push({ u, r });
          if (u >= 10000) break;
        }
        const utilBps = Math.round(util * 10000);
        let rateBps = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          if (utilBps >= pts[i].u && utilBps <= pts[i + 1].u) {
            const t = pts[i + 1].u === pts[i].u ? 0 : (utilBps - pts[i].u) / (pts[i + 1].u - pts[i].u);
            rateBps = pts[i].r + t * (pts[i + 1].r - pts[i].r);
            break;
          }
        }
        if (utilBps >= (pts[pts.length - 1]?.u ?? 10000)) rateBps = pts[pts.length - 1]?.r ?? 0;
        borrowAPR = rateBps / 10000;
      }

      if (!info) {
        // Drop the result if (a) the effect was torn down, or (b) the
        // selected obligation changed since this load started — both
        // mean the data we just fetched is stale and would clobber
        // whatever the in-flight newer load produces. `targetObId`
        // captured at top-of-function pins the id this run loaded for.
        if (isCancelled() || targetObId !== selectedObligationId) return;
        setPosition({ address: obPda.toBase58(), deposits: [], borrows: [], elevationGroup: 0, totalCollateralUsd: 0, totalBorrowUsd: 0, healthFactor: null, ltvPct: 95, liqThreshPct: 98, walletBalances, usdcBalance, maxBorrow: 0, availableLiquidity, liquidationPrice: null, borrowAPR, debtSymbol: activeBorrowMeta.symbol, debtBalance: activeBorrowMeta.mint.equals(USDC_MINT) ? usdcBalance : 0, legs });
        setLoading(false);
        return;
      }

      const data = info.data;
      const deposits: Deposit[] = [];
      const borrows: Borrow[] = [];

      for (const [addr, meta] of Object.entries(RESERVE_META)) {
        const buf = new PublicKey(addr).toBuffer();
        const factor = 10 ** meta.decimals;
        for (let i = 64; i < Math.min(data.length - 32, 1200); i++) {
          if (data.subarray(i, i + 32).equals(buf)) {
            const amount = Number(data.readBigUInt64LE(i + 32)) / factor;
            if (amount > 0) deposits.push({ reserve: addr, symbol: meta.symbol, amount, valueUsd: amount * meta.price });
            break;
          }
        }
        for (let i = 1200; i < Math.min(data.length - 32, 2400); i++) {
          if (data.subarray(i, i + 32).equals(buf)) {
            const sfLo = data.readBigUInt64LE(i + 88);
            const sfHi = data.readBigUInt64LE(i + 96);
            const amount = Number((sfLo + (sfHi << 64n)) / (1n << 60n)) / factor;
            if (amount > 0.001) borrows.push({ reserve: addr, symbol: meta.symbol, amount, valueUsd: amount * meta.price });
            break;
          }
        }
      }

      const totalCollateralUsd = deposits.reduce((s, d) => s + d.valueUsd, 0);
      const totalBorrowUsd = borrows.reduce((s, b) => s + b.valueUsd, 0);
      let ltvPct = 95, liqThreshPct = 98;
      if (deposits.length > 0) {
        const ri = await connection.getAccountInfo(new PublicKey(deposits[0].reserve));
        if (ri) { ltvPct = ri.data[4872]; liqThreshPct = ri.data[4873]; }
      }
      const healthFactor = totalBorrowUsd > 0 ? (totalCollateralUsd * (liqThreshPct / 100)) / totalBorrowUsd : null;
      const maxBorrow = Math.max(0, totalCollateralUsd * (ltvPct / 100) - totalBorrowUsd);
      const totalCollateralTokens = deposits.reduce((s, d) => s + d.amount, 0);
      const liquidationPrice = totalBorrowUsd > 0 && totalCollateralTokens > 0
        ? totalBorrowUsd / (totalCollateralTokens * (liqThreshPct / 100))
        : null;

      const elevationGroup = data.length > 2285 ? data[2285] : 0;

      // Wallet balance of the active debt asset — drives the Repay form's
      // wallet-has hint + MAX cap. Reused usdcBalance when the debt is
      // sUSDC; reads the wSOL ATA otherwise. native SOL is intentionally
      // NOT folded in: klend's repay path takes wrapped wSOL, so showing
      // unwrapped SOL here would just mislead the user.
      let debtBalance = 0;
      const debtSymbol = activeBorrowMeta.symbol;
      if (activeBorrowMeta.mint.equals(USDC_MINT)) {
        debtBalance = usdcBalance;
      } else {
        try {
          const debtAta = getAssociatedTokenAddressSync(activeBorrowMeta.mint, publicKey, false, activeBorrowMeta.tokenProgram);
          const di = await connection.getAccountInfo(debtAta);
          if (di) debtBalance = Number(di.data.readBigUInt64LE(64)) / 10 ** activeBorrowMeta.decimals;
        } catch { debtBalance = 0; }
      }

      // Same guard as the !info branch — if the selection changed
      // mid-load OR the effect was torn down, drop the result so we
      // don't overwrite the newer in-flight load's setPosition.
      if (isCancelled() || targetObId !== selectedObligationId) return;
      setPosition({ address: obPda.toBase58(), deposits, borrows, elevationGroup, totalCollateralUsd, totalBorrowUsd, healthFactor, ltvPct, liqThreshPct, walletBalances, usdcBalance, maxBorrow, availableLiquidity, liquidationPrice, borrowAPR, debtSymbol, debtBalance, legs });
    } catch (e) { console.warn("Load failed:", e); }
    if (!isCancelled() && targetObId === selectedObligationId) setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, connection, selectedObligationId]);

  // The effect owns the cancellation token: when it tears down (because
  // selectedObligationId / publicKey / connection changed and a new
  // load is about to start), `cancelled` flips to `true` and the
  // outgoing load's setPosition / setLoading calls are skipped.
  useEffect(() => {
    let cancelled = false;
    loadPosition(() => cancelled);
    return () => { cancelled = true; };
  }, [loadPosition]);

  // --- Action handlers (logic unchanged from previous version) ---

  async function handleDeposit() {
    if (!publicKey || !depositAmt || !depositAsset) return;
    setActionLoading(true);
    const asset = depositAsset;
    setStatus({ msg: `Depositing ${asset.symbol}...`, type: "info" });
    try {
      const amt = BigInt(Math.floor(parseFloat(depositAmt) * 10 ** asset.decimals));

      const userAta = getAssociatedTokenAddressSync(asset.mint, publicKey, false, asset.tokenProgram);
      const ataInfo = await connection.getAccountInfo(userAta);
      if (!ataInfo) throw new Error(`No ${asset.symbol} token account found. Prepare collateral first (Step 2).`);
      const obPda = getObligationPda(publicKey, selectedObligationId);
      const obInfo = await connection.getAccountInfo(obPda);
      const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), asset.reserve.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), asset.reserve.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), asset.reserve.toBuffer()], KLEND);

      const tx = new Transaction();
      if (!obInfo) {
        const umInfo = await connection.getAccountInfo(userMeta);
        if (!umInfo) {
          tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_user_metadata, Buffer.alloc(32)]), keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: userMeta, isSigner: false, isWritable: true },
            { pubkey: KLEND, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]});
        }
        tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_obligation, Buffer.from([0, selectedObligationId])]), keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: PublicKey.default, isSigner: false, isWritable: false },
          { pubkey: PublicKey.default, isSigner: false, isWritable: false },
          { pubkey: userMeta, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]});
      }

      const reserves = obInfo ? findObligationReserves(Buffer.from(obInfo.data)) : [];
      const others = reserves.filter(r => !r.equals(asset.reserve));
      for (const r of [...others, asset.reserve]) {
        const oracle = RESERVE_ORACLES[r.toBase58()];
        if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      // Klend's check_refresh on `deposit_reserve_liquidity_and_obligation_collateral`
      // requires refresh_obligation at current_idx-1 unconditionally —
      // including when init_obligation was emitted earlier in the same
      // tx. Skipping it here trips IncorrectInstructionInPosition (6051 /
      // 0x17a3) on the very first deposit of a brand-new obligation, since
      // refresh_reserve(ceUSX) ends up at current_idx-1 instead. On a
      // freshly-init'd obligation `reserves` is [] and refresh_obligation
      // takes zero remaining_accounts (active_{deposits,borrows}_count = 0),
      // so it's effectively a no-op that just satisfies the discriminator
      // check. Reserves passed as remaining_accounts must be writable —
      // marking read-only trips the same 6051.
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: true })),
      ]});

      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      // The reserve_liquidity_mint slot is writable for Token-2022
      // reserves (klend updates the mint's transfer-fee accounting
      // during the SPL transfer). Legacy SPL-Token mints are not
      // modified, so passing them as writable is harmless. Flagging
      // unconditionally keeps the builder simple and avoids the
      // Token-2022 trap that produced the csSOL-WT deposit revert.
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.deposit_reserve_liquidity_and_obligation_collateral, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: asset.reserve, isSigner: false, isWritable: true }, { pubkey: asset.mint, isSigner: false, isWritable: true },
        { pubkey: liqSupply, isSigner: false, isWritable: true }, { pubkey: collMint, isSigner: false, isWritable: true },
        { pubkey: collSupply, isSigner: false, isWritable: true }, { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: asset.tokenProgram, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});

      // Bundle EG switch into the same tx when the user is supplying
      // into a previewed EG that differs from the obligation's current
      // group. Klend's `request_elevation_group` rejects empty
      // obligations (ObligationDepositsEmpty 6020), so we always run
      // it AFTER the deposit so there's at least one collateral entry
      // to elevate against. Order matters: deposit → refresh_reserve
      // (asset's last_update bumped by deposit) → refresh_obligation
      // (also went stale) → request_elevation_group.
      const wantsEgSwitch =
        selectedEg !== (p?.elevationGroup ?? 0) &&
        // Only bundle when the deposit is into a collateral the target
        // EG accepts; otherwise klend would reject the EG request.
        // EG-0 (drop-out) accepts any deposit.
        (selectedEg === 0 || (getElevationOption(selectedEg)?.collaterals as readonly string[] | undefined)?.includes(asset.symbol));
      if (wantsEgSwitch) {
        const postDepositReserves = reserves.some((r) => r.equals(asset.reserve))
          ? reserves
          : [...reserves, asset.reserve];
        // Post-deposit refresh chain — `request_elevation_group`'s
        // `check_refresh_ixs!` walks backwards from itself and expects:
        //   ix N-1 : refresh_obligation
        //   ix N-K : refresh_reserve for EACH obligation reserve
        // Refreshing only `asset.reserve` here works for first-deposit
        // obligations but trips IncorrectInstructionInPosition (6051)
        // on any obligation that already has prior deposits/borrows —
        // klend can't find their refresh_reserve ixes in the window
        // immediately preceding the EG request. Refresh the FULL
        // post-deposit reserve set unconditionally.
        for (const r of postDepositReserves) {
          const oracle = RESERVE_ORACLES[r.toBase58()];
          if (!oracle) continue;
          tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
            { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
            { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
            { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          ]});
        }
        tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
          { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
          ...postDepositReserves.map(r => ({ pubkey: r, isSigner: false, isWritable: true })),
        ]});
        // request_elevation_group disc + 1-byte EG number.
        tx.add({ programId: KLEND, data: Buffer.concat([DISC.request_elevation_group, Buffer.from([selectedEg & 0xff])]), keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          ...postDepositReserves.map(r => ({ pubkey: r, isSigner: false, isWritable: true })),
        ]});
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      const successMsg = wantsEgSwitch
        ? `Deposited ${depositAmt} ${asset.symbol} + activated EG-${selectedEg}`
        : `Deposited ${depositAmt} ${asset.symbol}`;
      setStatus({ msg: successMsg, type: "success", sig });
      setDepositAmt(""); setDepositAsset(null); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Deposit failed: ${formatTxError(e)}`, type: "error" }); }
    setActionLoading(false);
  }

  async function handleWithdraw() {
    if (!publicKey || !withdrawAmt || !withdrawAsset) return;
    setActionLoading(true);
    const asset = withdrawAsset;
    setStatus({ msg: `Withdrawing ${asset.symbol}...`, type: "info" });
    try {
      // Sentinel: when the user clicks MAX we store "max" in state and
      // pass U64_MAX to klend's `withdrawObligationCollateralAndRedeemReserveCollateral`.
      // klend's on-chain handler treats U64_MAX as "redeem ALL pledged
      // cTokens for this reserve" — sidesteps the cToken-vs-underlying
      // decimals mismatch that otherwise leaves dust (the wSOL reserve's
      // cToken mint is 6-decimal while the underlying is 9-decimal, so a
      // numeric round-trip via `amount × 10^9` always under-redeems by
      // a few hundred raw cTokens). Same convention `handleRepay` uses.
      const isMax = withdrawAmt === "max";
      const amt = isMax
        ? BigInt("18446744073709551615")
        : BigInt(Math.floor(parseFloat(withdrawAmt) * 10 ** asset.decimals));
      const obPda = getObligationPda(publicKey, selectedObligationId);
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) throw new Error("No obligation.");
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), asset.reserve.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), asset.reserve.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), asset.reserve.toBuffer()], KLEND);
      const userAta = getAssociatedTokenAddressSync(asset.mint, publicKey, false, asset.tokenProgram);

      const tx = new Transaction();
      // Ensure the destination ATA exists. Users who supplied via legacy
      // flows or the credit-trade panel may have closed their underlying
      // ATA after deposit (rent reclaim) — for wSOL especially, where
      // most wallets hold native SOL and only briefly held a wrapped ATA.
      // Idempotent create is a no-op if the ATA is already there.
      const userAtaInfo = await connection.getAccountInfo(userAta);
      if (!userAtaInfo) {
        const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
        tx.add(createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userAta, publicKey, asset.mint, asset.tokenProgram,
        ));
      }
      const reserves = findObligationReserves(Buffer.from(obInfo.data));
      const others = reserves.filter(r => !r.equals(asset.reserve));
      for (const r of [...others, asset.reserve]) {
        const oracle = RESERVE_ORACLES[r.toBase58()]; if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});

      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      // klend IDL `withdrawObligationCollateralAndRedeemReserveCollateral`:
      //   owner / obligation / lendingMarket / lendingMarketAuthority /
      //   withdrawReserve / reserveLiquidityMint / reserveSourceCollateral
      //   / reserveCollateralMint / reserveLiquiditySupply /
      //   userDestinationLiquidity / placeholderUserDestinationCollateral
      //   (optional, KLEND placeholder for None) / collateralTokenProgram /
      //   liquidityTokenProgram / instructionSysvarAccount
      // The earlier code-path swapped reserveSourceCollateral (the
      // reserve_coll_supply *vault*) and reserveCollateralMint (the cToken
      // *mint*). Anchor's account-deserialise on the source-collateral slot
      // tries to read it as a token account — feeding the mint there fails
      // with InvalidAccountData (mint = ~82 bytes, token acct = 165). Order
      // now matches the IDL exactly.
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.withdraw_obligation_collateral_and_redeem_reserve_collateral, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false },
        { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: asset.reserve, isSigner: false, isWritable: true },
        { pubkey: asset.mint, isSigner: false, isWritable: false },
        { pubkey: collSupply, isSigner: false, isWritable: true },   // reserveSourceCollateral
        { pubkey: collMint, isSigner: false, isWritable: true },     // reserveCollateralMint
        { pubkey: liqSupply, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false },       // placeholder (optional)
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: asset.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Withdrew ${isMax ? "all" : withdrawAmt} ${asset.symbol}`, type: "success", sig });
      setWithdrawAmt(""); setWithdrawAsset(null); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Withdraw failed: ${formatTxError(e)}`, type: "error" }); }
    setActionLoading(false);
  }

  async function handleBorrow() {
    if (!publicKey || !borrowAmt) return;
    setActionLoading(true);
    setStatus({ msg: "Borrowing USDC...", type: "info" });
    try {
      // USDC = 6 decimals — pinned literal. If a non-USDC borrow asset
      // is added, switch to a per-asset decimals lookup.
      const amt = BigInt(Math.floor(parseFloat(borrowAmt) * 1e6));
      const obPda = getObligationPda(publicKey, selectedObligationId);
      await new Promise(r => setTimeout(r, 1000));
      const obInfo = await connection.getAccountInfo(obPda, "confirmed");
      if (!obInfo) throw new Error("No obligation. Deposit collateral first.");
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [usdcLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), USDC_RESERVE.toBuffer()], KLEND);
      const [usdcFeeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), USDC_RESERVE.toBuffer()], KLEND);
      // cUSDC is a Token-2022 mint (delta-mint KYC wrapper) — the ATA
      // derivation MUST pass TOKEN_2022_PROGRAM_ID or it lands on the
      // wrong address (the legacy-SPL one) and klend's borrow handler
      // fails with InvalidAccountData on the destination.
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const usdcAtaInfo = await connection.getAccountInfo(userUsdcAta);

      const tx = new Transaction();

      if (!usdcAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, userUsdcAta, publicKey, USDC_MINT, TOKEN_2022_PROGRAM_ID));
      }

      const reserves = findObligationReserves(Buffer.from(obInfo.data));
      const allReserves = new Set([...reserves.map(r => r.toBase58()), USDC_RESERVE.toBase58()]);
      const refreshOrder = [...[...allReserves].filter(r => r !== USDC_RESERVE.toBase58()), USDC_RESERVE.toBase58()];
      for (const rAddr of refreshOrder) {
        const oracle = RESERVE_ORACLES[rAddr]; if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: new PublicKey(rAddr), isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: true })),
      ]});
      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      // Anchor accounts (klend IDL `borrowObligationLiquidity`): 12 keys.
      // When the obligation is in an elevation group (>0), klend's
      // `update_elevation_group_debt_trackers_on_borrow` walks the
      // obligation's active deposits and pulls one Reserve account per
      // deposit slot from `remaining_accounts`. Without them the iter
      // returns None on the first deposit and klend throws
      // InvalidAccountInput (6006) at lending_operations.rs (around 2760
      // in the deployed devnet binary; 3298 on master). Same rule the
      // repay path already follows.
      const borrowKeys = [
        { pubkey: publicKey, isSigner: true, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: USDC_RESERVE, isSigner: false, isWritable: true }, { pubkey: USDC_MINT, isSigner: false, isWritable: true },
        { pubkey: usdcLiqSupply, isSigner: false, isWritable: true }, { pubkey: usdcFeeRecv, isSigner: false, isWritable: true },
        { pubkey: userUsdcAta, isSigner: false, isWritable: true }, { pubkey: KLEND, isSigner: false, isWritable: false },
        // cUSDC is Token-2022 — pass the Token-2022 program in the
        // tokenProgram slot. klend uses this for the SPL transfer from
        // the liquidity vault to the user's ATA. Wrong program here →
        // InvalidProgramExecutable; mismatched mint vs. program →
        // ConstraintTokenMint.
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ];
      if ((position?.elevationGroup ?? 0) > 0) {
        const depositReserves = findObligationDepositReserves(Buffer.from(obInfo.data));
        for (const r of depositReserves) {
          borrowKeys.push({ pubkey: r, isSigner: false, isWritable: true });
        }
      }
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.borrow_obligation_liquidity, amtBuf]), keys: borrowKeys });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Borrowed ${borrowAmt} USDC`, type: "success", sig });
      setBorrowAmt(""); setShowBorrow(false); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Borrow failed: ${formatTxError(e)}`, type: "error" }); }
    setActionLoading(false);
  }

  async function handleRepay() {
    if (!publicKey || !repayAmt) return;
    setActionLoading(true);
    // Pick the borrow leg from the obligation's first non-zero debt.
    // Falls back to USDC for the lending obligation and wSOL for the
    // credit-trade obligation (their canonical EG-1 / EG-2 debt assets)
    // so the repay button still does something sensible if `position`
    // hasn't loaded yet.
    const debtRow = position?.borrows?.[0];
    const debtReserve = debtRow ? new PublicKey(debtRow.reserve)
      : (position?.elevationGroup === 2 ? CSOL_RESERVE : USDC_RESERVE);
    const debtMeta = BORROW_LEGS[debtReserve.toBase58()]
      ?? BORROW_LEGS[USDC_RESERVE.toBase58()];
    setStatus({ msg: `Repaying ${debtMeta.symbol}...`, type: "info" });
    try {
      const isMax = repayAmt === "max";
      const scale = 10 ** debtMeta.decimals;
      const amt = isMax ? BigInt("18446744073709551615") : BigInt(Math.floor(parseFloat(repayAmt) * scale));
      const obPda = getObligationPda(publicKey, selectedObligationId);
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) throw new Error("No obligation.");
      const [debtLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), debtReserve.toBuffer()], KLEND);
      const userDebtAta = getAssociatedTokenAddressSync(debtMeta.mint, publicKey, false, debtMeta.tokenProgram);

      const tx = new Transaction();

      // wSOL repays must be funded from a wrapped-SOL token account. If
      // the user's wSOL ATA is missing or short, top it up from native
      // SOL (System.transfer → sync_native) before the repay ix runs.
      // For an exact "max" we wrap (debt × 1.005) — klend only debits
      // the actual debt, so the leftover gets unwrapped by the trailing
      // close ix. Without this users hit SPL Token error 0x1
      // (InsufficientFunds) on the source ATA during repay.
      let wsolAtaCreatedThisTx = false;
      if (debtMeta.mint.equals(NATIVE_MINT)) {
        const debtUi = position?.borrows?.find(b => b.reserve === debtReserve.toBase58())?.amount ?? 0;
        const debtLamports = BigInt(Math.ceil(debtUi * 1.005 * scale));
        const targetLamports = isMax ? debtLamports : amt;

        const ataInfo = await connection.getAccountInfo(userDebtAta);
        let currentLamports = 0n;
        if (ataInfo) {
          currentLamports = ataInfo.data.readBigUInt64LE(64);
        } else {
          tx.add(createAssociatedTokenAccountInstruction(publicKey, userDebtAta, publicKey, debtMeta.mint, debtMeta.tokenProgram));
          wsolAtaCreatedThisTx = true;
        }
        if (targetLamports > currentLamports) {
          const transferLamports = targetLamports - currentLamports;
          tx.add(SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: userDebtAta,
            lamports: Number(transferLamports),
          }));
          tx.add(createSyncNativeInstruction(userDebtAta, debtMeta.tokenProgram));
        }
      }

      const reserves = findObligationReserves(Buffer.from(obInfo.data));
      const others = reserves.filter(r => !r.equals(debtReserve));
      for (const r of [...others, debtReserve]) {
        const oracle = RESERVE_ORACLES[r.toBase58()]; if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});
      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      // Anchor accounts (klend IDL `repayObligationLiquidity`): 9 keys —
      //   owner / obligation / lendingMarket / repayReserve / reserveLiquidityMint
      //   / reserveDestinationLiquidity / userSourceLiquidity / tokenProgram
      //   / instructionSysvarAccount
      // When the obligation is in an elevation group (>0), klend also
      // expects the obligation's deposit reserves appended as WRITABLE
      // remaining_accounts — without them lending_operations.rs:2835
      // throws InvalidAccountInput (6006). This was the wSOL/EG-2 repay
      // failure mode.
      const repayKeys = [
        { pubkey: publicKey, isSigner: true, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: debtReserve, isSigner: false, isWritable: true },
        { pubkey: debtMeta.mint, isSigner: false, isWritable: false }, { pubkey: debtLiqSupply, isSigner: false, isWritable: true },
        { pubkey: userDebtAta, isSigner: false, isWritable: true },
        { pubkey: debtMeta.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ];
      if ((position?.elevationGroup ?? 0) > 0) {
        const depositReserves = findObligationDepositReserves(Buffer.from(obInfo.data));
        for (const r of depositReserves) {
          repayKeys.push({ pubkey: r, isSigner: false, isWritable: true });
        }
      }
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.repay_obligation_liquidity, amtBuf]), keys: repayKeys });

      // If we created the wSOL ATA in this same tx (i.e. the user had
      // no prior wrapped-SOL position), close it after repay so any
      // leftover from the (debt × 1.005) buffer plus the ATA rent flow
      // back to native SOL. We deliberately don't close pre-existing
      // wSOL ATAs — the user may be holding wrapped SOL on purpose.
      if (wsolAtaCreatedThisTx) {
        tx.add(createCloseAccountInstruction(userDebtAta, publicKey, publicKey, [], debtMeta.tokenProgram));
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Repaid ${isMax ? "all" : repayAmt} ${debtMeta.symbol}`, type: "success", sig });
      setRepayAmt(""); setShowRepay(false); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Repay failed: ${formatTxError(e)}`, type: "error" }); }
    setActionLoading(false);
  }

  // ── ceUSX redemption — Stage 1: convert ceUSX collateral → ceUSX-WT ──
  // Atomic via flash-loan: borrow WT → deposit WT → withdraw ceUSX →
  // unwrap → Solstice.Unlock (queues per-user pending PDA) → flash-repay.
  // Leaves the obligation healthy and queues the off-chain unlock timer.
  async function handleConvertCeusx() {
    if (!publicKey) return;
    if (!solsticeApiKey) {
      setStatus({ msg: "Solstice API key missing — set VITE_SOLSTICE_API_KEY in .env to enable redemptions.", type: "error" });
      return;
    }
    const amtFloat = parseFloat(redeemAmt);
    if (!amtFloat || amtFloat <= 0) return;
    setActionLoading(true);
    setStatus({ msg: "Building convert tx (flash-loan ceUSX → ceUSX-WT)...", type: "info" });
    try {
      const obPda = getObligationPda(publicKey, selectedObligationId);
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) throw new Error("No obligation — deposit ceUSX first.");
      const obDeposits = findObligationReserves(Buffer.from(obInfo.data));

      const ixes = await buildConvertCeusxIxes({
        user: publicKey,
        // ceUSX = 6 decimals — pinned literal.
        amount: BigInt(Math.floor(amtFloat * 1e6)),
        apiKey: solsticeApiKey,
        obligationDeposits: obDeposits,
      });

      const tx = new Transaction();
      for (const ix of ixes) tx.add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = publicKey;

      setStatus({ msg: "Sign convert transaction in your wallet...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: `Converted ${amtFloat.toFixed(2)} ceUSX → ceUSX-WT — wait for the Solstice unlock window, then complete the redemption.`, type: "success", sig });
      setRedeemAmt("");
      setShowRedeem(false);
      await loadPosition();
    } catch (e: any) {
      setStatus({ msg: `Convert failed: ${formatTxError(e)}`, type: "error" });
    }
    setActionLoading(false);
  }

  // ── ceUSX redemption — Stage 3: unwind ceUSX-WT → USDC ──
  // Atomic via flash-loan: borrow sUSDC → repay obligation USDC debt →
  // withdraw WT → governor.redeem_ceusx_wt (CPIs Solstice.Withdraw to
  // mint USX) → Solstice RequestRedeem + ConfirmRedeem (USX → USDC) →
  // flash-repay sUSDC. Will fail if the pending-unlock PDA hasn't
  // matured yet — the user can simply retry once it has.
  async function handleUnwindCeusxWt(amountTokens: number) {
    if (!publicKey) return;
    if (!solsticeApiKey) {
      setStatus({ msg: "Solstice API key missing — set VITE_SOLSTICE_API_KEY in .env to enable redemptions.", type: "error" });
      return;
    }
    if (amountTokens <= 0) return;
    setActionLoading(true);
    setStatus({ msg: "Building unwind tx (ceUSX-WT → USDC)...", type: "info" });
    try {
      const obPda = getObligationPda(publicKey, selectedObligationId);
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) throw new Error("No obligation found.");
      const obDeposits = findObligationReserves(Buffer.from(obInfo.data));

      const ixes = await buildUnwindCeusxWtIxes({
        user: publicKey,
        // ceUSX-WT = 6 decimals (matches ceUSX) — pinned literal.
        amount: BigInt(Math.floor(amountTokens * 1e6)),
        apiKey: solsticeApiKey,
        obligationDeposits: obDeposits,
      });

      const tx = new Transaction();
      for (const ix of ixes) tx.add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = publicKey;

      setStatus({ msg: "Sign unwind transaction in your wallet...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: `Redeemed ${amountTokens.toFixed(2)} ceUSX-WT → USDC`, type: "success", sig });
      await loadPosition();
    } catch (e: any) {
      const msg = formatTxError(e);
      // Heuristic: Solstice's pending-unlock PDA failure is the
      // most-likely cause of a runtime revert here. Surface a friendly
      // hint alongside the raw error so the user knows to retry later.
      const hint = msg.match(/PendingUnlock|not.*matured|UnlockNotReady/i)
        ? " (the Solstice unlock window may not have matured yet — try again later)"
        : "";
      setStatus({ msg: `Unwind failed${hint}: ${msg}`, type: "error" });
    }
    setActionLoading(false);
  }

  // Only show the full-page spinner on the first load (when there's
  // nothing to display yet). Subsequent refreshes — post-tx reloads,
  // obligation switches — keep the previous data on screen so the page
  // doesn't blank-out and re-mount on every action.
  if (loading && !position) {
    return (
      <div className="flex justify-center py-20">
        <span
          className="inline-block h-8 w-8 rounded-full border-2 border-primary border-r-transparent"
          style={{ animation: "cs-spin 700ms linear infinite" }}
        />
      </div>
    );
  }

  const p = position;
  const hfTone: "success" | "warning" | "error" | "neutral" =
    !p?.healthFactor ? "neutral" :
    p.healthFactor > 1.5 ? "success" :
    p.healthFactor > 1.1 ? "warning" : "error";

  return (
    <div className="space-y-8 pb-12">
      <PageHeader
        eyebrow="Lending"
        title="Positions"
        subtitle={(() => {
          const activeEntry = obligationCatalog.find((e) => e.id === selectedObligationId);
          const label = activeEntry?.label;
          return `Live view of your collateral, borrows, obligation health, and elevation group. (Obligation #${selectedObligationId}${label ? ` — ${label}` : ""}.)`;
        })()}
        actions={
          p && (
            p.elevationGroup > 0
              ? <Badge tone="primary" variant="solid" size="md">EG-{p.elevationGroup} active</Badge>
              : <Badge tone="neutral" variant="soft" size="md">no EG</Badge>
          )
        }
      />

      {/* Obligation switcher — flat numbered list of every obligation
          this wallet holds on the v3 market, plus a `+ New` affordance
          for opening a fresh slot. Full-width self-labelled component:
          the "Positions" eyebrow lives inside the switcher's chrome
          alongside the pills, the EG info `(i)` is rendered inside the
          active pill via `trailingSlot`, and overflow obligations
          collapse into a `+N more` dropdown so the row never grows past
          the page width. */}
      <ObligationSwitcher
        className="w-full"
        value={selectedObligationId}
        onChange={setSelectedObligationId}
        catalog={obligationCatalog}
        onCreate={() => setSelectedObligationId(nextUnusedId(obligationCatalog))}
        trailingSlot={(entry) =>
          entry.id === selectedObligationId &&
          position &&
          position.elevationGroup > 0 ? (
            <ObligationInfoButton elevationGroup={position.elevationGroup} />
          ) : null
        }
      />
      {position && !position.deposits.length && !position.borrows.length && (
        <Snackbar
          variant="inline"
          type="info"
          message={`Obligation #${selectedObligationId} is empty.`}
          detail="Supply collateral below — the deposit transaction will initialise this obligation on-chain. EG and debt asset are picked when you opt into an elevation group or take your first borrow."
        />
      )}

      {/* Summary KPIs — Stat hero tiles. Health factor / liq price keep
          their semantic colour signals because that's actual accounting
          (asset=green, debt-watch=amber, liquidation=red). */}
      {p && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat
            size="sm"
            label="Collateral"
            value={`$${p.totalCollateralUsd.toFixed(2)}`}
            accent="primary"
          />
          <Stat
            size="sm"
            label="Borrows"
            value={`$${p.totalBorrowUsd.toFixed(2)}`}
            accent="info"
          />
          <Stat
            size="sm"
            label="Available to borrow"
            value={`$${Math.min(p.maxBorrow, p.availableLiquidity).toFixed(2)}`}
            accent="accent"
          />
          <Stat
            size="sm"
            label="Health factor"
            value={
              <span className={
                hfTone === "success" ? "text-success" :
                hfTone === "warning" ? "text-warning" :
                hfTone === "error" ? "text-error" : "text-base-content/40"
              }>
                {p.healthFactor ? p.healthFactor.toFixed(2) : "—"}
              </span>
            }
          />
          <Stat
            size="sm"
            label="Liquidation price"
            value={
              <span className="text-error">
                {p.liquidationPrice ? `$${p.liquidationPrice.toFixed(4)}` : "—"}
              </span>
            }
          />
        </div>
      )}

      {/* Elevation group selector */}
      {p && (
        <Card tone="elevated" size="lg">
          <ElevationGroupPicker
            currentGroup={p.elevationGroup}
            selectedGroup={selectedEg}
            onSelect={setSelectedEg}
            onSwitched={() => loadPosition()}
            obligationId={selectedObligationId}
            hasDeposits={p.deposits.length > 0}
          />
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Collateral */}
        <Card tone="elevated" size="lg">
          <CardHeader
            title="Collateral"
            eyebrow={
              p && selectedEg !== p.elevationGroup
                ? `Supply side · previewing EG-${selectedEg}`
                : "Supply side"
            }
          />

          {(() => {
            const eg = getElevationOption(selectedEg);
            const allowed = new Set<string>(eg?.collaterals ?? []);
            const candidates = COLLATERAL_ASSETS.filter((a) => {
              if (allowed.has(a.symbol)) return true;
              const dep = p?.deposits.find(d => d.symbol === a.symbol);
              if (dep && dep.amount > 0) return true;
              return false;
            });
            const positionRows = candidates.filter((a) => {
              const dep = p?.deposits.find(d => d.symbol === a.symbol);
              return !!dep && dep.amount > 0;
            });
            const availableRows = candidates.filter((a) => {
              const dep = p?.deposits.find(d => d.symbol === a.symbol);
              return !dep || dep.amount === 0;
            });

            if (candidates.length === 0) {
              return (
                <div className="px-2 py-6 text-center text-base-content/45 text-xs">
                  No assets in {eg?.name ?? `EG-${selectedEg}`} are wired up in this UI yet.
                </div>
              );
            }

            const renderRow = (asset: CollateralAsset, muted: boolean) => {
              const dep = p?.deposits.find(d => d.symbol === asset.symbol);
              const walBal = p?.walletBalances[asset.symbol] || 0;
              return (
                <CollateralRowCard
                  key={asset.symbol}
                  asset={asset}
                  dep={dep}
                  walBal={walBal}
                  muted={muted}
                  onWithdraw={() => { setWithdrawAsset(asset); setWithdrawAmt(""); setDepositAsset(null); }}
                  onSupply={() => { setDepositAsset(asset); setDepositAmt(""); setWithdrawAsset(null); }}
                />
              );
            };

            return (
              <div className="space-y-2">
                <BlockHeader label="Positions" count={positionRows.length} />
                {positionRows.length === 0
                  ? <EmptyBlock text="No active collateral positions." />
                  : <div className="space-y-1.5">{positionRows.map((a) => renderRow(a, false))}</div>}

                {availableRows.length > 0 && <BlockSeparator />}

                <BlockHeader label="Available" count={availableRows.length} subtle />
                {availableRows.length === 0
                  ? <EmptyBlock text={`All supported assets in ${eg?.name ?? `EG-${selectedEg}`} are already supplied.`} />
                  : <div className="space-y-1.5">{availableRows.map((a) => renderRow(a, true))}</div>}
              </div>
            );
          })()}

          {/* Deposit form */}
          {depositAsset && (
            <Card tone="muted" size="md" className="mt-4">
              <SectionHeader
                title={`Supply ${depositAsset.symbol}`}
                subtitle={`Wallet balance: ${(p?.walletBalances[depositAsset.symbol] || 0).toFixed(Math.min(4, depositAsset.decimals))} ${depositAsset.symbol}`}
                actions={
                  <Button variant="ghost" size="sm" onClick={() => setDepositAsset(null)}>
                    Cancel
                  </Button>
                }
              />
              <div className="space-y-3">
                <TokenAmountInput
                  symbol={depositAsset.symbol as TokenSymbol}
                  value={depositAmt}
                  onChange={setDepositAmt}
                  balance={p?.walletBalances[depositAsset.symbol] || 0}
                  balanceDecimals={Math.min(4, depositAsset.decimals)}
                  onMax={() => p && setDepositAmt((p.walletBalances[depositAsset.symbol] || 0).toFixed(Math.min(4, depositAsset.decimals)))}
                />
                {depositAmt && parseFloat(depositAmt) > 0 && p && (
                  <Card tone="flat" size="sm">
                    <KeyValue compact label="New collateral value" value={`$${(p.totalCollateralUsd + parseFloat(depositAmt) * depositAsset.price).toFixed(2)}`} />
                    <KeyValue compact label="New max borrow" value={`$${((p.totalCollateralUsd + parseFloat(depositAmt) * depositAsset.price) * (p.ltvPct / 100) - p.totalBorrowUsd).toFixed(2)}`} />
                    {p.totalBorrowUsd > 0 && (
                      <KeyValue
                        compact
                        label="New health factor"
                        value={
                          <span className="text-success">
                            {((p.totalCollateralUsd + parseFloat(depositAmt) * depositAsset.price) * (p.liqThreshPct / 100) / p.totalBorrowUsd).toFixed(2)}
                          </span>
                        }
                      />
                    )}
                  </Card>
                )}
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={actionLoading}
                  disabled={!depositAmt || parseFloat(depositAmt) <= 0}
                  onClick={handleDeposit}
                >
                  Deposit {depositAsset.symbol}
                </Button>
              </div>
            </Card>
          )}

          {/* Withdraw form */}
          {withdrawAsset && p && (() => {
            const dep = p.deposits.find(d => d.symbol === withdrawAsset.symbol);
            const maxWithdraw = dep ? dep.amount : 0;
            // `withdrawAmt === "max"` is a sentinel used by the MAX
            // button — handleWithdraw turns it into klend's U64_MAX
            // which redeems all pledged cTokens regardless of the
            // float-roundable display value. For the live preview math
            // we substitute the underlying max so the "new collateral"
            // / health-factor numbers reflect the actual outcome.
            const isMax = withdrawAmt === "max";
            const inputForMath = isMax ? maxWithdraw : (withdrawAmt ? parseFloat(withdrawAmt) : 0);
            const newCollUsd = isMax || withdrawAmt
              ? Math.max(0, p.totalCollateralUsd - inputForMath * withdrawAsset.price)
              : p.totalCollateralUsd;
            const newHF = p.totalBorrowUsd > 0 ? newCollUsd * (p.liqThreshPct / 100) / p.totalBorrowUsd : null;
            const newMaxBorrow = Math.max(0, newCollUsd * (p.ltvPct / 100) - p.totalBorrowUsd);
            const wouldLiquidate = newHF !== null && newHF < 1.0;
            return (
              <Card tone="muted" size="md" className="mt-4">
                <SectionHeader
                  title={`Withdraw ${withdrawAsset.symbol}`}
                  subtitle={`Deposited: ${maxWithdraw.toFixed(Math.min(4, withdrawAsset.decimals))} ${withdrawAsset.symbol}`}
                  actions={
                    <Button variant="ghost" size="sm" onClick={() => setWithdrawAsset(null)}>
                      Cancel
                    </Button>
                  }
                />
                <div className="space-y-3">
                  <TokenAmountInput
                    symbol={withdrawAsset.symbol as TokenSymbol}
                    value={isMax ? maxWithdraw.toFixed(Math.min(4, withdrawAsset.decimals)) : withdrawAmt}
                    onChange={(v) => setWithdrawAmt(v)}
                    balance={maxWithdraw}
                    balanceDecimals={Math.min(4, withdrawAsset.decimals)}
                    // MAX stores the "max" sentinel — handleWithdraw turns
                    // it into klend's U64_MAX so the redeem clears all
                    // pledged cTokens with no float dust left behind. The
                    // displayed string is the user-friendly cap.
                    onMax={() => setWithdrawAmt("max")}
                    invalid={wouldLiquidate}
                    errorText={wouldLiquidate ? "Would push health factor below 1.0 — would liquidate." : undefined}
                  />
                  {isMax && (
                    <div className="text-[11px] text-base-content/55 -mt-1">
                      Full-balance withdraw — closes the {withdrawAsset.symbol} position completely.
                    </div>
                  )}
                  {(isMax || (withdrawAmt && parseFloat(withdrawAmt) > 0)) && (
                    <Card tone="flat" size="sm">
                      <KeyValue compact label="New collateral" value={`$${newCollUsd.toFixed(2)}`} />
                      {p.totalBorrowUsd > 0 && (
                        <KeyValue
                          compact
                          label="New health factor"
                          value={
                            <span className={!newHF ? "" : newHF > 1.5 ? "text-success" : newHF > 1.1 ? "text-warning" : "text-error"}>
                              {newHF ? newHF.toFixed(2) : "∞"}
                            </span>
                          }
                        />
                      )}
                      <KeyValue compact label="Remaining borrow capacity" value={`$${newMaxBorrow.toFixed(2)}`} />
                    </Card>
                  )}
                  <Button
                    variant="destructive"
                    size="lg"
                    fullWidth
                    loading={actionLoading}
                    disabled={!withdrawAmt || (!isMax && (parseFloat(withdrawAmt) <= 0 || parseFloat(withdrawAmt) > maxWithdraw + 1e-9)) || wouldLiquidate}
                    onClick={handleWithdraw}
                  >
                    Withdraw {withdrawAsset.symbol}
                  </Button>
                </div>
              </Card>
            );
          })()}
        </Card>

        {/* Borrows */}
        <Card tone="elevated" size="lg">
          <CardHeader
            title="Borrows"
            eyebrow="Debt side"
            actions={
              <div className="flex gap-2">
                {p && p.totalBorrowUsd > 0 && (
                  <Button
                    variant={showRepay ? "ghost" : "secondary"}
                    size="sm"
                    onClick={() => { setShowRepay(!showRepay); setShowBorrow(false); }}
                  >
                    {showRepay ? "Cancel" : "Repay"}
                  </Button>
                )}
                {/* Borrow is hidden on EG-2 obligations: that group
                    locks the debt to wSOL and the in-page borrow flow
                    is USDC-only. Opening new wSOL credit lives in the
                    dedicated Credit Trade panel. */}
                {p?.elevationGroup !== 2 && (
                  <Button
                    variant={showBorrow ? "ghost" : "primary"}
                    size="sm"
                    onClick={() => { setShowBorrow(!showBorrow); setShowRepay(false); }}
                  >
                    {showBorrow ? "Cancel" : "+ Borrow"}
                  </Button>
                )}
              </div>
            }
          />

          {(() => {
            const positionRows = p?.borrows ?? [];
            const borrowedSymbols = new Set(positionRows.map((b) => b.symbol));
            // Available rows surface every borrow leg the market exposes
            // (cUSDC + cSOL today). Each leg is hidden if it's already
            // borrowed by the active obligation (so the row doesn't
            // duplicate the position card above) or if the leg's pool
            // is empty. Visibility no longer keys off elevationGroup;
            // EG-2 obligations now see cSOL as the only borrowable
            // asset, EG-1 / EG-3 obligations see cUSDC. Treat any
            // straggler sUSDC debt as "already borrowed" so it doesn't
            // double-render in the Available strip.
            const usdcAvail = !borrowedSymbols.has("cUSDC") && !borrowedSymbols.has("sUSDC") && (p?.legs?.["cUSDC"]?.available ?? 0) > 0;
            // cSOL is the active EG-2 debt asset post-migration; wSOL
            // is retired (limits zeroed on-chain) so no wSOL row is
            // surfaced as borrowable. Legacy wSOL debt still shows up
            // in the Positions block above via `position.borrows[]`.
            const csolAvail = !borrowedSymbols.has("cSOL")  && (p?.legs?.["cSOL"]?.available  ?? 0) > 0;
            const availableCount = (usdcAvail ? 1 : 0) + (csolAvail ? 1 : 0);

            return (
              <div className="space-y-2">
                <BlockHeader label="Positions" count={positionRows.length} />
                {positionRows.length === 0
                  ? <EmptyBlock text="No outstanding debt." />
                  : <div className="space-y-1.5">
                      {positionRows.map((b) => (
                        <BorrowRowCard
                          key={b.reserve}
                          borrow={b}
                          pool={p?.legs?.[b.symbol]?.available ?? null}
                        />
                      ))}
                    </div>}

                {availableCount > 0 && <BlockSeparator />}

                <BlockHeader label="Available to borrow" count={availableCount} subtle />
                {availableCount === 0
                  ? <EmptyBlock text="No additional debt assets available right now." />
                  : (
                    <div className="space-y-1.5">
                      {usdcAvail && (
                        <BorrowAvailableRowCard
                          symbol="USDC"
                          apr={p?.legs?.["cUSDC"]?.apr ?? null}
                          pool={p?.legs?.["cUSDC"]?.available ?? 0}
                        />
                      )}
                      {csolAvail && (
                        <BorrowAvailableRowCard
                          symbol="cSOL"
                          apr={p?.legs?.["cSOL"]?.apr ?? null}
                          pool={p?.legs?.["cSOL"]?.available ?? 0}
                        />
                      )}
                    </div>
                  )}
              </div>
            );
          })()}

          {showBorrow && p && (() => {
            const newBorrow = borrowAmt ? p.totalBorrowUsd + parseFloat(borrowAmt) : p.totalBorrowUsd;
            const newHF = p.totalCollateralUsd * (p.liqThreshPct / 100) / Math.max(newBorrow, 1e-9);
            const totalTokens = p.deposits.reduce((s, d) => s + d.amount, 0);
            const newLiqPrice = totalTokens > 0 ? newBorrow / (totalTokens * (p.liqThreshPct / 100)) : 0;
            const exceeds = borrowAmt ? parseFloat(borrowAmt) > Math.min(p.maxBorrow, p.availableLiquidity) : false;
            return (
              <Card tone="muted" size="md" className="mt-4">
                <SectionHeader
                  title="Borrow USDC"
                  subtitle={`Pool ${p.availableLiquidity.toFixed(2)} · capacity ${p.maxBorrow.toFixed(2)}${p.borrowAPR !== null ? ` · ${(p.borrowAPR * 100).toFixed(2)}% APR` : ""}`}
                  actions={<Button variant="ghost" size="sm" onClick={() => setShowBorrow(false)}>Cancel</Button>}
                />
                <div className="space-y-3">
                  <TokenAmountInput
                    symbol="USDC"
                    value={borrowAmt}
                    onChange={setBorrowAmt}
                    balance={Math.min(p.maxBorrow, p.availableLiquidity)}
                    balanceUnit="USDC available"
                    balanceDecimals={2}
                    onMax={() => setBorrowAmt(((Math.floor(Math.min(p.maxBorrow, p.availableLiquidity) * 100)) / 100).toString())}
                    invalid={exceeds}
                    errorText={exceeds ? "Exceeds borrow capacity or available pool liquidity." : undefined}
                  />
                  {borrowAmt && parseFloat(borrowAmt) > 0 && (
                    <Card tone="flat" size="sm">
                      <KeyValue compact label="New total debt" value={`$${newBorrow.toFixed(2)}`} />
                      <KeyValue
                        compact
                        label="New health factor"
                        value={
                          <span className={newHF > 1.5 ? "text-success" : newHF > 1.1 ? "text-warning" : "text-error"}>
                            {newHF.toFixed(2)}
                          </span>
                        }
                      />
                      <KeyValue compact label="New liq. price" value={<span className="text-error">${newLiqPrice.toFixed(4)}</span>} />
                    </Card>
                  )}
                  <Button
                    variant="primary"
                    size="lg"
                    fullWidth
                    loading={actionLoading}
                    disabled={!borrowAmt || parseFloat(borrowAmt) <= 0 || exceeds}
                    onClick={handleBorrow}
                  >
                    Borrow USDC
                  </Button>
                </div>
              </Card>
            );
          })()}

          {showRepay && p && (() => {
            // Debt row drives ALL labels here — for the credit-trade
            // obligation that's wSOL, for lending it's sUSDC. We display
            // and accept the input in *token* units (matches the
            // TokenAmountInput's "wSOL owed" hint), then convert back to
            // USD only for the remaining-debt summary card.
            const debtRow = p.borrows[0];
            const debtSym = debtRow?.symbol ?? p.debtSymbol;
            const debtAmount = debtRow?.amount ?? 0;
            const debtPriceUsd = debtRow ? debtRow.valueUsd / Math.max(debtRow.amount, 1e-9) : 1;
            const inputAmt = repayAmt && repayAmt !== "max" ? parseFloat(repayAmt) : 0;
            const remainingTokens = repayAmt === "max" ? 0 : Math.max(0, debtAmount - inputAmt);
            const remainingUsd = remainingTokens * debtPriceUsd;
            const newHF = remainingUsd > 0 ? p.totalCollateralUsd * (p.liqThreshPct / 100) / remainingUsd : null;
            // SOL-family debts need 4 fractional digits to surface
            // sub-$1 wSOL amounts — sUSDC stays at 2 since it's pegged.
            const decimals = debtSym === "wSOL" ? 4 : 2;
            return (
              <Card tone="muted" size="md" className="mt-4">
                <SectionHeader
                  title={`Repay ${debtSym}`}
                  subtitle={`Wallet ${p.debtBalance.toFixed(decimals)} ${debtSym} · debt ${debtAmount.toFixed(decimals)} ${debtSym} ($${(debtAmount * debtPriceUsd).toFixed(2)})`}
                  actions={<Button variant="ghost" size="sm" onClick={() => setShowRepay(false)}>Cancel</Button>}
                />
                <div className="space-y-3">
                  <TokenAmountInput
                    symbol={(debtSym === "wSOL" ? "SOL" : "USDC") as TokenSymbol}
                    value={repayAmt === "max" ? debtAmount.toFixed(decimals) : repayAmt}
                    onChange={(v) => setRepayAmt(v)}
                    balance={debtAmount}
                    balanceUnit={`${debtSym} owed`}
                    balanceDecimals={decimals}
                    onMax={() => setRepayAmt("max")}
                  />
                  {repayAmt === "max" && (
                    <div className="text-[11px] text-base-content/55 -mt-1">
                      All-debt repay — health factor → ∞
                    </div>
                  )}
                  {repayAmt && repayAmt !== "max" && parseFloat(repayAmt) > 0 && (
                    <Card tone="flat" size="sm">
                      <KeyValue compact label="Remaining debt" value={`${remainingTokens.toFixed(decimals)} ${debtSym} ($${remainingUsd.toFixed(2)})`} />
                      <KeyValue
                        compact
                        label="New health factor"
                        value={<span className="text-success">{newHF ? newHF.toFixed(2) : "∞ (no debt)"}</span>}
                      />
                    </Card>
                  )}
                  {repayAmt === "max" && (
                    <Card tone="flat" size="sm">
                      <p className="text-xs text-base-content/65">Repaying full debt — health factor → ∞.</p>
                    </Card>
                  )}
                  <Button
                    variant="primary"
                    size="lg"
                    fullWidth
                    loading={actionLoading}
                    disabled={!repayAmt || (repayAmt !== "max" && parseFloat(repayAmt) > p.debtBalance)}
                    onClick={handleRepay}
                  >
                    {repayAmt === "max" ? `Repay All ${debtSym}` : `Repay ${debtSym}`}
                  </Button>
                  {repayAmt && repayAmt !== "max" && parseFloat(repayAmt) > p.debtBalance && (
                    <p className="text-xs text-error">
                      Exceeds wallet balance ({p.debtBalance.toFixed(decimals)} {debtSym}).{debtSym === "wSOL" ? " Wrap SOL → wSOL first." : ""}
                    </p>
                  )}
                </div>
              </Card>
            );
          })()}
        </Card>
      </div>

      {/* ── Redeem ceUSX → USDC ────────────────────────────────────────────
          Surfaces the leveraged ceUSX redemption flow when the user holds
          either ceUSX (Stage 1: convert to redemption ticket) or
          ceUSX-WT (Stage 3: complete redemption to USDC). Hidden when
          neither is present, since there's nothing to redeem. */}
      {p && (() => {
        const ceusxDep = p.deposits.find(d => d.symbol === "ceUSX");
        const ceusxWtDep = p.deposits.find(d => d.symbol === "ceUSX-WT");
        const hasCeusx = (ceusxDep?.amount ?? 0) > 0;
        const hasCeusxWt = (ceusxWtDep?.amount ?? 0) > 0;
        if (!hasCeusx && !hasCeusxWt) return null;
        const maxRedeem = ceusxDep?.amount ?? 0;
        const redeemNum = parseFloat(redeemAmt) || 0;
        const exceedsCeusx = redeemNum > maxRedeem;
        return (
          <Card tone="elevated" size="lg">
            <CardHeader
              title="Redeem ceUSX → USDC"
              eyebrow="Solstice unwind"
              actions={
                hasCeusx && (
                  <Button
                    variant={showRedeem ? "ghost" : "secondary"}
                    size="sm"
                    onClick={() => setShowRedeem(!showRedeem)}
                  >
                    {showRedeem ? "Cancel" : "Start redemption"}
                  </Button>
                )
              }
            />

            {!solsticeApiKey && (
              <Card tone="muted" size="sm" className="mb-3">
                <p className="text-xs text-base-content/65 leading-relaxed">
                  <span className="font-semibold text-base-content">Solstice API key missing.</span>{" "}
                  Set <code className="font-mono text-[11px]">VITE_SOLSTICE_API_KEY</code> in
                  your <code className="font-mono text-[11px]">.env</code> to enable redemptions
                  — the API derives the per-user PDAs that the
                  Solstice <code className="font-mono text-[11px]">Unlock</code>/
                  <code className="font-mono text-[11px]">Withdraw</code> ixes need.
                </p>
              </Card>
            )}

            <p className="text-xs text-base-content/65 leading-relaxed mb-3">
              ceUSX redemption is a two-stage flow: an atomic{" "}
              <span className="font-semibold text-base-content">convert</span> swaps your ceUSX
              collateral for ceUSX-WT (a placeholder representing your queued
              Solstice unlock) and then, once the unlock window matures,
              an atomic <span className="font-semibold text-base-content">unwind</span>
              {" "}flash-repays your USDC debt and converts the WT back to USDC.
              Both stages use a klend flash-loan so the obligation never
              becomes unhealthy mid-flow.
            </p>

            <div className="space-y-3">
              {hasCeusx && (
                <Card tone="muted" size="md">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-base-content/60 leading-none">
                        Stage 1
                      </div>
                      <div className="font-display text-sm font-medium tracking-[-0.01em] mt-1">
                        Convert {ceusxDep?.amount.toFixed(2)} ceUSX → redemption ticket
                      </div>
                    </div>
                    <Badge tone="info" variant="soft" size="xs">atomic flash-loan</Badge>
                  </div>
                  {showRedeem ? (
                    <div className="space-y-3">
                      <TokenAmountInput
                        symbol="ceUSX"
                        value={redeemAmt}
                        onChange={setRedeemAmt}
                        balance={maxRedeem}
                        balanceUnit="ceUSX deposited"
                        balanceDecimals={2}
                        onMax={() => setRedeemAmt(maxRedeem.toFixed(2))}
                        invalid={exceedsCeusx}
                        errorText={exceedsCeusx ? "Exceeds ceUSX deposit." : undefined}
                      />
                      <Button
                        variant="primary"
                        size="lg"
                        fullWidth
                        loading={actionLoading}
                        disabled={!solsticeApiKey || !redeemAmt || redeemNum <= 0 || exceedsCeusx}
                        onClick={handleConvertCeusx}
                      >
                        Convert {redeemNum > 0 ? redeemNum.toFixed(2) : ""} ceUSX → ticket
                      </Button>
                    </div>
                  ) : (
                    <p className="text-[11px] text-base-content/55 leading-snug">
                      Click <span className="font-semibold text-base-content">Start redemption</span> to choose
                      an amount. The convert tx queues a Solstice unlock —
                      typical wait is one Solstice unlock epoch.
                    </p>
                  )}
                </Card>
              )}

              {hasCeusxWt && (
                <Card tone="muted" size="md">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-base-content/60 leading-none">
                        Stage 2
                      </div>
                      <div className="font-display text-sm font-medium tracking-[-0.01em] mt-1">
                        Complete {ceusxWtDep?.amount.toFixed(2)} ceUSX-WT → USDC
                      </div>
                    </div>
                    <Badge tone="info" variant="soft" size="xs">atomic flash-loan</Badge>
                  </div>
                  <p className="text-[11px] text-base-content/55 leading-snug mb-3">
                    Burns your ceUSX-WT, claims the matured Solstice unlock,
                    flash-repays your USDC debt, and credits your wallet
                    USDC ATA. If the unlock window hasn't passed, the tx
                    will revert — just retry later.
                  </p>
                  <Button
                    variant="primary"
                    size="lg"
                    fullWidth
                    loading={actionLoading}
                    disabled={!solsticeApiKey || !ceusxWtDep || ceusxWtDep.amount <= 0}
                    onClick={() => handleUnwindCeusxWt(ceusxWtDep?.amount ?? 0)}
                  >
                    Complete redemption → USDC
                  </Button>
                </Card>
              )}
            </div>
          </Card>
        );
      })()}

      {/* Market Parameters (collapsible) */}
      {p && (
        <Card tone="muted" size="md">
          <button
            className="flex items-center justify-between w-full text-left"
            onClick={() => setShowMarketParams(!showMarketParams)}
            type="button"
          >
            <div>
              <StatLabel>Market parameters</StatLabel>
              <div className="font-display text-base font-medium tracking-[-0.01em] text-base-content mt-0.5">
                {showMarketParams ? "Hide" : "Show"} reserve config
              </div>
            </div>
            <span className="text-base-content/40 text-sm">{showMarketParams ? "▲" : "▼"}</span>
          </button>
          {showMarketParams && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 mt-4 pt-4 border-t border-base-300/70">
              <KeyValue compact label="LTV" value={`${p.ltvPct}%`} />
              <KeyValue compact label="Liq. threshold" value={`${p.liqThreshPct}%`} />
              <KeyValue compact label="Pool liquidity" value={`${p.availableLiquidity.toFixed(2)} USDC`} />
              <KeyValue compact label="Collateral yield" value={<span className="text-success">~8–12% APY</span>} />
              <KeyValue compact label="Obligation ID" value={(() => {
                const activeEntry = obligationCatalog.find((e) => e.id === selectedObligationId);
                const label = activeEntry?.label;
                return `#${selectedObligationId}${label ? ` · ${label}` : ""}`;
              })()} />
              <KeyValue compact label="Obligation" value={`${p.address.slice(0, 16)}…`} />
              <KeyValue compact label="Market" value={`${MARKET.toBase58().slice(0, 16)}…`} />
              <KeyValue compact label="Borrow rate" value={p.borrowAPR !== null ? `${(p.borrowAPR * 100).toFixed(2)}% APR` : "—"} />
            </div>
          )}
        </Card>
      )}

      {/* Toast — every tx flow on this page funnels through one Snackbar
          so the layout stays uniform: short headline as `message`, the
          truncated `sig=…` on its own line, and the Explorer / Copy-sig
          action cluster sitting flush-right. Same shape the credit-trade
          panel already uses, lifted out into the shared TxActionButtons
          component (../components/TxActionButtons) so future tx flows
          drop into the same look without duplicating the anchor markup. */}
      {status && (
        <Snackbar
          variant="toast"
          type={status.type === "success" ? "success" : status.type === "error" ? "error" : "info"}
          message={status.msg}
          detail={status.sig ? `sig=${shortSig(status.sig)}` : undefined}
          action={status.sig ? <TxActionButtons sig={status.sig} /> : undefined}
          dismissAfterMs={status.type === "success" ? 8000 : undefined}
          onDismiss={() => setStatus(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error formatting — wallet adapters truncate `error.message` to a few words
// ("custom p…") which makes simulation failures undebuggable. We pull the
// last few `logMessages` from `SendTransactionError` (when present) and
// always log the full error object to the console so failures can be
// triaged without recompiling. Also forwarded to the toast subtitle so
// the program-error code shows in the UI.
// ---------------------------------------------------------------------------

function formatTxError(e: unknown): string {
  // Always dump the full error to the console — user can copy the
  // logs for any subsequent investigation.
  // eslint-disable-next-line no-console
  console.error("[PositionsPage] tx error:", e);
  const err = e as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const msg = err.message ?? String(e);
  const logs = err.logs ?? err.transactionLogs ?? [];
  if (logs.length > 0) {
    // Last 3 program-log lines usually carry the precise revert reason
    // ("Program log: AnchorError… Custom(6010): …"). Keep the message
    // short enough for the toast but informative enough to act on.
    const tail = logs.slice(-3).join(" · ");
    return `${msg.slice(0, 160)} — ${tail.slice(0, 240)}`;
  }
  return msg.slice(0, 320);
}

// ---------------------------------------------------------------------------
// Position-list helpers — render Collateral and Borrows as responsive cards
// instead of a fixed table. On wide viewports the row stays a horizontal
// strip; on narrow viewports it stacks (icon → values → actions). Tables
// were cropping content under ~640px, which is why this exists.
// ---------------------------------------------------------------------------

/** Hover/focus popover that surfaces the active EG's framing
 *  (debt asset, collateral basket, why some flows are hidden). Replaces
 *  the inline Snackbar that previously sat below the obligation
 *  switcher and ate ~half a page width before the KPI strip. The
 *  button stays subtle (mono `i` glyph in a circular outline) so the
 *  switcher remains the primary affordance. */
function ObligationInfoButton({ elevationGroup }: { elevationGroup: number }) {
  const content = (() => {
    switch (elevationGroup) {
      case 1:
        return {
          title: "Stables elevation group active.",
          body: "EG-1 locks the debt asset to cUSDC (KYC-gated USDC wrapper) and the collateral basket to ceUSX / ceUSX-WT. Plain SOL borrowing is hidden here; opening new cUSDC credit lives in the Lending tab.",
        };
      case 2:
        return {
          title: "LST / SOL elevation group active.",
          body: "EG-2 locks the debt asset to cSOL and the collateral basket to csSOL / csSOL-WT. Plain USDC borrowing is hidden here; opening new cSOL credit lives in the Credit Trade panel.",
        };
      case 3:
        return {
          title: "Margin-long SOL elevation group active.",
          body: "EG-3 pairs cSOL collateral with cUSDC debt for leveraged-long SOL exposure. Other debt assets are hidden on this obligation.",
        };
      case 4:
        return {
          title: "Margin-short SOL elevation group active.",
          body: "EG-4 pairs cUSDC collateral with cSOL debt — the mirror of EG-3 for leveraged-short SOL exposure.",
        };
      default:
        return {
          title: `Elevation group EG-${elevationGroup} active.`,
          body: "This obligation has opted into a custom elevation group. Debt asset and collateral basket are locked to the EG configuration.",
        };
    }
  })();

  // The pill itself is `position: relative` (Tailwind doesn't apply
  // it explicitly but flex children of a flex container default to
  // static — so we anchor the popover to the info button's wrapper
  // here). The popover uses `z-[100]` to clear adjacent KPI tiles
  // and the COLLATERAL/BORROWS row that previously drew over it.
  return (
    <span className="relative group/eginfo inline-flex">
      <button
        type="button"
        aria-label={content.title}
        className={cn(
          // The pill is now a "selected card" (light surface, primary
          // border) rather than a navy fill, so the icon switched from
          // primary-content (white-on-navy) to primary (navy-on-white).
          // Tinted primary bg + primary border keeps it a clear
          // deliberate affordance against the pill's white chrome.
          "inline-flex items-center justify-center h-6 w-6 rounded-full",
          "border border-primary/40 bg-primary/10 text-primary",
          "hover:bg-primary/20 hover:border-primary/60",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/70",
          "transition-colors cursor-pointer",
        )}
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 top-full mt-2 z-[100] w-72 -translate-x-1/2",
          "rounded-xl border border-base-300 bg-base-200 p-3 shadow-[var(--shadow-stone-lg)]",
          // The pill (this popover's ancestor) carries
          // `whitespace-nowrap` so its label never wraps — that
          // cascades to the popover and causes its body text to
          // overflow the 288px box, clipping at "…and the collate".
          // Force whitespace + colour back to defaults so the popover
          // wraps and reads cleanly regardless of the pill's state.
          "whitespace-normal text-base-content",
          "opacity-0 translate-y-1 transition-[opacity,transform] duration-150",
          "group-hover/eginfo:opacity-100 group-hover/eginfo:translate-y-0",
          "group-focus-within/eginfo:opacity-100 group-focus-within/eginfo:translate-y-0",
        )}
      >
        <div className="text-xs font-semibold text-base-content leading-snug mb-1">{content.title}</div>
        <p className="text-[11px] text-base-content/65 leading-snug">{content.body}</p>
      </span>
    </span>
  );
}

function BlockHeader({
  label,
  count,
  subtle,
}: {
  label: string;
  count: number;
  subtle?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pt-1">
      <span
        className={cn(
          "text-[10px] font-bold uppercase tracking-[0.2em] leading-none",
          subtle ? "text-base-content/45" : "text-base-content/65",
        )}
      >
        {label}
      </span>
      <Badge tone={subtle ? "neutral" : "primary"} variant="soft" size="xs">
        {count}
      </Badge>
    </div>
  );
}

function BlockSeparator() {
  return (
    <div aria-hidden className="px-1 py-1">
      <div className="h-px bg-gradient-to-r from-transparent via-base-300 to-transparent" />
    </div>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return (
    <div className="px-3 py-3 text-center text-xs text-base-content/40 rounded-lg border border-dashed border-base-300/60">
      {text}
    </div>
  );
}

/** Single label/value column inside a row card. Mobile: label-above-value
 *  vertical stack. Desktop: label-then-value flush right. */
function DataCell({
  label,
  value,
  valueClass,
  align = "right",
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
  align?: "right" | "left";
}) {
  return (
    <div className={cn(
      "flex flex-col gap-1 sm:gap-0.5",
      align === "right" && "sm:items-end",
    )}>
      <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-base-content/50 leading-none">
        {label}
      </span>
      <span className={cn("font-mono tabular-nums leading-none text-sm", valueClass)}>
        {value}
      </span>
    </div>
  );
}

function CollateralRowCard({
  asset,
  dep,
  walBal,
  muted,
  onWithdraw,
  onSupply,
}: {
  asset: CollateralAsset;
  dep: Deposit | undefined;
  walBal: number;
  muted: boolean;
  onWithdraw: () => void;
  onSupply: () => void;
}) {
  const showWithdraw = !!dep && dep.amount > 0 && !asset.pending;
  const showSupply = walBal > 0 && !asset.pending;
  // SOL-family rows need 4 fractional digits to surface meaningful
  // amounts (a 0.05 csSOL position would round to 0.05 anyway, but a
  // 0.0054 wallet balance would render as 0.01 with 2 digits).
  const displayDigits = Math.min(4, asset.decimals);
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4",
        "rounded-xl border border-base-300/50 px-3 py-3 sm:py-2.5",
        muted ? "bg-base-100/50" : "bg-base-200",
        asset.pending && "opacity-75",
      )}
    >
      {/* Asset identity — fixed column, just icon + symbol (+ optional
          ticket badge). The yield/brand caption was previously crammed
          on the secondary line here, which collided with the next
          column on long symbols (csSOL-WT). It now lives on its own
          row beneath the data cells (see subtitle row below), so this
          column stays clean and short across every asset. */}
      <div className="flex items-center gap-3 sm:w-40 sm:flex-shrink-0 min-w-0">
        <BalanceIcon symbol={iconSymbolFor(asset.symbol)} size="sm" />
        <div className="flex items-center gap-1.5 leading-none min-w-0">
          <span className="font-mono font-semibold truncate">{asset.symbol}</span>
          {asset.isWithdrawTicket && (
            <Badge tone="info" variant="soft" size="xs">ticket</Badge>
          )}
        </div>
      </div>

      {/* Data + subtitle stack — both rows live inside the same flex
          item so the subtitle inherits the data column's width. The
          subtitle stops at the inner edge of the actions column (it's
          inside this stack, not on the row itself), so it never runs
          under the Withdraw/Supply buttons. */}
      <div className="flex flex-col gap-1.5 sm:flex-1 sm:min-w-0">
        <div className="grid grid-cols-3 gap-3 sm:flex sm:items-baseline sm:justify-end sm:gap-6">
          <DataCell
            label="Deposited"
            value={dep ? dep.amount.toFixed(displayDigits) : (0).toFixed(displayDigits)}
            align="left"
          />
          <DataCell
            label="Value"
            value={dep ? `$${dep.valueUsd.toFixed(2)}` : "—"}
            valueClass={dep ? "text-success" : "text-base-content/35"}
            align="left"
          />
          <DataCell
            label="Wallet"
            value={asset.pending ? "—" : walBal.toFixed(displayDigits)}
            valueClass="text-base-content/65 text-xs"
            align="left"
          />
        </div>
        {asset.subtitle && (
          <div className="text-[11px] text-base-content/55 font-mono leading-snug truncate sm:text-right">
            {asset.subtitle}
          </div>
        )}
      </div>

      {/* Actions — flex-shrink-0 holds the buttons in a guaranteed-width
          column on the right, so they never get squeezed by the data. */}
      <div className="flex items-center gap-1.5 flex-shrink-0 sm:justify-end">
        {asset.pending ? (
          <Badge tone="neutral" variant="outline" size="xs">Coming soon</Badge>
        ) : (
          <>
            {showWithdraw && (
              <Button variant="destructive" size="sm" onClick={onWithdraw}>
                Withdraw
              </Button>
            )}
            {showSupply && (
              <Button variant={muted ? "secondary" : "primary"} size="sm" onClick={onSupply}>
                Supply
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BorrowRowCard({ borrow, pool }: { borrow: Borrow; pool: number | null }) {
  // Pool = remaining available liquidity in the borrow reserve, in
  // underlying token units. Same source as the "Available to borrow"
  // strip uses (`legs[symbol].available`); the prior em-dash here was
  // a placeholder from before the legs map was wired up. Drop back to
  // em-dash when legs hasn't loaded yet (null) or the leg is missing.
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 rounded-xl border border-base-300/50 px-3 py-3 sm:py-2.5 bg-base-200">
      <div className="flex items-center gap-3 sm:w-40 sm:flex-shrink-0">
        <BalanceIcon symbol={iconSymbolFor(borrow.symbol)} size="sm" />
        <span className="font-mono font-semibold">{borrow.symbol}</span>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:flex sm:flex-1 sm:min-w-0 sm:items-center sm:justify-end sm:gap-6">
        <DataCell label="Amount" value={borrow.amount.toFixed(borrow.symbol === "wSOL" ? 4 : 2)} align="left" />
        <DataCell label="Value" value={`$${borrow.valueUsd.toFixed(2)}`} valueClass="text-warning" align="left" />
        <DataCell
          label="Pool"
          value={pool !== null && pool > 0 ? `$${pool.toFixed(2)}` : "—"}
          valueClass={pool !== null && pool > 0 ? "text-base-content/65 text-xs" : "text-base-content/35"}
          align="left"
        />
      </div>
    </div>
  );
}

function BorrowAvailableRowCard({
  symbol,
  apr,
  pool,
}: {
  symbol: TokenSymbol;
  apr: number | null;
  pool: number;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 rounded-xl border border-base-300/50 px-3 py-3 sm:py-2.5 bg-base-100/50">
      <div className="flex items-center gap-3 sm:w-40 sm:flex-shrink-0">
        <BalanceIcon symbol={symbol} size="sm" />
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-mono font-semibold leading-none">{symbol}</span>
          {apr !== null && (
            <span className="text-[10px] text-base-content/55 leading-none">
              {(apr * 100).toFixed(2)}% APR
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:flex sm:flex-1 sm:min-w-0 sm:items-center sm:justify-end sm:gap-6">
        <DataCell label="Amount" value="—" valueClass="text-base-content/35" align="left" />
        <DataCell label="Value" value="—" valueClass="text-base-content/35" align="left" />
        <DataCell
          label="Pool"
          value={`$${pool.toFixed(2)}`}
          valueClass="text-base-content/65 text-xs"
          align="left"
        />
      </div>
    </div>
  );
}
