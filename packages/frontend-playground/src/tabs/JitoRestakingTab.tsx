import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import { CSSOL_VAULT } from "../lib/addresses";
import {
  buildDepositTx,
  getCssolBalance,
  getVrtBalance,
  isWhitelisted,
  readVaultState,
  type VaultState,
} from "../lib/jitoVault";

function short(p: string | PublicKey, n = 6): string {
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}
function fmt(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
}

export default function JitoRestakingTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [state, setState] = useState<VaultState | null>(null);
  const [vrt, setVrt] = useState<bigint>(0n);
  const [cssol, setCssol] = useState<bigint>(0n);
  const [solBal, setSolBal] = useState<bigint>(0n);
  const [whitelisted, setWhitelisted] = useState<boolean | null>(null);
  const [amount, setAmount] = useState<string>("0.005");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await readVaultState(connection, CSSOL_VAULT);
      setState(s);
      if (wallet.publicKey) {
        const [v, cs, sol, wl] = await Promise.all([
          getVrtBalance(connection, wallet.publicKey, s.vrtMint),
          getCssolBalance(connection, wallet.publicKey),
          connection.getBalance(wallet.publicKey).then(BigInt),
          isWhitelisted(connection, wallet.publicKey),
        ]);
        setVrt(v); setCssol(cs); setSolBal(sol); setWhitelisted(wl);
      }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  const ratio = state && state.vrtSupply > 0n ? Number(state.tokensDeposited) / Number(state.vrtSupply) : 1;
  const canDeposit = !!whitelisted;

  async function deposit() {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    setBusy(true);
    setError(null);
    setLog([`building wrap_with_jito_vault tx for ${amount} SOL …`]);
    try {
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");
      const tx = await buildDepositTx(connection, wallet.publicKey, lamports);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signed = await wallet.signTransaction(tx);
      setLog((l) => [...l, "submitted, waiting for confirmation …"]);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(sig, "confirmed");
      const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (receipt?.meta?.err) throw new Error("on-chain err: " + JSON.stringify(receipt.meta.err));
      setLog((l) => [...l, `✓ confirmed: ${sig}`]);
      await refresh();
    } catch (e: any) {
      const logs = e?.transactionLogs ?? e?.logs ?? null;
      setError(`${e.message ?? e}${logs ? "\n\n" + logs.slice(-6).join("\n") : ""}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-bold mb-2">Jito Restaking — SOL → csSOL</h2>
        <p className="opacity-70 mb-6">
          One-tx deposit: native SOL → wSOL → Jito Vault (mints VRT) → pool VRT vault → mints csSOL to user.
          The pool PDA signs the Jito Vault MintTo via CPI as <code>mintBurnAdmin</code>; KYC is enforced
          at the delta-mint layer via the user's whitelist entry.
        </p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  return (
    <section className="max-w-3xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">Jito Restaking — SOL → csSOL</h2>
        <p className="opacity-70 mt-1 text-sm">
          One <code>governor::wrap_with_jito_vault</code> ix wraps SOL into csSOL with full Jito Vault
          backing in a single user signature. The pool PDA signs the MintTo via CPI; the user only
          needs to be on the delta-mint KYC whitelist.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Vault state</div>
            <div>address: <code>{short(CSSOL_VAULT)}</code></div>
            {state ? (
              <>
                <div>VRT mint: <code>{short(state.vrtMint)}</code></div>
                <div>tokensDeposited: <code>{state.tokensDeposited.toString()}</code></div>
                <div>vrtSupply: <code>{state.vrtSupply.toString()}</code></div>
                <div>exchange rate: <code>{ratio.toFixed(8)}</code> SOL / VRT</div>
                <div>admin: <code>{short(state.admin)}</code></div>
                <div>mintBurnAdmin: <code>{short(state.mintBurnAdmin)}</code> (governor PDA)</div>
              </>
            ) : <div className="opacity-60">loading …</div>}
          </div>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Connected wallet</div>
            <div>pubkey: <code>{short(wallet.publicKey)}</code></div>
            <div>SOL balance: <code>{fmt(solBal)}</code></div>
            <div>VRT balance: <code>{vrt.toString()}</code> ({fmt(vrt)})</div>
            <div>csSOL balance: <code>{cssol.toString()}</code> ({fmt(cssol)})</div>
            <div className={`text-xs mt-2 ${whitelisted ? "text-success" : "text-warning"}`}>
              {whitelisted === null ? "loading whitelist status…"
                : whitelisted
                  ? "✓ Wallet is KYC-whitelisted on delta-mint → wrap will succeed."
                  : "⚠ Wallet is NOT on the delta-mint whitelist. The wrap ix will fail at the delta-mint::mint_to CPI. Run governor.add_participant(Holder, your_pubkey) from an admin wallet first."}
            </div>
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-3">
          <div className="font-bold">Deposit</div>
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="input input-bordered w-48"
              value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            <span className="text-sm opacity-70">SOL</span>
            <button className="btn btn-primary" onClick={deposit} disabled={busy || !state || !canDeposit}
              title={!canDeposit ? "Wallet is not KYC-whitelisted on delta-mint" : undefined}>
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              Deposit & receive csSOL
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          </div>
          {error ? <pre className="alert alert-error text-xs whitespace-pre-wrap">{error}</pre> : null}
          {log.length > 0 ? <pre className="bg-base-300 p-2 text-xs whitespace-pre-wrap rounded">{log.join("\n")}</pre> : null}
        </div>
      </div>

      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">What this tx actually does</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1">
          <li>Idempotently creates user's wSOL, VRT, csSOL, and fee-VRT ATAs.</li>
          <li>Transfers <code>amount</code> lamports of native SOL into user's wSOL ATA + <code>sync_native</code>.</li>
          <li>Calls <code>governor::wrap_with_jito_vault</code>, which CPIs:
            <ol className="list-[lower-alpha] pl-5 mt-1">
              <li>Jito Vault <code>MintTo</code> — wSOL transferred from user → vault, VRT minted to user (governor PDA signs as mintBurnAdmin).</li>
              <li>SPL Token <code>transfer_checked</code> — VRT swept from user → pool VRT vault (canonical backing).</li>
              <li>delta-mint <code>mint_to</code> — csSOL minted to user, KYC whitelist verified.</li>
            </ol>
          </li>
        </ol>
      </details>
    </section>
  );
}
