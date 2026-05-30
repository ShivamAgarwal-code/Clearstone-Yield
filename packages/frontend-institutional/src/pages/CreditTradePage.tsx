/**
 * CreditTradePage — variant-driven credit-trade surface. Pick between
 * the Stables (EG-1) and LST/SOL (EG-2) credit trades, then drive an
 * open / increase / close flow inside the active panel.
 *
 * Companion to PositionsPage: both surfaces drive the same klend
 * obligation (OB_ID = 3), but this page focuses on opening intent
 * (margin + target leverage), while PositionsPage stays à-la-carte.
 */

import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PageHeader } from "@clearstone/design-system";

import { CreditVariantPicker, CreditVariant } from "../components/credit-trade/CreditVariantPicker";
import CssolWsolCreditPanel from "../components/credit-trade/CssolWsolCreditPanel";
import CeusxSusdcCreditPanel from "../components/credit-trade/CeusxSusdcCreditPanel";
import { readObligation } from "../lib/credit-trade/obligationView";

export default function CreditTradePage() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [variant, setVariant] = useState<CreditVariant>("lstSol");
  // Lifted obligation id — both panels read this so when the user
  // picks `#3 stables` from the Stables panel's switcher, switching
  // the page-level variant (next effect) preserves their selection
  // into the LST/SOL panel and vice versa.
  const [selectedObligationId, setSelectedObligationId] = useState<number>(0);
  const [currentEg, setCurrentEg] = useState<number | null>(null);

  // Read the active obligation's elevation group so:
  //   1. the picker can surface "on-chain active" on the matching tile
  //   2. the next effect can snap the variant when the user switches
  //      to a position with a different EG (EG-1 → Stables, EG-2 →
  //      LST/SOL). Re-runs whenever the user picks a different
  //      obligation pill in either panel.
  useEffect(() => {
    let cancelled = false;
    if (!publicKey) { setCurrentEg(null); return; }
    void (async () => {
      try {
        const ob = await readObligation(connection, publicKey, selectedObligationId);
        if (cancelled) return;
        setCurrentEg(ob.exists ? ob.elevationGroup : 0);
      } catch {
        if (!cancelled) setCurrentEg(null);
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey, connection, selectedObligationId]);

  // Snap the visible variant whenever the active obligation's EG
  // disagrees with it. EG-1 → Stables, EG-2 → LST/SOL. Skip when the
  // obligation is empty (eg=0) so a fresh `+ New` pill doesn't bounce
  // the user out of the variant they were composing in.
  useEffect(() => {
    if (currentEg === 1 && variant !== "stables") setVariant("stables");
    else if (currentEg === 2 && variant !== "lstSol") setVariant("lstSol");
  }, [currentEg, variant]);

  return (
    <div className="space-y-8 pb-12">
      <PageHeader
        eyebrow="Lending"
        title="Credit trade"
        subtitle="Leveraged collateral / debt loops on the v3 klend market. Pick a variant — each maps to one elevation group with its own open + close mechanics."
      />

      <CreditVariantPicker selected={variant} onSelect={setVariant} currentEg={currentEg} />

      {variant === "lstSol" && (
        <CssolWsolCreditPanel
          obligationId={selectedObligationId}
          onObligationChange={setSelectedObligationId}
        />
      )}
      {variant === "stables" && (
        <CeusxSusdcCreditPanel
          obligationId={selectedObligationId}
          onObligationChange={setSelectedObligationId}
        />
      )}
    </div>
  );
}
