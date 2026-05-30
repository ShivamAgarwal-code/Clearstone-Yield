import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { usePrograms } from "./usePrograms";

export type KycState = "unknown" | "checking" | "approved" | "not_approved";

/** A single delta-mint pool the retail flow needs whitelisting on. */
export interface KycPoolRequirement {
  /** Human-readable label (used in surfaces / errors). */
  label: string;
  /** delta-mint MintConfig pubkey for the pool. */
  dmMintConfig: PublicKey;
  /** delta-mint program id that owns the whitelist PDA. */
  deltaMintProgram: PublicKey;
}

export interface KycStatus {
  status: KycState;
  /** True iff status === "approved" — every pool requirement satisfied. */
  approved: boolean;
  /** Per-pool whitelist PDA + presence flag. */
  pools: Array<{
    label: string;
    pda: PublicKey;
    /** True if the whitelist account exists on chain with role=Holder. */
    granted: boolean;
  }>;
  /** Force a re-check (e.g. after the user completes Civic). */
  refresh: () => void;
}

/**
 * KYC status for the connected wallet — aggregated across every pool
 * the retail flow needs whitelisting on.
 *
 * Post-2026-05-06 USDY deprecation, retail only needs ONE whitelist:
 *   * v3 cSOL pool (`config.csolPool`) — required by `wrap_native`
 *     in the SOL deposit flow. Without this PDA, delta-mint's
 *     mint_to CPI fails with `AccountNotInitialized` (Custom 3012).
 *
 * USDC supply on the v3 sUSDC reserve doesn't require any whitelist,
 * so retail USDC deposits work regardless of cSOL whitelist state.
 * KycGate still surfaces if cSOL is missing — that's the only remote
 * action a non-onboarded retail wallet can fail on.
 *
 * `approved` is STRICTLY: every required whitelist exists on chain
 * with role byte set. We never accept a backend signal as a substitute
 * — that's how we got bypassed-gate users hitting AccountNotInitialized
 * earlier (their compliance backend said "approved" but no on-chain
 * whitelist existed, so the wrap failed).
 */
export function useKycStatus(): KycStatus {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const { config } = usePrograms();

  const [status, setStatus] = useState<KycState>("unknown");
  const [pools, setPools] = useState<KycStatus["pools"]>([]);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!publicKey || !connected) {
      setStatus("unknown");
      setPools([]);
      return;
    }
    setStatus("checking");

    const wallet = publicKey.toBase58();

    // The list of pools the retail flow needs whitelisting on. cSOL is
    // currently the only one. Add new entries here when adding a
    // KYC-gated retail asset; bump the sessionStorage cache key
    // (`kyc_retail_v2_…`) at the same time so wallets whose existing
    // cache predates the new requirement are forced through a fresh
    // on-chain check.
    const requirements: KycPoolRequirement[] = [
      {
        label: "cSOL",
        dmMintConfig: config.csolPool.dmMintConfig,
        deltaMintProgram: config.programs.deltaMint,
      },
    ];

    const derived = requirements.map((req) => {
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("whitelist"),
          req.dmMintConfig.toBuffer(),
          publicKey.toBuffer(),
        ],
        req.deltaMintProgram,
      );
      return { label: req.label, pda, granted: false };
    });
    setPools(derived);

    if (sessionStorage.getItem(`kyc_retail_v2_${wallet}`) === "approved") {
      setStatus("approved");
      setPools(derived.map((p) => ({ ...p, granted: true })));
      return;
    }

    let cancelled = false;
    Promise.all(
      derived.map((p) =>
        connection
          .getAccountInfo(p.pda)
          .then((info) => ({
            ...p,
            // delta-mint WhitelistEntry layout: disc(8) + wallet(32) +
            // mint_config(32) + role(1, byte 72) + bump(1) + flags…
            // The retail hook previously read byte 64 (mid-pubkey
            // garbage) which silently never matched 1, masking real
            // gates. Institutional KycGate hit and fixed the same
            // bug earlier; bringing retail in line with that.
            granted: !!info && info.data.length >= 73 && info.data[72] === 1,
          }))
          .catch(() => p),
      ),
    )
      .then((resolved) => {
        if (cancelled) return;
        setPools(resolved);
        const allGranted = resolved.every((p) => p.granted);
        if (allGranted) {
          sessionStorage.setItem(`kyc_retail_v2_${wallet}`, "approved");
          setStatus("approved");
        } else {
          // Make sure stale cache entries can't keep claiming approval
          // after a whitelist was revoked or a new pool was added.
          sessionStorage.removeItem(`kyc_retail_v2_${wallet}`);
          setStatus("not_approved");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("unknown");
      });

    return () => {
      cancelled = true;
    };
  }, [publicKey?.toBase58(), connected, connection, config, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    status,
    approved: status === "approved",
    pools,
    refresh,
  };
}
