import { useState, useEffect, useCallback, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  Button,
  Card,
  CardHeader,
  Input,
  PageHeader,
  SectionHeader,
} from "@clearstone/design-system";
import { usePrograms } from "../hooks/usePrograms";
import { useAuthority, authorityReason } from "../hooks/useAuthority";
import Dropdown from "../components/Dropdown";

// klend offsets
const BORROW_CURVE_OFFSET = 4920;

// klend program / market — pinned literals so this panel doesn't
// depend on hook order.
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

// `update_reserve_config` Anchor disc: sha256("global:update_reserve_config")[0..8]
const UPDATE_RESERVE_CONFIG_DISC = Buffer.from([61, 148, 100, 70, 143, 107, 17, 13]);
const MODE_UPDATE_BORROW_RATE_CURVE = 23;

interface CurvePoint {
  utilizationRateBps: number;
  borrowRateBps: number;
}

interface ReserveEntry {
  label: string;
  symbol: string;
  address: PublicKey;
}

// Production preset — same shape as cSOL's current curve: convex,
// strictly-increasing util, target 10% APR at 90% util kink, 45% cap.
const PRESET_PRODUCTION_SOL: CurvePoint[] = [
  { utilizationRateBps: 0,     borrowRateBps: 1 },
  { utilizationRateBps: 5000,  borrowRateBps: 200 },
  { utilizationRateBps: 8000,  borrowRateBps: 500 },
  { utilizationRateBps: 9000,  borrowRateBps: 1000 },
  { utilizationRateBps: 9500,  borrowRateBps: 1500 },
  { utilizationRateBps: 9700,  borrowRateBps: 2000 },
  { utilizationRateBps: 9800,  borrowRateBps: 2500 },
  { utilizationRateBps: 9900,  borrowRateBps: 3000 },
  { utilizationRateBps: 9950,  borrowRateBps: 3500 },
  { utilizationRateBps: 9980,  borrowRateBps: 4000 },
  { utilizationRateBps: 10000, borrowRateBps: 4500 },
];

// Stable-asset preset — gentler ramp suitable for sUSDC-style debt.
const PRESET_STABLE: CurvePoint[] = [
  { utilizationRateBps: 0,     borrowRateBps: 0 },
  { utilizationRateBps: 1000,  borrowRateBps: 50 },
  { utilizationRateBps: 4000,  borrowRateBps: 200 },
  { utilizationRateBps: 6000,  borrowRateBps: 400 },
  { utilizationRateBps: 7500,  borrowRateBps: 700 },
  { utilizationRateBps: 8500,  borrowRateBps: 1000 },
  { utilizationRateBps: 9000,  borrowRateBps: 1500 },
  { utilizationRateBps: 9500,  borrowRateBps: 2500 },
  { utilizationRateBps: 9700,  borrowRateBps: 3500 },
  { utilizationRateBps: 9900,  borrowRateBps: 4500 },
  { utilizationRateBps: 10000, borrowRateBps: 5000 },
];

// ---------------------------------------------------------------------------
// SVG Chart
// ---------------------------------------------------------------------------

// Chart viewBox — taller aspect ratio so the chart fills the card
// vertically (the right Curve Points card has 11 rows + header, which
// pulls the grid row tall; the chart was previously dwarfed by it).
const W = 560, H = 460;
const PAD = { top: 18, right: 26, bottom: 40, left: 60 };
const PW = W - PAD.left - PAD.right;
const PH = H - PAD.top - PAD.bottom;

// Brand-aligned palette — uses our design tokens so the chart matches
// the rest of the surface instead of generic cyan/amber.
const CURVE_LIVE  = "#0E7C9E"; // brand-teal — current on-chain curve
const CURVE_DRAFT = "#B89968"; // accent-warm — proposed/draft curve

// Smart percent formatter — keeps up to 2 decimals but drops trailing
// zeros so axis ticks stay tidy ("18%" not "18.00%") while sub-percent
// values render at full precision ("1.75%" not "1.8%").
function bps(v: number) {
  const pct = v / 100;
  const s = pct.toFixed(2).replace(/\.?0+$/, "");
  return s + "%";
}

function toPath(pts: CurvePoint[], maxR: number): string {
  return pts.map((p, i) => {
    const x = PAD.left + (p.utilizationRateBps / 10000) * PW;
    const y = PAD.top + PH - (Math.min(p.borrowRateBps, maxR) / maxR) * PH;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function Chart({ curve, draftCurve }: { curve: CurvePoint[]; draftCurve?: CurvePoint[] }) {
  const all = draftCurve ? [...curve, ...draftCurve] : curve;
  const rawMax = Math.max(...all.map(p => p.borrowRateBps), 100);
  const maxR = rawMax <= 1000 ? Math.ceil(rawMax / 200) * 200
    : rawMax <= 5000 ? Math.ceil(rawMax / 1000) * 1000
    : Math.ceil(rawMax / 5000) * 5000;

  const yTicks = Array.from({ length: 5 }, (_, i) => (maxR / 5) * (i + 1));
  const xTicks = [0, 2000, 4000, 6000, 8000, 10000];

  // Build a soft gradient fill under the live curve so the chart reads
  // as a filled area, not a thin line lost in white space. Anchor the
  // baseline at PH (chart bottom) so the fill stops at the x-axis.
  const areaPath =
    toPath(curve, maxR) +
    ` L ${(PAD.left + PW).toFixed(1)},${(PAD.top + PH).toFixed(1)}` +
    ` L ${PAD.left.toFixed(1)},${(PAD.top + PH).toFixed(1)} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 h-full w-full"
    >
      <defs>
        <linearGradient id="curve-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"   stopColor={CURVE_LIVE} stopOpacity="0.20" />
          <stop offset="100%" stopColor={CURVE_LIVE} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Plot frame — left + bottom axis lines drawn solid so the chart
          has a clear anchor instead of just floating gridlines. */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PH}
        stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />
      <line x1={PAD.left} y1={PAD.top + PH} x2={PAD.left + PW} y2={PAD.top + PH}
        stroke="currentColor" strokeOpacity={0.35} strokeWidth={1} />

      {/* Y gridlines + labels */}
      {[0, ...yTicks].map(v => {
        const y = PAD.top + PH - (v / maxR) * PH;
        return <g key={`y${v}`}>
          <line x1={PAD.left} y1={y} x2={PAD.left + PW} y2={y}
            stroke="currentColor" strokeOpacity={v === 0 ? 0 : 0.14}
            strokeDasharray="2 4" />
          <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize={11}
            fill="currentColor" fillOpacity={0.65}
            fontFamily="var(--font-mono)">{bps(v)}</text>
          {/* Tick mark for visibility against the axis line */}
          <line x1={PAD.left - 4} y1={y} x2={PAD.left} y2={y}
            stroke="currentColor" strokeOpacity={0.4} strokeWidth={1} />
        </g>;
      })}

      {/* X gridlines + labels */}
      {xTicks.map(v => {
        const x = PAD.left + (v / 10000) * PW;
        return <g key={`x${v}`}>
          <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + PH}
            stroke="currentColor" strokeOpacity={v === 0 ? 0 : 0.14}
            strokeDasharray="2 4" />
          <text x={x} y={PAD.top + PH + 18} textAnchor="middle" fontSize={11}
            fill="currentColor" fillOpacity={0.65}
            fontFamily="var(--font-mono)">{(v / 100)}%</text>
          <line x1={x} y1={PAD.top + PH} x2={x} y2={PAD.top + PH + 4}
            stroke="currentColor" strokeOpacity={0.4} strokeWidth={1} />
        </g>;
      })}

      {/* Axis titles */}
      <text x={PAD.left + PW / 2} y={H - 4} textAnchor="middle" fontSize={12}
        fill="currentColor" fillOpacity={0.7} fontWeight={500}
        letterSpacing="0.04em">Utilization</text>
      <text x={14} y={PAD.top + PH / 2} textAnchor="middle" fontSize={12}
        fill="currentColor" fillOpacity={0.7} fontWeight={500}
        letterSpacing="0.04em"
        transform={`rotate(-90,14,${PAD.top + PH / 2})`}>Borrow Rate (APR)</text>

      {/* Filled area under the live curve */}
      <path d={areaPath} fill="url(#curve-fill)" />

      {/* Live curve — brand teal, thicker stroke for legibility. */}
      <path d={toPath(curve, maxR)} fill="none" stroke={CURVE_LIVE}
        strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {curve.map((p, i) => {
        const x = PAD.left + (p.utilizationRateBps / 10000) * PW;
        const y = PAD.top + PH - (Math.min(p.borrowRateBps, maxR) / maxR) * PH;
        return (
          <g key={`o${i}`}>
            <circle cx={x} cy={y} r={5} fill="white" stroke={CURVE_LIVE} strokeWidth={2} />
          </g>
        );
      })}

      {/* Draft curve — dashed warm-accent so the user sees what they're
          about to apply alongside what's currently on-chain. */}
      {draftCurve && (
        <>
          <path d={toPath(draftCurve, maxR)} fill="none" stroke={CURVE_DRAFT}
            strokeWidth={2.5} strokeDasharray="7 4"
            strokeLinejoin="round" strokeLinecap="round" />
          {draftCurve.map((p, i) => {
            const x = PAD.left + (p.utilizationRateBps / 10000) * PW;
            const y = PAD.top + PH - (Math.min(p.borrowRateBps, maxR) / maxR) * PH;
            return (
              <circle key={`d${i}`} cx={x} cy={y} r={4.5} fill="white"
                stroke={CURVE_DRAFT} strokeWidth={2} />
            );
          })}
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Validation — klend's `validate_reserve_config_integrity` rules:
//   * 11 points exactly
//   * util strictly non-decreasing (duplicates allowed only at 10000)
//   * rate non-decreasing
//   * convex: per-segment slope monotonically non-decreasing
//
// klend's `skip_config_integrity_validation` flag (sent in the ix) is
// the OPPOSITE of "bypass everything": it requires the reserve to be
// in `is_predeposit` state (no deposits / below market minimum). For
// any in-use reserve we MUST send skipValidation=false so klend runs
// `validate_reserve_config_integrity` — which is what actually accepts
// well-formed curve updates on live reserves.
// ---------------------------------------------------------------------------

function validateCurve(pts: CurvePoint[]): string | null {
  if (pts.length !== 11) return `expected 11 points, got ${pts.length}`;
  if (pts[0].utilizationRateBps !== 0) return `point 1 must start at 0% util`;
  if (pts[10].utilizationRateBps !== 10000) return `point 11 must end at 100% util`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.utilizationRateBps < a.utilizationRateBps) {
      return `point ${i + 1}: util ${b.utilizationRateBps} < prev ${a.utilizationRateBps}`;
    }
    if (b.borrowRateBps < a.borrowRateBps) {
      return `point ${i + 1}: rate ${b.borrowRateBps} < prev ${a.borrowRateBps}`;
    }
  }
  // Convexity: slopes between consecutive distinct-util points
  // should be monotonically non-decreasing.
  let prevSlope = -Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const du = b.utilizationRateBps - a.utilizationRateBps;
    if (du === 0) continue;
    const slope = (b.borrowRateBps - a.borrowRateBps) / du;
    if (slope < prevSlope - 1e-9) {
      return `non-convex: slope drop at point ${i + 1} (${slope.toFixed(3)} < ${prevSlope.toFixed(3)})`;
    }
    prevSlope = slope;
  }
  return null;
}

function curveBuf(points: CurvePoint[]): Buffer {
  const buf = Buffer.alloc(88);
  points.forEach((p, i) => {
    buf.writeUInt32LE(p.utilizationRateBps, i * 8);
    buf.writeUInt32LE(p.borrowRateBps, i * 8 + 4);
  });
  return buf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function RateCurvePanel() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { config } = usePrograms();
  const authority = useAuthority();
  // Reserve config / curve updates require klend lendingMarket.owner
  // signature. Non-owner wallets can browse the curves but every Edit /
  // Apply / Reset button below is disabled with this tooltip.
  const writeReason = authorityReason(authority, "marketOwner");
  const canWriteCurve = authority.isMarketOwner;

  const reserveEntries: ReserveEntry[] = useMemo(() => {
    const market = config.market as any;
    const oracles = config.oracles as any;
    const list: ReserveEntry[] = [
      // Active EG-2 debt asset (post-2026-05-06 migration). Edit here
      // to tune the SOL borrow curve.
      ...(market.cSolReserve
        ? [{ label: "cSOL (EG-2 debt) — KYC-wrapped wSOL", symbol: "cSOL", address: market.cSolReserve as PublicKey }]
        : []),
      { label: "csSOL (EG-2 collateral)", symbol: "csSOL", address: market.csSolReserve },
      ...(market.csSolWtReserve
        ? [{ label: "csSOL-WT (EG-2 collateral, WT)", symbol: "csSOL-WT", address: market.csSolWtReserve as PublicKey }]
        : []),
      { label: "ceUSX (EG-1 collateral)", symbol: "ceUSX", address: market.ceUsxReserve },
      ...(market.ceUsxWtReserve
        ? [{ label: "ceUSX-WT (EG-1 collateral, WT)", symbol: "ceUSX-WT", address: market.ceUsxWtReserve as PublicKey }]
        : []),
      { label: "sUSDC (EG-1 / EG-3 debt)", symbol: "sUSDC", address: market.sUsdcReserve },
      // Legacy wSOL deliberately excluded from the dropdown — retired
      // 2026-05-06 (status=Hidden, deposit_limit=0). The reserve still
      // exists on chain for legacy-position read paths but operators
      // shouldn't be tuning a curve nobody can deposit/borrow against;
      // the manual-address input below is the escape hatch for the
      // rare case someone needs to inspect it.
    ];
    void oracles;
    return list;
  }, [config]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [customAddr, setCustomAddr] = useState("");
  const activeAddress = customAddr
    ? (() => { try { return new PublicKey(customAddr); } catch { return null; } })()
    : reserveEntries[selectedIdx]?.address ?? null;
  const activeSymbol = customAddr ? "custom" : reserveEntries[selectedIdx]?.symbol ?? "";

  const [curve, setCurve] = useState<CurvePoint[] | null>(null);
  const [loading, setLoading] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CurvePoint[]>([]);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchCurve = useCallback(async () => {
    if (!activeAddress) { setCurve(null); return; }
    setLoading(true);
    try {
      const info = await connection.getAccountInfo(activeAddress);
      if (!info || info.data.length < BORROW_CURVE_OFFSET + 88) { setCurve(null); setLoading(false); return; }
      const points: CurvePoint[] = [];
      for (let i = 0; i < 11; i++) {
        const off = BORROW_CURVE_OFFSET + i * 8;
        points.push({
          utilizationRateBps: info.data.readUInt32LE(off),
          borrowRateBps: info.data.readUInt32LE(off + 4),
        });
      }
      setCurve(points);
    } catch { setCurve(null); }
    setLoading(false);
  }, [activeAddress, connection]);

  useEffect(() => { fetchCurve(); }, [fetchCurve]);
  useEffect(() => { setEditing(false); setStatus(null); }, [activeAddress]);

  function startEdit() {
    setDraft(curve ? curve.map((p) => ({ ...p })) : PRESET_PRODUCTION_SOL.map((p) => ({ ...p })));
    setStatus(null);
    setEditing(true);
  }

  function applyPreset(preset: CurvePoint[]) {
    setDraft(preset.map((p) => ({ ...p })));
  }

  function updateDraftPoint(i: number, field: "utilizationRateBps" | "borrowRateBps", value: number) {
    setDraft((d) => d.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));
  }

  const draftValidation = useMemo(() => (editing ? validateCurve(draft) : null), [editing, draft]);

  const handleApply = useCallback(async () => {
    if (!publicKey || !activeAddress) return;
    if (draftValidation) { setStatus({ msg: `Curve invalid: ${draftValidation}`, type: "err" }); return; }
    setBusy(true);
    setStatus({ msg: "Building update_reserve_config tx…", type: "info" });
    try {
      const value = curveBuf(draft);
      const ixData = Buffer.alloc(1 + 4 + value.length + 1);
      ixData.writeUInt8(MODE_UPDATE_BORROW_RATE_CURVE, 0);
      ixData.writeUInt32LE(value.length, 1);
      value.copy(ixData, 5);
      // skipValidation = false: forces klend through `validate_reserve_config_integrity`,
      // which is the path that accepts curve edits on in-use reserves.
      // (skipValidation = true would *require* `is_predeposit` and reject
      // any reserve with deposits — see the comment block above.)
      ixData.writeUInt8(0, 5 + value.length);

      const ix = new TransactionInstruction({
        programId: KLEND,
        data: Buffer.concat([UPDATE_RESERVE_CONFIG_DISC, ixData]),
        keys: [
          { pubkey: publicKey,            isSigner: true,  isWritable: false },
          { pubkey: KLEND_GLOBAL,         isSigner: false, isWritable: false },
          { pubkey: config.market.lendingMarket, isSigner: false, isWritable: false },
          { pubkey: activeAddress,        isSigner: false, isWritable: true  },
        ],
      });

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(ix);

      // Simulate first so common failures (InvalidSigner, non-convex
      // curve, EG-id mismatch) surface before the user confirms in
      // their wallet.
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sim = await connection.simulateTransaction(tx);
      if (sim.value.err) {
        const lastLog = (sim.value.logs ?? []).slice(-3).join(" | ");
        setStatus({ msg: `Simulation failed: ${JSON.stringify(sim.value.err)} — ${lastLog}`, type: "err" });
        setBusy(false);
        return;
      }

      setStatus({ msg: "Sign in your wallet…", type: "info" });
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus({ msg: `Confirmed: ${sig.slice(0, 16)}…`, type: "ok" });
      setEditing(false);
      await fetchCurve();
    } catch (e: any) {
      setStatus({ msg: `Error: ${e.message?.slice(0, 200) ?? String(e)}`, type: "err" });
    }
    setBusy(false);
  }, [publicKey, sendTransaction, connection, activeAddress, draft, draftValidation, config, fetchCurve]);

  const displayCurve = useMemo(() => {
    if (!curve) return null;
    const unique: CurvePoint[] = [curve[0]];
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].utilizationRateBps !== curve[i - 1].utilizationRateBps ||
          curve[i].borrowRateBps !== curve[i - 1].borrowRateBps) {
        unique.push(curve[i]);
      }
    }
    return unique;
  }, [curve]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Operator"
        title="Rate Curves"
        subtitle={
          <>
            On-chain borrow rate curves for klend reserves. Edit + sign as the
            lending-market authority to apply changes via{" "}
            <code className="bg-base-300/70 border border-base-300 px-1.5 py-0.5 rounded text-[11px] font-mono">update_reserve_config(mode=23)</code>.
            Curves must satisfy klend's integrity check (11 points, util/rate
            non-decreasing, convex). Live reserves accept curve edits — the ix
            runs through klend's full integrity validator.
          </>
        }
      />

      {/* Reserve selector */}
      <Card>
        <CardHeader title="Select Reserve" />
        <div className="flex gap-3 flex-wrap items-start">
          <Dropdown
            value={selectedIdx}
            onChange={(v) => { setSelectedIdx(Number(v)); setCustomAddr(""); }}
            options={reserveEntries.map((r, i) => ({
              value: i,
              label: `${r.label} (${r.address.toBase58().slice(0, 8)}…)`,
            }))}
            className="min-w-[320px]"
          />
          <span className="h-10 inline-flex items-center px-1 text-xs uppercase tracking-[0.18em] text-base-content/45">or</span>
          <Input
            placeholder="Paste any reserve address"
            value={customAddr}
            onChange={(e) => setCustomAddr(e.target.value)}
            numeric
            className="font-mono"
            wrapperClassName="flex-1 min-w-[260px]"
          />
          {loading && (
            <span
              role="status"
              aria-label="Loading"
              className="h-10 inline-flex items-center"
            >
              <span
                className="inline-block h-4 w-4 rounded-full border-2 border-base-content/30 border-r-transparent"
                style={{ animation: "cs-spin 700ms linear infinite" }}
              />
            </span>
          )}
        </div>
        {activeAddress && (
          <div className="mt-3 text-[11px] font-mono text-base-content/45 break-all">{activeAddress.toBase58()}</div>
        )}
      </Card>

      {/* Chart + Table / Editor */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <Card className="flex flex-col">
          <CardHeader title="Borrow Rate Curve" />
          {curve ? (
            <div className="relative flex-1 min-h-[320px]">
              <Chart curve={curve} draftCurve={editing ? draft : undefined} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center min-h-[320px] text-sm text-base-content/40">
              {loading ? "Loading…" : "No curve data — select a valid reserve"}
            </div>
          )}
          {editing && (
            <div className="text-[11px] mt-3 text-base-content/60 flex items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-4 h-0.5" style={{ backgroundColor: CURVE_LIVE }} /> on-chain
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-4 h-0.5 border-t" style={{ borderColor: CURVE_DRAFT, borderStyle: "dashed" }} /> draft
              </span>
            </div>
          )}
        </Card>

        <Card>
          <SectionHeader
            title={editing ? `Editing — ${activeSymbol}` : "Curve Points"}
            actions={
              !editing && curve ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={startEdit}
                  disabled={!publicKey || !canWriteCurve}
                  title={!publicKey ? "Connect wallet to edit" : !canWriteCurve ? writeReason : "Edit curve"}
                >
                  Edit
                </Button>
              ) : editing ? (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
              ) : null
            }
            className="mb-4"
          />

          {editing ? (
            <div className="flex flex-col gap-4">
              <div className="flex gap-2 flex-wrap">
                <Button variant="secondary" size="xs" onClick={() => applyPreset(PRESET_PRODUCTION_SOL)} disabled={busy}>
                  Preset · production SOL
                </Button>
                <Button variant="secondary" size="xs" onClick={() => applyPreset(PRESET_STABLE)} disabled={busy}>
                  Preset · stable
                </Button>
                {curve && (
                  <Button variant="ghost" size="xs" onClick={() => setDraft(curve.map((p) => ({ ...p })))} disabled={busy}>
                    Reset to chain
                  </Button>
                )}
              </div>

              <div className="overflow-y-auto max-h-80 -mx-2 px-2 rounded-lg">
                <table className="w-full text-sm border-separate border-spacing-y-1">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.18em] text-base-content/55">
                      <th className="text-left font-medium pb-1 pl-2">#</th>
                      <th className="text-left font-medium pb-1">Util %</th>
                      <th className="text-left font-medium pb-1">Rate %</th>
                      <th className="text-left font-medium pb-1">Util bps</th>
                      <th className="text-left font-medium pb-1 pr-2">Rate bps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.map((p, i) => (
                      <tr key={i} className="bg-base-100/60 hover:bg-base-100 rounded-md">
                        <td className="font-mono text-base-content/45 pl-2 py-1.5 rounded-l-md">{i + 1}</td>
                        <td className="font-mono text-[11px] text-base-content/60 py-1.5">{(p.utilizationRateBps / 100).toFixed(2)}</td>
                        <td className="font-mono text-[11px] text-base-content/60 py-1.5">{(p.borrowRateBps / 100).toFixed(2)}</td>
                        <td className="py-1">
                          <Input
                            inputSize="sm"
                            type="number" min={0} max={10000}
                            value={p.utilizationRateBps}
                            onChange={(e) => updateDraftPoint(i, "utilizationRateBps", parseInt(e.target.value) || 0)}
                            numeric
                            wrapperClassName="w-28"
                          />
                        </td>
                        <td className="py-1 pr-2 rounded-r-md">
                          <Input
                            inputSize="sm"
                            type="number" min={0}
                            value={p.borrowRateBps}
                            onChange={(e) => updateDraftPoint(i, "borrowRateBps", parseInt(e.target.value) || 0)}
                            numeric
                            wrapperClassName="w-28"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {draftValidation && (
                <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
                  <span className="font-semibold">Invalid:</span> {draftValidation}
                </div>
              )}

              <Button
                variant="primary"
                size="md"
                onClick={handleApply}
                loading={busy}
                disabled={busy || !!draftValidation || !publicKey || !canWriteCurve}
                title={!canWriteCurve ? writeReason : undefined}
                fullWidth
              >
                Simulate + apply
              </Button>

              {status && (
                <div className={`text-xs break-all ${status.type === "err" ? "text-error" : status.type === "ok" ? "text-success" : "text-base-content/70"}`}>
                  {status.msg}
                </div>
              )}
            </div>
          ) : displayCurve ? (
            <div className="overflow-y-auto -mx-2 px-2">
              <table className="w-full text-sm border-separate border-spacing-y-0.5">
                <thead>
                  <tr className="text-[10px] uppercase tracking-[0.18em] text-base-content/55">
                    <th className="text-left font-medium pb-2 pl-2">#</th>
                    <th className="text-left font-medium pb-2">Utilization</th>
                    <th className="text-left font-medium pb-2 pr-2">Borrow Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {displayCurve.map((p, i) => (
                    <tr key={i} className="hover:bg-base-100/60 rounded-md">
                      <td className="font-mono text-base-content/45 py-1.5 pl-2 rounded-l-md">{i + 1}</td>
                      <td className="font-mono py-1.5">{bps(p.utilizationRateBps)}</td>
                      <td className="font-mono py-1.5 pr-2 rounded-r-md">{bps(p.borrowRateBps)}</td>
                    </tr>
                  ))}
                  {curve && displayCurve.length < curve.length && (
                    <tr><td colSpan={3} className="text-[11px] text-base-content/45 text-center pt-2">
                      +{curve.length - displayCurve.length} trailing points at {bps(displayCurve[displayCurve.length - 1].borrowRateBps)}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-sm text-base-content/40">No data</div>
          )}
        </Card>
      </div>
    </div>
  );
}
