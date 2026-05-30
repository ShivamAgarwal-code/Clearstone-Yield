import { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Heading primitives — page title, section title, eyebrow, subtitle.
 *
 * The institutional / console UIs were drifting because every page
 * implemented its own ad-hoc title pattern (some used <h1>, some divs,
 * some daisyUI's font utilities). Exposing this as a small set of
 * components keeps the visual hierarchy consistent: every page header
 * looks like every other page header, every section like every other
 * section, regardless of which surface it lives on.
 *
 * Pattern:
 *   <PageHeader
 *     eyebrow="Lending"
 *     title="Positions"
 *     subtitle="Active obligations, accrued yield, health factors."
 *     actions={<Button>Refresh</Button>}
 *   />
 */

export interface EyebrowProps {
  children: ReactNode;
  className?: string;
  as?: "div" | "span" | "p";
}

export function Eyebrow({ children, className, as: As = "div" }: EyebrowProps) {
  return (
    <As
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.22em] text-base-content/55",
        className,
      )}
    >
      {children}
    </As>
  );
}

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-6 pb-5 mb-6 border-b border-base-300/80",
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="font-display text-3xl font-light tracking-[-0.012em] text-base-content leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-base-content/60 max-w-2xl leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex-shrink-0 flex items-center gap-2 pt-1">{actions}</div>}
    </header>
  );
}

export interface SectionHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Render a thin divider beneath. Off by default; on inside cards it
   *  introduces an unwanted second line. */
  divider?: boolean;
}

export function SectionHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className,
  divider,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4",
        divider && "pb-3 mb-4 border-b border-base-300/80",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 className="font-display text-lg font-medium tracking-[-0.01em] text-base-content leading-tight">
          {title}
        </h2>
        {subtitle && (
          <p className="text-xs text-base-content/55 leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex-shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Subdued caption used above small groups — lighter than SectionHeader. */
export interface FieldGroupHeadingProps {
  children: ReactNode;
  className?: string;
}

export function FieldGroupHeading({ children, className }: FieldGroupHeadingProps) {
  return (
    <div
      className={cn(
        "text-xs font-semibold tracking-tight text-base-content/70 mb-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
