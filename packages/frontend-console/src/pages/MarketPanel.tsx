import { useState, useCallback, useEffect, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Eyebrow,
  FormLabel,
  Input,
  KeyValue,
  PageHeader,
  SectionHeader,
  Snackbar,
  Stat,
} from "@clearstone/design-system";
import { usePrograms } from "../hooks/usePrograms";

import Dropdown from "../components/Dropdown";
import {
  reserveLiquiditySupply,
  reserveCollateralMint,
  reserveCollateralSupply,
  feeReceiver,
  buildRefreshReserveIx,
} from "../lib/klend";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const MARKET_AUTHORITY = "AhKNmBmaeq6XrrEyGnSQne3WeU4SoN7hSAGieTiqPaJX";

const DISC: Record<string, Buffer> = {
  update_reserve_config: Buffer.from([61, 148, 100, 70, 143, 107, 17, 13]),
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  init_reserve: Buffer.from([138, 245, 71, 225, 153, 4, 3, 43]),
  // sha256("global:update_lending_market")[0..8] — precomputed via
  // `crypto.createHash` so the browser bundle doesn't pull in Node's
  // `crypto`. Used by the EG editor to send mode-9 ixes that update a
  // single elevation group on the LendingMarket.
  update_lending_market: Buffer.from([209, 157, 53, 210, 97, 180, 31, 45]),
};

type Role = "collateral" | "borrow";

interface ReserveMeta {
  symbol: string;
  address: PublicKey;
  role: Role;
  /** Elevation group ID this reserve participates in. */
  eg: number;
  /** True when EG registration is on-chain but per-reserve config is still pending. */
  egPending?: boolean;
  /** Token amount decimals — used to scale deposit/borrow limits for display. */
  decimals: number;
  /** Underlying asset note shown under the symbol. */
  note: string;
}

interface ReserveStatus extends ReserveMeta {
  /** BASE LTV — applies when the obligation is NOT in any elevation group.
   *  When the obligation is in an EG, the EG's `ltvPct` overrides this
   *  uniformly across all the EG's collaterals (klend resolves the
   *  effective LTV at borrow / withdraw time via `get_elevation_group`).
   *  The institutional UI shows the EG-effective LTV; the console
   *  surfaces both via `egEffectiveLtvByGroup` so an operator can see
   *  the override in the same place they're editing the base. */
  ltvPct: number | null;
  liqThresholdPct: number | null;
  depositLimitRaw: bigint | null;
  borrowLimitRaw: bigint | null;
  statusByte: number | null;
  onChainName: string | null;
  /** Every EG id this reserve participates in — read from the on-chain
   *  `config.elevation_groups: [u8; 20]` (zeros stripped). cSOL is in
   *  [2, 3, 4]; cUSDC in [1, 3, 4]; the SOL/USDC LST collaterals each
   *  in a single EG. Memory note: `klend reserve.elevation_groups`. */
  participatingEgs: number[];
  /** EG-effective (LTV, liqThresh) pulled from the LendingMarket's
   *  `elevation_groups[]` table — the values klend actually uses when
   *  the obligation is in that EG. Empty for reserves not in any EG. */
  egEffectiveLtvByGroup: Record<number, { ltvPct: number; liqThresholdPct: number }>;
}

/** Full decoded EG entry — every field klend's `update_lending_market(9)`
 *  ix takes, so the editor can preserve the ones it isn't changing.
 *  Mirrors `ElevationGroupParams` in `packages/programs/scripts/lib/
 *  klend-elevation-group.ts`. */
interface ElevationGroupSummary {
  id: number;
  ltvPct: number;
  liqThresholdPct: number;
  maxLiquidationBonusBps: number;
  allowNewLoans: number;
  maxReservesAsCollateral: number;
  debtReserve: PublicKey;
  /** Index in the on-chain `elevation_groups[32]` array — needed only
   *  for re-reading the same slot after an edit. */
  arrayIndex: number;
}

const STATUS_LABELS = ["Active", "Obsolete", "Hidden"];
function statusBadge(byte: number | null) {
  if (byte === null) return <Badge tone="neutral" size="xs">unknown</Badge>;
  const label = STATUS_LABELS[byte] ?? String(byte);
  if (label === "Active")   return <Badge tone="success" size="xs">active</Badge>;
  if (label === "Obsolete") return <Badge tone="warning" size="xs">obsolete</Badge>;
  if (label === "Hidden")   return <Badge tone="neutral" size="xs">hidden</Badge>;
  return <Badge tone="neutral" size="xs">{label}</Badge>;
}

function fmtLimit(raw: bigint | null, decimals: number) {
  if (raw === null) return "—";
  if (raw > 1_000_000_000_000_000n) return "∞";
  const scale = 10 ** decimals;
  const n = Number(raw) / scale;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(0);
}

function shortAddr(s: string) { return s.slice(0, 4) + "…" + s.slice(-4); }

/**
 * Format spec for every `update_reserve_config` mode the editor exposes.
 * Each entry pins:
 *   * `format`       — one-line "what should I type here" prose
 *   * `placeholder`  — example shape for the Input's placeholder slot
 *   * `example`      — concrete sample value (string, since the Input is
 *                      stringly-typed and ints over 2^53 can't be Number)
 *   * `exampleFor`   — optional dynamic example that derives from the
 *                      currently-selected reserve (decimals / name) so a
 *                      USDC-mode example reads "100000000000 = 100,000
 *                      USDC" rather than a generic "1000000000".
 *   * `exampleNote`  — short trailing gloss appended after the example.
 *
 * Keys must match the dropdown's mode value strings.
 */
interface ConfigFormat {
  format: string;
  placeholder: string;
  example: string;
  exampleFor?: (decimals: number, name: string) => string;
  exampleNote?: string;
}
const CONFIG_FORMAT: Record<string, ConfigFormat> = {
  // 0 — UpdateLoanToValuePct. Single u8 percent, 0–99, must be strictly
  // less than the reserve's liquidation threshold.
  "0": {
    format: "Integer percent, 0–99 (must be < liquidation threshold).",
    placeholder: "e.g. 75",
    example: "75",
    exampleNote: "= 75% LTV",
  },
  // 2 — UpdateLiquidationThresholdPct. u8 percent, must be ≥ LTV and ≤ 100.
  "2": {
    format: "Integer percent, ≥ LTV and ≤ 100.",
    placeholder: "e.g. 85",
    example: "85",
    exampleNote: "= 85% liquidation threshold",
  },
  // 8 — UpdateDepositLimit. u64 in raw token units (NOT human-decimal
  // amounts). Rendering it inline using the reserve's decimals removes
  // the most common operator footgun ("typed 100, meant 100k").
  "8": {
    format: "u64 raw token units (NOT human amount). Multiply by 10^decimals.",
    placeholder: "e.g. 100000000000",
    example: "1000000000000",
    exampleFor: (decimals, name) => {
      const raw = (100_000n * 10n ** BigInt(decimals)).toString();
      const sym = name || "tokens";
      return `${raw}  // = 100,000 ${sym} @ ${decimals} decimals`;
    },
    exampleNote: "Pass 18446744073709551615 (u64::MAX) for ∞.",
  },
  // 9 — UpdateBorrowLimit. Same shape as deposit limit.
  "9": {
    format: "u64 raw token units. Must be ≥ borrow_limit_outside_eg.",
    placeholder: "e.g. 75000000000",
    example: "750000000000",
    exampleFor: (decimals, name) => {
      const raw = (75_000n * 10n ** BigInt(decimals)).toString();
      const sym = name || "tokens";
      return `${raw}  // = 75,000 ${sym} @ ${decimals} decimals`;
    },
    exampleNote: "Pass 18446744073709551615 (u64::MAX) for ∞.",
  },
  // 16 — UpdateName. UTF-8 string, padded / truncated to 32 bytes by
  // the handler. Don't include null terminator.
  "16": {
    format: "UTF-8 string, ≤ 32 bytes. Padded with zeros on chain.",
    placeholder: "e.g. cUSDC",
    example: "cUSDC",
    exampleNote: "Used as the symbol in klend log lines.",
  },
  // 17 — UpdatePriceMaxAge. u64 seconds — how stale a price reading the
  // reserve will accept before refresh_reserve fails check_age.
  "17": {
    format: "u64 seconds — max age of a price reading before it's rejected.",
    placeholder: "e.g. 120",
    example: "120",
    exampleNote: "Pass 18446744073709551615 (u64::MAX) on devnet where Pyth pushers are sparse.",
  },
  // 20 — UpdatePythPrice. Pyth Receiver `PriceUpdateV2` account pubkey.
  "20": {
    format: "Base58 PublicKey of the Pyth Receiver PriceUpdateV2 account.",
    placeholder: "e.g. ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD",
    example: "ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD",
    exampleNote: "USDC on devnet. cSOL/wSOL = 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE.",
  },
  // 32 — UpdateBorrowFactor. u64 percent ≥100. 100 = 1.0× (no risk
  // adjustment); 120 = treat each unit of debt as 1.2 units for HF math.
  "32": {
    format: "u64 percent, ≥ 100. 100 = no risk weighting; >100 amplifies HF.",
    placeholder: "e.g. 100",
    example: "100",
    exampleNote: "Stables = 100. Volatile-asset debt sometimes 110–120.",
  },
  // 38 — UpdateReserveStatus. u8 enum: 0=Active, 1=Obsolete, 2=Hidden.
  "38": {
    format: "u8 enum: 0 = Active, 1 = Obsolete, 2 = Hidden.",
    placeholder: "0, 1, or 2",
    example: "2",
    exampleNote: "2 (Hidden) blocks new deposits/borrows but keeps repay/withdraw open — used to retire a reserve.",
  },
  // 44 — UpdateBorrowLimitOutsideElevationGroup. u64 raw — caps how much
  // of this reserve can be borrowed outside any EG. Must be ≤ borrow_limit.
  "44": {
    format: "u64 raw token units. Must be ≤ borrow_limit (mode 9).",
    placeholder: "e.g. 75000000000",
    example: "750000000000",
    exampleFor: (decimals, name) => {
      const raw = (75_000n * 10n ** BigInt(decimals)).toString();
      const sym = name || "tokens";
      return `${raw}  // = 75,000 ${sym} @ ${decimals} decimals`;
    },
    exampleNote: "Set to 0 to force every borrow through an elevation group.",
  },
};

export default function MarketPanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { config, ready } = usePrograms();

  const market = config.market.lendingMarket;
  const tokens = config.tokens || [];
  const isMarketAuthority = publicKey?.toBase58() === MARKET_AUTHORITY;

  const reserveMeta: ReserveMeta[] = useMemo(() => [
    { symbol: "csSOL",    address: config.market.csSolReserve,    role: "collateral", eg: 2, decimals: 9, note: "Jito-staked SOL" },
    { symbol: "csSOL-WT", address: config.market.csSolWtReserve,  role: "collateral", eg: 2, decimals: 9, note: "withdraw ticket" },
    // EG-2 debt is cSOL post-2026-05-06 migration. wSOL retired below.
    { symbol: "cSOL",     address: config.market.cSolReserve,     role: "borrow",     eg: 2, decimals: 9, note: "EG-2 debt · KYC-wrapped wSOL" },
    { symbol: "ceUSX",    address: config.market.ceUsxReserve,    role: "collateral", eg: 1, decimals: 6, note: "Solstice eUSX" },
    { symbol: "ceUSX-WT", address: config.market.ceUsxWtReserve,  role: "collateral", eg: 1, decimals: 6, note: "withdraw ticket" },
    { symbol: "sUSDC",    address: config.market.sUsdcReserve,    role: "borrow",     eg: 1, decimals: 6, note: "EG-1 debt · EG-3 debt" },
    // Legacy wSOL reserve deliberately excluded — retired 2026-05-06
    // (status=Hidden, deposit_limit=0, borrow_limit=0, EG-2 membership
    // cleared). It remains on chain for legacy-position read paths but
    // showing it in the live market table just clutters the operator
    // view with a row that can't be acted on.
  ], [config]);

  const [reserves, setReserves] = useState<ReserveStatus[]>([]);
  /** Snapshot of every registered EG on the LendingMarket (sorted by
   *  id ascending). Drives the new Elevation-groups editor + the
   *  per-reserve effective-LTV view in the reserve grid. */
  const [elevationGroups, setElevationGroups] = useState<ElevationGroupSummary[]>([]);
  /** EG editor state — mirror of the reserve editor below it.
   *  `selectedEgId` 0 means no editor open; otherwise the pencil card
   *  shows that EG's editable fields. `egDraft` is the pending edit
   *  buffer; on Apply we re-encode the full 72-byte struct from this. */
  const [selectedEgId, setSelectedEgId] = useState<number>(0);
  const [egDraft, setEgDraft] = useState<{ ltvPct: string; liqThresholdPct: string; maxLiquidationBonusBps: string; maxReservesAsCollateral: string; allowNewLoans: string }>({
    ltvPct: "", liqThresholdPct: "", maxLiquidationBonusBps: "", maxReservesAsCollateral: "", allowNewLoans: "",
  });
  const [selectedToken, setSelectedToken] = useState(0);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [configTarget, setConfigTarget] = useState<string>(config.market.csSolReserve.toBase58());
  const [configMode, setConfigMode] = useState("0");
  const [configValue, setConfigValue] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const targetReserve = reserves.find(r => r.address.toBase58() === configTarget) ?? null;
  const currentLtv = targetReserve?.ltvPct ?? null;
  const currentLiqThreshold = targetReserve?.liqThresholdPct ?? null;

  const showStatus = (msg: string, type: "info" | "success" | "error") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 10_000);
  };

  // Load all v3 reserves + the LendingMarket EG table in one effect.
  // Reserve offsets (klend layout):
  //   4861 status u8, 4872 LTV u8, 4873 LiqThreshold u8,
  //   5016 DepositLimit u64, 5024 BorrowLimit u64, 5032 Name [32],
  //   5480 elevation_groups [u8; 20].
  // LendingMarket layout (8 disc + 192 leading fields = 200): 32 entries
  // of 72 bytes each starting at offset 200. Per-entry layout:
  //   u16 maxLiquidationBonusBps · u8 id · u8 ltvPct · u8 liqThresholdPct
  //   · u8 allowNewLoans · u8 maxReservesAsCollateral · u8 padding0
  //   · 32 debtReserve · 32 padding1.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      // 1. Decode the LendingMarket EG table once. Cheap (one RPC) and
      //    used by every reserve's effective-LTV view AND by the new
      //    Elevation-groups editor below the reserve grid.
      // Per-entry layout (mirrors klend's ElevationGroupParams pack):
      //   u16 maxLiquidationBonusBps · u8 id · u8 ltvPct
      //   · u8 liqThresholdPct · u8 allowNewLoans
      //   · u8 maxReservesAsCollateral · u8 padding0 · 32 debtReserve
      //   · 32 padding1
      const egByGroup = new Map<number, ElevationGroupSummary>();
      const egList: ElevationGroupSummary[] = [];
      try {
        const mktInfo = await connection.getAccountInfo(market);
        if (mktInfo && mktInfo.data.length >= 200 + 32 * 72) {
          for (let i = 0; i < 32; i++) {
            const off = 200 + i * 72;
            const id = mktInfo.data[off + 2];
            if (id === 0) continue; // unused slot
            const summary: ElevationGroupSummary = {
              id,
              ltvPct: mktInfo.data[off + 3],
              liqThresholdPct: mktInfo.data[off + 4],
              maxLiquidationBonusBps: mktInfo.data.readUInt16LE(off),
              allowNewLoans: mktInfo.data[off + 5],
              maxReservesAsCollateral: mktInfo.data[off + 6],
              debtReserve: new PublicKey(mktInfo.data.subarray(off + 8, off + 40)),
              arrayIndex: i,
            };
            egByGroup.set(id, summary);
            egList.push(summary);
          }
        }
      } catch (e) {
        console.warn("loadEgTable failed", e);
      }
      egList.sort((a, b) => a.id - b.id);
      if (!cancelled) setElevationGroups(egList);

      // 2. Fetch every reserve and merge in the EG-effective view.
      const out: ReserveStatus[] = [];
      for (const m of reserveMeta) {
        try {
          const info = await connection.getAccountInfo(m.address);
          if (!info || info.data.length < 8624) {
            out.push({ ...m, ltvPct: null, liqThresholdPct: null, depositLimitRaw: null, borrowLimitRaw: null, statusByte: null, onChainName: null, participatingEgs: [], egEffectiveLtvByGroup: {} });
            continue;
          }
          const data = info.data;
          // elevation_groups is a [u8; 20] starting at 5480; zeros are
          // empty slots. We strip them to a tidy list of EG ids.
          const participatingEgs: number[] = [];
          for (let i = 0; i < 20; i++) {
            const id = data[5480 + i];
            if (id !== 0) participatingEgs.push(id);
          }
          // For each EG this reserve is in, look up the LendingMarket-
          // level (ltv, threshold). klend uses these uniformly across
          // every collateral in that EG, so the same number applies
          // regardless of which reserve you're looking at — but we
          // surface them per-reserve so the operator sees the override
          // in the same row they'd edit the base.
          const egEffectiveLtvByGroup: ReserveStatus["egEffectiveLtvByGroup"] = {};
          for (const id of participatingEgs) {
            const eg = egByGroup.get(id);
            if (eg) {
              egEffectiveLtvByGroup[id] = { ltvPct: eg.ltvPct, liqThresholdPct: eg.liqThresholdPct };
            }
          }
          out.push({
            ...m,
            ltvPct: data[4872],
            liqThresholdPct: data[4873],
            depositLimitRaw: data.readBigUInt64LE(5016),
            borrowLimitRaw: data.readBigUInt64LE(5024),
            statusByte: data[4861],
            onChainName: Buffer.from(data.subarray(5032, 5064)).toString().replace(/\0/g, "") || null,
            participatingEgs,
            egEffectiveLtvByGroup,
          });
        } catch (e) {
          console.warn("loadReserve failed", m.symbol, e);
          out.push({ ...m, ltvPct: null, liqThresholdPct: null, depositLimitRaw: null, borrowLimitRaw: null, statusByte: null, onChainName: null, participatingEgs: [], egEffectiveLtvByGroup: {} });
        }
      }
      if (!cancelled) setReserves(out);
    })();
    return () => { cancelled = true; };
  }, [ready, connection, reserveMeta, market]);

  // ────────────────────────────────────────────────────────────────────
  // create reserve — unchanged from prior version, pulls from tokens[].
  // ────────────────────────────────────────────────────────────────────
  const handleCreateReserve = useCallback(async () => {
    if (!publicKey || !tokens[selectedToken]) return;
    setLoading(true);
    const token = tokens[selectedToken];
    showStatus(`Creating klend reserve for d${token.symbol}…`, "info");

    try {
      const reserveKp = Keypair.generate();
      const rent = await connection.getMinimumBalanceForRentExemption(8624);
      const dTokenAta = getAssociatedTokenAddressSync(token.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const ataInfo = await connection.getAccountInfo(dTokenAta);
      if (!ataInfo) {
        showStatus("You need d-token balance for the seed deposit. Mint first.", "error");
        setLoading(false);
        return;
      }

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }));
      tx.add(SystemProgram.createAccount({
        fromPubkey: publicKey, newAccountPubkey: reserveKp.publicKey,
        lamports: rent, space: 8624, programId: KLEND,
      }));

      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND);
      tx.add({
        programId: KLEND,
        data: DISC.init_reserve,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: token.wrappedMint, isSigner: false, isWritable: false },
          { pubkey: reserveLiquiditySupply(reserveKp.publicKey), isSigner: false, isWritable: true },
          { pubkey: feeReceiver(reserveKp.publicKey), isSigner: false, isWritable: true },
          { pubkey: reserveCollateralMint(reserveKp.publicKey), isSigner: false, isWritable: true },
          { pubkey: reserveCollateralSupply(reserveKp.publicKey), isSigner: false, isWritable: true },
          { pubkey: dTokenAta, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection, { signers: [reserveKp] });
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Reserve created: ${reserveKp.publicKey.toBase58()}. Configuring…`, "info");

      const configUpdates: [string, number, Buffer][] = [
        ["Name", 16, (() => { const b = Buffer.alloc(32); Buffer.from(`d${token.symbol}`).copy(b); return b; })()],
        ["PriceMaxAge", 17, (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt("18446744073709551615")); return b; })()],
        ["TwapMaxAge", 18, (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt("18446744073709551615")); return b; })()],
        ["PythOracle", 20, token.oracle.toBuffer()],
        ["LTV", 0, Buffer.from([75])],
        ["LiqThreshold", 2, Buffer.from([85])],
        ["BorrowFactor", 32, (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(100n); return b; })()],
      ];

      for (const [, mode, value] of configUpdates) {
        const ixData = Buffer.alloc(1 + 4 + value.length + 1);
        ixData.writeUInt8(mode, 0);
        ixData.writeUInt32LE(value.length, 1);
        value.copy(ixData, 5);
        ixData.writeUInt8(1, 5 + value.length);

        const cfgTx = new Transaction();
        cfgTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
        cfgTx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 }));
        cfgTx.add({
          programId: KLEND,
          data: Buffer.concat([DISC.update_reserve_config, ixData]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: KLEND_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
          ],
        });
        try {
          const cfgSig = await sendTransaction(cfgTx, connection);
          await connection.confirmTransaction(cfgSig, "confirmed");
        } catch {}
      }

      for (const [, mode] of [["DepositLimit", 8], ["BorrowLimit", 9], ["BorrowLimitOutside", 44]] as const) {
        const limit = Buffer.alloc(8);
        limit.writeBigUInt64LE(BigInt("1000000000000000"));
        const ixData = Buffer.alloc(1 + 4 + 8 + 1);
        ixData.writeUInt8(mode, 0);
        ixData.writeUInt32LE(8, 1);
        limit.copy(ixData, 5);
        ixData.writeUInt8(0, 13);

        const limTx = new Transaction();
        limTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
        limTx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 }));
        limTx.add({
          programId: KLEND,
          data: Buffer.concat([DISC.update_reserve_config, ixData]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: KLEND_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: reserveKp.publicKey, isSigner: false, isWritable: true },
          ],
        });
        try {
          const sig2 = await sendTransaction(limTx, connection);
          await connection.confirmTransaction(sig2, "confirmed");
        } catch {}
      }

      const refreshTx = new Transaction();
      refreshTx.add(buildRefreshReserveIx(reserveKp.publicKey, market, token.oracle));
      try {
        const rSig = await sendTransaction(refreshTx, connection);
        await connection.confirmTransaction(rSig, "confirmed");
        showStatus(`Reserve for d${token.symbol} created and configured.`, "success");
      } catch {
        showStatus(`Reserve created but RefreshReserve failed. Address: ${reserveKp.publicKey.toBase58()}`, "error");
      }
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 120)}`, "error");
    }
    setLoading(false);
  }, [publicKey, tokens, selectedToken, connection, sendTransaction, market]);

  // ────────────────────────────────────────────────────────────────────
  // edit reserve config
  // ────────────────────────────────────────────────────────────────────
  const handleUpdateConfig = useCallback(async () => {
    if (!publicKey || !configTarget || !configValue) return;
    setLoading(true);
    const mode = parseInt(configMode);
    showStatus(`Updating reserve config (mode ${mode})…`, "info");

    try {
      let value: Buffer;
      if (mode === 16) { value = Buffer.alloc(32); Buffer.from(configValue).copy(value); }
      else if (mode === 20) { value = new PublicKey(configValue).toBuffer(); }
      else if (mode === 0 || mode === 2 || mode === 38) { value = Buffer.from([parseInt(configValue)]); }
      else { value = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(configValue)); }

      const ixData = Buffer.alloc(1 + 4 + value.length + 1);
      ixData.writeUInt8(mode, 0);
      ixData.writeUInt32LE(value.length, 1);
      value.copy(ixData, 5);
      ixData.writeUInt8(0, 5 + value.length);

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 }));
      tx.add({
        programId: KLEND,
        data: Buffer.concat([DISC.update_reserve_config, ixData]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: KLEND_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: new PublicKey(configTarget), isSigner: false, isWritable: true },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Config updated. Tx: ${sig.slice(0, 16)}…`, "success");
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 120)}`, "error");
    }
    setLoading(false);
  }, [publicKey, configTarget, configMode, configValue, connection, sendTransaction, market]);

  // ────────────────────────────────────────────────────────────────────
  // edit elevation group — `update_lending_market(mode=9, value=[u8; 72])`
  // The mode-9 ix replaces a whole EG entry on the LendingMarket. We
  // re-encode every field of the selected EG (preserving id, debt
  // reserve, padding) and only swap in the operator's edits, so a
  // partial change never accidentally clobbers the rest of the entry.
  // Mirrors the pattern in
  //   packages/programs/scripts/migrate-eg-debt-to-cusdc.ts
  // and `lib/klend-elevation-group.ts:packElevationGroup`.
  // ────────────────────────────────────────────────────────────────────
  const handleUpdateElevationGroup = useCallback(async () => {
    if (!publicKey || !selectedEgId) return;
    const current = elevationGroups.find((g) => g.id === selectedEgId);
    if (!current) return;
    setLoading(true);
    showStatus(`Updating EG-${selectedEgId} on the lending market…`, "info");

    try {
      // Parse drafts; fall back to the current on-chain value when the
      // input is blank so a single-field edit doesn't require typing
      // the whole struct.
      const ltvPct = egDraft.ltvPct.trim() === "" ? current.ltvPct : parseInt(egDraft.ltvPct);
      const liqThresholdPct = egDraft.liqThresholdPct.trim() === "" ? current.liqThresholdPct : parseInt(egDraft.liqThresholdPct);
      const maxLiquidationBonusBps = egDraft.maxLiquidationBonusBps.trim() === "" ? current.maxLiquidationBonusBps : parseInt(egDraft.maxLiquidationBonusBps);
      const maxReservesAsCollateral = egDraft.maxReservesAsCollateral.trim() === "" ? current.maxReservesAsCollateral : parseInt(egDraft.maxReservesAsCollateral);
      const allowNewLoans = egDraft.allowNewLoans.trim() === "" ? current.allowNewLoans : parseInt(egDraft.allowNewLoans);

      // Client-side validation — same checks klend's mode-9 handler
      // runs (require ltv ≤ liqThreshold ≤ 100, allowNewLoans is 0|1).
      if (ltvPct < 0 || ltvPct > 100) throw new Error(`ltv must be 0..=100, got ${ltvPct}`);
      if (liqThresholdPct < ltvPct || liqThresholdPct > 100) throw new Error(`liqThreshold must be ≥ ltv (${ltvPct}) and ≤ 100, got ${liqThresholdPct}`);
      if (allowNewLoans !== 0 && allowNewLoans !== 1) throw new Error(`allowNewLoans must be 0 or 1, got ${allowNewLoans}`);
      if (maxLiquidationBonusBps < 0 || maxLiquidationBonusBps > 65535) throw new Error(`maxLiquidationBonusBps out of u16 range`);
      if (maxReservesAsCollateral < 0 || maxReservesAsCollateral > 255) throw new Error(`maxReservesAsCollateral out of u8 range`);

      // Pack the 72-byte ElevationGroup struct.
      const packed = Buffer.alloc(72);
      let off = 0;
      packed.writeUInt16LE(maxLiquidationBonusBps, off); off += 2;
      packed.writeUInt8(current.id, off); off += 1;
      packed.writeUInt8(ltvPct, off); off += 1;
      packed.writeUInt8(liqThresholdPct, off); off += 1;
      packed.writeUInt8(allowNewLoans, off); off += 1;
      packed.writeUInt8(maxReservesAsCollateral, off); off += 1;
      packed.writeUInt8(0, off); off += 1; // padding0
      current.debtReserve.toBuffer().copy(packed, off);
      // padding1 [u64; 4] left as zeros.

      // Anchor wire format for `update_lending_market`: disc(8) + mode(u64
      // LE) + value([u8; 72]). NB the value is fixed-size — no length
      // prefix, unlike `update_reserve_config`.
      const modeBuf = Buffer.alloc(8);
      modeBuf.writeBigUInt64LE(9n);
      const data = Buffer.concat([DISC.update_lending_market, modeBuf, packed]);

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add({
        programId: KLEND,
        data,
        keys: [
          { pubkey: publicKey, isSigner: true,  isWritable: false }, // lendingMarketOwner
          { pubkey: market,    isSigner: false, isWritable: true  },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`EG-${selectedEgId} updated. Tx: ${sig.slice(0, 16)}…`, "success");

      // Refresh the in-memory EG list so the editor's "current" values
      // catch up immediately instead of waiting for a re-mount.
      setElevationGroups((prev) =>
        prev.map((g) =>
          g.id === selectedEgId
            ? { ...g, ltvPct, liqThresholdPct, maxLiquidationBonusBps, maxReservesAsCollateral, allowNewLoans }
            : g,
        ),
      );
      // Clear the draft so the inputs collapse back to placeholders.
      setEgDraft({ ltvPct: "", liqThresholdPct: "", maxLiquidationBonusBps: "", maxReservesAsCollateral: "", allowNewLoans: "" });
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 160)}`, "error");
    }
    setLoading(false);
  }, [publicKey, selectedEgId, elevationGroups, egDraft, connection, sendTransaction, market]);

  if (!connected) {
    return (
      <Card tone="muted" size="lg">
        <p className="text-sm text-base-content/60">Connect wallet to manage lending markets.</p>
      </Card>
    );
  }

  const totalReserves   = reserves.length;
  const collateralCount = reserves.filter(r => r.role === "collateral").length;
  const borrowCount     = reserves.filter(r => r.role === "borrow").length;
  const pendingCount    = reserves.filter(r => r.egPending).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Operator"
        title="Lending market"
        subtitle="v3 unified klend market — csSOL/csSOL-WT/ceUSX/ceUSX-WT/cSOL collateral with wSOL + sUSDC borrow legs across EG-1 (stables), EG-2 (LST/SOL), and EG-3/EG-4 (margin pair, registered)."
        actions={
          isMarketAuthority
            ? <Badge tone="success" variant="soft" size="sm">Authority ✓</Badge>
            : <Badge tone="warning" variant="soft" size="sm">Read-only</Badge>
        }
      />

      {status && (
        <Snackbar
          type={status.type === "success" ? "success" : status.type === "error" ? "error" : "info"}
          message={status.msg}
          variant="inline"
          onDismiss={() => setStatus(null)}
        />
      )}

      {/* KPI strip — derives from loaded reserves so it reflects on-chain truth. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Reserves"    value={totalReserves}  unit="total" accent="primary" caption="v3 unified market" />
        <Stat label="Collateral"  value={collateralCount} unit="legs"  accent="info"    caption="csSOL / WT · ceUSX / WT · cSOL" />
        <Stat label="Borrow"      value={borrowCount}     unit="legs"  accent="accent"  caption="wSOL · sUSDC" />
        <Stat label="EG pending"  value={pendingCount}    unit="rsv"   accent={pendingCount ? "info" : "neutral"} caption="phase-2 elevation_groups update" />
      </div>

      {/* Reserve grid — replaces the old table. Each tile is selectable. */}
      <Card tone="elevated" size="md">
        <CardHeader
          eyebrow="Active"
          title="Reserves"
          subtitle="Click a reserve to load it into the editor below."
        />
        {reserves.length === 0 ? (
          <p className="text-sm text-base-content/50">Loading reserves…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {reserves.map((r) => {
              const addr = r.address.toBase58();
              const selected = configTarget === addr;
              return (
                <button
                  key={addr}
                  type="button"
                  onClick={() => setConfigTarget(addr)}
                  className={[
                    "text-left rounded-xl border p-4 transition-[border-color,box-shadow,background-color] duration-150",
                    selected
                      ? "border-primary/60 bg-primary/5 shadow-[0_0_0_3px_rgba(31,45,72,0.10)]"
                      : "border-base-300 bg-base-100 hover:border-base-content/25 hover:bg-base-200/40",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="font-display text-sm font-medium tracking-[-0.01em] flex items-center gap-2">
                        {r.symbol}
                        {r.egPending && <Badge tone="warning" size="xs">pending</Badge>}
                      </div>
                      <div className="text-[11px] text-base-content/50 mt-0.5">{r.note}</div>
                    </div>
                    {statusBadge(r.statusByte)}
                  </div>

                  <div className="flex items-center gap-1.5 mb-3 flex-wrap">
                    <Badge
                      tone={r.role === "collateral" ? "info" : "primary"}
                      variant="outline"
                      size="xs"
                    >
                      {r.role}
                    </Badge>
                    {/* All EGs this reserve participates in (debt or
                        collateral side), sourced from the on-chain
                        elevation_groups array. Multiple chips for
                        cSOL ([2,3,4]) / cUSDC ([1,3,4]); a single chip
                        falls back to the static `r.eg` so reserves the
                        loader hasn't returned for yet still render. */}
                    {(r.participatingEgs.length > 0 ? r.participatingEgs : [r.eg]).map((id) => (
                      <Badge key={id} tone="neutral" variant="outline" size="xs">
                        EG-{id}
                      </Badge>
                    ))}
                  </div>

                  <div className="space-y-0.5">
                    {/* Base values — apply only outside any elevation
                        group. Labelled "(Base)" so an operator never
                        confuses these with what klend actually uses
                        when an obligation is in EG-N. */}
                    <KeyValue compact label="LTV (Base)"        value={r.ltvPct === null ? "—" : `${r.ltvPct}%`} />
                    <KeyValue compact label="Liq thresh (Base)" value={r.liqThresholdPct === null ? "—" : `${r.liqThresholdPct}%`} />
                    {/* EG-effective overrides — one row per EG this
                        reserve participates in, with the LTV / liq
                        threshold klend resolves to via the market's
                        elevation_groups[] table. Mirrors what the
                        institutional UI's PositionsPage shows. */}
                    {r.participatingEgs.map((id) => {
                      const eff = r.egEffectiveLtvByGroup[id];
                      return (
                        <KeyValue
                          key={id}
                          compact
                          label={`EG-${id} ltv/liq`}
                          value={
                            eff
                              ? <span className="text-success">{eff.ltvPct}% / {eff.liqThresholdPct}%</span>
                              : <span className="text-base-content/40">—</span>
                          }
                        />
                      );
                    })}
                    <KeyValue compact label="Deposit cap" value={fmtLimit(r.depositLimitRaw, r.decimals)} />
                    {r.role === "borrow" && (
                      <KeyValue compact label="Borrow cap" value={fmtLimit(r.borrowLimitRaw, r.decimals)} />
                    )}
                    <KeyValue compact label="Address" value={<span className="font-mono text-[10px]">{shortAddr(addr)}</span>} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* Elevation groups — market-level table that overrides each
          reserve's base LTV / liq threshold for any obligation in that
          EG. Click a row to load it into the inline editor; Apply sends
          `update_lending_market(mode=9)` with the full 72-byte struct
          re-encoded from the on-chain values + the operator's edits. */}
      {elevationGroups.length > 0 && (
        <Card tone="elevated" size="md">
          <CardHeader
            eyebrow="Active"
            title="Elevation groups"
            subtitle="LendingMarket-level LTV / liq-threshold overrides. Click a row to edit."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {elevationGroups.map((g) => {
              const debtSym = reserves.find((r) => r.address.equals(g.debtReserve))?.symbol;
              const selected = selectedEgId === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    setSelectedEgId(selected ? 0 : g.id);
                    // Load current values into the draft so the inputs
                    // display the on-chain state. Empty-string fall-
                    // through to "preserve current" semantics on Apply.
                    setEgDraft({
                      ltvPct: String(g.ltvPct),
                      liqThresholdPct: String(g.liqThresholdPct),
                      maxLiquidationBonusBps: String(g.maxLiquidationBonusBps),
                      maxReservesAsCollateral: String(g.maxReservesAsCollateral),
                      allowNewLoans: String(g.allowNewLoans),
                    });
                  }}
                  className={[
                    "text-left rounded-xl border px-4 py-3 transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/5"
                      : "border-base-300 bg-base-100 hover:border-base-content/25 hover:bg-base-200/40",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="font-display text-sm font-medium tracking-[-0.01em]">
                      EG-{g.id}
                    </div>
                    <Badge
                      tone={g.allowNewLoans ? "success" : "warning"}
                      variant="outline"
                      size="xs"
                    >
                      {g.allowNewLoans ? "open" : "closed"}
                    </Badge>
                  </div>
                  <div className="space-y-0.5">
                    <KeyValue compact label="LTV / liq" value={
                      <span className="font-mono">{g.ltvPct}% / {g.liqThresholdPct}%</span>
                    } />
                    <KeyValue compact label="Max bonus"   value={`${g.maxLiquidationBonusBps} bps`} />
                    <KeyValue compact label="Max coll."   value={String(g.maxReservesAsCollateral)} />
                    <KeyValue compact label="Debt asset"  value={
                      <span className="font-mono text-[11px]">
                        {debtSym ?? shortAddr(g.debtReserve.toBase58())}
                      </span>
                    } />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Inline editor — appears below the grid when an EG is
              selected. Mirrors the reserve editor's "Mode & value"
              shape: each input shows the current on-chain value as the
              placeholder *and* as the initial draft, so leaving a field
              alone preserves it on Apply (the handler falls back to
              `current` when the trimmed input is empty). */}
          {selectedEgId !== 0 && (() => {
            const current = elevationGroups.find((g) => g.id === selectedEgId);
            if (!current) return null;
            const debtSym = reserves.find((r) => r.address.equals(current.debtReserve))?.symbol
              ?? shortAddr(current.debtReserve.toBase58());
            return (
              <Card tone="muted" size="sm" className="mt-4">
                <div className="flex items-center justify-between mb-3">
                  <Eyebrow>Edit EG-{selectedEgId} — debt = {debtSym}</Eyebrow>
                  <Button variant="ghost" size="xs" onClick={() => setSelectedEgId(0)}>Close</Button>
                </div>

                {!isMarketAuthority && (
                  <Snackbar
                    type="warning"
                    message="Connect the market authority wallet to apply changes."
                    detail={MARKET_AUTHORITY}
                    variant="inline"
                  />
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                  <div>
                    <FormLabel>LTV %</FormLabel>
                    <Input
                      placeholder={`current ${current.ltvPct}`}
                      value={egDraft.ltvPct}
                      onChange={(e) => setEgDraft((d) => ({ ...d, ltvPct: e.target.value }))}
                      numeric
                    />
                  </div>
                  <div>
                    <FormLabel>Liq threshold %</FormLabel>
                    <Input
                      placeholder={`current ${current.liqThresholdPct}`}
                      value={egDraft.liqThresholdPct}
                      onChange={(e) => setEgDraft((d) => ({ ...d, liqThresholdPct: e.target.value }))}
                      numeric
                    />
                  </div>
                  <div>
                    <FormLabel>Max liq bonus (bps)</FormLabel>
                    <Input
                      placeholder={`current ${current.maxLiquidationBonusBps}`}
                      value={egDraft.maxLiquidationBonusBps}
                      onChange={(e) => setEgDraft((d) => ({ ...d, maxLiquidationBonusBps: e.target.value }))}
                      numeric
                    />
                  </div>
                  <div>
                    <FormLabel>Max reserves as collateral</FormLabel>
                    <Input
                      placeholder={`current ${current.maxReservesAsCollateral}`}
                      value={egDraft.maxReservesAsCollateral}
                      onChange={(e) => setEgDraft((d) => ({ ...d, maxReservesAsCollateral: e.target.value }))}
                      numeric
                    />
                  </div>
                  <div>
                    <FormLabel>Allow new loans (0/1)</FormLabel>
                    <Input
                      placeholder={`current ${current.allowNewLoans}`}
                      value={egDraft.allowNewLoans}
                      onChange={(e) => setEgDraft((d) => ({ ...d, allowNewLoans: e.target.value }))}
                      numeric
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="primary"
                      onClick={handleUpdateElevationGroup}
                      loading={loading}
                      disabled={!isMarketAuthority}
                      className="w-full"
                    >
                      Apply
                    </Button>
                  </div>
                </div>

                <p className="text-[11px] text-base-content/55 mt-3 leading-snug">
                  Empty inputs preserve the current value on chain. Required: 0 ≤ LTV ≤ liq threshold ≤ 100; allowNewLoans ∈ {"{0, 1}"}; debt reserve + id are preserved automatically (use the on-chain {`migrate-eg-debt-to-cusdc.ts`}-style script to swap a debt reserve, since that's a riskier change).
                </p>
              </Card>
            );
          })()}
        </Card>
      )}

      {/* Edit panel — uses target from grid selection. */}
      {targetReserve && (
        <Card tone="elevated" size="md">
          <CardHeader
            eyebrow="Editor"
            title={
              <span className="flex items-center gap-2">
                Configure {targetReserve.symbol}
                <Badge tone={targetReserve.role === "collateral" ? "info" : "primary"} variant="soft" size="sm">
                  {targetReserve.role}
                </Badge>
                <Badge tone="neutral" variant="soft" size="sm">EG-{targetReserve.eg}</Badge>
              </span>
            }
            subtitle={<span className="font-mono text-[11px]">{configTarget}</span>}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setConfigTarget("")}>
                Close
              </Button>
            }
          />

          {!isMarketAuthority && (
            <Snackbar
              type="warning"
              message="Connect the market authority wallet to apply changes."
              detail={MARKET_AUTHORITY}
              variant="inline"
            />
          )}

          {/* Current parameters — muted card to recess inside the editor.
              The LTV / liq-threshold pair is rendered twice intentionally:
              once as the "(Base)" values stored on the reserve config
              (those are what `update_reserve_config` mode 0 / 2 edit),
              and once per EG showing the LendingMarket-level overrides
              that klend actually applies when an obligation is in that
              EG. The institutional UI surfaces only the EG-effective
              number; the console operator needs to see both because
              they're editing the base. */}
          <Card tone="muted" size="sm" className="mt-4">
            <Eyebrow className="mb-3">Current</Eyebrow>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KeyValue label="Name"             value={targetReserve.onChainName ?? "—"} />
              <KeyValue label="Status"           value={STATUS_LABELS[targetReserve.statusByte ?? -1] ?? "—"} />
              <KeyValue label="LTV (Base)"        value={targetReserve.ltvPct === null ? "—" : `${targetReserve.ltvPct}%`} />
              <KeyValue label="Liq thresh (Base)" value={targetReserve.liqThresholdPct === null ? "—" : `${targetReserve.liqThresholdPct}%`} />
              <KeyValue label="Deposit cap"      value={fmtLimit(targetReserve.depositLimitRaw, targetReserve.decimals)} />
              <KeyValue label="Borrow cap"       value={fmtLimit(targetReserve.borrowLimitRaw,  targetReserve.decimals)} />
            </div>
            {targetReserve.participatingEgs.length > 0 && (
              <div className="mt-3 pt-3 border-t border-base-300/60">
                <Eyebrow className="mb-2">EG-effective overrides</Eyebrow>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {targetReserve.participatingEgs.map((id) => {
                    const eff = targetReserve.egEffectiveLtvByGroup[id];
                    return (
                      <KeyValue
                        key={id}
                        label={`EG-${id} ltv / liq`}
                        value={
                          eff
                            ? <span className="text-success font-mono">{eff.ltvPct}% / {eff.liqThresholdPct}%</span>
                            : <span className="text-base-content/40">—</span>
                        }
                      />
                    );
                  })}
                </div>
                <p className="text-[11px] text-base-content/55 mt-2 leading-snug">
                  EG-effective values come from the market's elevation_groups[] table (mode UpdateLendingMarket(9)) — they apply uniformly to every collateral in the EG. Edit them via the LendingMarket editor, not here. The base values above only matter for obligations not in any EG.
                </p>
              </div>
            )}
          </Card>

          <div className="mt-5 flex flex-col gap-3">
            <FormLabel>Mode &amp; value</FormLabel>
            <div className="flex flex-wrap items-stretch gap-3">
              <Dropdown
                value={configMode}
                onChange={(v) => setConfigMode(String(v))}
                options={[
                  { value: "0",  label: "LTV % (0–99)" },
                  { value: "2",  label: "Liq Threshold % (LTV–100)" },
                  { value: "8",  label: "Deposit Limit (lamports)" },
                  { value: "9",  label: "Borrow Limit (lamports)" },
                  { value: "16", label: "Token Name (string)" },
                  { value: "17", label: "Price Max Age (seconds)" },
                  { value: "20", label: "Pyth Oracle (pubkey)" },
                  { value: "32", label: "Borrow Factor (≥100)" },
                  { value: "38", label: "Reserve Status (0/2)" },
                  { value: "44", label: "Borrow Limit Outside EG" },
                ]}
                className="min-w-[260px]"
              />
              <div className="flex-1 min-w-[200px]">
                <Input
                  placeholder={CONFIG_FORMAT[configMode]?.placeholder ?? "New value"}
                  value={configValue}
                  onChange={(e) => setConfigValue(e.target.value)}
                  numeric={configMode !== "16" && configMode !== "20"}
                />
              </div>
              <Button
                variant="primary"
                onClick={handleUpdateConfig}
                loading={loading}
                disabled={!configValue || !isMarketAuthority}
              >
                Apply
              </Button>
            </div>

            {/* Format indicator — every mode gets a persistent hint that
                names the wire format, then a concrete example with the
                actual decimals applied for the selected reserve when
                relevant. Replaces the prior ad-hoc warnings (which only
                covered modes 0/2/32) so an operator never has to guess
                whether to type "100" or "100000000000". */}
            {(() => {
              const fmt = CONFIG_FORMAT[configMode];
              if (!fmt) return null;
              const example = fmt.exampleFor
                ? fmt.exampleFor(targetReserve.decimals ?? 6, targetReserve.onChainName ?? "")
                : fmt.example;
              return (
                <div className="rounded-lg border border-base-300/60 bg-base-200/40 px-3 py-2 text-xs leading-relaxed">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-mono uppercase tracking-[0.18em] text-[10px] text-base-content/55">Format</span>
                    <span className="text-base-content/85">{fmt.format}</span>
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2 flex-wrap">
                    <span className="font-mono uppercase tracking-[0.18em] text-[10px] text-base-content/55">Example</span>
                    <code className="font-mono text-base-content/90 break-all">{example}</code>
                    {fmt.exampleNote && (
                      <span className="text-base-content/55">— {fmt.exampleNote}</span>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Live constraint warnings — keep the existing reserve-state
                checks (these compare against `currentLtv` / `currentLiqThreshold`
                which are dynamic, so they can't live in CONFIG_FORMAT). */}
            {configMode === "0" && currentLiqThreshold !== null && (
              <p className="text-xs text-warning">LTV must be &lt; liq threshold ({currentLiqThreshold}%). Max: {currentLiqThreshold - 1}.</p>
            )}
            {configMode === "2" && currentLtv !== null && (
              <p className="text-xs text-warning">Must be ≥ LTV ({currentLtv}%) and ≤ 100.</p>
            )}
          </div>
        </Card>
      )}

      {/* Create reserve — collapsed by default, the v3 set is already live. */}
      <Card tone="elevated" size="md">
        <CardHeader
          eyebrow="Operator"
          title="Create new reserve"
          subtitle="The v3 reserves above are already deployed. Use this only when adding a new wrapper to the market."
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowCreate((v) => !v)}
            >
              {showCreate ? "Hide" : "Show"}
            </Button>
          }
        />

        {showCreate && (
          <div className="flex flex-col gap-3">
            <FormLabel hint={tokens.length ? `${tokens.length} wrappers in tokens[]` : "no wrappers"}>
              Wrapper
            </FormLabel>
            <div className="flex flex-wrap items-stretch gap-3">
              <Dropdown
                value={selectedToken}
                onChange={(v) => setSelectedToken(Number(v))}
                options={tokens.map((t, i) => ({ value: i, label: `d${t.symbol} — ${t.name} ($${t.price})` }))}
                className="flex-1 min-w-[260px]"
              />
              <Button
                variant="primary"
                loading={loading}
                disabled={tokens.length === 0 || !isMarketAuthority}
                onClick={handleCreateReserve}
              >
                Create reserve
              </Button>
            </div>
            <p className="text-xs text-base-content/50">
              Configures oracle, LTV (75%), liq threshold (85%), borrow factor (100), and ∞ deposit/borrow caps.
            </p>
          </div>
        )}
      </Card>

      {/* Market info — final reference card. */}
      <Card tone="muted" size="md">
        <SectionHeader eyebrow="Reference" title="Market" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
          <KeyValue label="Lending market" value={<span className="font-mono text-[11px]">{market.toBase58()}</span>} />
          <KeyValue label="Global config"  value={<span className="font-mono text-[11px]">{KLEND_GLOBAL.toBase58()}</span>} />
          <KeyValue label="klend program"  value={<span className="font-mono text-[11px]">{KLEND.toBase58()}</span>} />
          <KeyValue label="Governor"       value={<span className="font-mono text-[11px]">{config.programs.governor.toBase58()}</span>} />
        </div>
      </Card>
    </div>
  );
}
