import { LabelHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Form / data labels.
 *
 *   * `FormLabel` — sits above an Input. Optional `required` indicator
 *     (subtle dot, not a loud red asterisk) and inline `hint` slot
 *     for max / unit context (e.g. "balance: 12.34 SOL").
 *   * `StatLabel` — caption above a number / KPI. Always uppercase, slightly
 *     tracked, lighter colour than body text.
 *   * `KeyValue` — single-line "Label … Value" pattern used in summary
 *     panels. Right-aligns the value, dot-leader optional via `withLeader`.
 */

export interface FormLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  hint?: ReactNode;
}

export function FormLabel({ children, required, hint, className, ...rest }: FormLabelProps) {
  return (
    <div className="flex items-center justify-between gap-3 mb-1.5">
      <label
        className={cn(
          "inline-flex items-center gap-1 text-xs font-semibold text-base-content/75",
          className,
        )}
        {...rest}
      >
        {children}
        {required && (
          <span
            aria-hidden
            className="inline-block h-1 w-1 rounded-full bg-error/70"
            title="Required"
          />
        )}
      </label>
      {hint && (
        <span className="text-[11px] text-base-content/55 font-mono tabular-nums">{hint}</span>
      )}
    </div>
  );
}

export interface StatLabelProps {
  children: ReactNode;
  className?: string;
}

export function StatLabel({ children, className }: StatLabelProps) {
  return (
    <div
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.16em] text-base-content/55",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface KeyValueProps {
  label: ReactNode;
  value: ReactNode;
  /** Smaller density — used in dense summary cards. */
  compact?: boolean;
  /** Render dotted leaders between label and value. */
  withLeader?: boolean;
  className?: string;
}

export function KeyValue({ label, value, compact, withLeader, className }: KeyValueProps) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3",
        compact ? "py-0.5 text-xs" : "py-1 text-sm",
        className,
      )}
    >
      <span className={cn("text-base-content/60 flex-shrink-0", compact && "text-xs")}>
        {label}
      </span>
      {withLeader && (
        <span
          aria-hidden
          className="flex-1 mx-2 border-b border-dotted border-base-content/15 translate-y-[-3px]"
        />
      )}
      <span
        className={cn(
          "font-mono tabular-nums text-base-content text-right",
          compact && "text-xs",
        )}
      >
        {value}
      </span>
    </div>
  );
}
