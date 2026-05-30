import { useEffect, useState, useCallback } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { fixedYield } from "@delta/calldata-sdk-solana";

export interface RollDelegationInfo {
  pda: PublicKey;
  exists: boolean;
  maxSlippageBps: number | null;
  expiresAtSlot: bigint | null;
}

/**
 * Reads the RollDelegation PDA for (vault, user) and decodes the
 * slippage + expiry fields. Uses the account's raw data rather than
 * pulling @coral-xyz/anchor into the frontend.
 *
 * RollDelegation layout (from clearstone_curator/src/roll_delegation.rs):
 *
 *   8    discriminator
 *   32   vault
 *   32   user
 *   2    max_slippage_bps        ← offset 72
 *   8    expires_at_slot         ← offset 74
 *   32   allocations_hash
 *   8    created_at_slot
 *   1    bump
 */
export function useRollDelegation(
  connection: Connection,
  vault: PublicKey | null,
  user: PublicKey | null
): {
  info: RollDelegationInfo | null;
  loading: boolean;
  refresh: () => void;
} {
  const [state, setState] = useState<{
    info: RollDelegationInfo | null;
    loading: boolean;
  }>({ info: null, loading: false });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!vault || !user) {
      setState({ info: null, loading: false });
      return;
    }
    const pda = fixedYield.delegation.rollDelegationPda(vault, user);
    setState((s) => ({ ...s, loading: true }));
    let cancelled = false;

    (async () => {
      const info = await connection.getAccountInfo(pda);
      if (cancelled) return;

      if (!info || info.data.length < 115) {
        setState({
          info: {
            pda,
            exists: false,
            maxSlippageBps: null,
            expiresAtSlot: null,
          },
          loading: false,
        });
        return;
      }

      const view = new DataView(
        info.data.buffer,
        info.data.byteOffset,
        info.data.byteLength
      );
      const maxSlippageBps = view.getUint16(72, true);
      const expiresAtSlot = view.getBigUint64(74, true);
      setState({
        info: { pda, exists: true, maxSlippageBps, expiresAtSlot },
        loading: false,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [vault?.toBase58(), user?.toBase58(), nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { info: state.info, loading: state.loading, refresh };
}
