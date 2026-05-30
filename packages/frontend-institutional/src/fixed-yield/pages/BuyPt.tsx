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

// Buy-PT flow — `clearstone_router.wrapper_buy_pt`.
//
//   user.base_ata ─► adapter.mint_sy ─► user.sy_ata
//                                          │
//                                          └► core.trade_pt(net_pt = +pt_amount)
//
// Hardwired to `generic_exchange_rate_sy` on the wrapper side
// (see periphery/clearstone_router/src/lib.rs::WrapperBuyPt — the
// sy_program field is `Program<'info, GenericExchangeRateSy>`). For the
// Kamino-backed devnet stack you'd need a kamino-specific buy_pt
// wrapper; not in scope here. Use the Setup tab's "Use test stack"
// button to switch to the canonicalStack handles, which use the generic
// adapter and can drive this wrapper.
//
// Account assembly: load MarketTwo on-chain for `cpi_accounts` /
// `address_lookup_table` / `token_pt_escrow` / `token_sy_escrow` /
// `token_fee_treasury_sy`, derive `base_vault` from `["pool_escrow",
// sy_market, base_mint]` under the SY adapter program id, and feed the
// SY-CPI extras through `remaining_accounts`. Same pattern Sourcing.tsx
// + LpProvision.tsx use.

const BUY_CU = 800_000;

// Generic adapter PDA seed — see `reference_adapters/generic_exchange_rate_sy::POOL_ESCROW_SEED`.
const POOL_ESCROW_SEED = Buffer.from("pool_escrow");

export function BuyPt() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { stack } = useStack();
  const provider = useAnchorProvider();

  const [marketPk, setMarketPk] = useState(stack.kaminoStack.ammMarket.toBase58());
  const [ptAmount, setPtAmount] = useState("100000");
  const [maxBase, setMaxBase] = useState("500000");
  // Negative because SY leaves the user when buying PT (core/trade_pt sign convention).
  const [maxSyIn, setMaxSyIn] = useState("-500000");
  const [busy, setBusy] = useState(false);
  // KYC-stack-compatible mode. The router's wrapper_buy_pt is hardwired
  // to generic_exchange_rate_sy; for kamino_sy_adapter (and any future
  // KYC adapter) the user mints SY first via Sourcing then trades it
  // directly with core.trade_pt — no router wrapper. This toggle picks
  // that path. Recommended for csSOL/csUSDC stacks.
  const [bareMode, setBareMode] = useState(false);
  const [position, setPosition] = useState<{
    base: bigint;
    sy: bigint;
    pt: bigint;
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
      setPosition({ base: pos.base, sy: pos.sy, pt: pos.pt });
    } catch (e) {
      log("error", `position read failed: ${formatError(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey?.toBase58(), stack.kaminoStack.ammMarket.toBase58()]);

  async function handleBuy() {
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
      log("info", `buy_pt(pt_amount=${ptAmount}, max_base=${maxBase}, max_sy_in=${maxSyIn})`);

      const core = new Program(
        idl.clearstoneCore,
        provider
      ) as unknown as Program;
      const router = new Program(
        idl.clearstoneRouter,
        provider
      ) as unknown as Program;

      // Read MarketTwo on-chain for cpi_accounts + ALT + escrows + treasury.
      const marketAcct = (await (core.account as Record<string, { fetch: (pk: PublicKey) => Promise<unknown> }>).marketTwo.fetch(
        market
      )) as {
        addressLookupTable: PublicKey;
        mintPt: PublicKey;
        mintSy: PublicKey;
        tokenPtEscrow: PublicKey;
        tokenSyEscrow: PublicKey;
        tokenFeeTreasurySy: PublicKey;
        syProgram: PublicKey;
        cpiAccounts: {
          getSyState: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
          depositSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
          withdrawSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
        };
      };

      // wrapper_buy_pt is hardwired to generic_exchange_rate_sy. The
      // KYC stacks (csSOL/csUSDC backed by kamino_sy_adapter) use the
      // bare-trade_pt path instead — see the toggle. Bail cleanly if
      // the user picked wrapper-mode against a non-generic adapter.
      if (!bareMode && !marketAcct.syProgram.equals(stack.programs.generic_exchange_rate_sy)) {
        log(
          "error",
          `market.sy_program=${marketAcct.syProgram.toBase58()} ≠ generic_exchange_rate_sy. Toggle "Bare trade_pt (KYC mode)" to use this market — it routes via core.trade_pt directly and works with any adapter.`
        );
        return;
      }

      const remainingAccounts = await syCpiRemainingAccounts({
        connection,
        cpiAccounts: marketAcct.cpiAccounts,
        alt: marketAcct.addressLookupTable,
      });
      log("info", `cpi extras = ${remainingAccounts.length} accounts`);

      // Generic adapter base_vault PDA: ["pool_escrow", sy_market, base_mint].
      const [baseVault] = PublicKey.findProgramAddressSync(
        [
          POOL_ESCROW_SEED,
          stack.kaminoStack.syMetadata.toBuffer(),
          stack.kaminoStack.baseMint.toBuffer(),
        ],
        marketAcct.syProgram
      );

      const { ata: userBaseAta, tokenProgram: baseTokenProgram } = await userAta(
        connection,
        publicKey,
        stack.kaminoStack.baseMint
      );
      const { ata: userSyAta } = await userAta(
        connection,
        publicKey,
        marketAcct.mintSy
      );
      const { ata: userPtAta, tokenProgram: ptTokenProgram } = await userAta(
        connection,
        publicKey,
        marketAcct.mintPt
      );

      // Pre-flight: surface a friendly warning if the user obviously
      // can't cover the spend.
      const baseBal = await ataBalance(connection, userBaseAta);
      if (baseBal < BigInt(maxBase)) {
        log("warn", `base balance ${baseBal} < max_base ${maxBase} — top up first`);
      }

      const [coreEventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        stack.programs.clearstone_core
      );

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: BUY_CU }))
        // Idempotent ATA inits — first-time users may not have these yet.
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            userSyAta,
            publicKey,
            marketAcct.mintSy,
            baseTokenProgram
          )
        )
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            userPtAta,
            publicKey,
            marketAcct.mintPt,
            ptTokenProgram
          )
        );

      let ix;
      if (bareMode) {
        // Bare core.trade_pt path. The user has SY already (minted via
        // Sourcing); no router wrapper, no kamino-specific accounts.
        // sy_program comes from the market itself, so this works for
        // any adapter (generic + kamino + future KYC adapters).
        const syBal = await ataBalance(connection, userSyAta);
        if (syBal === 0n) {
          log("warn", `SY balance is 0 — mint SY first in the Sourcing tab`);
        }
        ix = await core.methods
          .tradePt(new BN(ptAmount), new BN(maxSyIn))
          .accounts({
            trader: publicKey,
            market,
            tokenSyTrader: userSyAta,
            tokenPtTrader: userPtAta,
            tokenSyEscrow: marketAcct.tokenSyEscrow,
            tokenPtEscrow: marketAcct.tokenPtEscrow,
            addressLookupTable: marketAcct.addressLookupTable,
            tokenProgram: baseTokenProgram,
            syProgram: marketAcct.syProgram,
            tokenFeeTreasurySy: marketAcct.tokenFeeTreasurySy,
            mintSy: marketAcct.mintSy,
            eventAuthority: coreEventAuthority,
            program: stack.programs.clearstone_core,
          } as never)
          .remainingAccounts(remainingAccounts)
          .instruction();
        log("info", "using bare core.trade_pt (no router wrapper)");
      } else {
        ix = await router.methods
          .wrapperBuyPt(
            new BN(ptAmount),
            new BN(maxBase),
            new BN(maxSyIn)
          )
          .accounts({
            user: publicKey,
            syMarket: stack.kaminoStack.syMetadata,
            baseMint: stack.kaminoStack.baseMint,
            syMint: marketAcct.mintSy,
            baseSrc: userBaseAta,
            baseVault,
            market,
            sySrc: userSyAta,
            ptDst: userPtAta,
            marketEscrowSy: marketAcct.tokenSyEscrow,
            marketEscrowPt: marketAcct.tokenPtEscrow,
            marketAlt: marketAcct.addressLookupTable,
            tokenProgram: baseTokenProgram,
            tokenFeeTreasurySy: marketAcct.tokenFeeTreasurySy,
            syProgram: marketAcct.syProgram,
            coreProgram: stack.programs.clearstone_core,
            coreEventAuthority,
          } as never)
          .remainingAccounts(remainingAccounts)
          .instruction();
      }
      tx.add(ix);

      const sig = await sendTransaction(tx, connection);
      const conf = await connection.confirmTransaction(sig, "confirmed");
      if (conf.value.err) {
        log("error", `on-chain err: ${JSON.stringify(conf.value.err)}`);
      } else {
        log("info", `buy_pt confirmed: ${sig}`);
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
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Buy PT</h2>
      <p style={{ color: "#8a8a8a", fontSize: 13 }}>
        base → SY → PT in one tx via clearstone_router.wrapper_buy_pt.
        Leftover SY stays in your SY ATA. Hardwired to the generic
        exchange-rate adapter — switch to the test stack in Setup if the
        live stack uses kamino_sy_adapter.
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
          <Stat label="base" value={position.base} />
          <Stat label="SY" value={position.sy} />
          <Stat label="PT" value={position.pt} />
        </div>
      )}

      <div style={{ display: "grid", gap: 12, maxWidth: 540 }}>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            fontSize: 13,
            background: "#161618",
            border: "1px solid #2a2a2e",
            borderRadius: 4,
            padding: "8px 12px",
          }}
        >
          <input
            type="checkbox"
            checked={bareMode}
            onChange={(e) => setBareMode(e.target.checked)}
          />
          <span>
            Bare <code>core.trade_pt</code> (KYC mode)
          </span>
          <span style={{ color: "#666", fontSize: 11 }}>
            — works with kamino_sy_adapter / csSOL / csUSDC stacks. Requires
            you to mint SY first in the Sourcing tab; max_base is ignored.
          </span>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          <span style={{ color: "#8a8a8a" }}>Market</span>
          <MarketPicker value={marketPk} onChange={setMarketPk} />
        </label>
        <Field label="PT amount (out)" value={ptAmount} onChange={setPtAmount} />
        {!bareMode && (
          <FieldWithMax
            label="Max base spend"
            value={maxBase}
            onChange={setMaxBase}
            available={position?.base}
          />
        )}
        <Field
          label="Max SY in (negative — SY leaves user)"
          value={maxSyIn}
          onChange={setMaxSyIn}
        />
        <button onClick={handleBuy} style={btnStyle} disabled={busy}>
          {busy ? "submitting…" : bareMode ? "Build + sign (trade_pt)" : "Build + sign"}
        </button>
      </div>

      <div style={{ marginTop: 24 }}>
        <LogPanel title="buy_pt log" />
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

function Field({
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
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
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

const btnStyle: React.CSSProperties = {
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
