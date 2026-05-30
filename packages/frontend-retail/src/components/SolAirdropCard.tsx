import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  Badge,
  Button,
  Snackbar,
  TokenIcon,
  TxActionButtons,
  shortSig,
} from "@clearstone/design-system";

interface Props {
  solBalance: number | null;
  onMinted: () => void;
}

/**
 * Devnet SOL airdrop card. Mirrors the USDC FaucetCard for SOL — no
 * separate faucet server needed, the Solana cluster's `requestAirdrop`
 * RPC is the source. Some public devnet endpoints rate-limit airdrops
 * heavily; if it fails, surface the URL of the public faucet.
 */
export function SolAirdropCard({ solBalance, onMinted }: Props) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<"idle" | "minting" | "success" | "error">("idle");
  const [toast, setToast] = useState<
    | { type: "success" | "error" | "info"; msg: string; sig?: string; detail?: string }
    | null
  >(null);

  const requestSol = useCallback(async () => {
    if (!publicKey) return;
    setStatus("minting");
    setToast({ type: "info", msg: "Requesting 1 SOL airdrop…" });

    try {
      const sig = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setStatus("success");
      setToast({ type: "success", msg: "Airdropped 1 SOL", sig });
      setTimeout(() => { setStatus("idle"); onMinted(); }, 1500);
    } catch (e: any) {
      // Public devnet RPC commonly rejects airdrops with a 429 — point
      // the user at the official faucet as a fallback.
      console.error("Airdrop failed:", e);
      const msg = e?.message
        || (typeof e === "string" ? e : null)
        || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setStatus("error");
      setToast({
        type: "error",
        msg: "Airdrop failed",
        detail: `${msg} — try faucet.solana.com if rate-limited.`,
      });
    }
  }, [publicKey, connection, onMinted]);

  if (!publicKey) return null;

  const hasEnough = (solBalance ?? 0) >= 1.0;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-lg">Devnet SOL Airdrop</h3>
          <Badge tone="warning" variant="soft" size="xs">DEVNET</Badge>
        </div>
        <p className="text-sm opacity-60 -mt-2">
          Request 1 SOL from the devnet faucet to try depositing.
        </p>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <TokenIcon symbol="SOL" size="sm" />
            <div className="text-sm">
              <div className="opacity-60 text-xs">Balance</div>
              <div className="font-mono tabular font-semibold">
                {solBalance !== null ? `${solBalance.toFixed(4)} SOL` : "—"}
              </div>
            </div>
          </div>

          <Button
            variant={hasEnough ? "secondary" : "primary"}
            size="sm"
            className="ml-auto"
            loading={status === "minting"}
            disabled={hasEnough}
            onClick={requestSol}
          >
            {status === "success" ? "Done" :
             hasEnough ? "Funded" :
             "Get 1 SOL"}
          </Button>
        </div>

        {toast && (
          <Snackbar
            variant="toast"
            type={toast.type}
            message={toast.msg}
            detail={toast.sig ? `sig=${shortSig(toast.sig)}` : toast.detail}
            action={toast.sig ? <TxActionButtons sig={toast.sig} /> : undefined}
            dismissAfterMs={toast.type === "success" ? 4000 : undefined}
            onDismiss={() => setToast(null)}
          />
        )}
      </div>
    </div>
  );
}
