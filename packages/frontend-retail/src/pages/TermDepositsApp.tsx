import { useState, useCallback, useEffect } from "react";
import {
  useWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fixedYield } from "@delta/calldata-sdk-solana";
import BN from "bn.js";
import {
  PublicKey,
  AddressLookupTableAccount,
  TransactionInstruction,
} from "@solana/web3.js";
import { useFixedYieldMarkets } from "../hooks/useFixedYieldMarkets";
import type { FixedYieldMarket } from "../hooks/useFixedYieldMarkets";
import { useKycStatus } from "../hooks/useKycStatus";
import { usePtPositions } from "../hooks/usePtPositions";
import type { PtPosition } from "../hooks/usePtPositions";
import {
  useCuratorVaults,
  useCuratorVaultPositions,
} from "../hooks/useCuratorVaults";
import type { CuratorVault } from "../hooks/useCuratorVaults";
import { MarketCard } from "../components/MarketCard";
import { DepositPtModal } from "../components/DepositPtModal";
import { PtPositionCard } from "../components/PtPositionCard";
import { SavingsAccountCard } from "../components/SavingsAccountCard";
import {
  SavingsDepositModal,
  type SavingsDepositSubmission,
} from "../components/SavingsDepositModal";
import { CuratorPositionCard } from "../components/CuratorPositionCard";

/**
 * Retail-facing fixed-yield savings page.
 *
 * Two sections:
 *   - Markets grid — open PT markets, deposit modal opens the zap-in flow.
 *   - Positions grid — user's PT holdings with a one-click Redeem button.
 *
 * Wire-up status:
 *   - Market list: backend-edge /fixed-yield/markets if `VITE_EDGE_URL`
 *     is set; fixture otherwise.
 *   - Positions: fixture for now. `usePtPositions` swaps to a backend
 *     query per (vault, user) when ready.
 *   - Deposit / Redeem tx: build via SDK, sign via wallet adapter, send
 *     via connection. Requires markets with real on-chain PDAs (so
 *     fixture-mode markets will fail at simulation).
 */
export function TermDepositsApp() {
  const { connected, publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { markets, loading, error: marketsError } = useFixedYieldMarkets();
  const { approved: kycApproved } = useKycStatus();
  const { positions, refresh: refreshPositions } = usePtPositions(markets);
  const { vaults: curatorVaults } = useCuratorVaults();
  const { positions: curatorPositions } = useCuratorVaultPositions(
    curatorVaults,
    publicKey ?? null
  );

  const [selected, setSelected] = useState<FixedYieldMarket | null>(null);
  const [selectedVault, setSelectedVault] = useState<CuratorVault | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Wallet balance of the selected market's underlying. Read on
  // demand when the user opens the deposit modal — keeps the page
  // load light. Token-program detected via the kamino bundle's
  // tokenProgramKamino slot (Token-2022 for csSOL); falls back to
  // classic SPL for the legacy adapter path.
  const [selectedBalance, setSelectedBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!publicKey || !selected) {
      setSelectedBalance(null);
      return;
    }
    let cancelled = false;
    const tokenProgram =
      selected.accounts?.kamino?.tokenProgramKamino?.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;
    const ata = getAssociatedTokenAddressSync(
      selected.baseMint,
      publicKey,
      false,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    connection
      .getTokenAccountBalance(ata)
      .then((bal) => {
        if (!cancelled) setSelectedBalance(Number(bal.value.uiAmount ?? 0));
      })
      .catch(() => {
        if (!cancelled) setSelectedBalance(0);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey?.toBase58(), selected?.id, connection]);

  const reset = () => {
    setStatusMsg(null);
    setErrorMsg(null);
  };

  // -------------------------------------------------------------------------
  // Deposit flow: build, sign, send.
  // -------------------------------------------------------------------------

  const handleDeposit = useCallback(
    async (args: { market: FixedYieldMarket; amountBase: BN }) => {
      if (!publicKey || !signTransaction) return;
      reset();
      setSubmitting(true);

      try {
        const m = args.market;
        if (!m.accounts) {
          throw new Error(
            "Market metadata incomplete — backend /fixed-yield/markets didn't include the adapter account block. Deposit unavailable until the indexer returns real on-chain state."
          );
        }

        const a = m.accounts;
        const ata = (mint: PublicKey) =>
          getAssociatedTokenAddressSync(
            mint,
            publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );

        const baseSrc = ata(m.baseMint);
        const sySrc = ata(a.syMint);
        const ptDst = ata(a.mintPt);
        const ytDst = ata(a.mintYt);

        // Ensure SY/PT/YT ATAs exist. Strip creates tokens into these;
        // the idempotent variant is a no-op if they're already there.
        const preIxs: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, sySrc, publicKey, a.syMint,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, ptDst, publicKey, a.mintPt,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, ytDst, publicKey, a.mintYt,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
        ];

        // Resolve ALTs. Frontend tolerates either being missing —
        // compileToV0Message falls back to inlining the accounts.
        const alts: AddressLookupTableAccount[] = [];
        for (const altKey of [a.vaultAlt, a.marketAlt]) {
          const res = await connection.getAddressLookupTable(altKey);
          if (res.value) alts.push(res.value);
        }

        const { blockhash } = await connection.getLatestBlockhash();

        // Adapter dispatch: kamino-backed vaults can't go through the
        // generic strip+sell_yt zap (router's `wrapper_strip` is
        // hardwired to generic_exchange_rate_sy). When the indexer
        // surfaces a kamino bundle, route through the single-ix
        // wrapper_buy_pt_kamino path. The PT amount we ask for is
        // amountBase / pt_price — for stable-curve markets pt_price ≈
        // 1 so amountBase ≈ ptOut; the curve will correct via slippage.
        // Setting `maxBase = amountBase` and `maxSyIn = -amountBase * 2`
        // gives generous slippage (negative because SY leaves the
        // user when buying PT). Tighten when the /quote endpoint lands.
        let zapIxs: TransactionInstruction[];
        if (a.kamino) {
          const k = a.kamino;
          if (!k.realKlend) {
            throw new Error(
              "Kamino market entry is missing realKlend bundle — populate via scripts/resolve-market-registry.ts"
            );
          }
          const r = k.realKlend;
          zapIxs = fixedYield.zap.buildZapInToPtKamino({
            user: publicKey,

            // adapter
            syMetadata: a.syMarket,
            underlyingMint: m.baseMint,
            syMint: a.syMint,
            baseSrc,
            sySrc,
            collateralVault: a.baseVault,
            klendReserve: k.klendReserve,
            klendLiquiditySupply: k.klendLiquiditySupply,
            klendCollateralMint: k.klendCollateralMint,
            klendProgram: k.klendProgram,

            realKlend: {
              klendLendingMarket: r.klendLendingMarket,
              klendLendingMarketAuthority: r.klendLendingMarketAuthority,
              klendInstructionSysvar: r.klendInstructionSysvar,
              klendLiquidityTokenProgram: r.klendLiquidityTokenProgram,
              klendPythOracle: r.klendPythOracle,
              klendSwitchboardPrice: r.klendSwitchboardPrice,
              klendSwitchboardTwap: r.klendSwitchboardTwap,
              klendScopePrices: r.klendScopePrices,
            },

            // core.trade_pt
            market: m.market,
            ptDst,
            marketEscrowSy: a.marketEscrowSy,
            marketEscrowPt: a.marketEscrowPt,
            marketAlt: a.marketAlt,
            tokenFeeTreasurySy: a.tokenFeeTreasurySy,
            coreEventAuthority: a.coreEventAuthority,

            tokenProgram: TOKEN_PROGRAM_ID,
            tokenProgramKamino: k.tokenProgramKamino,
            syProgram: a.syProgram,

            ptAmount: args.amountBase,
            maxBase: args.amountBase,
            maxSyIn: args.amountBase.muln(2).neg(),
          });
        } else {
          // Legacy generic-adapter path: strip → sell_yt cascade.
          zapIxs = fixedYield.zap.buildZapInToPt({
            user: publicKey,
            syMarket: a.syMarket,
            baseMint: m.baseMint,
            syMint: a.syMint,
            baseVault: a.baseVault,
            authority: a.vaultAuthority,
            vault: m.vault,
            yieldPosition: a.yieldPosition,
            addressLookupTable: a.vaultAlt,
            coreEventAuthority: a.coreEventAuthority,
            baseSrc,
            sySrc,
            escrowSy: a.escrowSy,
            ytDst,
            ptDst,
            mintPt: a.mintPt,
            mintYt: a.mintYt,
            amountBase: args.amountBase,
            sellYt: {
              ytIn: args.amountBase,
              minSyOut: new BN(0),
              market: m.market,
              marketEscrowSy: a.marketEscrowSy,
              marketEscrowPt: a.marketEscrowPt,
              marketAlt: a.marketAlt,
              tokenFeeTreasurySy: a.tokenFeeTreasurySy,
            },
            syProgram: a.syProgram,
          });
        }

        const tx = fixedYield.tx.packV0Tx({
          ixs: [...preIxs, ...zapIxs],
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: alts,
          computeBudget: { unitLimit: 400_000 },
        });

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(`Deposit confirmed: ${sig.slice(0, 12)}…`);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Deposit failed"
        );
      } finally {
        setSubmitting(false);
        setSelected(null);
        refreshPositions();
      }
    },
    [publicKey, signTransaction, connection, refreshPositions]
  );

  // -------------------------------------------------------------------------
  // Redeem flow: build buildZapOutToBaseV0Tx, sign, send.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Savings-account (curator-vault) deposit. One-tx flow:
  //   idempotent ATA → curator.deposit(amount_base)
  // -------------------------------------------------------------------------

  const handleSavingsDeposit = useCallback(
    async (args: SavingsDepositSubmission) => {
      const { vault, amountBase, enableAutoRoll, maxSlippageBps, ttlSlots } =
        args;
      if (!publicKey || !signTransaction) return;
      reset();
      setSubmitting(true);

      try {
        const baseSrc = getAssociatedTokenAddressSync(
          vault.baseMint,
          publicKey,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const position = fixedYield.curator.curatorUserPositionPda(
          vault.vault,
          publicKey
        );

        const preIxs: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            baseSrc,
            publicKey,
            vault.baseMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          ),
        ];

        const depositIx = fixedYield.curator.buildCuratorDeposit({
          owner: publicKey,
          vault: vault.vault,
          baseMint: vault.baseMint,
          baseEscrow: vault.baseEscrow,
          baseSrc,
          position,
          amountBase,
        });

        const ixs: TransactionInstruction[] = [...preIxs, depositIx];

        // If the user enabled auto-roll, bundle a create_delegation ix.
        // Single signature covers both — deposit and delegation happen
        // atomically; if either fails, nothing persists.
        if (enableAutoRoll) {
          ixs.push(
            fixedYield.delegation.buildCreateDelegation({
              user: publicKey,
              vault: vault.vault,
              maxSlippageBps,
              ttlSlots,
            })
          );
        }

        const { blockhash } = await connection.getLatestBlockhash();
        const tx = fixedYield.tx.packV0Tx({
          ixs,
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: [],
          computeBudget: { unitLimit: 240_000 },
        });

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(
          enableAutoRoll
            ? `Deposit + auto-roll enabled: ${sig.slice(0, 12)}…`
            : `Deposit confirmed: ${sig.slice(0, 12)}…`
        );
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Savings deposit failed"
        );
      } finally {
        setSubmitting(false);
        setSelectedVault(null);
      }
    },
    [publicKey, signTransaction, connection]
  );

  // Revoke an active delegation. Single-ix tx; UX parity with deposit.
  const handleRevokeDelegation = useCallback(
    async (vault: CuratorVault) => {
      if (!publicKey || !signTransaction) return;
      reset();
      try {
        const ix = fixedYield.delegation.buildCloseDelegation({
          user: publicKey,
          vault: vault.vault,
        });
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = fixedYield.tx.packV0Tx({
          ixs: [ix],
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: [],
          computeBudget: { unitLimit: 50_000 },
        });
        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(`Auto-roll revoked: ${sig.slice(0, 12)}…`);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Revoke failed"
        );
      }
    },
    [publicKey, signTransaction, connection]
  );

  const handleRedeem = useCallback(
    async (position: PtPosition, amountPy: BN) => {
      if (!publicKey || !signTransaction) return;
      reset();
      setRedeemingId(position.market.id);

      try {
        const m = position.market;
        if (!m.accounts) {
          throw new Error(
            "Market metadata incomplete — backend /fixed-yield/markets didn't include the adapter account block."
          );
        }

        const a = m.accounts;
        const ata = (mint: PublicKey) =>
          getAssociatedTokenAddressSync(
            mint,
            publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );

        const baseDst = ata(m.baseMint);
        const sySrc = ata(a.syMint);
        const ptSrc = ata(a.mintPt);
        const ytSrc = ata(a.mintYt);

        // Base ATA must exist to receive redeem proceeds. SY/PT/YT ATAs
        // already exist (user must have PT/YT to redeem), but we
        // idempotent-create for safety.
        const preIxs: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, baseDst, publicKey, m.baseMint,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
        ];

        const alts: AddressLookupTableAccount[] = [];
        const vaultAltRes = await connection.getAddressLookupTable(a.vaultAlt);
        if (vaultAltRes.value) alts.push(vaultAltRes.value);

        const { blockhash } = await connection.getLatestBlockhash();

        const mergeIx = fixedYield.zap.buildZapOutToBase({
          user: publicKey,
          syMarket: a.syMarket,
          baseMint: m.baseMint,
          syMint: a.syMint,
          baseVault: a.baseVault,
          authority: a.vaultAuthority,
          vault: m.vault,
          yieldPosition: a.yieldPosition,
          addressLookupTable: a.vaultAlt,
          coreEventAuthority: a.coreEventAuthority,
          sySrc,
          baseDst,
          escrowSy: a.escrowSy,
          ytSrc,
          ptSrc,
          mintPt: a.mintPt,
          mintYt: a.mintYt,
          amountPy,
          syProgram: a.syProgram,
        });

        const tx = fixedYield.tx.packV0Tx({
          ixs: [...preIxs, mergeIx],
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: alts,
          computeBudget: { unitLimit: 300_000 },
        });

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(`Redeem confirmed: ${sig.slice(0, 12)}…`);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Redeem failed"
        );
      } finally {
        setRedeemingId(null);
        refreshPositions();
      }
    },
    [publicKey, signTransaction, connection, refreshPositions]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col flex-1">
      <main className="mx-auto max-w-5xl p-6">
        <section>
          <div className="mb-8">
            <span className="eyebrow">Fixed yield</span>
            <h1 className="font-display text-3xl md:text-4xl font-light tracking-tight mt-2">
              Term <span className="text-primary font-medium">deposits</span>
            </h1>
            <p className="mt-2 text-sm opacity-70 max-w-2xl">
              Deposit now, earn a locked-in rate through maturity. Redeem
              any time at the prevailing PT price on the AMM.
            </p>
          </div>

          {!connected && (
            <div className="alert alert-info mb-6">
              <span>Connect a wallet to deposit.</span>
            </div>
          )}

          {marketsError && (
            <div className="alert alert-warning mb-6">
              <span>
                Live market data unavailable ({marketsError.message}) —
                showing fixture data.
              </span>
            </div>
          )}

          {statusMsg && (
            <div className="alert alert-info mb-6">
              <span>{statusMsg}</span>
            </div>
          )}
          {errorMsg && (
            <div className="alert alert-error mb-6">
              <span>{errorMsg}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 opacity-70">
              <span className="loading loading-spinner loading-sm" />
              <span>Loading markets…</span>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {markets.map((m) => (
                <MarketCard
                  key={m.id}
                  market={m}
                  kycApproved={kycApproved}
                  onDeposit={(mk) => setSelected(mk)}
                />
              ))}
            </div>
          )}
        </section>

        {curatorVaults.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xl font-semibold mb-1">Auto-roll savings</h2>
            <p className="text-sm opacity-70 mb-4">
              Deposit once and let the curator reroll your position across
              maturities. Withdraw any time up to vault idle liquidity.
            </p>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {curatorVaults.map((v) => (
                <SavingsAccountCard
                  key={v.id}
                  vault={v}
                  onDeposit={(vk) => setSelectedVault(vk)}
                />
              ))}
            </div>
          </section>
        )}

        {connected &&
          (positions.length > 0 || curatorPositions.length > 0) && (
            <section className="mt-10">
              <h2 className="text-xl font-semibold mb-4">Your positions</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {positions.map((p) => (
                  <PtPositionCard
                    key={p.market.id}
                    position={p}
                    redeeming={redeemingId === p.market.id}
                    onRedeem={handleRedeem}
                  />
                ))}
                {curatorPositions.map((p) => (
                  <CuratorPositionCard
                    key={`sav-${p.vault.id}`}
                    position={p}
                    user={publicKey!}
                    connection={connection}
                    onRevoke={() => handleRevokeDelegation(p.vault)}
                  />
                ))}
              </div>
            </section>
          )}

        <DepositPtModal
          market={selected}
          walletBalance={selectedBalance}
          onClose={() => (submitting ? null : setSelected(null))}
          onSubmit={handleDeposit}
          submitting={submitting}
        />

        <SavingsDepositModal
          vault={selectedVault}
          onClose={() => (submitting ? null : setSelectedVault(null))}
          onSubmit={handleSavingsDeposit}
          submitting={submitting}
        />
      </main>
    </div>
  );
}
