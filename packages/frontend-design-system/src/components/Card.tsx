import { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Eyebrow } from "./Heading";

/**
 * Card / Panel — primary surface for grouping content.
 *
 * Tones:
 *   * `elevated` — default. White surface + drop shadow. Sits on the
 *     tinted page background and lifts off it. Use for primary panels.
 *   * `flat`     — same surface, no shadow. Use when nesting inside an
 *     already-elevated card so the inner panel doesn't compete.
 *   * `muted`    — tinted recessed surface (page color). Use for inline
 *     groups inside a white card — KeyValue lists, summary blocks.
 *
 * Densities (`size`) are matched to stack depth:
 *   * `lg` — page-level standalone panels (32px).
 *   * `md` — default; grids of 2–3 cards (24px).
 *   * `sm` — dense rows or muted inline groups (16px).
 *
 * `interactive` adds a hover-lift + cursor-pointer. Used when the card
 * itself is a click target (a navigation tile, a selectable option). Does
 * not add a focus ring on its own — wrap in <button> / <a> for that.
 */

export type CardTone = "elevated" | "flat" | "muted";
export type CardSize = "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  size?: CardSize;
  /** Add a hover-lift + cursor-pointer when the whole card is clickable. */
  interactive?: boolean;
  /** Render as <section> with the supplied `aria-labelledby`. */
  as?: "div" | "section" | "article";
}

const PADDING: Record<CardSize, string> = {
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
};

const TONE: Record<CardTone, string> = {
  elevated: "bg-base-200 border border-base-300 shadow-[var(--shadow-stone-md)]",
  flat: "bg-base-200 border border-base-300",
  muted: "bg-base-100 border border-base-300/70",
};

const INTERACTIVE = cn(
  "cursor-pointer",
  "transition-[transform,box-shadow,border-color] duration-200 ease-out",
  "hover:-translate-y-0.5 hover:shadow-[var(--shadow-stone-lg)]",
  "hover:border-base-content/15",
  "active:translate-y-0 active:shadow-[var(--shadow-stone)]",
);

export function Card({
  tone = "elevated",
  size = "md",
  interactive,
  as: As = "div",
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <As
      className={cn(
        "rounded-2xl",
        TONE[tone],
        PADDING[size],
        interactive && INTERACTIVE,
        className,
      )}
      {...rest}
    >
      {children}
    </As>
  );
}

export interface CardHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Add a dividing line under the header. */
  divider?: boolean;
}

export function CardHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className,
  divider,
}: CardHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4",
        divider ? "pb-4 mb-6 border-b border-base-300/70" : "mb-5",
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <div className="font-display text-base font-medium tracking-[-0.01em] text-base-content leading-tight">
          {title}
        </div>
        {subtitle && (
          <p className="text-xs text-base-content/55 leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex-shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface CardFooterProps extends HTMLAttributes<HTMLDivElement> {
  /** Add a dividing line above. */
  divider?: boolean;
}

export function CardFooter({ divider, className, children, ...rest }: CardFooterProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2",
        divider ? "pt-5 mt-5 border-t border-base-300/70" : "mt-5",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
