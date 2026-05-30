import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Button,
  Input,
  Snackbar,
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

interface WithdrawCardProps {
  depositedUsdc: number;
  cTokenBalance: number;
  exchangeRate: number;
  config: DeploymentConfig;
  onSuccess?: () => void;
}

export function WithdrawCard({
  depositedUsdc,
  cTokenBalance,
  exchangeRate,
  config,
  onSuccess,
}: WithdrawCardProps) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "withdrawing" | "success" | "error">("idle");
  // Tx feedback funnels through the design-system Snackbar so retail
  // matches institutional. Mirrors the DepositCard pattern: `sig` lights
  // up the Explorer / Copy-sig action cluster, `detail` carries the full
  // error message on failure (no truncation; the toast's built-in copy
  // button gives the user the full payload for support threads).
  const [toast, setToast] = useState<
    | { type: "success" | "error" | "info"; msg: string; sig?: string; detail?: string }
    | null
  >(null);

  const maxUsdc = depositedUsdc;

  const handleWithdraw = useCallback(async () => {
    if (!publicKey || !amount || Number(amount) <= 0) return;
    setStatus("withdrawing");
    setToast({ type: "info", msg: `Withdrawing ${amount} USDC…` });

    try {
      // Symmetric to DepositCard: redeem cToken → cUSDC, then
      // unwrap cUSDC → sUSDC. The user's wallet holds sUSDC; cUSDC is
      // transient inside the tx. Reserve liquidity is denominated in
      // cUSDC, so the cToken/exchangeRate math (raw underlying / raw
      // cToken) is unchanged from the pre-migration shape.
      const reserve = config.market.usdcReserve;        // cUSDC reserve
      const market = config.market.lendingMarket;
      const oracle = config.market.usdcOracle;
      const cusdcMint = config.usdc.mint;               // cUSDC (Token-2022)
      const susdcMint = config.usdcUnderlying.mint;     // sUSDC (legacy SPL)

      // Convert USDC amount to cToken amount.
      const usdcNative = Number(amount) * 1e6;
      const cTokenAmount = exchangeRate > 0
        ? BigInt(Math.floor(usdcNative / exchangeRate))
        : BigInt(Math.floor(usdcNative));
      // Same number of cUSDC raw units back from redeem (1:1 with the
      // klend underlying), so we can drive unwrap_native off the same
      // amount. For a max withdraw this matches the user's cToken stack
      // × exchangeRate within rounding.
      const cusdcUnwrapAmount = BigInt(Math.floor(usdcNative));

      const cMint = reserveCollateralMint(reserve);
      const userCTokenAta = getAssociatedTokenAddressSync(
        cMint, publicKey, false, TOKEN_PROGRAM_ID,
      );
      const userCusdcAta = getAssociatedTokenAddressSync(
        cusdcMint, publicKey, false, TOKEN_2022_PROGRAM_ID,
      );
      const userSusdcAta = getAssociatedTokenAddressSync(
        susdcMint, publicKey, false, TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

      // [1] cUSDC ATA — Token-2022. Idempotent so repeated withdraws
      //     reuse the same account.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userCusdcAta, publicKey, cusdcMint, TOKEN_2022_PROGRAM_ID,
        ),
      );

      // [2] sUSDC ATA — legacy SPL. Receive endpoint for unwrap_native.
      //     Idempotent in case the user closed it after a prior session.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userSusdcAta, publicKey, susdcMint, TOKEN_PROGRAM_ID,
        ),
      );

      // [3] Refresh the cUSDC reserve before redeem (check_refresh).
      tx.add(buildRefreshReserveIx(reserve, market, oracle));

      // [4] cToken → cUSDC. Liquidity = Token-2022 (cUSDC); cToken
      //     stays legacy SPL.
      tx.add(
        buildRedeemReserveCollateralIx(
          publicKey,
          reserve,
          market,
          cusdcMint,
          cTokenAmount,
          TOKEN_2022_PROGRAM_ID, // liquidity (cUSDC)
          TOKEN_PROGRAM_ID,       // cToken
          userCTokenAta,
          userCusdcAta,
        )
      );

      // [5] cUSDC → sUSDC via the cUSDC native pool. Unconditional —
      //     no whitelist check, by design (matches SolWithdrawCard).
      tx.add(
        buildUnwrapNativeIx({
          governor: config.programs.governor,
          user: publicKey,
          amount: cusdcUnwrapAmount,
          poolConfig: config.cusdcPool.poolConfig,
          poolUnderlyingVault: config.cusdcPool.poolUnderlyingVault,
          wrappedMint: cusdcMint,
          underlyingMint: susdcMint,
          userUnderlyingAta: userSusdcAta,
          userWrappedAta: userCusdcAta,
        }),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signed = await signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      setStatus("success");
      setToast({ type: "success", msg: `Withdrew ${amount} USDC`, sig });
      setAmount("");
      onSuccess?.();
    } catch (e: any) {
      console.error("Withdraw failed:", e);
      const msg = e?.message
        || (typeof e === "string" ? e : null)
        || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setStatus("error");
      setToast({ type: "error", msg: "Withdrawal failed", detail: msg });
    }
  }, [publicKey, amount, connection, config, exchangeRate, signTransaction, onSuccess]);

  if (depositedUsdc <= 0) return null;

  const isDisabled = status === "withdrawing" || Number(amount) <= 0 || Number(amount) > maxUsdc;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <h3 className="card-title text-lg">Withdraw USDC</h3>
        <p className="text-sm opacity-50 mb-5">Redeem your deposit + earned interest</p>

        <div className="mb-4">
          <label className="block text-[11px] font-medium uppercase tracking-[0.18em] text-base-content/55 mb-2">
            Amount (USDC)
          </label>
          <Input
            inputSize="lg"
            type="number"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setStatus("idle"); }}
            placeholder="0.00"
            min="0"
            max={maxUsdc}
            step="0.01"
            numeric
            addonRight={
              <button
                type="button"
                onClick={() => setAmount(String(maxUsdc.toFixed(2)))}
                className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary hover:text-primary-content hover:bg-primary px-2 py-1 -mx-1 rounded-md transition-colors cursor-pointer"
              >
                MAX
              </button>
            }
          />
          <span className="block text-xs text-base-content/50 mt-2 text-right tabular-nums">
            Available: {maxUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC
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
          {status === "success" ? "Withdrawn" : "Withdraw USDC"}
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
