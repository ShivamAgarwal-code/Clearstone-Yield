// Robust error → string formatter.
//
// `String(e)` produces "[object Object]" when `e` is a plain object
// (which Anchor's wrapped errors and some Solana RPC errors actually
// are post-marshalling). Walk a few well-known shapes before falling
// back to JSON to keep the tx log informative.
//
// Surfaces, in priority order:
//   1. AnchorError — has `.error.errorCode.code` + `.error.errorMessage`
//      and a top-level `.message`. Extract the most useful field set.
//   2. SendTransactionError — `.message` is human-readable; `.logs` is
//      the program-log array. Show both.
//   3. Error — just `.message`.
//   4. string — passthrough.
//   5. fallthrough — JSON.stringify with circular-ref guard.

interface AnchorErrorLike {
  error?: {
    errorCode?: { code?: string; number?: number };
    errorMessage?: string;
    origin?: string;
  };
  message?: string;
  logs?: string[];
}

interface SendTransactionErrorLike {
  message?: string;
  logs?: string[];
  signature?: string;
}

export function formatError(e: unknown): string {
  if (e == null) return "(null)";
  if (typeof e === "string") return e;

  if (e instanceof Error) {
    // Anchor's AnchorError extends Error and exposes `.error.errorCode`.
    const ae = e as unknown as AnchorErrorLike;
    if (ae.error?.errorCode) {
      const code = ae.error.errorCode.code ?? "?";
      const num = ae.error.errorCode.number ?? "?";
      const msg = ae.error.errorMessage ?? e.message;
      const origin = ae.error.origin ? ` @ ${ae.error.origin}` : "";
      const logs = formatLogs(ae.logs);
      return `AnchorError ${code} (${num})${origin}: ${msg}${logs}`;
    }
    // SendTransactionError carries logs separately on devnet sims.
    const ste = e as unknown as SendTransactionErrorLike;
    if (Array.isArray(ste.logs) && ste.logs.length > 0) {
      return `${e.message}${formatLogs(ste.logs)}`;
    }
    return e.message || e.toString();
  }

  // Non-Error object: try the same field paths as the Error branch
  // (Anchor sometimes throws plain objects from inner CPIs after
  // serialisation).
  if (typeof e === "object") {
    const ae = e as AnchorErrorLike;
    if (ae.error?.errorCode) {
      const code = ae.error.errorCode.code ?? "?";
      const num = ae.error.errorCode.number ?? "?";
      const msg = ae.error.errorMessage ?? ae.message ?? "(no message)";
      const logs = formatLogs(ae.logs);
      return `AnchorError ${code} (${num}): ${msg}${logs}`;
    }
    if (typeof ae.message === "string") {
      const logs = formatLogs(ae.logs);
      return `${ae.message}${logs}`;
    }
    try {
      return JSON.stringify(e, replaceBigInt, 2);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }

  return String(e);
}

function formatLogs(logs: string[] | undefined): string {
  if (!logs || logs.length === 0) return "";
  // Truncate; full logs are usually too verbose for the tx log panel.
  const max = 12;
  const head = logs.slice(0, max).join("\n  ");
  const trailer = logs.length > max ? `\n  …(+${logs.length - max} more lines)` : "";
  return `\n  ${head}${trailer}`;
}

function replaceBigInt(_key: string, val: unknown): unknown {
  return typeof val === "bigint" ? val.toString() : val;
}
