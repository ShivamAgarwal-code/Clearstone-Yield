import { InputHTMLAttributes, ReactNode, forwardRef } from "react";
import { cn } from "../lib/cn";

/**
 * Input — text / number input with optional left adornment, right addon
 * (token symbol, MAX button), and explicit invalid state.
 *
 * Heights are aligned 1:1 with `<Button>` of the same size so a Button
 * placed next to an Input in the same row sits on the same baseline:
 * sm = 36px, md = 40px, lg = 48px.
 *
 * Padding rules (kept boring):
 *   - The wrapper owns horizontal padding (`px-{N}`). The inner <input>
 *     has `p-0` and `flex-1`, so it never adds its own gutter.
 *   - When `addonRight` is present, the wrapper drops its right padding
 *     and the addon span owns it instead — that's how the divider line
 *     reaches the field edge cleanly.
 *   - `gap-2.5` on the wrapper handles the space between adornment and
 *     value uniformly across sizes; no bespoke `pr-2`/`pl-2` patches.
 *
 * Numeric inputs (amounts, prices) opt into `numeric` to get
 * `font-mono tabular-nums`. Default is the body sans stack so search /
 * note / address fields don't render in monospace.
 */

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: InputSize;
  invalid?: boolean;
  /** Element rendered inside the field, before the input (e.g. icon). */
  adornmentLeft?: ReactNode;
  /** Element rendered inside the field, after the input (e.g. MAX, ticker). */
  addonRight?: ReactNode;
  /** Text to show under the field. Tone follows `invalid`. */
  helperText?: ReactNode;
  /** Render with mono + tabular-nums for amounts / prices. Off by default. */
  numeric?: boolean;
  /** Class on the outer wrapper (sets width / margin). The default is
   *  `w-full`; pass e.g. `w-28` to make a narrow numeric cell. */
  wrapperClassName?: string;
}

// Heights match `<Button>` exactly so a row of Inputs + Buttons aligns.
const HEIGHT: Record<InputSize, string> = {
  sm: "h-9",
  md: "h-10",
  lg: "h-12",
};

const FONT: Record<InputSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

// Symmetric horizontal padding when no right addon. Slightly larger
// than the button's px to compensate for the input's lower visual weight.
const PX_BOTH: Record<InputSize, string> = {
  sm: "px-3",
  md: "px-3.5",
  lg: "px-4",
};
// Left-only padding when an addon-right is present (the addon owns the
// right gutter so its border-l can sit flush against the field edge).
const PL_ONLY: Record<InputSize, string> = {
  sm: "pl-3 pr-0",
  md: "pl-3.5 pr-0",
  lg: "pl-4 pr-0",
};
// Padding inside the addon span — same scale as the wrapper's outer pad.
const ADDON_PX: Record<InputSize, string> = {
  sm: "px-3",
  md: "px-3.5",
  lg: "px-4",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    inputSize = "md",
    invalid,
    adornmentLeft,
    addonRight,
    helperText,
    className,
    disabled,
    numeric,
    wrapperClassName,
    ...rest
  },
  ref,
) {
  const hasRight = !!addonRight;
  return (
    <div className={wrapperClassName ?? "w-full"}>
      <div
        data-disabled={disabled || undefined}
        className={cn(
          "group flex items-center gap-2.5 w-full rounded-lg border bg-base-100",
          // recessed feel — single inset shadow is enough; deeper wells
          // start to look "stuck" against the muted base palette.
          "shadow-[inset_0_1px_2px_rgba(31,45,72,0.05)]",
          "transition-[border-color,box-shadow,background-color] duration-150 ease-out",
          HEIGHT[inputSize],
          hasRight ? PL_ONLY[inputSize] : PX_BOTH[inputSize],
          invalid
            ? "border-error/60 focus-within:border-error focus-within:shadow-[inset_0_1px_2px_rgba(31,45,72,0.05),0_0_0_3px_rgba(177,74,74,0.15)]"
            : "border-base-300 focus-within:border-primary/70 focus-within:shadow-[inset_0_1px_2px_rgba(31,45,72,0.05),0_0_0_3px_rgba(31,45,72,0.10)]",
          disabled && "opacity-60 cursor-not-allowed bg-base-200",
        )}
      >
        {adornmentLeft && (
          <span className="flex-shrink-0 inline-flex items-center text-base-content/55">
            {adornmentLeft}
          </span>
        )}
        <input
          ref={ref}
          disabled={disabled}
          className={cn(
            "flex-1 min-w-0 bg-transparent border-0 outline-none p-0",
            "text-base-content placeholder:text-base-content/40",
            numeric && "font-mono tabular-nums",
            FONT[inputSize],
            "disabled:cursor-not-allowed",
            className,
          )}
          aria-invalid={invalid || undefined}
          {...rest}
        />
        {hasRight && (
          <span
            className={cn(
              "flex-shrink-0 inline-flex items-center self-stretch gap-2",
              "border-l border-base-300/70",
              "text-xs font-semibold text-base-content/65",
              ADDON_PX[inputSize],
            )}
          >
            {addonRight}
          </span>
        )}
      </div>
      {helperText && (
        <p
          className={cn(
            "mt-2 text-xs leading-snug",
            invalid ? "text-error" : "text-base-content/55",
          )}
        >
          {helperText}
        </p>
      )}
    </div>
  );
});
