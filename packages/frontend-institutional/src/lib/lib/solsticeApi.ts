import { PublicKey, TransactionInstruction } from "@solana/web3.js";

// Production proxy — backend-edge Worker has a `/solstice` route that
// forwards body + `x-api-key` to instructions.solstice.finance. Set
// VITE_EDGE_URL in the Pages env vars to enable. Falls through to the
// dev-only Vite proxy and finally to the direct URL (most likely to
// CORS-fail in the browser, but kept as a last-resort).
const EDGE_URL = (import.meta.env.VITE_EDGE_URL as string | undefined) ?? "";
const SOLSTICE_API_EDGE   = EDGE_URL ? `${EDGE_URL.replace(/\/$/, "")}/solstice` : null;
const SOLSTICE_API_PROXY  = "/api/solstice";
const SOLSTICE_API_DIRECT = "https://instructions.solstice.finance/v1/instructions";

type SolsticeIxResponse =
  | { transaction: string }
  | {
      instruction: {
        program_id: number[];
        accounts: { pubkey: number[]; is_signer: boolean; is_writable: boolean }[];
        data: number[];
      };
    };

/**
 * Call the Solstice REST API and return the raw instruction(s) the user
 * must sign. Mirrors the playground's `callSolstice` (returns plain
 * `TransactionInstruction[]` so callers can compose them with their own
 * ATA-creation / refresh / klend ixes), and falls back from the dev-only
 * `/api/solstice` Vite proxy to the prod URL — same dual-URL behavior as
 * `PreparePage.callSolstice`.
 */
export async function callSolsticeRaw(
  apiKey: string,
  body: object,
): Promise<TransactionInstruction[]> {
  if (!apiKey) throw new Error("Solstice API key is required");

  let resp: Response | null = null;
  let lastError = "";
  const candidates = [SOLSTICE_API_EDGE, SOLSTICE_API_PROXY, SOLSTICE_API_DIRECT].filter(
    (u): u is string => !!u,
  );
  for (const url of candidates) {
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (resp.ok) break;
      lastError = `HTTP ${resp.status}: ${(await resp.text()).slice(0, 150)}`;
      resp = null;
    } catch (e: any) {
      lastError = e?.message ?? "fetch failed";
      resp = null;
    }
  }
  if (!resp || !resp.ok) throw new Error(`Solstice API failed — ${lastError}`);

  const result = (await resp.json()) as SolsticeIxResponse;
  if ("transaction" in result) {
    throw new Error(
      "Solstice returned a serialized transaction; this caller expects raw instruction responses.",
    );
  }
  if ("instruction" in result) {
    const ix = result.instruction;
    return [
      new TransactionInstruction({
        programId: new PublicKey(Buffer.from(ix.program_id)),
        keys: ix.accounts.map((acc) => ({
          pubkey: new PublicKey(Buffer.from(acc.pubkey)),
          isSigner: acc.is_signer,
          isWritable: acc.is_writable,
        })),
        data: Buffer.from(ix.data),
      }),
    ];
  }
  throw new Error(`Unexpected Solstice response: ${JSON.stringify(result).slice(0, 200)}`);
}
