import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { useStack } from "../lib/stack-context.js";
import { useAnchorProvider, idl } from "../lib/anchor.js";
import {
  ataBalance,
  readPosition,
  syCpiRemainingAccounts,
  userAta,
} from "../lib/accounts.js";
import { formatError } from "../lib/format.js";
import { useTxLog } from "../components/TxLog.js";
import { MarketPicker } from "../components/MarketPicker.js";

// LP provision flow — `clearstone_router.wrapper_provide_liquidity_classic`.
//
// The user must hold PT + SY before calling this. Use the Sourcing tab to
// mint SY then strip into PT+YT first; bring SY back to the desired ratio
// via Buy PT or by holding both. The "classic" wrapper does NOT mint_sy
// internally — non-classic `wrapper_provide_liquidity` is the auto-mint
// variant (not wired here yet).
//
// Wire shape: the wrapper just CPIs `core.market_two_deposit_liquidity`,
// which itself CPIs the SY adapter's `withdraw_sy` (to compute the
// exchange rate and route SY into the LP escrow). Means we MUST include
// the market's `cpi_accounts` SY extras in `remaining_accounts`. We
// derive them from MarketTwo on-chain — same pattern as Sourcing.tsx
// reads `vault.cpi_accounts` for the strip ix.

const LP_CU = 800_000;

export function LpProvision() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { stack } = useStack();
  const provider = useAnchorProvider();

  const [marketPk, setMarketPk] = useState(stack.kaminoStack.ammMarket.toBase58());
  const [ptIntent, setPtIntent] = useState("100000");
  const [syIntent, setSyIntent] = useState("100000");
  const [minLpOut, setMinLpOut] = useState("1");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<{
    pt: bigint;
    sy: bigint;
    lp: bigint;
  } | null>(null);

  const { log, LogPanel } = useTxLog();

  async function refresh() {
    if (!publicKey) return;
    try {
      const pos = await readPosition({
        connection,
        owner: publicKey,
        baseMint: stack.kaminoStack.baseMint,
        syMint: stack.kaminoStack.syMint,
        ptMint: stack.kaminoStack.mintPt,
        ytMint: stack.kaminoStack.mintYt,
        lpMint: stack.kaminoStack.mintLp,
      });
      setPosition({ pt: pos.pt, sy: pos.sy, lp: pos.lp });
    } catch (e) {
      log("error", `position read failed: ${formatError(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey?.toBase58(), stack.kaminoStack.ammMarket.toBase58()]);

  async function handleProvide() {
    if (!publicKey || !provider || !sendTransaction) {
      log("error", "connect a wallet");
      return;
    }
    let market: PublicKey;
    try {
      market = new PublicKey(marketPk);
    } catch {
      log("error", "invalid market pubkey");
      return;
    }
    setBusy(true);
    try {
      log("info", `provide_liquidity_classic(pt=${ptIntent}, sy=${syIntent}, min_lp_out=${minLpOut})`);

      const core = new Program(
        idl.clearstoneCore,
        provider
      ) as unknown as Program;
      const router = new Program(
        idl.clearstoneRouter,
        provider
      ) as unknown as Program;

      // Read MarketTwo for cpi_accounts + ALT + escrow handles.
      const marketAcct = (await (core.account as Record<string, { fetch: (pk: PublicKey) => Promise<unknown> }>).marketTwo.fetch(
        market
      )) as {
        addressLookupTable: PublicKey;
        mintPt: PublicKey;
        mintSy: PublicKey;
        mintLp: PublicKey;
        tokenPtEscrow: PublicKey;
        tokenSyEscrow: PublicKey;
        syProgram: PublicKey;
        cpiAccounts: {
          getSyState: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
          depositSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
          withdrawSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
        };
      };

      const remainingAccounts = await syCpiRemainingAccounts({
        connection,
        cpiAccounts: marketAcct.cpiAccounts,
        alt: marketAcct.addressLookupTable,
      });
      log("info", `cpi extras = ${remainingAccounts.length} accounts`);

      const { ata: userBaseAta } = await userAta(
        connection,
        publicKey,
        stack.kaminoStack.baseMint
      );
      const { ata: userSyAta, tokenProgram: syTokenProgram } = await userAta(
        connection,
        publicKey,
        marketAcct.mintSy
      );
      const { ata: userPtAta, tokenProgram: ptTokenProgram } = await userAta(
        connection,
        publicKey,
        marketAcct.mintPt
      );
      const { ata: userLpAta, tokenProgram: lpTokenProgram } = await userAta(
        connection,
        publicKey,
        marketAcct.mintLp
      );

      // Pre-flight: classic wrapper requires the user to hold PT + SY
      // already. Catch the trivial empty-balance case here so we don't
      // burn an on-chain revert + tx fee.
      const [ptBal, syBal] = await Promise.all([
        ataBalance(connection, userPtAta),
        ataBalance(connection, userSyAta),
      ]);
      if (ptBal < BigInt(ptIntent)) {
        log("warn", `PT balance ${ptBal} < pt_intent ${ptIntent} — strip first`);
      }
      if (syBal < BigInt(syIntent)) {
        log("warn", `SY balance ${syBal} < sy_intent ${syIntent} — mint_sy first`);
      }

      const [coreEventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        stack.programs.clearstone_core
      );

      // base_vault is required by the accounts struct even though classic
      // doesn't use it. Use poolEscrow as a placeholder — the constraint
      // is just `Box<InterfaceAccount<'info, TokenAccount>>` (any valid
      // token account works since the wrapper never reads it on the
      // classic path).
      const baseVault = stack.kaminoStack.poolEscrow;

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: LP_CU }))
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            userLpAta,
            publicKey,
            marketAcct.mintLp,
            lpTokenProgram
          )
        );

      const ix = await router.methods
        .wrapperProvideLiquidityClassic(
          new BN(ptIntent),
          new BN(syIntent),
          new BN(minLpOut)
        )
        .accounts({
          user: publicKey,
          syMarket: stack.kaminoStack.syMetadata,
          baseMint: stack.kaminoStack.baseMint,
          syMint: marketAcct.mintSy,
          baseSrc: userBaseAta,
          baseVault,
          market,
          ptSrc: userPtAta,
          sySrc: userSyAta,
          escrowPt: marketAcct.tokenPtEscrow,
          escrowSy: marketAcct.tokenSyEscrow,
          lpDst: userLpAta,
          mintLp: marketAcct.mintLp,
          addressLookupTable: marketAcct.addressLookupTable,
          tokenProgram: syTokenProgram,
          syProgram: marketAcct.syProgram,
          coreProgram: stack.programs.clearstone_core,
          coreEventAuthority,
        } as never)
        .remainingAccounts(remainingAccounts)
        .instruction();
      tx.add(ix);

      // Silence ptTokenProgram unused warning — keep it logged for the
      // operator who's debugging mint mismatches.
      log("info", `pt token program = ${ptTokenProgram.toBase58().slice(0, 8)}…`);

      const sig = await sendTransaction(tx, connection);
      const conf = await connection.confirmTransaction(sig, "confirmed");
      if (conf.value.err) {
        log("error", `on-chain err: ${JSON.stringify(conf.value.err)}`);
      } else {
        log("info", `provide_liquidity confirmed: ${sig}`);
      }
      await refresh();
    } catch (e) {
      log("error", formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Provide liquidity</h2>
      <p style={{ color: "#8a8a8a", fontSize: 13 }}>
        PT + SY → LP via clearstone_router.wrapper_provide_liquidity_classic.
        You must hold PT and SY beforehand — strip from SY in the Sourcing
        tab first if you only have base / SY.
      </p>

      {position && (
        <div
          style={{
            display: "grid",
            gap: 6,
            gridTemplateColumns: "repeat(3, 1fr)",
            background: "#161618",
            border: "1px solid #2a2a2e",
            borderRadius: 4,
            padding: "10px 14px",
            margin: "12px 0",
          }}
        >
          <Stat label="PT" value={position.pt} />
          <Stat label="SY" value={position.sy} />
          <Stat label="LP" value={position.lp} />
        </div>
      )}

      <div style={{ display: "grid", gap: 12, maxWidth: 540 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          <span style={{ color: "#8a8a8a" }}>Market</span>
          <MarketPicker value={marketPk} onChange={setMarketPk} />
        </label>
        <FieldWithMax
          label="PT intent"
          value={ptIntent}
          onChange={setPtIntent}
          available={position?.pt}
        />
        <FieldWithMax
          label="SY intent"
          value={syIntent}
          onChange={setSyIntent}
          available={position?.sy}
        />
        <F label="Min LP out (slippage floor)" value={minLpOut} onChange={setMinLpOut} />
        <button onClick={handleProvide} style={btn} disabled={busy}>
          {busy ? "submitting…" : "Build + sign"}
        </button>
      </div>

      <div style={{ marginTop: 24 }}>
        <LogPanel title="provide_liquidity log" />
      </div>

      <div style={{ marginTop: 24, fontSize: 11, color: "#666" }}>
        Router: <code>{stack.programs.clearstone_router.toBase58()}</code>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: bigint }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 14 }}>
        {value.toString()}
      </div>
    </div>
  );
}

function F({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ color: "#8a8a8a" }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </label>
  );
}

function FieldWithMax({
  label,
  value,
  onChange,
  available,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  available?: bigint;
}) {
  const setPct = (pct: number) => {
    if (available == null) return;
    const next = (available * BigInt(pct)) / 100n;
    onChange(next.toString());
  };
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ color: "#8a8a8a" }}>
        {label}
        {available != null && (
          <span style={{ marginLeft: 8, color: "#666" }}>
            avail {available.toString()}
          </span>
        )}
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        {[25, 50, 100].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPct(p)}
            style={pctBtn}
            disabled={available == null}
          >
            {p}%
          </button>
        ))}
      </div>
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

const pctBtn: React.CSSProperties = {
  background: "transparent",
  color: "#8a8a8a",
  border: "1px solid #2a2a2e",
  padding: "4px 10px",
  borderRadius: 4,
  fontSize: 11,
  cursor: "pointer",
};

const btn: React.CSSProperties = {
  background: "#6cf",
  color: "#0e0e10",
  border: "none",
  padding: "10px 16px",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  width: "max-content",
};
