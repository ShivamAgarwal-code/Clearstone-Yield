import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Button,
  Input,
  Snackbar,
  TokenIcon,
  TxActionButtons,
  shortSig,
} from "@clearstone/design-system";
import type { DeploymentConfig } from "../config/devnet";
import {
  buildDepositReserveLiquidityIx,
  buildRefreshReserveIx,
  reserveCollateralMint,
} from "../lib/klend";
import { buildWrapNativeIx } from "../lib/governorWrap";

interface SolDepositCardProps {
  /** User's native-SOL balance in SOL units. */
  solBalance: number | null;
  config: DeploymentConfig;
  supplyAPY?: number;
  onSuccess?: () => void;
}

/**
 * Atomic SOL → wSOL → cSOL → klend-supply in a single signature.
 *
 * Post-2026-05-06 the EG-2 debt asset moved from wSOL to cSOL (a 1:1
 * KYC-wrapped variant on the v3 native pool). Retail SOL deposits land
 * on the cSOL klend reserve via `wrap_native` + DepositReserveLiquidity.
 * The wSOL reserve is retired (deposit_limit=0) — kept only for the
 * matching SolWithdrawCard so legacy depositors can exit.
 *
 * Flow:
 *   [1] CU limit
 *   [2] ATA(wSOL)               idempotent — Token-classic
 *   [3] SystemProgram.transfer  SOL → wSOL ATA (lamports)
 *   [4] spl_token::SyncNative   refresh wSOL token-account amount
 *   [5] ATA(cSOL)               idempotent — Token-2022 (the wrap mint)
 *   [6] ATA(cSOL-cToken)        idempotent — Token-classic (klend cToken)
 *   [7] governor::wrap_native   wSOL → cSOL via the v3 native pool (KYC)
 *   [8] klend::RefreshReserve   precondition for deposit
 *   [9] klend::DepositReserveLiquidity (cSOL → klend cToken)
 *
 * The user pays gas + ATA rent; cSOL pool's `dm_mint_authority` mints
 * cSOL into the user's Token-2022 ATA, which is then deposited as the
 * reserve's underlying liquidity. The cToken mint stays Token-classic
 * (klend reserves are init'd with classic cToken mints), so the user's
 * c-account ATA uses TOKEN_PROGRAM_ID even though the underlying does
 * not.
 *
 * Whitelist gating lives on the unified retail `KycGate` (see
 * `useKycStatus` — checks the cSOL whitelist PDA). One Civic ceremony
 * onboards the wallet onto the cSOL pool via `selfRegisterNative`;
 * USDY-track whitelisting is gone after the 2026-05-06 deprecation.
 * By the time this card mounts the wallet is whitelisted on cSOL, so
 * the `wrap_native` step won't revert with delta-mint's
 * AccountNotInitialized (Custom 3012). A defensive precheck right
 * before signing catches the rare case where someone bypasses the
 * gate via a stale cache.
 */
export function SolDepositCard({ solBalance, config, supplyAPY = 0, onSuccess }: SolDepositCardProps) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "depositing" | "success" | "error">("idle");
  // Tx feedback funnels through the design-system Snackbar so retail
  // matches institutional. Mirrors DepositCard / WithdrawCard: `sig`
  // lights up the Explorer / Copy-sig action cluster on success;
  // `detail` carries the full error verbatim on failure (no slice).
  const [toast, setToast] = useState<
    | { type: "success" | "error" | "info"; msg: string; sig?: string; detail?: string }
    | null
  >(null);

  // Reserve a small SOL buffer so the user keeps fee-paying capacity
  // (rent for new ATAs + a couple of future txs). Cap MAX at
  // balance - 0.05 SOL.
  const SOL_RESERVE = 0.05;
  const maxAmount = Math.max((solBalance || 0) - SOL_RESERVE, 0);
  const apyPct = (supplyAPY * 100).toFixed(2);

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !amount || Number(amount) <= 0) return;
    setStatus("depositing");
    setToast({ type: "info", msg: `Depositing ${amount} SOL…` });

    try {
      const reserve = config.marketSol.cSolReserve;
      const market = config.marketSol.lendingMarket;
      const wsolMint = config.wsol.mint;
      const oracle = config.marketSol.cSolOracle;
      const csolMint = config.csolPool.wrappedMint;

      const lamports = BigInt(Math.floor(Number(amount) * LAMPORTS_PER_SOL));

      // Defensive cSOL whitelist precheck — if KycGate was bypassed
      // (e.g. stale sessionStorage from before the v2 cache key), the
      // wrap_native step would otherwise fail at the delta-mint
      // mint_to CPI with AccountNotInitialized (Custom 3012 / 0xbc4).
      // Surface that as an actionable message before the user signs.
      const [csolWhitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), config.csolPool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
        config.programs.deltaMint,
      );
      const csolWl = await connection.getAccountInfo(csolWhitelistEntry, "confirmed");
      if (!csolWl) {
        throw new Error(
          "cSOL whitelist missing — clear browser storage for this site and re-run the Civic verification gate. (delta-mint would reject the wrap with AccountNotInitialized 3012.)",
        );
      }

      const userWsolAta = getAssociatedTokenAddressSync(
        wsolMint, publicKey, false, TOKEN_PROGRAM_ID,
      );
      const userCsolAta = getAssociatedTokenAddressSync(
        csolMint, publicKey, false, TOKEN_2022_PROGRAM_ID,
      );
      // klend's cToken mint for the cSOL reserve. Reserves were init'd
      // with Token-classic cToken mints regardless of the underlying's
      // token program — see klend `init_reserve`.
      const cMint = reserveCollateralMint(reserve);
      const userCTokenAta = getAssociatedTokenAddressSync(
        cMint, publicKey, false, TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction();
      // Wrap + deposit needs ~120k CU on top of the standard wSOL
      // wrap; bump to 600k for headroom.
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

      // [2] wSOL ATA (idempotent — no-op if it exists).
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userWsolAta, publicKey, wsolMint, TOKEN_PROGRAM_ID,
        ),
      );

      // [3] Native SOL → wSOL ATA. wSOL token account amount is just
      //     the lamport balance of the underlying account; we transfer
      //     lamports, then sync_native (next ix) writes the amount
      //     field on the token account header so SPL transfers see it.
      tx.add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: userWsolAta,
          lamports,
        }),
      );

      // [4] Refresh the wSOL token account's amount field.
      tx.add(createSyncNativeInstruction(userWsolAta));

      // [5] cSOL ATA (idempotent — Token-2022).
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userCsolAta, publicKey, csolMint, TOKEN_2022_PROGRAM_ID,
        ),
      );

      // [6] cToken ATA (idempotent — Token-classic).
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userCTokenAta, publicKey, cMint, TOKEN_PROGRAM_ID,
        ),
      );

      // [7] wrap_native: wSOL → cSOL (KYC-gated).
      tx.add(
        buildWrapNativeIx({
          governor: config.programs.governor,
          deltaMint: config.programs.deltaMint,
          user: publicKey,
          amount: lamports,
          poolConfig: config.csolPool.poolConfig,
          poolUnderlyingVault: config.csolPool.poolWsolVault,
          dmMintConfig: config.csolPool.dmMintConfig,
          wrappedMint: csolMint,
          underlyingMint: wsolMint,
          userUnderlyingAta: userWsolAta,
          userWrappedAta: userCsolAta,
        }),
      );

      // [8] klend requires a fresh reserve before deposit_reserve_liquidity.
      tx.add(buildRefreshReserveIx(reserve, market, oracle));

      // [9] Deposit cSOL into the cSOL klend reserve.
      //     Liquidity token program = Token-2022 (cSOL is Token-2022);
      //     collateral token program = Token-classic (cToken mint).
      tx.add(
        buildDepositReserveLiquidityIx(
          publicKey,
          reserve,
          market,
          csolMint,
          lamports,
          TOKEN_2022_PROGRAM_ID,  // liquidity (cSOL)
          TOKEN_PROGRAM_ID,        // cToken
          userCsolAta,
          userCTokenAta,
        ),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signed = await signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      setStatus("success");
      setToast({ type: "success", msg: `Deposited ${amount} SOL`, sig });
      setAmount("");
      onSuccess?.();
    } catch (e: any) {
      console.error("SOL deposit failed:", e);
      const msg = e?.message
        || (typeof e === "string" ? e : null)
        || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setStatus("error");
      setToast({ type: "error", msg: "SOL deposit failed", detail: msg });
    }
  }, [publicKey, amount, connection, config, signTransaction, onSuccess]);

  const isDisabled =
    status === "depositing" ||
    Number(amount) <= 0 ||
    Number(amount) > maxAmount;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-lg">Deposit SOL</h3>
          <TokenIcon symbol="cSOL" size="md" />
        </div>
        <p className="text-sm opacity-60 -mt-1 mb-3">
          Earn <span className="text-primary font-semibold">{apyPct}%</span> APY by supplying SOL to the lending market.
          Your SOL is wrapped 1:1 into <span className="font-mono">cSOL</span> (KYC-gated) and deposited atomically.
        </p>

        <div className="mb-4">
          <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-base-content/55 mb-2">
            Amount (SOL)
          </label>
          <Input
            inputSize="lg"
            type="number"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setStatus("idle"); }}
            placeholder="0.00"
            min="0"
            max={maxAmount}
            step="0.001"
            numeric
            addonRight={
              <button
                type="button"
                onClick={() => setAmount(String(maxAmount))}
                className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary hover:text-primary-content hover:bg-primary px-2 py-1 -mx-1 rounded-md transition-colors cursor-pointer"
              >
                MAX
              </button>
            }
          />
          <span className="block text-xs text-base-content/50 mt-2 text-right tabular-nums">
            Balance: {(solBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SOL
            <span className="text-base-content/35"> · {SOL_RESERVE.toFixed(2)} reserved for fees</span>
          </span>
        </div>

        {Number(amount) > 0 && (
          <div className="bg-base-300 rounded-lg p-3 mb-4">
            <div className="flex justify-between text-sm opacity-80 mb-1">
              <span>You deposit</span>
              <span className="font-mono tabular">{Number(amount).toFixed(4)} SOL → cSOL</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="opacity-80">Est. yearly yield ({apyPct}%)</span>
              <span className="text-success font-semibold font-mono tabular">
                +{(Number(amount) * supplyAPY).toFixed(4)} SOL
              </span>
            </div>
          </div>
        )}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={status === "depositing"}
          disabled={isDisabled}
          onClick={handleDeposit}
        >
          {status === "success" ? "Deposited" : "Deposit SOL"}
        </Button>

        {toast && (
          <Snackbar
            variant="toast"
            type={toast.type}
            message={toast.msg}
            detail={toast.sig ? `sig=${shortSig(toast.sig)}` : toast.detail}
            action={toast.sig ? <TxActionButtons sig={toast.sig} /> : undefined}
            dismissAfterMs={toast.type === "success" ? 8000 : undefined}
            onDismiss={() => setToast(null)}
          />
        )}

        <div className="mt-5 pt-4 border-t border-base-300 text-xs opacity-50 leading-relaxed">
          <p>SOL is wrapped to cSOL atomically — single signature</p>
          <p>No lock-up period — withdraw anytime</p>
        </div>
      </div>
    </div>
  );
}
