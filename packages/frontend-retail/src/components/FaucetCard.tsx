import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Badge, Button, Snackbar, TokenIcon } from "@clearstone/design-system";
import { DEVNET_CONFIG } from "../config/devnet";

const FAUCET_API = import.meta.env.VITE_FAUCET_URL || "http://localhost:3099";

interface Props {
  usdcBalance: number | null;
  onMinted: () => void;
}

export function FaucetCard({ usdcBalance, onMinted }: Props) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<"idle" | "minting" | "success" | "error">("idle");
  const [toast, setToast] = useState<
    | { type: "success" | "error" | "info"; msg: string; detail?: string }
    | null
  >(null);

  const requestUsdc = useCallback(async () => {
    if (!publicKey) return;
    setStatus("minting");
    setToast({ type: "info", msg: "Requesting test USDC…" });

    try {
      // First ensure the ATA exists (user pays for creation)
      const mint = DEVNET_CONFIG.usdc.mint;
      const ata = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);

      const ataInfo = await connection.getAccountInfo(ata);
      if (!ataInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            publicKey, ata, publicKey, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = publicKey;
        const signed = await signTransaction!(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      }

      // Call faucet API
      const res = await fetch(`${FAUCET_API}/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), amount: 1000 }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Faucet error ${res.status}`);
      }

      setStatus("success");
      setToast({ type: "success", msg: "Minted 1,000 test USDC" });
      setTimeout(() => { setStatus("idle"); onMinted(); }, 2000);
    } catch (e: any) {
      console.error("Faucet failed:", e);
      const msg = e?.message
        || (typeof e === "string" ? e : null)
        || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setStatus("error");
      setToast({
        type: "error",
        msg: "Faucet request failed",
        detail: `${msg} — is the faucet server running? (pnpm faucet:serve)`,
      });
    }
  }, [publicKey, connection, signTransaction, onMinted]);

  if (!publicKey) return null;

  const hasEnough = (usdcBalance ?? 0) >= 10;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-lg">Test USDC Faucet</h3>
          <Badge tone="warning" variant="soft" size="xs">DEVNET</Badge>
        </div>
        <p className="text-sm opacity-60 -mt-2">
          Get free test USDC to try depositing. Devnet only.
        </p>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <TokenIcon symbol="USDC" size="sm" />
            <div className="text-sm">
              <div className="opacity-60 text-xs">Balance</div>
              <div className="font-mono tabular font-semibold">
                {usdcBalance !== null ? `${usdcBalance.toFixed(2)} USDC` : "\u2014"}
              </div>
            </div>
          </div>

          <Button
            variant={hasEnough ? "secondary" : "primary"}
            size="sm"
            className="ml-auto"
            loading={status === "minting"}
            disabled={hasEnough}
            onClick={requestUsdc}
          >
            {status === "success" ? "Done" :
             hasEnough ? "Funded" :
             "Get 1,000 USDC"}
          </Button>
        </div>

        {toast && (
          <Snackbar
            variant="toast"
            type={toast.type}
            message={toast.msg}
            detail={toast.detail}
            dismissAfterMs={toast.type === "success" ? 4000 : undefined}
            onDismiss={() => setToast(null)}
          />
        )}
      </div>
    </div>
  );
}
