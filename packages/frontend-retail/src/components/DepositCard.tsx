import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
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

interface DepositCardProps {
  usdcBalance: number | null;
  config: DeploymentConfig;
  supplyAPY?: number;
  onSuccess?: () => void;
}

export function DepositCard({ usdcBalance, config, supplyAPY = 0, onSuccess }: DepositCardProps) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "depositing" | "success" | "error">("idle");
  // Toast state — mirrors the institutional UI's pattern. `sig` lights
  // up the Explorer/Copy-sig action cluster on success; `detail` carries
  // the long error message on failure (no character truncation; the
  // Snackbar's built-in copy button gives the user the full payload).
  const [toast, setToast] = useState<
    | { type: "success" | "error" | "info"; msg: string; sig?: string; detail?: string }
    | null
  >(null);

  const maxAmount = usdcBalance || 0;
  const apyPct = (supplyAPY * 100).toFixed(2);

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !amount || Number(amount) <= 0) return;
    setStatus("depositing");
    setToast({ type: "info", msg: `Depositing ${amount} USDC…` });

    try {
      // Reserve / mints. Post-2026-05-07 the retail USDC track lands on
      // the KYC-gated cUSDC reserve. The user's wallet holds Solstice
      // USDC (sUSDC) — DepositCard wraps to cUSDC inside this same tx.
      const reserve = config.market.usdcReserve;        // cUSDC reserve
      const market = config.market.lendingMarket;
      const oracle = config.market.usdcOracle;
      const cusdcMint = config.usdc.mint;               // cUSDC (Token-2022)
      const susdcMint = config.usdcUnderlying.mint;     // sUSDC (legacy SPL)

      const amountNative = BigInt(Math.floor(Number(amount) * 1e6));

      // KYC precheck — wrap_native fails at the delta-mint mint_to CPI
      // with AccountNotInitialized (Custom 3012 / 0xbc4) if the
      // whitelist PDA is missing. Surface that as an actionable
      // message before the user signs. The unified KycGate seeds this
      // PDA via add_participant_via_pool — if it's missing here the
      // gate was bypassed (stale cache, different wallet).
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("whitelist"),
          config.cusdcPool.dmMintConfig.toBuffer(),
          publicKey.toBuffer(),
        ],
        config.programs.deltaMint,
      );
      const wl = await connection.getAccountInfo(whitelistEntry, "confirmed");
      if (!wl) {
        throw new Error(
          "cUSDC whitelist missing — clear browser storage for this site and re-run the KYC gate, then try again. (delta-mint would otherwise reject the wrap with AccountNotInitialized 3012.)",
        );
      }

      // ATAs.
      //   - sUSDC ATA: legacy SPL; source for the wrap.
      //   - cUSDC ATA: Token-2022; transient destination of the wrap +
      //                source of the klend deposit. Always created
      //                idempotently (Token-2022 means the legacy ATA
      //                derivation in older code lands on the wrong
      //                address — pass TOKEN_2022_PROGRAM_ID explicitly).
      //   - cToken ATA: legacy SPL (klend reserves init their cToken
      //                mints with TOKEN_PROGRAM_ID regardless of the
      //                underlying's program).
      const userSusdcAta = getAssociatedTokenAddressSync(
        susdcMint, publicKey, false, TOKEN_PROGRAM_ID,
      );
      const userCusdcAta = getAssociatedTokenAddressSync(
        cusdcMint, publicKey, false, TOKEN_2022_PROGRAM_ID,
      );
      const cMint = reserveCollateralMint(reserve);
      const userCTokenAta = getAssociatedTokenAddressSync(
        cMint, publicKey, false, TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction();
      // wrap + deposit + ATA creates ≈ 400k CU; bump to 600k for headroom.
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

      // [1] cUSDC ATA (idempotent, Token-2022) — destination of the wrap.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userCusdcAta, publicKey, cusdcMint, TOKEN_2022_PROGRAM_ID,
        ),
      );

      // [2] cToken ATA (idempotent, legacy SPL) — destination of the deposit.
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          publicKey, userCTokenAta, publicKey, cMint, TOKEN_PROGRAM_ID,
        ),
      );

      // [3] wrap_native: sUSDC → cUSDC (KYC-gated by the whitelist PDA).
      tx.add(
        buildWrapNativeIx({
          governor: config.programs.governor,
          deltaMint: config.programs.deltaMint,
          user: publicKey,
          amount: amountNative,
          poolConfig: config.cusdcPool.poolConfig,
          poolUnderlyingVault: config.cusdcPool.poolUnderlyingVault,
          dmMintConfig: config.cusdcPool.dmMintConfig,
          wrappedMint: cusdcMint,
          underlyingMint: susdcMint,
          userUnderlyingAta: userSusdcAta,
          userWrappedAta: userCusdcAta,
          // sUSDC is legacy SPL — leave the default underlyingTokenProgram.
        }),
      );

      // [4] Refresh the cUSDC reserve before the deposit (check_refresh).
      tx.add(buildRefreshReserveIx(reserve, market, oracle));

      // [5] Deposit cUSDC liquidity → cToken. cUSDC is Token-2022; the
      //     cToken mint stays legacy SPL (klend reserves are init'd with
      //     classic cToken mints regardless of underlying's program).
      tx.add(
        buildDepositReserveLiquidityIx(
          publicKey,
          reserve,
          market,
          cusdcMint,
          amountNative,
          TOKEN_2022_PROGRAM_ID, // liquidity (cUSDC)
          TOKEN_PROGRAM_ID,       // cToken
          userCusdcAta,
          userCTokenAta,
        )
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const signed = await signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      setStatus("success");
      setToast({ type: "success", msg: `Deposited ${amount} USDC`, sig });
      setAmount("");
      onSuccess?.();
    } catch (e: any) {
      // Always full object to console for triage; the toast carries the
      // long-form message verbatim so the user can copy it without
      // opening devtools. Falls back to a stringified payload when the
      // error doesn't have a `message` (e.g. some wallet adapters reject
      // with `{ name, code }` shapes).
      console.error("Deposit failed:", e);
      const msg = e?.message
        || (typeof e === "string" ? e : null)
        || (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
      setStatus("error");
      setToast({ type: "error", msg: "Deposit failed", detail: msg });
    }
  }, [publicKey, amount, connection, config, signTransaction, onSuccess]);

  const isDisabled = status === "depositing" || Number(amount) <= 0 || Number(amount) > maxAmount;

  return (
    <div className="card bg-base-200 border border-base-300 shadow-xl">
      <div className="card-body p-6 gap-4">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-lg">Deposit USDC</h3>
          <TokenIcon symbol="USDC" size="md" />
        </div>
        <p className="text-sm opacity-60 -mt-1 mb-3">
          Earn <span className="text-primary font-semibold">{apyPct}%</span> APY by supplying USDC to the lending market
        </p>

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
            max={maxAmount}
            step="0.01"
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
            Balance: {maxAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC
          </span>
        </div>

        {Number(amount) > 0 && (
          <div className="bg-base-300 rounded-lg p-3 mb-4">
            <div className="flex justify-between text-sm opacity-80 mb-1">
              <span>You deposit</span>
              <span>${Number(amount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="opacity-80">Est. yearly yield ({apyPct}%)</span>
              <span className="text-success font-semibold">
                +${(Number(amount) * supplyAPY).toFixed(2)}
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
          {status === "success" ? "Deposited" : "Deposit USDC"}
        </Button>

        {/* Success / error feedback now lives in a fixed-position toast
            (institutional UI parity). The toast renders the full error
            message with a built-in copy button on failure, and the
            Explorer / copy-sig action cluster on success — no more
            truncated `text-xs` line under the input. */}
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
          <p>No lock-up period — withdraw anytime</p>
          <p>Interest accrues every Solana slot (~400ms)</p>
        </div>
      </div>
    </div>
  );
}
