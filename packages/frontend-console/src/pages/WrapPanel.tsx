import { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { usePrograms } from "../hooks/usePrograms";
import { BN } from "@coral-xyz/anchor";
import Dropdown from "../components/Dropdown";

export default function WrapPanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { config, governor, ready } = usePrograms();

  const [selectedToken, setSelectedToken] = useState(0);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"wrap" | "unwrap">("wrap");
  const [underlyingBal, setUnderlyingBal] = useState<Record<string, string>>({});
  const [wrappedBal, setWrappedBal] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ msg: string; type: "ok" | "err" | "info" } | null>(null);
  const [loading, setLoading] = useState(false);

  const tokens = config.tokens || [];
  const token = tokens[selectedToken];

  // Load balances
  useEffect(() => {
    if (!publicKey || !connected || tokens.length === 0) return;
    let cancelled = false;

    (async () => {
      const uBals: Record<string, string> = {};
      const wBals: Record<string, string> = {};
      for (const t of tokens) {
        try {
          const uAta = getAssociatedTokenAddressSync(t.underlyingMint, publicKey);
          const uBal = await connection.getTokenAccountBalance(uAta).catch(() => null);
          uBals[t.symbol] = uBal ? (Number(uBal.value.amount) / 10 ** t.decimals).toFixed(2) : "0.00";
        } catch { uBals[t.symbol] = "0.00"; }
        try {
          const wAta = getAssociatedTokenAddressSync(t.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
          const wBal = await connection.getTokenAccountBalance(wAta).catch(() => null);
          wBals[t.symbol] = wBal ? (Number(wBal.value.amount) / 10 ** t.decimals).toFixed(2) : "0.00";
        } catch { wBals[t.symbol] = "0.00"; }
      }
      if (!cancelled) { setUnderlyingBal(uBals); setWrappedBal(wBals); }
    })();
    return () => { cancelled = true; };
  }, [publicKey, connected, connection, tokens]);

  const handleWrap = useCallback(async () => {
    if (!publicKey || !governor || !token || !amount) return;
    setLoading(true);
    const isWrap = mode === "wrap";
    setStatus({ msg: `${isWrap ? "Wrapping" : "Unwrapping"} ${amount} ${isWrap ? token.name : `d${token.symbol}`}...`, type: "info" });

    try {
      const amountBN = new BN(Math.floor(Number(amount) * 10 ** token.decimals));
      const poolPda = token.pool;
      const [dmAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority"), token.wrappedMint.toBuffer()],
        config.programs.deltaMint
      );
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), token.dmMintConfig.toBuffer(), publicKey.toBuffer()],
        config.programs.deltaMint
      );

      const userUnderlyingAta = getAssociatedTokenAddressSync(token.underlyingMint, publicKey);
      const userWrappedAta = getAssociatedTokenAddressSync(token.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const vaultAta = getAssociatedTokenAddressSync(token.underlyingMint, poolPda, true);

      const tx = new Transaction();

      if (isWrap) {
        // Ensure d-token ATA exists
        const wAtaInfo = await connection.getAccountInfo(userWrappedAta);
        if (!wAtaInfo) {
          tx.add(createAssociatedTokenAccountInstruction(publicKey, userWrappedAta, publicKey, token.wrappedMint, TOKEN_2022_PROGRAM_ID));
        }

        const ix = await (governor.methods as any)
          .wrap(amountBN)
          .accounts({
            user: publicKey,
            poolConfig: poolPda,
            underlyingMint: token.underlyingMint,
            userUnderlyingAta,
            vault: vaultAta,
            dmMintConfig: token.dmMintConfig,
            wrappedMint: token.wrappedMint,
            dmMintAuthority: dmAuthority,
            whitelistEntry,
            userWrappedAta,
            deltaMintProgram: config.programs.deltaMint,
            underlyingTokenProgram: TOKEN_PROGRAM_ID,
            wrappedTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();
        tx.add(ix);
      } else {
        const ix = await (governor.methods as any)
          .unwrap(amountBN)
          .accounts({
            user: publicKey,
            poolConfig: poolPda,
            underlyingMint: token.underlyingMint,
            userUnderlyingAta,
            vault: vaultAta,
            wrappedMint: token.wrappedMint,
            userWrappedAta,
            underlyingTokenProgram: TOKEN_PROGRAM_ID,
            wrappedTokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();
        tx.add(ix);
      }

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");

      setStatus({
        msg: `${isWrap ? "Wrapped" : "Unwrapped"} ${amount} ${isWrap ? token.name : `d${token.symbol}`}! Tx: ${sig.slice(0, 20)}...`,
        type: "ok",
      });
      setAmount("");

      // Refresh balances
      try {
        const uBal = await connection.getTokenAccountBalance(userUnderlyingAta).catch(() => null);
        const wBal = await connection.getTokenAccountBalance(userWrappedAta).catch(() => null);
        if (uBal) setUnderlyingBal(prev => ({ ...prev, [token.symbol]: (Number(uBal.value.amount) / 10 ** token.decimals).toFixed(2) }));
        if (wBal) setWrappedBal(prev => ({ ...prev, [token.symbol]: (Number(wBal.value.amount) / 10 ** token.decimals).toFixed(2) }));
      } catch {}
    } catch (e: any) {
      setStatus({ msg: `Failed: ${e.message?.slice(0, 120)}`, type: "err" });
    }
    setLoading(false);
  }, [publicKey, governor, token, amount, mode, connection, sendTransaction, config]);

  if (!connected) return <p className="opacity-50">Connect wallet to wrap/unwrap tokens.</p>;
  if (tokens.length === 0) return <p className="opacity-50">No wrapped tokens configured.</p>;

  const sourceBal = mode === "wrap" ? underlyingBal[token?.symbol] : wrappedBal[token?.symbol];
  const sourceLabel = mode === "wrap" ? token?.name : `d${token?.symbol}`;
  const destLabel = mode === "wrap" ? `d${token?.symbol}` : token?.name;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="eyebrow">Operator</span>
        <h2 className="text-2xl mt-1">Wrap</h2>
        <p className="text-sm text-base-content/55 mt-1">
          Wrap underlying tokens into KYC-gated d-tokens (1:1 backed) or unwrap d-tokens back. Requires
          KYC whitelist approval.
        </p>
      </div>

      {status && (
        <div role="alert" className={`alert ${status.type === "ok" ? "alert-success" : status.type === "err" ? "alert-error" : "alert-info"}`}>
          <span className="text-sm font-mono break-all">{status.msg}</span>
        </div>
      )}

      {/* Balances overview */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <h3 className="card-title text-base">Token Balances</h3>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Token</th>
                  <th className="text-right">Underlying Balance</th>
                  <th className="text-right">d-Token Balance</th>
                  <th className="text-right">Oracle Price</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.symbol} className={selectedToken === tokens.indexOf(t) ? "bg-base-300" : ""}>
                    <td className="font-semibold cursor-pointer" onClick={() => setSelectedToken(tokens.indexOf(t))}>
                      {t.name} <span className="opacity-40">/ d{t.symbol}</span>
                    </td>
                    <td className="text-right font-mono">{underlyingBal[t.symbol] ?? "..."}</td>
                    <td className="text-right font-mono text-success">{wrappedBal[t.symbol] ?? "..."}</td>
                    <td className="text-right font-mono opacity-60">${t.price >= 100 ? t.price.toFixed(2) : t.price.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Wrap / Unwrap form */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <div className="flex items-center gap-3">
            <h3 className="card-title text-base flex-1">
              {mode === "wrap" ? "Wrap" : "Unwrap"} Tokens
            </h3>
            <div className="join">
              <button
                className={`join-item btn btn-sm ${mode === "wrap" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setMode("wrap")}
              >
                Wrap
              </button>
              <button
                className={`join-item btn btn-sm ${mode === "unwrap" ? "btn-warning" : "btn-ghost"}`}
                onClick={() => setMode("unwrap")}
              >
                Unwrap
              </button>
            </div>
          </div>

          <div className="bg-base-300 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs opacity-50 uppercase tracking-wide">
                {mode === "wrap" ? "You deposit" : "You burn"}
              </span>
              <span className="text-xs opacity-40">
                Balance: {sourceBal ?? "0.00"} {sourceLabel}
              </span>
            </div>
            <div className="flex gap-3">
              <Dropdown
                value={selectedToken}
                onChange={(v) => setSelectedToken(Number(v))}
                options={tokens.map((t, i) => ({
                  value: i,
                  label: mode === "wrap" ? t.name : `d${t.symbol}`,
                }))}
                className="min-w-[160px]"
              />
              <input
                inputMode="decimal" pattern="[0-9.]*"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="input input-bordered bg-base-200 text-base-content font-mono flex-1 text-lg"
              />
              <button
                onClick={() => setAmount(sourceBal || "0")}
                className="btn btn-ghost btn-sm self-center opacity-50 hover:opacity-100"
              >
                MAX
              </button>
            </div>
          </div>

          {/* Arrow */}
          <div className="flex justify-center">
            <div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-lg opacity-50">
              {mode === "wrap" ? "↓" : "↑"}
            </div>
          </div>

          <div className="bg-base-300 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs opacity-50 uppercase tracking-wide">
                {mode === "wrap" ? "You receive" : "You receive"}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-semibold text-lg">{destLabel}</span>
              <span className="font-mono text-lg flex-1 text-right text-success">
                {amount || "0.00"}
              </span>
            </div>
            <p className="text-xs opacity-40 mt-2">1:1 exchange rate — fully backed</p>
          </div>

          <button
            onClick={handleWrap}
            disabled={loading || !amount || Number(amount) <= 0}
            className={`btn w-full ${mode === "wrap" ? "btn-primary" : "btn-warning"} ${loading ? "loading" : ""}`}
          >
            {loading ? "Processing..." : mode === "wrap" ? `Wrap ${token?.name} → d${token?.symbol}` : `Unwrap d${token?.symbol} → ${token?.name}`}
          </button>

          <div className="text-xs opacity-40 leading-relaxed">
            <p>{mode === "wrap"
              ? "Your underlying tokens are locked in the pool vault. You receive KYC-gated d-tokens that can be used as collateral in the lending market."
              : "Your d-tokens are burned. The underlying tokens are released from the pool vault back to your wallet."
            }</p>
          </div>
        </div>
      </div>
    </div>
  );
}
