import { ReactNode, useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Badge,
  Button,
  Card,
  Eyebrow,
  Snackbar,
  Stat,
  TokenIcon,
  tokenBrandColor,
} from "@clearstone/design-system";
import { DEVNET_CONFIG } from "../config/devnet";

// v3 unified market — pulled from the single source of truth in
// `config/devnet.ts`. The legacy v1 program IDs (delta-mint=13Su8nR…QkEn,
// governor=BrZYcb…3KJh) and the legacy pool list (eUSX/USX/tUSDY/"Legacy
// Pool") are not used by any v3 mint flow — checking against them here
// would let users past the KYC gate while they still trip Custom 3012
// inside the actual wrap CPIs.
const DELTA_MINT = DEVNET_CONFIG.programs.deltaMint;
const GOVERNOR = DEVNET_CONFIG.programs.governor;

// Root authority that can whitelist
const ROOT_AUTHORITY = "AhKNmBmaeq6XrrEyGnSQne3WeU4SoN7hSAGieTiqPaJX";

// v3 pools the institutional stack actually targets — derived from
// `DEVNET_CONFIG.tokens` so adding a new wrapped asset there
// automatically extends the KYC gate's coverage.
const POOLS = DEVNET_CONFIG.tokens.map(t => ({
  name: t.name,
  pool: t.pool.toBase58(),
  dmConfig: t.dmMintConfig.toBase58(),
  isWithdrawTicket: !!t.isWithdrawTicket,
}));

// Headline csSOL pool — the one the SolStakePanel + CssolWsolCreditPanel
// mint against. Used as the target for the root-authority devnet
// self-whitelist helper.
const CSSOL_POOL = DEVNET_CONFIG.pool;

type KycStatus = "loading" | "not_connected" | "checking" | "approved" | "pending" | "self_whitelisting" | "error";

// Precomputed Anchor discriminator for global:add_participant_via_pool
// (v3 path — used after the pool's MintConfig authority has been
// transferred to the pool PDA via activate_wrapping). Matches the IDL
// in public/idl/governor.json.
const ADD_PARTICIPANT_VIA_POOL_DISC = new Uint8Array([200, 11, 127, 111, 117, 242, 194, 36]);

export default function KycGate({ children }: { children: ReactNode }) {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<KycStatus>("not_connected");
  const [institution, setInstitution] = useState<string | null>(null);
  const [approvedPools, setApprovedPools] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Session key for persisting approval across tab changes
  const sessionKey = publicKey ? `kyc_approved_${publicKey.toBase58()}` : null;

  const checkWhitelist = useCallback(async () => {
    if (!publicKey) return;

    // Check session cache first — avoid re-checking every tab change
    if (sessionKey && sessionStorage.getItem(sessionKey) === "true") {
      setStatus("approved");
      setInstitution(sessionStorage.getItem(`${sessionKey}_pool`) || "KYC Verified");
      setIsAdmin(publicKey.toBase58() === ROOT_AUTHORITY);
      return;
    }

    setStatus("checking");
    setError(null);

    try {
      const approved: string[] = [];
      let adminFound = false;

      // 1. Check on-chain whitelist
      // delta-mint's WhitelistEntry account layout (with 8-byte anchor
      // disc): [0..8) disc, [8..40) wallet, [40..72) dm_mint_config,
      // [72] approved-flag (1 = approved), [73] role, ... padding.
      // The earlier check used `data[64] === 1` which silently skipped
      // the 8-byte disc and read into the dm_mint_config pubkey's tail
      // — that byte is effectively random per config, so the gate was
      // a coin-flip for legitimately-whitelisted users.
      for (const pool of POOLS) {
        const [whitelistEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("whitelist"), new PublicKey(pool.dmConfig).toBuffer(), publicKey.toBuffer()],
          DELTA_MINT
        );
        const info = await connection.getAccountInfo(whitelistEntry);
        if (info && info.data.length >= 73 && info.data[72] === 1) {
          approved.push(pool.name);
        }

        // Check admin
        if (!adminFound) {
          const [adminEntry] = PublicKey.findProgramAddressSync(
            [Buffer.from("admin"), new PublicKey(pool.pool).toBuffer(), publicKey.toBuffer()],
            GOVERNOR
          );
          const adminInfo = await connection.getAccountInfo(adminEntry);
          if (adminInfo) adminFound = true;
        }
      }

      if (publicKey.toBase58() === ROOT_AUTHORITY) adminFound = true;

      // 2. If not found on-chain, check backend KYC status
      if (approved.length === 0 && !adminFound) {
        try {
          const BACKEND_URL = import.meta.env.VITE_COMPLIANCE_API || "http://localhost:4000";
          const resp = await fetch(`${BACKEND_URL}/kyc/status/${publicKey.toBase58()}`);
          if (resp.ok) {
            const data = await resp.json() as any;
            if (data.data?.status === "approved") {
              approved.push("KYC Verified");
            }
          }
        } catch {} // Backend unavailable — rely on on-chain only
      }

      setApprovedPools(approved);
      setIsAdmin(adminFound);
      setInstitution(approved.length > 0 ? approved[0] : adminFound ? "Admin" : null);
      const isApproved = approved.length > 0 || adminFound;
      setStatus(isApproved ? "approved" : "pending");

      // Cache approval in session so tab changes don't re-check
      if (isApproved && sessionKey) {
        sessionStorage.setItem(sessionKey, "true");
        sessionStorage.setItem(`${sessionKey}_pool`, approved[0] || "Admin");
      }
    } catch (e: any) {
      setError("Failed to verify on-chain credentials. Check your connection and retry.");
      setStatus("error");
    }
  }, [publicKey, connection]);

  useEffect(() => {
    if (!connected || !publicKey) {
      setStatus("not_connected");
      return;
    }
    checkWhitelist();
  }, [publicKey, connected, checkWhitelist]);

  // Self-whitelist on the v3 csSOL pool. Only useful for the root
  // authority on devnet — production onboarding goes through the
  // backend (`handleBackendVerification`). Uses
  // `add_participant_via_pool` (post-activation path); the pre-v3
  // `add_participant` ix targeted authority-owned MintConfigs that no
  // longer exist on this market.
  const handleSelfWhitelist = useCallback(async () => {
    if (!publicKey) return;
    setStatus("self_whitelisting");
    setError(null);

    try {
      const dmMintConfig = CSSOL_POOL.dmMintConfig;
      const poolConfig = CSSOL_POOL.poolConfig;
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), dmMintConfig.toBuffer(), publicKey.toBuffer()],
        DELTA_MINT,
      );
      const disc = Buffer.from(ADD_PARTICIPANT_VIA_POOL_DISC);
      const roleData = Buffer.from([0]); // ParticipantRole::Holder

      const tx = new Transaction().add({
        programId: GOVERNOR,
        data: Buffer.concat([disc, roleData]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },          // authority
          { pubkey: poolConfig, isSigner: false, isWritable: true },        // pool_config
          { pubkey: GOVERNOR, isSigner: false, isWritable: false },         // admin_entry = None (placeholder)
          { pubkey: dmMintConfig, isSigner: false, isWritable: true },      // dm_mint_config
          { pubkey: publicKey, isSigner: false, isWritable: false },        // wallet
          { pubkey: whitelistEntry, isSigner: false, isWritable: true },    // whitelist_entry
          { pubkey: DELTA_MINT, isSigner: false, isWritable: false },       // delta_mint_program
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      await checkWhitelist();
    } catch (e: any) {
      setError(e.message?.slice(0, 200) || "Whitelist failed");
      setStatus("pending");
    }
  }, [publicKey, connection, sendTransaction, checkWhitelist]);

  // Backend-powered verification flow
  const handleBackendVerification = useCallback(async () => {
    if (!publicKey) return;
    setVerifying(true);
    setError(null);

    const BACKEND_URL = import.meta.env.VITE_COMPLIANCE_API || "http://localhost:4000";

    try {
      // Step 1: Submit wallet for KYC review
      setError("Step 1/3: Submitting identity...");
      const submitResp = await fetch(`${BACKEND_URL}/kyc/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: publicKey.toBase58(),
          entityType: "company",
          name: "Demo Institution",
          email: "demo@institution.test",
        }),
      });

      if (!submitResp.ok) {
        const err = await submitResp.json().catch(() => ({ error: "Backend unavailable" }));
        throw new Error(err.error || `Submit failed: ${submitResp.status}`);
      }

      // Step 2: Auto-approve (in production this would be a manual review)
      setError("Step 2/3: KYT screening & compliance review...");
      await new Promise(r => setTimeout(r, 1500)); // Simulate review delay

      const approveResp = await fetch(`${BACKEND_URL}/kyc/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: publicKey.toBase58() }),
      });

      if (!approveResp.ok) {
        const err = await approveResp.json().catch(() => ({ error: "Approval failed" }));
        throw new Error(err.error || `Approve failed: ${approveResp.status}`);
      }

      const approveData = await approveResp.json() as any;

      // Step 3: Verify approval
      setError("Step 3/3: Verifying approval...");

      if (approveData.data?.status === "approved" || approveData.message?.includes("approved")) {
        // Backend confirmed approval — grant access immediately and cache
        setApprovedPools(["KYC Verified"]);
        setInstitution("KYC Verified");
        setStatus("approved");
        setVerifying(false);
        setError(null);
        if (sessionKey) {
          sessionStorage.setItem(sessionKey, "true");
          sessionStorage.setItem(`${sessionKey}_pool`, "KYC Verified");
        }
        return;
      }

      // Fallback: check on-chain directly
      setError("Step 3/3: Verifying on-chain...");
      await new Promise(r => setTimeout(r, 2000));
      await checkWhitelist();
      setVerifying(false);
    } catch (e: any) {
      setError(e.message || "Verification failed");
      setVerifying(false);
    }
  }, [publicKey, checkWhitelist]);

  // Not connected — landing page. Re-themed to the design-system
  // vocabulary so the disconnected screen reads as the same product as
  // the authenticated dashboard: Stat hero tiles for assets and metrics,
  // TokenIcons for personality, an explicit three-step value prop instead
  // of a generic paragraph + KPI grid.
  if (!connected) {
    return (
      <div className="space-y-10 pb-12">
        {/* Hero — title + value prop + primary CTA. Centred, capped width. */}
        <div className="text-center space-y-5 max-w-2xl mx-auto pt-4">
          <Eyebrow as="div" className="!text-base-content/55">
            Clearstone Fusion · Institutional
          </Eyebrow>
          <h1 className="font-display text-4xl font-light tracking-[-0.014em] leading-tight text-base-content">
            Earn on your collateral.
            <br />
            Borrow against it.
          </h1>
          <p className="text-base text-base-content/60 leading-relaxed max-w-xl mx-auto">
            A KYC-gated lending market for institutional desks. Mint
            yield-bearing collateral from your stables or SOL, deposit into
            klend, and unlock USDC at up to 95% LTV — net carry on day one.
          </p>
          <div className="pt-3 flex justify-center">
            <WalletMultiButton />
          </div>
          <div className="pt-1 flex items-center justify-center gap-2">
            <Badge tone="success" variant="soft" size="xs">KYC / KYB</Badge>
            <Badge tone="primary" variant="soft" size="xs">Klend v3</Badge>
            <Badge tone="neutral" variant="soft" size="xs">Solana devnet</Badge>
          </div>
        </div>

        {/* Supported assets — TokenIcon hero tiles, same shape as the head
            balance bar inside the app, so the brand reads as continuous. */}
        <div className="space-y-3">
          <div className="text-center">
            <Eyebrow as="div">Supported assets</Eyebrow>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat
              size="sm"
              icon={<TokenIcon symbol="ceUSX" size="md" />}
              iconHalo={tokenBrandColor("ceUSX")}
              label="ceUSX"
              value="~10%"
              unit="APY"
              caption="KYC-wrapped yield-bearing stable"
            />
            <Stat
              size="sm"
              icon={<TokenIcon symbol="csSOL" size="md" />}
              iconHalo={tokenBrandColor("csSOL")}
              label="csSOL"
              value="Jito"
              unit="restaking"
              caption="KYC-wrapped Solana LST"
            />
            <Stat
              size="sm"
              icon={<TokenIcon symbol="USDC" size="md" />}
              iconHalo={tokenBrandColor("USDC")}
              label="USDC"
              value="0.5–20%"
              unit="APR"
              caption="Borrow asset"
            />
            <Stat
              size="sm"
              icon={<TokenIcon symbol="USX" size="md" />}
              iconHalo={tokenBrandColor("USX")}
              label="USX"
              value="1.00"
              unit="USD"
              caption="Mintable from USDC / USDT"
            />
          </div>
        </div>

        {/* Key market metrics — surface accent stripe Stats (no icon) so
            they read as KPIs about the market, not balances. */}
        <div className="space-y-3">
          <div className="text-center">
            <Eyebrow as="div">Market parameters</Eyebrow>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat size="sm" label="Max LTV"          value="95%"     accent="primary" caption="Stables EG" />
            <Stat size="sm" label="Liquidation"      value="98%"     accent="info"    caption="Stables EG" />
            <Stat size="sm" label="Collateral yield" value="~8–12%"  accent="accent"  caption="eUSX baseline" />
            <Stat size="sm" label="Borrow APR"       value="0.5–20%" accent="info"    caption="USDC, util-curve" />
          </div>
        </div>

        {/* What you can do — three steps mirroring the Overview tab's
            lending-flow narrative. Concrete actions, in order. */}
        <Card tone="elevated" size="lg">
          <div className="text-center mb-6">
            <Eyebrow as="div">What you can do</Eyebrow>
            <h2 className="mt-2 font-display text-xl font-medium tracking-[-0.01em]">
              Three steps to a leveraged carry position
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <ValueStep
              n={1}
              title="Wrap"
              text="Mint USX from USDC / USDT, lock it for eUSX, then KYC-wrap into ceUSX collateral."
              icon={<TokenIcon symbol="ceUSX" size="md" />}
            />
            <ValueStep
              n={2}
              title="Earn"
              text="Supply ceUSX into the institutional klend reserve. The collateral keeps earning ~10% APY while it sits as backing."
              icon={<TokenIcon symbol="USX" size="md" />}
            />
            <ValueStep
              n={3}
              title="Borrow"
              text="Borrow USDC at the reserve rate, up to 95% LTV. Net carry: collateral yield minus borrow APR, on every dollar deployed."
              icon={<TokenIcon symbol="USDC" size="md" />}
            />
          </div>
        </Card>

        <p className="text-xs text-center text-base-content/45 max-w-md mx-auto">
          Access requires KYC/KYB verification through the institutional
          onboarding process. Connect your wallet to begin or check status.
        </p>
      </div>
    );
  }

  // Checking
  if (status === "checking" || status === "loading") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <span className="loading loading-spinner loading-lg text-primary"></span>
        <p className="text-base-content/60 text-sm">Verifying institutional credentials...</p>
      </div>
    );
  }

  // RPC / connection error
  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <p className="text-base-content/60 text-sm text-center max-w-sm">{error}</p>
        <Button variant="primary" size="sm" onClick={checkWhitelist}>Retry Verification</Button>
      </div>
    );
  }

  // Self-whitelisting in progress
  if (status === "self_whitelisting") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <span className="loading loading-spinner loading-lg text-primary"></span>
        <p className="text-base-content/60 text-sm">Processing KYC verification...</p>
      </div>
    );
  }

  // Not KYC'd — onboarding screen
  if (status === "pending") {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-8 space-y-6">
            <div className="text-center space-y-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
              <h2 className="text-2xl font-bold">Institutional Verification</h2>
              <p className="text-base-content/60 text-sm">
                Your wallet is not yet approved. Complete verification to access the lending platform.
              </p>
            </div>

            <div className="divider text-xs text-base-content/40">VERIFICATION STEPS</div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-base-300 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  <span className="font-semibold text-sm">1. Identity</span>
                </div>
                <p className="text-xs text-base-content/50">
                  Microsoft Entra B2C authentication with corporate credentials (OIDC)
                </p>
              </div>
              <div className="bg-base-300 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  <span className="font-semibold text-sm">2. KYB Review</span>
                </div>
                <p className="text-xs text-base-content/50">
                  Entity verification, beneficial ownership, AML/KYT screening
                </p>
              </div>
              <div className="bg-base-300 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                  <span className="font-semibold text-sm">3. Wallet Link</span>
                </div>
                <p className="text-xs text-base-content/50">
                  On-chain whitelist entry created for permissioned DeFi access
                </p>
              </div>
            </div>

            {error && (
              <div className={`alert ${verifying ? "alert-info" : "alert-error"} text-sm`}>
                {verifying ? (
                  <span className="loading loading-spinner loading-sm" />
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                )}
                <span>{error}</span>
              </div>
            )}

            {/* Devnet mock KYC — only for root authority */}
            {publicKey?.toBase58() === ROOT_AUTHORITY && (
              <div className="alert alert-warning">
                <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>
                <div>
                  <div className="font-semibold text-sm">Devnet: You are the root authority</div>
                  <div className="text-xs">You can self-whitelist for testing purposes.</div>
                </div>
                <Button variant="secondary" size="sm" onClick={handleSelfWhitelist}>
                  Mock KYC Approval
                </Button>
              </div>
            )}

            {/* Backend-powered verification for non-authority wallets */}
            {publicKey?.toBase58() !== ROOT_AUTHORITY && (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-2">
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleBackendVerification}
                    loading={verifying}
                    iconLeft={
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    }
                  >
                    Begin Verification
                  </Button>
                  <p className="text-xs text-base-content/40">
                    Compliance backend: KYC/KYB review → KYT screening → on-chain whitelist
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Approved — auto-dismissing sticky verification banner.
  return <ApprovedShell approvedPools={approvedPools} isAdmin={isAdmin} publicKey={publicKey}>{children}</ApprovedShell>;
}

interface ApprovedShellProps {
  approvedPools: string[];
  isAdmin: boolean;
  publicKey: PublicKey | null;
  children: ReactNode;
}

/**
 * Verified-access shell. Renders a bottom-right toast confirming KYC
 * status; the toast auto-dismisses after 3s — once the user has seen
 * the confirmation it gets out of the way and stops competing with
 * the page content. Failure / pending states still use their own
 * persistent surfaces above.
 */
function ApprovedShell({ approvedPools, isAdmin, publicKey, children }: ApprovedShellProps) {
  const [showToast, setShowToast] = useState(true);

  const detail = [
    approvedPools.length > 0 ? `Pools: ${approvedPools.join(", ")}` : null,
    isAdmin ? "admin" : null,
    publicKey ? `${publicKey.toBase58().slice(0, 12)}…` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div>
      {children}
      {showToast && (
        <Snackbar
          type="success"
          variant="toast"
          message="Institutional access verified"
          detail={detail || undefined}
          dismissAfterMs={3000}
          onDismiss={() => setShowToast(false)}
        />
      )}
    </div>
  );
}

/** Three-up step card used on the disconnected landing. Numbered eyebrow,
 *  TokenIcon header, short copy. Mirrors the lending-flow narrative on
 *  the authenticated Overview tab so the brand language is continuous
 *  pre- and post-login. */
function ValueStep({
  n,
  title,
  text,
  icon,
}: {
  n: number;
  title: string;
  text: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-base-300/70 bg-base-200 p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-base-content/45">
          Step {n}
        </span>
        {icon}
      </div>
      <div className="font-display text-lg font-medium tracking-[-0.01em] text-base-content leading-tight">
        {title}
      </div>
      <p className="text-xs text-base-content/60 leading-relaxed">{text}</p>
    </div>
  );
}
