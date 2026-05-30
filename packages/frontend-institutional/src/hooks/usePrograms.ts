import { useMemo, useState, useEffect } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { DEVNET_CONFIG } from "../config/devnet";

// IDLs loaded dynamically to avoid build path issues
async function loadIdls() {
  const [governorIdl, deltaMintIdl] = await Promise.all([
    fetch("/idl/governor.json").then((r) => r.json()).catch(() => null),
    fetch("/idl/delta_mint.json").then((r) => r.json()).catch(() => null),
  ]);
  return { governorIdl, deltaMintIdl };
}

export function usePrograms() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [idls, setIdls] = useState<{ governorIdl: any; deltaMintIdl: any } | null>(null);

  useEffect(() => {
    loadIdls().then(setIdls);
  }, []);

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  }, [connection, wallet]);

  const governor = useMemo(() => {
    if (!provider || !idls?.governorIdl) return null;
    return new Program(idls.governorIdl, provider);
  }, [provider, idls]);

  const deltaMint = useMemo(() => {
    if (!provider || !idls?.deltaMintIdl) return null;
    return new Program(idls.deltaMintIdl, provider);
  }, [provider, idls]);

  return {
    provider,
    governor,
    deltaMint,
    config: DEVNET_CONFIG,
    ready: !!provider && !!governor && !!deltaMint,
  };
}
