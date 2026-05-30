import { InputHTMLAttributes, ReactNode, forwardRef, isValidElement } from "react";
import { cn } from "../lib/cn";
import { TokenIcon, TokenSymbol } from "./TokenIcon";

const KNOWN_TOKEN_SYMBOLS = new Set<string>([
  "USDC", "USDT", "DAI", "USX", "eUSX", "ceUSX",
  "SOL", "wSOL", "csSOL", "JitoSOL", "BTC", "ETH",
]);

/**
 * TokenAmountInput — specialised numeric input for crypto amounts.
 *
 * Replaces the fragile pattern of composing `<Input addonRight={<>...</>}>`
 * with a button + symbol fragment, which made spacing dependent on the
 * caller's children and the surrounding flex context. Here the layout
 * is fixed: large numeric field, optional MAX pill, distinct token
 * chip on the right. The token chip is its own surface (not a
 * borderless span) so it reads as a control, not as part of the value.
 *
 * Header row exposes a label slot on the left and a clickable
 * "balance: X SYM" affordance on the right. Clicking the balance fires
 * `onMax` when supplied, so the user has two ways to populate the field.
 *
 *   <TokenAmountInput
 *     label="Amount"
 *     value={amt} onChange={(v) => setAmt(v)}
 *     symbol="USDC" balance={21.10}
 *     onMax={() => setAmt("21.10")}
 *     invalid={over} errorText="Exceeds wallet balance."
 *     helperText="Minimum 1 USDC."
 *   />
 */

export type TokenAmountInputSize = "md" | "lg";

export interface TokenAmountInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange"> {
  label?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  symbol: ReactNode;
  /** Optional balance shown in the header. If `onMax` is set the row is clickable. */
  balance?: number | string;
  /** Optional balance unit override (defaults to `symbol`). */
  balanceUnit?: ReactNode;
  /** Decimals when formatting `balance`. Default 4. */
  balanceDecimals?: number;
  /** Click "balance:" or the MAX pill to populate the field. */
  onMax?: () => void;
  /** Inline error styling. Render `errorText` instead of `helperText` when set. */
  invalid?: boolean;
  errorText?: ReactNode;
  helperText?: ReactNode;
  inputSize?: TokenAmountInputSize;
}

const HEIGHT: Record<TokenAmountInputSize, string> = {
  md: "h-12",
  lg: "h-14",
};
const VALUE_FONT: Record<TokenAmountInputSize, string> = {
  md: "text-lg",
  lg: "text-2xl",
};

function formatBalance(b: number | string | undefined, decimals: number): string {
  if (b === undefined) return "";
  const n = typeof b === "string" ? parseFloat(b) : b;
  if (!Number.isFinite(n)) return String(b);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

export const TokenAmountInput = forwardRef<HTMLInputElement, TokenAmountInputProps>(
  function TokenAmountInput(
    {
      label,
      value,
      onChange,
      symbol,
      balance,
      balanceUnit,
      balanceDecimals = 4,
      onMax,
      invalid,
      errorText,
      helperText,
      inputSize = "md",
      className,
      disabled,
      placeholder = "0.00",
      ...rest
    },
    ref,
  ) {
    const hasMax = typeof onMax === "function";
    const balLabel = balance !== undefined ? `balance: ${formatBalance(balance, balanceDecimals)} ${balanceUnit ?? symbol}` : null;
    const showError = invalid && errorText;

    return (
      <div className={cn("w-full", className)}>
        {(label || balLabel) && (
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <span className="text-xs font-semibold text-base-content/75">{label}</span>
            {balLabel && (
              hasMax ? (
                <button
                  type="button"
                  onClick={onMax}
                  className={cn(
                    "text-[11px] font-mono tabular-nums text-base-content/55",
                    "hover:text-base-content transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/50 rounded",
                  )}
                >
                  {balLabel}
                </button>
              ) : (
                <span className="text-[11px] font-mono tabular-nums text-base-content/55">
                  {balLabel}
                </span>
              )
            )}
          </div>
        )}
        <div
          data-disabled={disabled || undefined}
          className={cn(
            "group flex items-center gap-2 w-full rounded-lg border bg-base-100",
            "shadow-[inset_0_1px_2px_rgba(31,45,72,0.06)]",
            "transition-[border-color,box-shadow,background-color] duration-150 ease-out",
            "pl-4 pr-2",
            HEIGHT[inputSize],
            invalid
              ? "border-error/60 focus-within:border-error focus-within:shadow-[inset_0_1px_2px_rgba(31,45,72,0.06),0_0_0_3px_rgba(177,74,74,0.15)]"
              : "border-base-300 focus-within:border-primary/70 focus-within:shadow-[inset_0_1px_2px_rgba(31,45,72,0.06),0_0_0_3px_rgba(31,45,72,0.10)]",
            disabled && "opacity-60 cursor-not-allowed bg-base-200",
          )}
        >
          <input
            ref={ref}
            type="text"
            inputMode="decimal"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={disabled}
            className={cn(
              "flex-1 min-w-0 bg-transparent border-0 outline-none p-0",
              "font-mono tabular-nums tracking-tight font-medium",
              VALUE_FONT[inputSize],
              "text-base-content placeholder:text-base-content/30",
              "disabled:cursor-not-allowed",
            )}
            aria-invalid={invalid || undefined}
            {...rest}
          />
          {hasMax && (
            <button
              type="button"
              onClick={onMax}
              disabled={disabled}
              className={cn(
                "flex-shrink-0 px-2.5 h-7 rounded-md text-[10px] font-bold uppercase tracking-[0.12em]",
                "bg-primary/10 text-primary",
                "hover:bg-primary hover:text-primary-content",
                "active:scale-[0.97] transition-[background-color,color,transform] duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/50",
                "disabled:opacity-40 disabled:hover:bg-primary/10 disabled:hover:text-primary",
              )}
            >
              max
            </button>
          )}
          <span
            className={cn(
              "flex-shrink-0 inline-flex items-center gap-2 h-9 pl-2 pr-3 rounded-md",
              "bg-base-200 border border-base-300",
              "text-sm font-semibold text-base-content leading-none",
            )}
          >
            {/* If `symbol` is a string that maps to a known TokenIcon,
                render the icon inline so the addon doubles as a token
                badge. Icon is forced to `xs` (20px) — `sm` (28px) plus
                the wrapped KYC gold ring (`ring-2 ring-offset-2` = +8px)
                produced a 36px visual extent that overflowed the chip's
                34px content area, reading as a vertically off-centre
                icon (especially on csSOL / ceUSX). `xs` keeps the ring
                inside the chip with breathing room on every side. */}
            {typeof symbol === "string" && KNOWN_TOKEN_SYMBOLS.has(symbol) ? (
              <>
                <TokenIcon symbol={symbol as TokenSymbol} size="xs" />
                <span className="leading-none">{symbol}</span>
              </>
            ) : isValidElement(symbol) ? (
              symbol
            ) : (
              <span className="leading-none">{symbol}</span>
            )}
          </span>
        </div>
        {(showError || helperText) && (
          <p
            className={cn(
              "mt-2 text-xs leading-snug",
              showError ? "text-error" : "text-base-content/55",
            )}
          >
            {showError ? errorText : helperText}
          </p>
        )}
      </div>
    );
  },
);
