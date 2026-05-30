import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
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
  buildRefreshReserveIx,
  buildRedeemReserveCollateralIx,
  reserveCollateralMint,
} from "../lib/klend";
import { buildUnwrapNativeIx } from "../lib/governorWrap";

interface SolWithdrawCardProps {
  /** SOL value of cToken holdings (already at exchange-rate). */
  depositedSol: number;
  /** Raw on-chain cToken balance (u64 from the SPL token account, NOT
   *  uiAmount). Used to back-solve the exact cToken amount to redeem
   *  on a max-withdraw — multiplying a uiAmount-style value by
   *  LAMPORTS_PER_SOL silently breaks for this reserve because the
   *  cToken mint is 6-decimal but the underlying wSOL is 9-decimal. */
  cTokenBalanceRaw: number;
  exchangeRate: number;
  config: DeploymentConfig;
  onSuccess?: () => void;
}

/**
 * Withdraw the user's cSOL klend position back to native SOL in one tx.
 *
 * Post-2026-05-06 the active SOL reserve is cSOL (KYC-wrapped wSOL),
 * not raw wSOL. Withdraw flow:
 *   [1] ATA(wSOL)                  idempotent (caller may have closed it)
 *   [2] ATA(cSOL)                  idempotent — Token-2022
 *   [3] klend::RefreshReserve      on the cSOL reserve
 *   [4] klend::RedeemReserveCollateral   cToken → cSOL
 *   [5] governor::unwrap_native    cSOL → wSOL (unconditional, no whitelist)
 *   [6] CloseAccount(wSOL ATA)     wSOL → native SOL (recipient = user)
 *
 * Step 5's `unwrap_native` is the burn-side of the cSOL native pool;
 * unlike `wrap_native` it has no whitelist requirement, so existing
 * depositors can always exit even if their delta-mint whitelist entry
 * was revoked. Step 6 converts the redeemed wSOL back to spendable
 * native SOL via the SPL token-account close trick (lamport balance
 * of an empty wSOL account refunds rent + the wrapped balance).
 */
export function SolWithdrawCard({
  depositedSol,
  cTokenBalanceRaw,
  exchangeRate,
  config,
  onSuccess,
}: SolWithdrawCardProps) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "withdrawing" | "success" | "error">("idle");
  // Tx feedback funnels through the design-system Snackbar — see the
  // SolDepositCard / DepositCard pattern. Full error message stays in
  // `detail`; truncation is the toast's UI concern, not ours.
  const [toast, setToast] = useState<
    | { type: "success" | "error" | "info"; msg: string; sig?: string; detail?: string }
    | null
  >(null);

  const maxSol = depositedSol;

  const handleWithdraw = useCallback(async () => {
    if (!publicKey || !amount || Number(amount) <= 0) return;
    setStatus("withdrawing");
    setToast({ type: "info", msg: `Withdrawing ${amount} SOL…` });

    try {
      const reserve = config.marketSol.cSolReserve;
      const market = config.marketSol.lendingMarket;
      const wsolMint = config.wsol.mint;
      const oracle = config.marketSol.cSolOracle;
      const csolMint = config.csolPool.wrappedMint;

      const lamportsRequested = Number(amount) * LAMPORTS_PER_SOL;
      // exchangeRate from useReserveData is raw-underlying / raw-cToken
      // (independent of either mint's decimals). Back-solving for a
      // partial withdraw: cTokens_raw = lamports / exchangeRate.
      // For a max withdraw use the wallet's actual on-chain cToken
      // balance verbatim — bypasses the partial-rate divide and avoids
      // a residual 1-cToken dust under-redemption from float error.
      const isMaxWithdraw = Math.abs(Number(amount) - maxSol) < 1e-6;
      const cTokenAmount = isMaxWithdraw
        ? BigInt(Math.floor(cTokenBalanceRaw))
        : exchangeRate > 0
          ? BigInt(Math.floor(lamportsRequested / exchangeRate))
          : BigInt(Math.floor(lamportsRequested));

      const cMint = reserveCollateralMint(reserve);
      const userCTokenAta = getAssociatedTokenAddressSync(cMint, publicKey, false, TOKEN_PROGRAM_ID);
      const userCsolAta = getAssociatedTokenAddressSync(csolMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const userWsolAta = getAssociatedTokenAddressSync(wsolMint, publicKey, false, TOKEN_PROGRAM_ID);

      // For a max withdraw, klend redeems the user's full cToken stack
      // → cSOL. Use the same raw cToken balance to drive the
      // unwrap_native amount; otherwise solve for cSOL via the
      // exchange rate the same way we did for the deposit ix.
      const csolUnwrapAmount = isMaxWithdraw
        ? BigInt(Math.floor(cTokenBalanceRaw * exchangeRate))
        : BigInt(Math.floor(lamportsRequested));

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

      // [1] wSOL ATA — user may have closed it after a previous withdraw.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userWsolAta, publicKey, wsolMint, TOKEN_PROGRAM_ID,
        ),
      );

      // [2] cSOL ATA — Token-2022. Idempotent so repeated withdraws
      //     reuse the same account.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userCsolAta, publicKey, csolMint, TOKEN_2022_PROGRAM_ID,
        ),
      );

      // [3] klend wants a fresh reserve before redeem_reserve_collateral.
      tx.add(buildRefreshReserveIx(reserve, market, oracle));

      // [4] cToken → cSOL. Liquidity token program = Token-2022;
      //     collateral mint stays Token-classic.
      tx.add(
        buildRedeemReserveCollateralIx(
          publicKey,
          reserve,
          market,
          csolMint,
          cTokenAmount,
          TOKEN_2022_PROGRAM_ID, // liquidity (cSOL)
          TOKEN_PROGRAM_ID,       // collateral cToken
          userCTokenAta,
          userCsolAta,
        ),
      );

      // [5] cSOL → wSOL via the v3 native pool. Unconditional — no
      //     whitelist check, by design.
      tx.add(
        buildUnwrapNativeIx({
          governor: config.programs.governor,
          user: publicKey,
          amount: csolUnwrapAmount,
          poolConfig: config.csolPool.poolConfig,
          poolUnderlyingVault: config.csolPool.poolWsolVault,
          wrappedMint: csolMint,
          underlyingMint: wsolMint,
          userUnderlyingAta: userWsolAta,
          userWrappedAta: userCsolAta,
        }),
      );

      // [6] Close wSOL ATA → user gets native SOL back.
      tx.add(createCloseAccountInstruction(userWsolAta, publicKey, publicKey));

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signed = await signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      setStatus("success");
      setToast({ type: "success", msg: `Withdrew ${amount} SOL`, sig });
      setAmount("");
      onSuccess?.();
    } catch (e: any) {
      console.error("SOL withdraw failed:", e);
      const msg = e?.message
        || (typeof e === "string" ? e : null)
        || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setStatus("error");
      setToast({ type: "error", msg: "SOL withdrawal failed", detail: msg });
    }
  }, [publicKey, amount, connection, config, exchangeRate, cTokenBalanceRaw, maxSol, signTransaction, onSuccess]);

  if (depositedSol <= 0) return null;

  // 1e-9 tolerance: user-facing maxSol carries float noise from
  // (cTokensRaw × exchangeRate / 1e9), and any manually-typed amount
  // that "looks equal" can float-round 1 ULP over and lock the button.
  // The redeem ix sees raw cTokens regardless, so the tolerance is
  // strictly a UX guard.
  const isDisabled =
    status === "withdrawing" || Number(amount) <= 0 || Number(amount) > maxSol + 1e-9;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-lg">Withdraw SOL</h3>
          <TokenIcon symbol="SOL" size="sm" />
        </div>
        <p className="text-sm opacity-60 -mt-1 mb-3">
          Redeem your deposit + earned interest, returned as native SOL
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
            max={maxSol}
            step="0.001"
            numeric
            addonRight={
              <button
                type="button"
                // Floor to 6 decimals so the displayed string can never
                // round *above* the underlying cap. `toFixed(6)` would
                // bump 0.10000258 → "0.100003" and then the >maxSol
                // disabled check would lock the button immediately after MAX.
                onClick={() => setAmount((Math.floor(maxSol * 1e6) / 1e6).toFixed(6))}
                className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary hover:text-primary-content hover:bg-primary px-2 py-1 -mx-1 rounded-md transition-colors cursor-pointer"
              >
                MAX
              </button>
            }
          />
          <span className="block text-xs opacity-50 mt-1.5 text-right">
            Available: {maxSol.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SOL
          </span>
        </div>

        <Button
          variant="secondary"
          size="lg"
          fullWidth
          loading={status === "withdrawing"}
          disabled={isDisabled}
          onClick={handleWithdraw}
        >
          {status === "success" ? "Withdrawn" : "Withdraw SOL"}
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
      </div>
    </div>
  );
}
