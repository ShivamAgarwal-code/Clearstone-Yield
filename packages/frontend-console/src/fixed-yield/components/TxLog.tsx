import { useCallback, useState } from "react";

// Reusable transaction-log panel.
//
// Co-locates step-by-step flow status, on-chain reverts, and warnings
// into ONE chronological panel. Use whenever you have a multi-step
// flow + an async on-chain confirm that returns errors separately —
// without this, error toasts and progress messages drift to different
// corners of the page and the operator can't reconstruct what happened.
//
// Usage:
//
//   const { entries, log, clear, LogPanel } = useTxLog();
//   …
//   async function handleWrap() {
//     log("info", "wrap 0.05 SOL → csSOL …");
//     try {
//       log("info", "signing …");
//       const sig = await sendTransaction(tx, connection);
//       log("info", `submitted: ${sig}`);
//       const conf = await connection.confirmTransaction(sig);
//       if (conf.value.err) {
//         log("error", `on-chain err: ${formatError(conf.value.err)}`);
//       } else {
//         log("info", "confirmed");
//       }
//     } catch (e) {
//       log("error", formatError(e));
//     }
//   }
//   return <>…page…<LogPanel/></>;
//
// Every channel funnels through `log(kind, msg)`. The panel renders
// newest-first, color-codes by kind, caps history at 50, and exposes a
// "clear" control. Drop the same hook into any other tab / project for
// uniform behaviour.

export type LogKind = "info" | "warn" | "error";
export interface LogEntry {
  id: number;
  kind: LogKind;
  msg: string;
  at: number;
}

export interface UseTxLogResult {
  entries: LogEntry[];
  log: (kind: LogKind, msg: string) => void;
  clear: () => void;
  LogPanel: React.FC<{ title?: string; height?: number }>;
}

const MAX_ENTRIES = 50;

export function useTxLog(): UseTxLogResult {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [seq, setSeq] = useState(1);

  const log = useCallback(
    (kind: LogKind, msg: string) => {
      setEntries((prev) =>
        [{ id: seq, kind, msg, at: Date.now() }, ...prev].slice(0, MAX_ENTRIES)
      );
      setSeq((s) => s + 1);
    },
    [seq]
  );

  const clear = useCallback(() => setEntries([]), []);

  const LogPanel: React.FC<{ title?: string; height?: number }> = ({
    title = "tx log",
    height = 280,
  }) => (
    <div
      style={{
        background: "#161618",
        border: "1px solid #2a2a2e",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #2a2a2e",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#888",
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          {title}
        </div>
        <button
          onClick={clear}
          style={{
            background: "transparent",
            color: "#e8e8e8",
            border: "1px solid #2a2a2e",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          clear
        </button>
      </div>
      <div
        style={{
          maxHeight: height,
          overflowY: "auto",
          fontFamily: "ui-monospace, monospace",
          fontSize: 12,
        }}
      >
        {entries.length === 0 && (
          <div style={{ padding: "16px 12px", color: "#555" }}>no entries</div>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid #1a1a1c",
              color:
                e.kind === "error" ? "#f88" : e.kind === "warn" ? "#fa6" : "#cfd",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
            }}
          >
            <span style={{ color: "#555", marginRight: 8 }}>
              {new Date(e.at).toLocaleTimeString()}
            </span>
            <span style={{ color: "#666", marginRight: 8 }}>[{e.kind}]</span>
            {e.msg}
          </div>
        ))}
      </div>
    </div>
  );

  return { entries, log, clear, LogPanel };
}
