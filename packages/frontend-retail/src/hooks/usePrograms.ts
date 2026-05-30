import { useMemo, useState, useEffect } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { DEVNET_CONFIG } from "../config/devnet";

/**
 * Loads the v3 governor + delta-mint Anchor programs.
 *
 * Post-2026-05-06 USDY deprecation: retail only talks to v3. The
 * legacy v1 governor / delta-mint pair (used by the dtUSDY pool +
 * `selfRegister`) is no longer wired here — every retail flow goes
 * through `governor.selfRegisterNative` against the v3 cSOL pool.
 *
 * After redeploys that add new ixs, copy the freshly-built IDL into
 * `frontend-retail/public/idl/governor.json` so the typed `methods`
 * accessor sees them.
 */
export function usePrograms() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [govIdl, setGovIdl] = useState<any>(null);
  const [dmIdl, setDmIdl] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      fetch("/idl/governor.json").then((r) => r.json()),
      fetch("/idl/delta_mint.json").then((r) => r.json()),
    ]).then(([gov, dm]) => {
      setGovIdl(gov);
      setDmIdl(dm);
    });
  }, []);

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  }, [connection, wallet]);

  // Anchor 0.30+ reads the program id from `idl.address`. We override
  // it explicitly so we don't depend on whatever address the IDL was
  // built against (the IDL ships with the workspace's declare_id —
  // which IS v3 — but being explicit guards against future moves).
  const governor = useMemo(() => {
    if (!provider || !govIdl) return null;
    const idl = { ...govIdl, address: DEVNET_CONFIG.programs.governor.toBase58() };
    return new Program(idl, provider);
  }, [provider, govIdl]);

  const deltaMint = useMemo(() => {
    if (!provider || !dmIdl) return null;
    const idl = { ...dmIdl, address: DEVNET_CONFIG.programs.deltaMint.toBase58() };
    return new Program(idl, provider);
  }, [provider, dmIdl]);

  return {
    ready: !!governor && !!deltaMint,
    provider,
    governor,
    deltaMint,
    config: DEVNET_CONFIG,
  };
}
