import { useEffect, useMemo, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useStack } from "../lib/stack-context.js";
import { formatError } from "../lib/format.js";

// Market picker dropdown.
//
// Sources, in order of priority:
//   1. Canonical markets from the active stack (today: kaminoStack.ammMarket).
//   2. On-chain discovery via `getProgramAccounts(clearstone_core)` filtered
//      by the MarketTwo account discriminator (Anchor sha256 prefix). This
//      gives integrators a live picker without needing to know pubkeys.
//   3. "Custom…" option that surfaces a free-form pubkey input.
//
// The on-chain discovery is best-effort: cancelled if the user navigates
// away, errors are surfaced as a non-blocking warning. We don't decode
// the full MarketTwo struct — we just count + display the pubkey. Tabs
// that need market metadata (mint_pt, escrows, ALT) should fetch them
// lazily from `program.account.marketTwo.fetch(pk)` on selection.

const MARKET_TWO_DISCRIMINATOR_BYTES = [
  // Anchor account discriminator = sha256("account:MarketTwo")[0..8].
  // Hard-coded so this component stays IDL-free.
  246, 70, 51, 18, 219, 152, 144, 250,
] as const;

interface DiscoveredMarket {
  pubkey: PublicKey;
  source: "canonical" | "on-chain";
  label: string;
}

export interface MarketPickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Override the placeholder for the custom-entry input. */
  placeholder?: string;
}

export function MarketPicker({ value, onChange, placeholder }: MarketPickerProps) {
  const { connection } = useConnection();
  const { stack } = useStack();
  const [discovered, setDiscovered] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [mode, setMode] = useState<"select" | "custom">(() =>
    value && !isCanonical(stack, value) ? "custom" : "select"
  );

  const canonicals: DiscoveredMarket[] = useMemo(
    () => [
      {
        pubkey: stack.kaminoStack.ammMarket,
        source: "canonical" as const,
        label: "Kamino USDC PT/SY (devnet canonical)",
      },
    ],
    [stack]
  );

  // On-chain discovery. Runs once on mount + whenever the stack RPC
  // changes. Cancellable via the AbortController-equivalent mounted flag.
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setDiscoveryError(null);
    const corePk = stack.programs.clearstone_core;
    connection
      .getProgramAccounts(corePk, {
        commitment: "confirmed",
        // Filter by Anchor account discriminator at offset 0 — picks
        // up only `MarketTwo` accounts, not `Vault`s or `LpStake`s etc.
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: bytesToBs58([...MARKET_TWO_DISCRIMINATOR_BYTES]),
            },
          },
        ],
        // dataSlice = first 0 bytes — we only need the pubkey, not the
        // payload. Keeps the RPC response tiny.
        dataSlice: { offset: 0, length: 0 },
      })
      .then((rows) => {
        if (!mounted) return;
        const list: DiscoveredMarket[] = rows.map((r) => ({
          pubkey: r.pubkey,
          source: "on-chain",
          label: `${r.pubkey.toBase58().slice(0, 8)}…${r.pubkey.toBase58().slice(-4)}`,
        }));
        setDiscovered(list);
      })
      .catch((e: unknown) => {
        if (!mounted) return;
        setDiscoveryError(formatError(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [connection, stack.programs.clearstone_core]);

  // Merge: canonicals first, then on-chain (deduped by pubkey).
  const options = useMemo(() => {
    const seen = new Set(canonicals.map((c) => c.pubkey.toBase58()));
    const onChain = discovered.filter((d) => !seen.has(d.pubkey.toBase58()));
    return [...canonicals, ...onChain];
  }, [canonicals, discovered]);

  if (mode === "custom") {
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "<market pubkey>"}
          style={inputStyle}
        />
        <button
          type="button"
          onClick={() => setMode("select")}
          style={{ ...linkStyle, justifySelf: "start" }}
        >
          ← back to picker
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom__") {
            setMode("custom");
            onChange("");
            return;
          }
          onChange(v);
        }}
        style={inputStyle}
      >
        <option value="" disabled>
          {loading ? "loading markets…" : "Select a market"}
        </option>
        {options.map((opt) => (
          <option key={opt.pubkey.toBase58()} value={opt.pubkey.toBase58()}>
            {opt.label}
            {opt.source === "canonical" ? "  (canonical)" : ""}
          </option>
        ))}
        <option value="__custom__">Custom…</option>
      </select>
      <div style={{ fontSize: 11, color: "#666" }}>
        {loading
          ? "scanning clearstone_core…"
          : discoveryError
            ? `on-chain discovery failed: ${discoveryError} (canonical entries still selectable)`
            : `${options.length} market${options.length === 1 ? "" : "s"} available`}
      </div>
    </div>
  );
}

function isCanonical(stack: ReturnType<typeof useStack>["stack"], pk: string): boolean {
  return stack.kaminoStack.ammMarket.toBase58() === pk;
}

// Encode a byte array as bs58 — `getProgramAccounts` requires the
// memcmp.bytes field as bs58. Built inline so this component has zero
// external deps beyond what `@solana/web3.js` already brings in.
function bytesToBs58(bytes: number[]): string {
  // PublicKey.encode is the simplest path: it's a 32-byte bs58 encoder
  // for Solana. For our 8-byte discriminator we pad-zero to 32 bytes,
  // encode, then truncate the bs58 result to the prefix that re-decodes
  // to the original 8 bytes.
  //
  // Cleaner: use bs58 directly. web3.js doesn't re-export it, so we
  // do the encoding inline. Standard bs58 alphabet:
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    const r = Number(n % 58n);
    out = ALPHABET[r] + out;
    n /= 58n;
  }
  // Leading-zero bytes preserve as leading "1"s in bs58.
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}

const inputStyle: React.CSSProperties = {
  background: "#161618",
  color: "#e8e8e8",
  border: "1px solid #2a2a2e",
  padding: "8px 10px",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 13,
};

const linkStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#6cf",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
  fontFamily: "inherit",
};
