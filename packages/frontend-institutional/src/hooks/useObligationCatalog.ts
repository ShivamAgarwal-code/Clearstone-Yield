import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { readObligation, sfToNumber } from "../lib/credit-trade/obligationView";
import type { ObligationCatalogEntry } from "../components/ObligationSwitcher";

/**
 * EG-name labels — data-driven so the pill describes what the
 * obligation IS (LST/SOL, stables, etc.) rather than which tab opened
 * it. Hardcoded role labels ("credit trade" / "manage") were a lie:
 * a wallet's #0 isn't always credit-trade — the convention is per-app
 * and bleeds into per-wallet UX as a stale label when a user opens
 * the same id from a different tab. The EG-N badge already carries
 * the precise identity; this label is the human-readable companion.
 */
function labelForEg(eg: number | undefined): string | undefined {
  if (eg === undefined || eg === 0) return undefined;
  if (eg === 1) return "stables";
  if (eg === 2) return "LST/SOL";
  if (eg === 3) return "margin long";
  if (eg === 4) return "margin short";
  return undefined;
}

interface UseObligationCatalogArgs {
  /**
   * Id always shown in the catalog even if its on-chain account doesn't
   * exist yet — typically the currently-selected slot. Lets the switcher
   * keep a "+New / empty" pill highlighted while the user is composing
   * the first deposit on that obligation.
   */
  selected: number;
  /** Number of seed-ids to probe (0..probeCount-1). Defaults to 8. */
  probeCount?: number;
  /**
   * Bump this to force a re-fetch (e.g. after a deposit/withdraw lands
   * so the displayed collateral USD reflects the new state).
   */
  nonce?: number;
}

/**
 * Shared obligation-catalog probe.
 *
 * Reads `readObligation` for every seed-id in `[0, probeCount)` against
 * the connected wallet, then returns a deduped, ordered catalog suitable
 * for handing to `<ObligationSwitcher catalog={...} />`. Always includes
 * the well-known slots (credit-trade=0, manage=3) and the
 * currently-selected slot, even when their on-chain accounts don't
 * exist yet — so the user can see "+New" alongside their existing
 * positions.
 *
 * Same primitive PositionsPage was rolling inline. Lifted here so the
 * credit-trade panel + any future tab can share one source of truth
 * (and one set of bug-fixes) for catalog construction.
 */
export function useObligationCatalog({
  selected,
  probeCount = 8,
  nonce = 0,
}: UseObligationCatalogArgs): {
  catalog: ObligationCatalogEntry[];
  loading: boolean;
  refresh: () => void;
} {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [catalog, setCatalog] = useState<ObligationCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [internalNonce, setInternalNonce] = useState(0);
  const refresh = useCallback(() => setInternalNonce((n) => n + 1), []);

  useEffect(() => {
    if (!publicKey) {
      setCatalog([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const ids = Array.from({ length: probeCount }, (_, i) => i);
        const reads = await Promise.all(
          ids.map((id) => readObligation(connection, publicKey, id)),
        );
        if (cancelled) return;
        const ALWAYS_VISIBLE = new Set<number>([0, 3, selected]);
        const entries: ObligationCatalogEntry[] = [];
        ids.forEach((id, i) => {
          const ob = reads[i];
          const visible = ob.exists || ALWAYS_VISIBLE.has(id);
          if (!visible) return;
          entries.push({
            id,
            summary: {
              exists: ob.exists,
              // klend's cached `depositedValueSf` is a Q60 USD value —
              // sfToNumber turns it into a JS number we can render.
              // Stale-by-one-slot (`refresh_obligation` updates it) but
              // close enough for a switcher pill caption.
              collateralUsd: ob.exists ? sfToNumber(ob.depositedValueSf) : undefined,
              elevationGroup: ob.exists ? ob.elevationGroup : undefined,
            },
            label: ob.exists
              ? labelForEg(ob.elevationGroup)
              : "new",
          });
        });
        setCatalog(entries.sort((a, b) => a.id - b.id));
      } catch {
        if (!cancelled) setCatalog([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey?.toBase58(), connection, probeCount, selected, nonce, internalNonce]);

  return { catalog, loading, refresh };
}
