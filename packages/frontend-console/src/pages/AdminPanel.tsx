import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { usePrograms } from "../hooks/usePrograms";
import { useAuthority, authorityReason } from "../hooks/useAuthority";

export default function AdminPanel() {
  const { publicKey, connected } = useWallet();
  const { governor, config, ready } = usePrograms();
  const authority = useAuthority();

  const [whitelistAddr, setWhitelistAddr] = useState("");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [loading, setLoading] = useState(false);

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 8000);
  };

  // --- Whitelist a wallet ---
  const handleWhitelist = useCallback(async () => {
    if (!governor || !publicKey || !whitelistAddr) return;
    setLoading(true);
    showStatus("Whitelisting...");
    try {
      const wallet = new PublicKey(whitelistAddr);
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), wallet.toBuffer()],
        config.programs.deltaMint
      );

      const accounts: any = {
        authority: publicKey,
        poolConfig: config.pool.poolConfig,
        adminEntry: isRootAuthority ? null : adminEntry,
        dmMintConfig: config.pool.dmMintConfig,
        wallet,
        whitelistEntry,
        deltaMintProgram: config.programs.deltaMint,
        systemProgram: SystemProgram.programId,
      };

      const sig = await (governor.methods as any)
        .addParticipant({ holder: {} })
        .accounts(accounts)
        .rpc();
      showStatus(`Whitelisted! Tx: ${sig.slice(0, 20)}...`, "ok");
      setWhitelistAddr("");
    } catch (e: any) {
      showStatus(`Failed: ${e.message}`, "err");
    }
    setLoading(false);
  }, [governor, publicKey, whitelistAddr, config]);


  const isRootAuthority = authority.isRoot;
  const isAuthority = authority.isAdmin;
  const writeReason = authorityReason(authority, "admin");

  // Derive admin PDA for current wallet — still needed locally to pass
  // into the addParticipant ix below. The "does it exist?" check has
  // been hoisted into useAuthority so every panel sees the same answer.
  const adminEntry = publicKey ? (() => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("admin"), config.pool.poolConfig.toBuffer(), publicKey.toBuffer()],
      config.programs.governor
    );
    return pda;
  })() : null;

  if (!connected) {
    return (
      <Card title="Connect Wallet">
        <p className="opacity-50">Connect your wallet to access admin controls.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="eyebrow">Operator</span>
        <h2 className="text-2xl mt-1">Admin</h2>
        <p className="text-sm text-base-content/55 mt-1">
          Root authority controls — manage admins, emergency pauses, and program parameters.
        </p>
      </div>
      {!authority.loading && !isAuthority && (
        <div role="alert" className="alert alert-warning">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          <div>
            <p className="text-sm">Read-only — connected wallet is not an admin.</p>
            <p className="text-xs opacity-70 mt-1">Ask the root authority to run: <code className="font-mono bg-base-300 px-1 rounded">pnpm add-admin {publicKey?.toBase58()}</code></p>
          </div>
        </div>
      )}
      {isAuthority && !isRootAuthority && (
        <div role="alert" className="alert alert-success">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span className="text-sm">Signed in as delegated admin. You can whitelist and mint.</span>
        </div>
      )}
      {status && (
        <div role="alert" className={`alert ${status.type === "ok" ? "alert-success" : status.type === "err" ? "alert-error" : "alert-info"}`}>
          <span className="text-sm font-mono break-all">{status.msg}</span>
        </div>
      )}

      {/* KYC Whitelist */}
      <Card title="KYC Whitelist Management">
        <p className="opacity-50 text-sm mb-3">
          Add a wallet to the KYC whitelist to allow them to hold cUSDY.
        </p>
        <div className="flex gap-3">
          <input
            placeholder="Wallet address to whitelist"
            value={whitelistAddr}
            onChange={(e) => setWhitelistAddr(e.target.value)}
            className="input input-bordered bg-base-200 text-base-content font-mono flex-1"
          />
          <ActionButton
            label="Whitelist"
            onClick={handleWhitelist}
            disabled={loading || !whitelistAddr || !isAuthority}
            title={!isAuthority ? writeReason : undefined}
          />
        </div>
      </Card>

      {/* Market Status */}
      <Card title="Deployment Status">
        <div className="grid grid-cols-2 gap-1 text-sm opacity-70">
          <span>Authority:</span>
          <Addr value={publicKey?.toBase58()} />
          <span>Cluster:</span><span>Devnet</span>
          <span>Governor Pool:</span>
          <Addr value={config.pool.poolConfig.toBase58()} />
          <span>cUSDY Mint:</span>
          <Addr value={config.pool.wrappedMint.toBase58()} />
          <span>delta-mint:</span>
          <Addr value={config.programs.deltaMint.toBase58()} />
          <span>governor:</span>
          <Addr value={config.programs.governor.toBase58()} />
          <span>klend:</span>
          <Addr value={config.programs.klend.toBase58()} />
          <span>SDK ready:</span>
          <span className={ready ? "text-success" : "text-error"}>{ready ? "Yes" : "No (connect wallet)"}</span>
        </div>
      </Card>
    </div>
  );
}

// ── Reusable components ──

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="card-body p-6 gap-4">
        <h3 className="text-base">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ActionButton({ label, onClick, disabled, title }: {
  label: string; onClick: () => void; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="btn btn-primary whitespace-nowrap"
    >
      {label}
    </button>
  );
}

function Addr({ value }: { value?: string }) {
  if (!value) return <span className="opacity-30">&mdash;</span>;
  return (
    <span className="font-mono text-xs opacity-60">
      {value.slice(0, 8)}...{value.slice(-4)}
    </span>
  );
}
