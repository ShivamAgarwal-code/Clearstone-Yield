import { ButtonHTMLAttributes, ReactNode, forwardRef } from "react";
import { cn } from "../lib/cn";

/**
 * Button — primary interactive primitive.
 *
 * Sizing, padding, and border weight are deliberately consistent across
 * variants so a row of mixed buttons (`primary` + `outline` + `ghost`)
 * lines up on the same baseline grid. The previous version mixed
 * `border` and `border-2` between variants, which threw off horizontal
 * rhythm in toolbar-style rows.
 *
 *   - `primary` carries an inset top highlight + a primary-tinted drop
 *     shadow. Hover lifts via -translate-y-px and grows the shadow; active
 *     drops back and inverts to an inset shadow (depressed-key feel).
 *   - `secondary` is the inverted twin: white-ish fill, soft border,
 *     gains a border + shadow on hover so it never blends into base-200.
 *   - `outline` matches `secondary` weight (1px border) but with a
 *     primary-tinted border + transparent fill. Fills on hover.
 *   - `destructive` mirrors `outline` in error tone.
 *   - `ghost` and `link` are the quietest tier — only used for tertiary
 *     actions (Cancel, MAX) where the primary CTA must dominate.
 */

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

// Heights match `<Input>` 1:1 so a row of mixed Input + Button aligns.
// Padding is generous-but-not-loud (≈ 1.6× height/4) and the radius
// scale steps once between sm/md so the "shape language" stays a
// single family without abrupt jumps.
const SIZE: Record<ButtonSize, string> = {
  xs: "h-7  px-3    text-[11px] gap-1.5 rounded-md",
  sm: "h-9  px-3.5  text-xs     gap-2   rounded-md",
  md: "h-10 px-4    text-sm     gap-2   rounded-lg",
  lg: "h-12 px-6    text-[15px] gap-2.5 rounded-lg",
};

// Typography — single family of weight + tracking so size is the only
// thing varying between buttons of the same variant.
const TYPE = "font-semibold tracking-[-0.005em]";

const VARIANT: Record<ButtonVariant, string> = {
  // Primary — depth-driven. Inset top highlight (subtle "lit edge") +
  // primary-tinted drop shadow. Hover lifts + brightens the shadow; active
  // depresses with an inset shadow.
  primary: cn(
    "bg-primary text-primary-content border border-primary",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_1px_2px_rgba(31,45,72,0.18),0_4px_14px_-2px_rgba(31,45,72,0.42)]",
    "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_2px_4px_rgba(31,45,72,0.24),0_10px_22px_-4px_rgba(31,45,72,0.55)]",
    "hover:-translate-y-px",
    "active:translate-y-0 active:shadow-[inset_0_2px_3px_rgba(0,0,0,0.22)]",
    "disabled:bg-base-300 disabled:border-base-300 disabled:text-base-content/40 disabled:shadow-none disabled:translate-y-0",
  ),
  // Secondary — inverted twin of primary so it reads as a button on the
  // page bg without competing.
  secondary: cn(
    "bg-base-100 text-base-content border border-base-300",
    "shadow-[0_1px_2px_rgba(31,45,72,0.06)]",
    "hover:bg-base-200 hover:border-base-content/35",
    "hover:shadow-[0_2px_6px_rgba(31,45,72,0.10),0_4px_14px_-4px_rgba(31,45,72,0.18)]",
    "hover:-translate-y-px",
    "active:translate-y-0 active:bg-base-300 active:shadow-none",
    "disabled:opacity-40 disabled:translate-y-0",
  ),
  // Outline — matches `secondary` border weight (1px) but with primary
  // tone. Fills on hover so the user has a clear pre-commit cue.
  outline: cn(
    "bg-transparent text-primary border border-primary/70",
    "hover:bg-primary hover:text-primary-content hover:border-primary",
    "active:scale-[0.99]",
    "disabled:opacity-40 disabled:bg-transparent",
  ),
  // Ghost — quietest. Tertiary actions only.
  ghost: cn(
    "bg-transparent text-base-content/75 border border-transparent",
    "hover:bg-base-content/[0.07] hover:text-base-content",
    "active:bg-base-content/[0.12]",
    "disabled:opacity-40",
  ),
  // Destructive — error tone outline. Fills on hover so the user has to
  // commit before the click registers visually.
  destructive: cn(
    "bg-error/10 text-error border border-error/60",
    "hover:bg-error hover:text-error-content hover:border-error",
    "active:scale-[0.99]",
    "disabled:opacity-40",
  ),
  link: cn(
    "bg-transparent text-primary underline-offset-4 px-0 border-0",
    "hover:underline",
    "active:opacity-80",
    "disabled:opacity-40 disabled:no-underline",
  ),
};

const BASE = cn(
  "inline-flex items-center justify-center select-none whitespace-nowrap leading-none",
  "transition-[transform,box-shadow,background-color,color,border-color] duration-150 ease-out",
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60",
  "disabled:cursor-not-allowed",
);

function Spinner({ size }: { size: ButtonSize }) {
  const dim = size === "xs" ? "h-3 w-3" : size === "sm" ? "h-3.5 w-3.5" : size === "md" ? "h-4 w-4" : "h-5 w-5";
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block rounded-full border-2 border-current border-r-transparent",
        dim,
      )}
      style={{ animation: "cs-spin 700ms linear infinite" }}
    />
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading,
      iconLeft,
      iconRight,
      fullWidth,
      disabled,
      type = "button",
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const isDisabled = disabled || loading;
    const isLink = variant === "link";
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        className={cn(
          BASE,
          TYPE,
          isLink
            ? size === "xs" ? "text-[11px]" : size === "sm" ? "text-xs" : size === "md" ? "text-sm" : "text-base"
            : SIZE[size],
          VARIANT[variant],
          fullWidth ? "w-full" : "",
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner size={size} /> : iconLeft ? <span className="flex-shrink-0 inline-flex">{iconLeft}</span> : null}
        {children}
        {!loading && iconRight ? <span className="flex-shrink-0 inline-flex">{iconRight}</span> : null}
      </button>
    );
  },
);
