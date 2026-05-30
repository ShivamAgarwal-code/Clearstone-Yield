import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useStack } from "../lib/stack-context.js";
import {
  bytesToHex,
  hexToBytes,
  orderHash as computeOrderHash,
} from "../lib/order.js";
import { formatError } from "../lib/format.js";

// Self-solve intent flow.
//
// One wallet plays BOTH the maker (signs the OrderConfig) AND the
// solver (submits the fill). The flow:
//
//   1. Maker side: build an OrderConfig, hash it under fusion's
//      `order_hash` rule, sign the hash with `wallet.signMessage()`.
//   2. Solver side: take the (orderConfig, signature, hash) bundle
//      and build [Ed25519.verify, core.flash_swap_pt(...)] for
//      submission. Same wallet signs the outer tx.
//
// This page does step 1 fully (real signing via the wallet) and stops
// at step 2 with the bundle previewed for export. Submitting the
// flash_swap_pt + fusion.fill chain requires loading the IDLs and
// resolving the market's ALT — that's the work scoped in
// `scripts/clearstone_pt_solver/src/{route,fill}.ts`. The "Self-solve
// (stub)" button below dispatches with a clear log message.

export function IntentFill() {
  const { connection } = useConnection();
  const { publicKey, signMessage } = useWallet();
  const { stack } = useStack();
  const [direction, setDirection] = useState<"buy_pt" | "sell_pt">("buy_pt");
  const [srcAmount, setSrcAmount] = useState("1000000");
  const [minDst, setMinDst] = useState("100000");
  const [expirationSec, setExpirationSec] = useState(
    () => Math.floor(Date.now() / 1000) + 3600
  );
  const [bundle, setBundle] = useState<{
    orderHashHex: string;
    signatureHex: string;
    srcMint: PublicKey;
    dstMint: PublicKey;
    config: Record<string, unknown>;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const srcMint =
    direction === "buy_pt" ? stack.kaminoStack.syMint : stack.kaminoStack.mintPt;
  const dstMint =
    direction === "buy_pt" ? stack.kaminoStack.mintPt : stack.kaminoStack.syMint;

  async function handleSign() {
    setError(null);
    setBundle(null);
    setStatus(null);
    if (!publicKey || !signMessage) {
      setError("connect a wallet that supports signMessage (Phantom, Backpack, …)");
      return;
    }
    try {
      // Build the OrderConfig matching fusion's IDL shape. Borsh layout
      // verified against `tests/fusion_sign.ts::buildSimpleOrder`. Field
      // order matters — fusion's `order.try_to_vec()` reads them in
      // declaration order.
      const config = {
        id: 1,
        srcAmount: BigInt(srcAmount),
        minDstAmount: BigInt(minDst),
        estimatedDstAmount: BigInt(minDst),
        expirationTime: expirationSec,
        dstAssetIsNative: false,
        fee: { protocolFee: 0, integratorFee: 0, surplusPercentage: 0 },
        dutchAuctionData: {
          startTime: 0,
          duration: 0,
          initialRateBump: 0,
          pointsAndTimeDeltas: [] as unknown[],
        },
        resolverPolicy: { allowedList: [] as PublicKey[] },
      };
      // Borsh-encode. The full IDL coder lives in `clearstone_fusion.ts`
      // (vendored in scripts/clearstone_pt_solver/src/). For the demo
      // we use a minimal hand-rolled encoder that covers the
      // permissionless / no-auction / no-fee path; production should
      // load the real IDL. See lib/order.ts.
      const orderBytes = encodeSimpleOrder(config);
      const hash = await computeOrderHash({
        fusionProgramId: stack.programs.clearstone_fusion,
        orderBytes,
        protocolDstAcc: null,
        integratorDstAcc: null,
        srcMint,
        dstMint,
        makerReceiver: publicKey,
      });
      const signature = await signMessage(hash);
      setBundle({
        orderHashHex: bytesToHex(hash),
        signatureHex: bytesToHex(signature),
        srcMint,
        dstMint,
        config: {
          ...config,
          srcAmount: config.srcAmount.toString(),
          minDstAmount: config.minDstAmount.toString(),
          estimatedDstAmount: config.estimatedDstAmount.toString(),
        },
      });
      setStatus(`signed order. order_hash = ${bytesToHex(hash).slice(0, 16)}…`);
    } catch (e: unknown) {
      setError(formatError(e));
    }
  }

  async function handleSelfSolve() {
    if (!bundle) {
      setStatus("sign the order first");
      return;
    }
    if (!publicKey) {
      setStatus("connect a wallet first");
      return;
    }
    // Sanity-check the signature is well-formed before claiming we'd
    // submit. Real submission needs the IDL-driven flash_swap_pt
    // builder (see clearstone_pt_solver). The demo stops here so the
    // bundle can be exported to a CLI test or pasted into the solver.
    const sigBytes = hexToBytes(bundle.signatureHex);
    if (sigBytes.length !== 64) {
      setStatus(`unexpected signature length ${sigBytes.length} (want 64)`);
      return;
    }
    // Touch `connection` so the import is justified — a real solver
    // path would pre-fetch market state here for ALT resolution.
    void connection;
    setStatus(
      `[stub] self-solve would build [Ed25519.verify, core.flash_swap_${
        direction === "buy_pt" ? "pt" : "sy"
      }(...)], sign + submit as the solver. Bundle is valid (hash + 64-byte signature). Export it via "Copy bundle JSON" and pipe to the clearstone_pt_solver to actually fill.`
    );
  }

  function handleCopy() {
    if (!bundle) return;
    const json = JSON.stringify(
      {
        orderHash: bundle.orderHashHex,
        signature: bundle.signatureHex,
        makerPubkey: publicKey?.toBase58(),
        srcMint: bundle.srcMint.toBase58(),
        dstMint: bundle.dstMint.toBase58(),
        config: bundle.config,
      },
      null,
      2
    );
    void navigator.clipboard.writeText(json);
    setStatus("bundle copied to clipboard");
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Self-solve intent</h2>
      <p style={{ color: "#8a8a8a", fontSize: 13 }}>
        Sign an OrderConfig with the connected wallet, then (optionally)
        submit the matching flash-swap to fill it as the solver. The same
        wallet plays both roles. See{" "}
        <a href="https://github.com/1delta-DAO/clearstone-fixed-yield/blob/main/FLOWS.md#3-intent-routed-buy--sell-via-clearstone_fusion">
          FLOWS.md §3
        </a>{" "}
        for the on-chain shape.
      </p>

      <div style={{ display: "grid", gap: 12, maxWidth: 540 }}>
        <Field label="Direction">
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
            style={inputStyle}
          >
            <option value="buy_pt">buy PT (src=SY, dst=PT)</option>
            <option value="sell_pt">sell PT (src=PT, dst=SY)</option>
          </select>
        </Field>
        <Field label={`src_amount (${direction === "buy_pt" ? "SY" : "PT"})`}>
          <input
            value={srcAmount}
            onChange={(e) => setSrcAmount(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label={`min_dst_amount (${direction === "buy_pt" ? "PT" : "SY"})`}>
          <input
            value={minDst}
            onChange={(e) => setMinDst(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Field label="expiration (unix seconds)">
          <input
            type="number"
            value={expirationSec}
            onChange={(e) => setExpirationSec(Number(e.target.value))}
            style={inputStyle}
          />
        </Field>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSign} style={btnPrimary} disabled={!publicKey}>
            1. Sign as maker
          </button>
          <button onClick={handleSelfSolve} style={btnSecondary} disabled={!bundle}>
            2. Self-solve
          </button>
          <button onClick={handleCopy} style={btnSecondary} disabled={!bundle}>
            Copy bundle JSON
          </button>
        </div>

        {error && (
          <div style={{ ...statusBox, color: "#f88", borderColor: "#622" }}>{error}</div>
        )}
        {bundle && (
          <pre style={{ ...statusBox, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {`order_hash:    ${bundle.orderHashHex}
signature:     ${bundle.signatureHex.slice(0, 32)}…
src_mint:      ${bundle.srcMint.toBase58()}
dst_mint:      ${bundle.dstMint.toBase58()}
maker:         ${publicKey?.toBase58()}`}
          </pre>
        )}
        {status && <div style={statusBox}>{status}</div>}
      </div>

      <div style={{ marginTop: 24, fontSize: 11, color: "#666" }}>
        Fusion: <code>{stack.programs.clearstone_fusion.toBase58()}</code>
        <br />
        Market: <code>{stack.kaminoStack.ammMarket.toBase58()}</code>
      </div>
    </div>
  );
}

/**
 * Minimal borsh encoder for the demo's narrow OrderConfig shape
 * (id u32, srcAmount u64, minDstAmount u64, estimatedDstAmount u64,
 *  expirationTime u32, dstAssetIsNative bool, fee {3 × u16},
 *  dutchAuctionData {startTime u32, duration u32, initialRateBump u16,
 *                     pointsAndTimeDeltas vec<...>=empty},
 *  resolverPolicy enum AllowedList(vec<Pubkey>=empty) [tag=0]).
 *
 * For full borsh, plug in the IDL coder. Bytes match
 * tests/fusion_sign.ts when its config has the same shape.
 */
function encodeSimpleOrder(c: {
  id: number;
  srcAmount: bigint;
  minDstAmount: bigint;
  estimatedDstAmount: bigint;
  expirationTime: number;
}): Uint8Array {
  const buf: number[] = [];
  // u32 id
  pushU32(buf, c.id);
  pushU64(buf, c.srcAmount);
  pushU64(buf, c.minDstAmount);
  pushU64(buf, c.estimatedDstAmount);
  pushU32(buf, c.expirationTime);
  buf.push(0); // dstAssetIsNative = false
  pushU16(buf, 0); // fee.protocolFee
  pushU16(buf, 0); // fee.integratorFee
  pushU16(buf, 0); // fee.surplusPercentage
  pushU32(buf, 0); // dutch.startTime
  pushU32(buf, 0); // dutch.duration
  pushU16(buf, 0); // dutch.initialRateBump
  pushU32(buf, 0); // dutch.pointsAndTimeDeltas length = 0
  buf.push(0); // resolverPolicy variant tag = 0 (AllowedList)
  pushU32(buf, 0); // AllowedList vec length = 0
  return new Uint8Array(buf);
}

function pushU16(buf: number[], v: number) {
  buf.push(v & 0xff, (v >> 8) & 0xff);
}
function pushU32(buf: number[], v: number) {
  buf.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
}
function pushU64(buf: number[], v: bigint) {
  for (let i = 0; i < 8; i++) {
    buf.push(Number((v >> BigInt(8 * i)) & 0xffn));
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ color: "#8a8a8a" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#161618",
  color: "#e8e8e8",
  border: "1px solid #2a2a2e",
  padding: "8px 10px",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
};
const btnPrimary: React.CSSProperties = {
  background: "#6cf",
  color: "#0e0e10",
  border: "none",
  padding: "10px 16px",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "#e8e8e8",
  border: "1px solid #2a2a2e",
  padding: "10px 16px",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};
const statusBox: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: "#8a8a8a",
  background: "#161618",
  border: "1px solid #2a2a2e",
  padding: "10px 12px",
  borderRadius: 4,
};
