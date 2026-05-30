import { ReactNode, useEffect, useState } from "react";
import { cn } from "../lib/cn";

/**
 * Snackbar — focused replacement for daisyUI's full-width `alert`.
 *
 *   * `inline` — capped at `max-w-md`, used inside cards / forms.
 *   * `toast`  — fixed bottom-right, slides in, optional auto-dismiss.
 *
 * Visual: clean white card with a colour-coded **icon badge** on the
 * left (filled circle, severity colour, white glyph). Replaces the old
 * tinted-bg + 4px stripe combo, which read as "loud monochrome rectangle"
 * — especially for the success state which painted half the screen
 * pale green. Now severity comes through the badge alone; the surface
 * stays white so the snackbar feels like a notification *card*, not a
 * coloured banner.
 */

export type SnackbarType = "info" | "success" | "warning" | "error";

export interface SnackbarProps {
  type?: SnackbarType;
  message: string;
  /** Secondary line — typically a tx signature or address. */
  detail?: string;
  /** Layout:
   *   - `inline` — capped width, sits in flow.
   *   - `toast`  — fixed bottom-right.
   *   - `sticky` — sticky to top of its scroll container, full width. */
  variant?: "inline" | "toast" | "sticky";
  dismissAfterMs?: number;
  onDismiss?: () => void;
  /** Optional action slot — typically a Button (`<Button size="sm">…</Button>`). */
  action?: ReactNode;
  /** Whether to show a copy-to-clipboard button. Defaults to `true` so
   *  long error blobs (klend custom-program errors, simulation logs) can
   *  always be lifted from a tx-status toast without the user having to
   *  manually select-and-copy from a stack trace in the console. Set to
   *  `false` for purely transient info toasts where copying makes no
   *  sense ("Loading…"). */
  copyable?: boolean;
}

interface Accent {
  /** Filled badge colour. */
  badge: string;
  /** Glyph colour against the badge. */
  glyph: string;
  /** Subtle hairline matching the accent — lifts the card without flooding bg. */
  edge: string;
}

const ACCENT: Record<SnackbarType, Accent> = {
  info:    { badge: "bg-[#4F607C]", glyph: "text-white",     edge: "border-[#4F607C]/25" },
  success: { badge: "bg-[#2E7D5B]", glyph: "text-white",     edge: "border-[#2E7D5B]/25" },
  warning: { badge: "bg-[#B57F3A]", glyph: "text-white",     edge: "border-[#B57F3A]/30" },
  error:   { badge: "bg-[#B14A4A]", glyph: "text-white",     edge: "border-[#B14A4A]/30" },
};

const ICON: Record<SnackbarType, ReactNode> = {
  info: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  success: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
      <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warning: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <path d="M12 9v4M12 17h.01" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  error: (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
      <path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round" />
    </svg>
  ),
};

export default function Snackbar({
  type = "info",
  message,
  detail,
  variant = "inline",
  dismissAfterMs,
  onDismiss,
  action,
  copyable = true,
}: SnackbarProps) {
  useEffect(() => {
    if (variant !== "toast" || !dismissAfterMs || !onDismiss) return;
    const id = setTimeout(onDismiss, dismissAfterMs);
    return () => clearTimeout(id);
  }, [variant, dismissAfterMs, onDismiss]);

  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = detail ? `${message}\n${detail}` : message;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older browsers / restrictive contexts (e.g. devnet behind a
      // sandboxed iframe) — fall back to a hidden textarea + execCommand.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const accent = ACCENT[type];

  const card = (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-3 px-4 py-3",
        "rounded-xl bg-base-200 border",
        accent.edge,
        "shadow-[var(--shadow-stone-md)]",
      )}
    >
      {/* Filled badge — severity colour lives here, not on the surface. */}
      <span
        aria-hidden
        className={cn(
          "flex-shrink-0 mt-0.5 inline-flex items-center justify-center",
          "h-6 w-6 rounded-full",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_2px_rgba(31,45,72,0.20)]",
          accent.badge,
          accent.glyph,
        )}
      >
        {ICON[type]}
      </span>

      {/* Content column — message / detail / action row stack as
          discrete rows so a long message can never collide with the
          action cluster on the right (which produced the asymmetric
          mis-aligned look in the success toast). */}
      <div className="flex-1 min-w-0 pt-0.5 space-y-1.5">
        <div className="text-sm font-medium text-base-content leading-snug break-words">
          {message}
        </div>
        {detail && (
          <div className="text-xs text-base-content/55 font-mono break-all leading-snug">
            {detail}
          </div>
        )}
        {action && (
          <div className="flex items-center justify-end gap-1.5 pt-1">
            {action}
          </div>
        )}
      </div>

      {/* Right-side controls: copy + dismiss. Sit in a single column so
          the layout stays balanced whether one or both are present. The
          copy button is opt-out via `copyable={false}` rather than
          opt-in — every tx flow that pipes a klend / sim error into a
          toast benefits without per-call wiring. */}
      <div className="flex-shrink-0 flex items-start gap-1 -m-1">
        {copyable && (
          <button
            onClick={handleCopy}
            aria-label={copied ? "Copied" : "Copy message"}
            title={copied ? "Copied" : "Copy"}
            type="button"
            className={cn(
              "p-1 rounded",
              "text-base-content/40 hover:text-base-content hover:bg-base-content/5",
              "transition-colors duration-150",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary/50",
            )}
          >
            {copied ? (
              <svg className="h-4 w-4 text-[#2E7D5B]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            type="button"
            className={cn(
              "p-1 rounded",
              "text-base-content/40 hover:text-base-content hover:bg-base-content/5",
              "transition-colors duration-150",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary/50",
            )}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  if (variant === "toast") {
    return (
      <div
        className="fixed bottom-6 right-6 z-50 w-full max-w-md pointer-events-auto"
        style={{ animation: "cs-toast-in 200ms ease-out both" }}
      >
        {card}
      </div>
    );
  }

  if (variant === "sticky") {
    return (
      <div
        className="sticky top-0 z-40 w-full backdrop-blur-md"
        style={{ animation: "cs-toast-in 220ms ease-out both" }}
      >
        {card}
      </div>
    );
  }

  return <div className="max-w-md">{card}</div>;
}
