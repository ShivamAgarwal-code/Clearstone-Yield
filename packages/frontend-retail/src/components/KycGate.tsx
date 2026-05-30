import { useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Badge, Button } from "@clearstone/design-system";

interface KycGateProps {
  onRegister: () => Promise<string | undefined>;
}

const COMPLIANCE_API = import.meta.env.VITE_COMPLIANCE_API || "https://clearstone-backend-edge.achim-d87.workers.dev";

export function KycGate({ onRegister }: KycGateProps) {
  const { publicKey } = useWallet();
  const [status, setStatus] = useState<"idle" | "civic" | "registering" | "backend" | "error">("idle");
  const [error, setError] = useState<string>("");

  // Try Civic first, then fall back to backend
  const handleCivicVerify = useCallback(async () => {
    setStatus("civic");
    setError("");
    try {
      // Try self_register (requires gateway token)
      setStatus("registering");
      await onRegister();
    } catch (e: any) {
      // Civic failed — offer backend fallback
      setError(`Civic verification failed: ${e.message?.slice(0, 80)}. Try the alternative below.`);
      setStatus("error");
    }
  }, [onRegister]);

  // Backend-powered compliance flag + on-chain whitelist. The backend
  // worker (`backend-edge/src/kyc.ts`) signs the on-chain
  // `add_participant_via_pool` (csSOL) +
  // `add_wt_participant_via_pool` (csSOL-WT) +
  // `add_participant_native_via_pool` (cSOL) ixs itself, using its
  // admin keypair (`clearstone-devnet.json`). The user pays NOTHING
  // for this path — no wallet popup, no rent, no tx fee. After
  // `/kyc/approve` returns, all three whitelist PDAs are live on
  // chain; the page reload triggers `useKycStatus` to re-verify
  // on-chain and write the v2 cache only if the PDAs are confirmed.
  //
  // We deliberately don't ALSO call `onRegister()` here — that would
  // ask the user to sign a redundant `selfRegisterNative` for a PDA
  // the backend already created, charge them rent for a duplicate
  // write, and fail with `AccountInUse`. The Civic path
  // (`handleCivicVerify`) is the user-pays alternative for wallets
  // that want to self-onboard with a Civic gateway token.
  const handleBackendVerify = useCallback(async () => {
    if (!publicKey) return;
    setStatus("backend");
    setError("");
    try {
      const submitResp = await fetch(`${COMPLIANCE_API}/kyc/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          entityType: "individual",
          name: "Retail User",
          email: "user@delta.savings",
        }),
      });
      if (!submitResp.ok) {
        const err = await submitResp.json().catch(() => ({ error: "Submit failed" }));
        throw new Error(err.error || "Submit failed");
      }

      const approveResp = await fetch(`${COMPLIANCE_API}/kyc/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58() }),
      });
      if (!approveResp.ok) {
        const err = await approveResp.json().catch(() => ({ error: "Approval failed" }));
        throw new Error(err.error || "Approval failed");
      }
      const data = await approveResp.json() as any;
      if (!(data.data?.status === "approved" || data.message?.includes("approved"))) {
        throw new Error("Approval did not return approved status");
      }

      // useKycStatus refreshes on the next mount; that re-read will
      // verify the cSOL whitelist PDA exists on chain and write the
      // v2 cache only if so. We deliberately don't write the cache
      // here, and we deliberately don't call `onRegister()` either —
      // the backend already wrote the on-chain whitelist as part of
      // `/kyc/approve`, so a frontend retry would just charge the
      // user rent for a duplicate.
      window.location.reload();
    } catch (e: any) {
      setError(e.message?.slice(0, 200) || "Verification failed");
      setStatus("error");
    }
  }, [publicKey]);

  return (
    <div
      className="card bg-base-200 border border-base-300 shadow-xl overflow-hidden"
      style={{
        backgroundImage:
          "radial-gradient(circle at 100% 0%, rgba(184,153,104,0.10), transparent 55%)",
      }}
    >
      <div className="card-body items-center text-center py-10 px-8">
        <span className="eyebrow mb-3">Compliance gate</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-12 w-12 text-primary mb-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        </svg>
        <h2 className="font-display text-2xl font-light tracking-tight mb-2">
          Identity verification
        </h2>
        <p className="text-sm opacity-65 max-w-md mb-6 leading-relaxed">
          Deposits require a one-time KYC pass. We mint a{" "}
          <code className="text-xs">WhitelistEntry</code> PDA against your
          wallet so on-chain transfers can land. About 30 seconds.
        </p>

        <ol className="flex flex-col gap-2.5 max-w-sm w-full mb-6 text-left">
          {[
            "Identity check (sandboxed compliance backend)",
            "Mint on-chain WhitelistEntry PDA",
            "Deposit + earn yield",
          ].map((step, i) => (
            <li key={step} className="flex items-center gap-3 text-sm">
              <span
                className="inline-flex items-center justify-center rounded-full bg-primary text-primary-content shrink-0 font-mono font-bold"
                style={{ width: 22, height: 22, fontSize: 11 }}
              >
                {i + 1}
              </span>
              <span className="opacity-80">{step}</span>
            </li>
          ))}
        </ol>

        {/* Primary: Backend verification (reliable on devnet) */}
        <Button
          variant="primary"
          size="lg"
          loading={status === "backend"}
          disabled={status === "registering" || status === "civic"}
          onClick={handleBackendVerify}
        >
          Verify identity
        </Button>

        {/* Secondary: Civic (may not work on devnet) */}
        <Button
          variant="ghost"
          size="sm"
          loading={status === "civic" || status === "registering"}
          disabled={status === "backend"}
          onClick={handleCivicVerify}
          className="mt-1 opacity-70"
        >
          Or verify with Civic Pass
        </Button>

        {error && (
          <div className="mt-4 max-w-sm">
            <Badge tone="error" variant="soft" size="sm">
              {error}
            </Badge>
          </div>
        )}

        <p className="text-xs opacity-45 mt-5 max-w-md leading-relaxed">
          Identity is verified by our compliance backend; no personal data
          is stored on-chain. Only your wallet's whitelist flag is committed.
        </p>
      </div>
    </div>
  );
}
