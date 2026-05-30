import { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Badge — small inline status / category tag.
 *
 * Replaces ad-hoc daisyUI `badge badge-*` calls. `tone` is colour-coded
 * to severity / category, and the *style* (`solid` / `soft` / `outline`)
 * controls visual weight. `soft` is the default — readable on light
 * surfaces without competing with content.
 */

export type BadgeTone = "neutral" | "primary" | "info" | "success" | "warning" | "error";
export type BadgeStyle = "solid" | "soft" | "outline";
export type BadgeSize = "xs" | "sm" | "md";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeStyle;
  size?: BadgeSize;
  iconLeft?: ReactNode;
}

const SIZE: Record<BadgeSize, string> = {
  xs: "h-4 px-1.5 text-[10px] gap-1 rounded",
  sm: "h-5 px-2 text-[11px] gap-1 rounded-md",
  md: "h-6 px-2.5 text-xs gap-1.5 rounded-md",
};

const SOLID: Record<BadgeTone, string> = {
  neutral: "bg-base-content/85 text-base-100",
  primary: "bg-primary text-primary-content",
  info: "bg-info text-info-content",
  success: "bg-success text-success-content",
  warning: "bg-warning text-warning-content",
  error: "bg-error text-error-content",
};

const SOFT: Record<BadgeTone, string> = {
  neutral: "bg-base-300 text-base-content",
  primary: "bg-primary/10 text-primary",
  info: "bg-info/12 text-info",
  success: "bg-success/12 text-success",
  warning: "bg-warning/15 text-warning",
  error: "bg-error/12 text-error",
};

const OUTLINE: Record<BadgeTone, string> = {
  neutral: "border border-base-300 text-base-content/70",
  primary: "border border-primary/40 text-primary",
  info: "border border-info/40 text-info",
  success: "border border-success/40 text-success",
  warning: "border border-warning/40 text-warning",
  error: "border border-error/40 text-error",
};

export function Badge({
  tone = "neutral",
  variant = "soft",
  size = "sm",
  iconLeft,
  className,
  children,
  ...rest
}: BadgeProps) {
  const palette = variant === "solid" ? SOLID : variant === "outline" ? OUTLINE : SOFT;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center font-semibold whitespace-nowrap leading-none",
        SIZE[size],
        palette[tone],
        className,
      )}
      {...rest}
    >
      {iconLeft && <span className="flex-shrink-0">{iconLeft}</span>}
      {children}
    </span>
  );
}
