import { useState } from "react";
import { useStack } from "../lib/stack-context.js";
import {
  clearStackOverride,
  BUILTIN_STACKS,
  loadActiveKey,
  saveActiveKey,
} from "../lib/deployments.js";
import { formatError } from "../lib/format.js";

// Setup tab: shows the active deployment handles + lets the user paste
// an override JSON to swap in a local validator's stack. Persists to
// localStorage so reload keeps the override.
//
// The default config mirrors `deployments/devnet.json`'s `kaminoStack`
// block. Stale-after dates >7d show a warning; if the on-chain state
// has drifted (e.g., maturity rolled), the override is the escape
// hatch.

export function Setup() {
  const { stack, replace } = useStack();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => stringifyStack(stack));
  const [error, setError] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState(loadActiveKey());
  const ageDays = computeAgeDays(stack.lastUpdated);
  void replace;

  function handleSave() {
    setError(null);
    try {
      const parsed = JSON.parse(draft);
      replace(parsed);
      setEditing(false);
    } catch (e: unknown) {
      setError(formatError(e));
    }
  }

  function handleReset() {
    clearStackOverride();
    window.location.reload();
  }

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Active deployment</h2>
      <p style={{ color: "#8a8a8a", fontSize: 13 }}>
        Cluster: <code>{stack.cluster}</code> · RPC: <code>{stack.rpcUrl}</code>
        {" · "}
        Updated: <code>{stack.lastUpdated}</code>
        {ageDays > 7 && (
          <span style={{ color: "#fa6" }}> (stale: {ageDays}d old)</span>
        )}
      </p>

      <div style={{ marginTop: 16 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 13, maxWidth: 540 }}>
          <span style={{ color: "#8a8a8a" }}>
            Active stack
            <span style={{ color: "#666", marginLeft: 8 }}>
              — switches the active deployment without touching the JSON
              override below. Add new entries (csSOL, csUSDC) to
              BUILTIN_STACKS in src/lib/deployments.ts as you stand them up.
            </span>
          </span>
          <select
            value={activeKey}
            onChange={(e) => {
              const k = e.target.value;
              setActiveKey(k);
              saveActiveKey(k);
              clearStackOverride();
              window.location.reload();
            }}
            style={{
              background: "#161618",
              color: "#e8e8e8",
              border: "1px solid #2a2a2e",
              padding: "8px 10px",
              borderRadius: 4,
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            {Object.keys(BUILTIN_STACKS).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Block title="Programs" obj={stack.programs} />
      <Block title="Kamino stack" obj={stack.kaminoStack} />

      <div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => setEditing((v) => !v)} style={btnSecondary}>
          {editing ? "Cancel" : "Override (paste JSON)"}
        </button>
        <button onClick={handleReset} style={btnSecondary}>
          Reset override → use active stack
        </button>
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: "#666", lineHeight: 1.5 }}>
        Hitting <code>AccountNotInitialized (3012 / 0xbc4)</code> on Solstice's
        SOL→csSOL wrap? That's delta_mint's whitelist gate — your wallet needs
        a <code>WhitelistEntry</code> PDA created by the pool authority before
        you can receive csSOL. Either get whitelisted out-of-band, or click
        "Use test stack" above to drive Clearstone's sourcing/LP flow against
        a plain SPL test USDC mint with no whitelist gate.
      </div>

      {editing && (
        <div style={{ marginTop: 16 }}>
          <textarea
            rows={20}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            style={{
              width: "100%",
              background: "#161618",
              color: "#e8e8e8",
              border: "1px solid #2a2a2e",
              padding: 10,
              borderRadius: 4,
              fontFamily: "inherit",
              fontSize: 12,
              resize: "vertical",
            }}
          />
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button onClick={handleSave} style={btnPrimary}>
              Save + reload
            </button>
            {error && <div style={{ color: "#f88", fontSize: 12 }}>{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Block({ title, obj }: { title: string; obj: Record<string, unknown> }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>{title}</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <tbody>
          {Object.entries(obj).map(([k, v]) => (
            <tr key={k} style={{ borderBottom: "1px solid #1a1a1c" }}>
              <td style={{ color: "#8a8a8a", padding: "6px 8px", width: 220 }}>{k}</td>
              <td
                style={{
                  fontFamily: "ui-monospace, monospace",
                  padding: "6px 8px",
                  wordBreak: "break-all",
                }}
              >
                {String(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stringifyStack(s: ReturnType<typeof useStack>["stack"]): string {
  const flat = (obj: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, String(v)])
    );
  return JSON.stringify(
    {
      cluster: s.cluster,
      rpcUrl: s.rpcUrl,
      lastUpdated: s.lastUpdated,
      programs: flat(s.programs as unknown as Record<string, unknown>),
      kaminoStack: flat(s.kaminoStack as unknown as Record<string, unknown>),
    },
    null,
    2
  );
}

function computeAgeDays(lastUpdated: string): number {
  const t = Date.parse(lastUpdated);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

const btnPrimary: React.CSSProperties = {
  background: "#6cf",
  color: "#0e0e10",
  border: "none",
  padding: "10px 16px",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "#e8e8e8",
  border: "1px solid #2a2a2e",
  padding: "10px 16px",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};
