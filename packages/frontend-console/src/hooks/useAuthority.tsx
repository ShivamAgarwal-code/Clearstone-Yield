import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { DEVNET_CONFIG } from "../config/devnet";

/**
 * Authority context — single source of truth for "is the connected
 * wallet allowed to send write transactions on this surface?"
 *
 * Two roles, OR'd into one `canWrite` flag for the page-level banner:
 *
 *   - `isAdmin`        — has the governor admin PDA, OR is the hardcoded
 *                        root authority. Required for KYC whitelist /
 *                        delta-mint admin actions.
 *   - `isMarketOwner`  — owner field on the klend lending-market account
 *                        matches the wallet. Required for `update_reserve_config`,
 *                        elevation-group registration, oracle pinning.
 *
 * Non-authority wallets are NOT redirected — they can browse every panel
 * read-only. Each write button consults this hook to disable itself
 * (with an explanatory tooltip) so the failure mode is "button is grey"
 * instead of "transaction sim fails after wallet sign".
 */

const ROOT_AUTHORITY = new PublicKey("AhKNmBmaeq6XrrEyGnSQne3WeU4SoN7hSAGieTiqPaJX");
// klend LendingMarket.owner offset — verified against ElevationGroupsPanel.tsx
// (which decodes the same struct).
const LM_OWNER_OFFSET = 24;

export interface AuthorityState {
  /** true while the on-chain checks are still in-flight. */
  loading: boolean;
  /** governor admin PDA exists, or wallet is the hardcoded root. */
  isAdmin: boolean;
  /** wallet is the klend lendingMarket.owner. */
  isMarketOwner: boolean;
  /** convenience: any kind of write authority. Used for the read-only banner. */
  canWrite: boolean;
  /** root authority bypass — useful for "delegated admin" callouts. */
  isRoot: boolean;
  /** the lendingMarket.owner publickey, once fetched. null while loading or on error. */
  marketOwner: PublicKey | null;
  /** force a re-fetch after a write succeeds (e.g. add-admin tx). */
  refresh: () => void;
}

const AuthorityContext = createContext<AuthorityState | null>(null);

export function AuthorityProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();

  const [marketOwner, setMarketOwner] = useState<PublicKey | null>(null);
  const [adminPdaExists, setAdminPdaExists] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const isRoot = useMemo(
    () => !!publicKey && publicKey.equals(ROOT_AUTHORITY),
    [publicKey],
  );

  // klend lendingMarket.owner — slot at offset 42 of the 4744-byte struct.
  // Fetched once per connection (the owner only changes on-chain via
  // klend's `update_lending_market_owner` ix, which is rare enough we
  // don't need to subscribe for live updates).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await connection.getAccountInfo(DEVNET_CONFIG.market.lendingMarket);
        if (cancelled) return;
        if (!info || info.data.length < LM_OWNER_OFFSET + 32) {
          setMarketOwner(null);
          return;
        }
        setMarketOwner(new PublicKey(info.data.subarray(LM_OWNER_OFFSET, LM_OWNER_OFFSET + 32)));
      } catch {
        if (!cancelled) setMarketOwner(null);
      }
    })();
    return () => { cancelled = true; };
  }, [connection]);

  // governor admin PDA — exists iff `add-admin <wallet>` has been run.
  useEffect(() => {
    if (!publicKey || !connected) {
      setAdminPdaExists(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [adminEntry] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("admin"),
            DEVNET_CONFIG.pool.poolConfig.toBuffer(),
            publicKey.toBuffer(),
          ],
          DEVNET_CONFIG.programs.governor,
        );
        const info = await connection.getAccountInfo(adminEntry);
        if (!cancelled) setAdminPdaExists(!!info);
      } catch {
        if (!cancelled) setAdminPdaExists(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, publicKey, connected, tick]);

  const isAdmin = isRoot || adminPdaExists === true;
  const isMarketOwner =
    !!publicKey && !!marketOwner && publicKey.equals(marketOwner);
  const canWrite = connected && (isAdmin || isMarketOwner);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const value = useMemo<AuthorityState>(
    () => ({
      loading,
      isAdmin,
      isMarketOwner,
      canWrite,
      isRoot,
      marketOwner,
      refresh,
    }),
    [loading, isAdmin, isMarketOwner, canWrite, isRoot, marketOwner, refresh],
  );

  return (
    <AuthorityContext.Provider value={value}>{children}</AuthorityContext.Provider>
  );
}

export function useAuthority(): AuthorityState {
  const ctx = useContext(AuthorityContext);
  if (!ctx) {
    throw new Error("useAuthority must be used inside <AuthorityProvider>");
  }
  return ctx;
}

/** Reason the user can't send a write tx — feeds tooltips on disabled
 *  buttons so the user knows *why* a control is greyed out. */
export function authorityReason(a: AuthorityState, role: "admin" | "marketOwner" | "any" = "any"): string {
  if (role === "admin" && !a.isAdmin) {
    return "Read-only — connect a wallet with governor admin authority.";
  }
  if (role === "marketOwner" && !a.isMarketOwner) {
    return "Read-only — connect the klend lending-market owner wallet.";
  }
  if (role === "any" && !a.canWrite) {
    return "Read-only — connect an admin or market-owner wallet.";
  }
  return "";
}
