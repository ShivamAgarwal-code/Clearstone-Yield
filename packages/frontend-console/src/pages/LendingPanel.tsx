import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { usePrograms } from "../hooks/usePrograms";
import {
  buildRefreshReserveIx,
  reserveCollateralMint,
  reserveCollateralSupply,
  reserveLiquiditySupply,
  lendingMarketAuthority,
  feeReceiver,
} from "../lib/klend";


const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

const DISC: Record<string, Buffer> = {
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refresh_obligation: Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]),
  deposit_reserve_liquidity_and_obligation_collateral: Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]),
  borrow_obligation_liquidity: Buffer.from([121, 127, 18, 204, 73, 245, 225, 65]),
  init_obligation: Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]),
  init_user_metadata: Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]),
};
function disc(name: string): Buffer {
  return (DISC as any)[name] || Buffer.alloc(8);
}

export default function LendingPanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { config } = usePrograms();

  const [depositAmt, setDepositAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");
  const [dUsdyBalance, setDUsdyBalance] = useState<string | null>(null);
  const [wsolBalance, setWsolBalance] = useState<string | null>(null);
  const [isWhitelisted, setIsWhitelisted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [obligationAddr, setObligationAddr] = useState<string | null>(null);

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 10000);
  };

  // Derive obligation PDA
  const getObligationPda = useCallback(() => {
    if (!publicKey) return null;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from([0]), Buffer.from([0]), publicKey.toBuffer(), config.market.lendingMarket.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
      KLEND
    );
    return pda;
  }, [publicKey, config]);

  // Fetch balances + obligation status
  useEffect(() => {
    if (!publicKey || !connected) return;
    let cancelled = false;

    (async () => {
      try {
        const dUsdyAta = getAssociatedTokenAddressSync(config.pool.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const dBal = await connection.getTokenAccountBalance(dUsdyAta).catch(() => null);
        if (!cancelled) setDUsdyBalance(dBal ? (Number(dBal.value.amount) / 1e6).toFixed(2) : "0.00");

        try {
          const wsolAta = getAssociatedTokenAddressSync(config.market.wsolMint, publicKey, false, TOKEN_PROGRAM_ID);
          const wBal = await connection.getTokenAccountBalance(wsolAta).catch(() => null);
          // wSOL is 9-decimal; the previous /1e6 rendered values 1000× too low
          if (!cancelled) setWsolBalance(wBal ? (Number(wBal.value.amount) / 1e9).toFixed(4) : "0.0000");
        } catch { if (!cancelled) setWsolBalance("0.0000"); }

        const [wlEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
          config.programs.deltaMint
        );
        const wlInfo = await connection.getAccountInfo(wlEntry);
        if (!cancelled) setIsWhitelisted(!!wlInfo);

        const obPda = getObligationPda();
        if (obPda) {
          const obInfo = await connection.getAccountInfo(obPda);
          if (!cancelled) setObligationAddr(obInfo ? obPda.toBase58() : null);
        }
      } catch {
        if (!cancelled) { setDUsdyBalance("0.00"); setIsWhitelisted(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey, connected, connection, config, getObligationPda]);

  // --- Deposit csSOL as collateral ---
  const handleDeposit = useCallback(async () => {
    if (!publicKey || !depositAmt || Number(depositAmt) <= 0) return;
    setLoading(true);
    showStatus("Depositing csSOL collateral...");

    try {
      const market = config.market.lendingMarket;
      const reserve = config.market.csSolReserve;
      const oracle = config.oracles.csSolOracle;
      const dUsdyMint = config.pool.wrappedMint;
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND);
      const obPda = getObligationPda()!;
      const dUsdyAta = getAssociatedTokenAddressSync(dUsdyMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const amount = Buffer.alloc(8);
      amount.writeBigUInt64LE(BigInt(Math.floor(Number(depositAmt) * 1e6)), 0);

      const tx = new Transaction();

      // Create obligation if needed
      if (!obligationAddr) {
        // UserMetadata
        const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);
        const metaInfo = await connection.getAccountInfo(userMeta);
        if (!metaInfo) {
          tx.add({
            programId: KLEND,
            data: Buffer.concat([DISC.init_user_metadata, PublicKey.default.toBuffer()]),
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: false },
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: userMeta, isSigner: false, isWritable: true },
              { pubkey: KLEND, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
          });
        }
        // InitObligation
        tx.add({
          programId: KLEND,
          data: Buffer.concat([DISC.init_obligation, Buffer.from([0, 0])]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: obPda, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: userMeta, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        });
      }

      // RefreshReserve → RefreshObligation → Deposit
      tx.add(buildRefreshReserveIx(reserve, market, oracle));
      tx.add({
        programId: KLEND, data: DISC.refresh_obligation,
        keys: [
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          // remaining: one per existing deposit (none if new obligation)
          ...(obligationAddr ? [{ pubkey: reserve, isSigner: false, isWritable: false }] : []),
        ],
      });
      tx.add({
        programId: KLEND,
        data: Buffer.concat([DISC.deposit_reserve_liquidity_and_obligation_collateral, amount]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: reserve, isSigner: false, isWritable: true },
          { pubkey: dUsdyMint, isSigner: false, isWritable: false },
          { pubkey: reserveLiquiditySupply(reserve), isSigner: false, isWritable: true },
          { pubkey: reserveCollateralMint(reserve), isSigner: false, isWritable: true },
          { pubkey: reserveCollateralSupply(reserve), isSigner: false, isWritable: true },
          { pubkey: dUsdyAta, isSigner: false, isWritable: true },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Deposited ${depositAmt} csSOL! Tx: ${sig.slice(0, 20)}...`, "ok");
      setDepositAmt("");
      setObligationAddr(obPda.toBase58());
    } catch (e: any) {
      showStatus(`Deposit failed: ${e.message?.slice(0, 100)}`, "err");
    }
    setLoading(false);
  }, [publicKey, depositAmt, connection, config, sendTransaction, getObligationPda, obligationAddr]);

  // --- Borrow wSOL ---
  const handleBorrow = useCallback(async () => {
    if (!publicKey || !borrowAmt || Number(borrowAmt) <= 0 || !obligationAddr) return;
    setLoading(true);
    showStatus("Borrowing wSOL...");

    try {
      const market = config.market.lendingMarket;
      const csSolReserve = config.market.csSolReserve;
      const wsolReserve = config.market.wsolReserve;
      const csSolOracle = config.oracles.csSolOracle;
      const wsolOracle = config.oracles.wsolOracle;
      const wsolMint = config.market.wsolMint;
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND);
      const obPda = new PublicKey(obligationAddr);
      const userWsolAta = getAssociatedTokenAddressSync(wsolMint, publicKey, false, TOKEN_PROGRAM_ID);
      const amount = Buffer.alloc(8);
      amount.writeBigUInt64LE(BigInt(Math.floor(Number(borrowAmt) * 1e6)), 0);

      const tx = new Transaction();

      // Create wSOL ATA if needed
      const ataInfo = await connection.getAccountInfo(userWsolAta);
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, userWsolAta, publicKey, wsolMint));
      }

      // RefreshReserve (collateral) → RefreshReserve (borrow) → RefreshObligation → Borrow
      tx.add(buildRefreshReserveIx(csSolReserve, market, csSolOracle));
      tx.add(buildRefreshReserveIx(wsolReserve, market, wsolOracle));
      tx.add({
        programId: KLEND, data: DISC.refresh_obligation,
        keys: [
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: csSolReserve, isSigner: false, isWritable: false },
        ],
      });
      tx.add({
        programId: KLEND,
        data: Buffer.concat([DISC.borrow_obligation_liquidity, amount]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: wsolReserve, isSigner: false, isWritable: true },
          { pubkey: wsolMint, isSigner: false, isWritable: false },
          { pubkey: reserveLiquiditySupply(wsolReserve), isSigner: false, isWritable: true },
          { pubkey: feeReceiver(wsolReserve), isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Borrowed ${borrowAmt} wSOL! Tx: ${sig.slice(0, 20)}...`, "ok");
      setBorrowAmt("");
    } catch (e: any) {
      showStatus(`Borrow failed: ${e.message?.slice(0, 100)}`, "err");
    }
    setLoading(false);
  }, [publicKey, borrowAmt, connection, config, sendTransaction, obligationAddr]);

  if (!connected) {
    return (
      <Card title="Connect Wallet">
        <p className="opacity-50">Connect your wallet to access lending operations.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="eyebrow">Operator</span>
        <h2 className="text-2xl mt-1">Lending</h2>
        <p className="text-sm text-base-content/55 mt-1">
          Inspect obligations, supply, and borrow against curated reserves.
        </p>
      </div>
      {status && (
        <div className={`alert font-mono text-sm break-all ${status.type === "ok" ? "alert-success" : status.type === "err" ? "alert-error" : "alert-info"}`}>
          {status.msg}
        </div>
      )}

      <Card title="Your Position">
        <div className="grid grid-cols-4 gap-4 text-center">
          <StatBox label="csSOL Balance" value={dUsdyBalance ?? "..."} unit="csSOL" />
          <StatBox label="wSOL Balance" value={wsolBalance ?? "..."} unit="wSOL" />
          <StatBox label="KYC Status" value={isWhitelisted ? "Approved" : "Not KYC'd"} colorClass={isWhitelisted ? "text-success" : "text-error"} />
          <StatBox label="Obligation" value={obligationAddr ? "Active" : "None"} colorClass={obligationAddr ? "text-success" : "opacity-40"} />
        </div>
      </Card>

      {!isWhitelisted && isWhitelisted !== null && (
        <div className="alert alert-warning text-sm">
          Your wallet is not KYC-whitelisted. Contact the market administrator.
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Card title="Deposit csSOL Collateral">
          <p className="text-sm opacity-50 mb-3">
            Deposit csSOL as collateral to borrow wSOL. Creates an obligation if needed.
          </p>
          <div className="flex gap-3">
            <input placeholder="Amount" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} className="input input-bordered bg-base-200 text-base-content flex-1 font-mono" inputMode="decimal" pattern="[0-9.]*" />
            <ActionButton label={loading ? "..." : "Deposit"} variant="success" onClick={handleDeposit} disabled={loading} />
          </div>
          <MaxButton label={`Wallet: ${dUsdyBalance ?? "—"} csSOL`} onClick={() => setDepositAmt(dUsdyBalance || "")} />
        </Card>

        {/* Borrow wSOL card removed 2026-05-06 — wSOL reserve was
            retired (status=Hidden, deposit_limit=0, borrow_limit=0)
            when EG-2 debt moved to cSOL. The bundled `handleBorrow`
            handler is left in place as scaffolding for a future
            "Borrow cSOL" rewrite (requires Token-2022 ATA wiring +
            cSolMint/cSolOracle config fields). Console operators do
            their borrow tests via the institutional credit-trade tab
            on the dev site for now. */}
        <Card title="Borrow (legacy)">
          <p className="text-sm opacity-50">
            wSOL reserve retired. EG-2 debt is cSOL — use the
            institutional credit-trade tab to borrow.
          </p>
        </Card>
      </div>

      {/* Wrapped Tokens */}
      {config.tokens && config.tokens.length > 0 && (
        <Card title="Available Wrapped Tokens (KYC-gated)">
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>d-Token</th>
                  <th>Underlying</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Oracle</th>
                  <th className="text-right">Pool</th>
                </tr>
              </thead>
              <tbody>
                {config.tokens.map((t: any) => (
                  <tr key={t.symbol}>
                    <td className="font-semibold text-success">d{t.symbol}</td>
                    <td className="opacity-70">{t.name}</td>
                    <td className="text-right font-mono">${t.price >= 100 ? t.price.toFixed(2) : t.price.toFixed(4)}</td>
                    <td className="text-right"><Addr value={t.oracle?.toBase58()} /></td>
                    <td className="text-right"><Addr value={t.pool?.toBase58()} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Market Info">
        <div className="grid grid-cols-2 gap-1 text-xs opacity-50">
          <span>Market:</span><Addr value={config.market.lendingMarket.toBase58()} />
          <span>csSOL Reserve:</span><Addr value={config.market.csSolReserve.toBase58()} />
          <span>cSOL Reserve:</span><Addr value={config.market.cSolReserve.toBase58()} />
          <span>csSOL Oracle:</span><Addr value={config.oracles.csSolOracle.toBase58()} />
          {obligationAddr && <><span>Obligation:</span><Addr value={obligationAddr} /></>}
        </div>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="card-body p-6 gap-4">
        <h3 className="card-title text-base">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function StatBox({ label, value, unit, colorClass }: { label: string; value: string; unit?: string; colorClass?: string }) {
  return (
    <div className="text-center p-2">
      <div className={`text-2xl font-bold font-mono ${colorClass || ""}`}>{value}</div>
      <div className="text-xs opacity-50 mt-1">{unit && <span className="badge badge-ghost badge-xs mr-1">{unit}</span>}{label}</div>
    </div>
  );
}

function ActionButton({ label, onClick, variant = "primary", disabled }: {
  label: string; onClick: () => void; variant?: "primary" | "success" | "warning" | "error" | "info"; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`btn btn-${variant} whitespace-nowrap`}
    >
      {label}
    </button>
  );
}

function MaxButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="mt-2">
      <button onClick={onClick} className="btn btn-ghost btn-xs opacity-40 hover:opacity-70">
        {label}
      </button>
    </div>
  );
}

function Addr({ value }: { value?: string }) {
  if (!value) return <span className="opacity-30">&mdash;</span>;
  return (
    <span className="font-mono text-xs opacity-60 hover:opacity-100 cursor-default" title={value}>
      {value.slice(0, 8)}...{value.slice(-4)}
    </span>
  );
}
