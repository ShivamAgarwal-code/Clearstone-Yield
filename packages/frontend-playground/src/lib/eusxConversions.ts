import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CEUSX_MINT,
  EUSX_DM_MINT_CONFIG,
  EUSX_MINT,
  EUSX_POOL_PDA,
  LEGACY_DELTA_MINT_PROGRAM,
  LEGACY_GOVERNOR_PROGRAM,
  SOLSTICE_API_URL,
  USX_MINT,
} from "./addresses";

/** Anchor sentence-case discriminator: first 8 bytes of sha256("global:<ix>"). */
async function sha256_8(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash, 0, 8);
}

/** Solstice REST instruction response — either fully serialized tx or
 *  a single instruction encoded as `{program_id, accounts, data}`. The
 *  user-facing flows (RequestMint, ConfirmMint, RequestRedeem,
 *  ConfirmRedeem, Lock, Unlock) all return the latter. */
type SolsticeIxResponse =
  | { transaction: string }
  | {
      instruction: {
        program_id: number[];
        accounts: { pubkey: number[]; is_signer: boolean; is_writable: boolean }[];
        data: number[];
      };
    };

/** Call the Solstice REST API and return the raw instruction(s) the user
 *  must sign. Mirrors `frontend-institutional/PreparePage.callSolstice`
 *  but returns plain TransactionInstructions (not a Transaction) so the
 *  caller can compose them with their own ATA-creation / refresh ixes. */
export async function callSolstice(
  apiKey: string,
  body: object,
): Promise<TransactionInstruction[]> {
  if (!apiKey) throw new Error("Solstice API key is required");
  const resp = await fetch(SOLSTICE_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Solstice API ${resp.status}: ${errBody.slice(0, 250)}`);
  }
  const result = (await resp.json()) as SolsticeIxResponse;
  if ("transaction" in result) {
    throw new Error(
      "Solstice returned a serialized transaction — the playground only knows how to handle raw instruction responses.",
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

/** Helper: derive `whitelist_entry` PDA on the legacy delta-mint for a
 *  given pool's MintConfig. The wrap ix CPIs delta-mint::mint_to which
 *  enforces the whitelist, so the user must already be onboarded by
 *  the institutional KYC flow. */
function legacyWhitelistPda(mintConfig: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), mintConfig.toBuffer(), user.toBuffer()],
    LEGACY_DELTA_MINT_PROGRAM,
  );
  return pda;
}

/** Build governor::wrap (eUSX → ceUSX). Mirrors the layout in
 *  PreparePage.handleWrapEUSX (governor lib.rs::WrapTokens, 13 accounts). */
export async function buildEusxToCeUsxWrapIx(args: {
  user: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const [dmAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), CEUSX_MINT.toBuffer()],
    LEGACY_DELTA_MINT_PROGRAM,
  );
  const whitelistEntry = legacyWhitelistPda(EUSX_DM_MINT_CONFIG, args.user);
  const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(EUSX_MINT, EUSX_POOL_PDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCeusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:wrap"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: LEGACY_GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: EUSX_POOL_PDA, isSigner: false, isWritable: true },
      { pubkey: EUSX_MINT, isSigner: false, isWritable: false },
      { pubkey: userEusxAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: EUSX_DM_MINT_CONFIG, isSigner: false, isWritable: false },
      { pubkey: CEUSX_MINT, isSigner: false, isWritable: true },
      { pubkey: dmAuthority, isSigner: false, isWritable: false },
      { pubkey: whitelistEntry, isSigner: false, isWritable: false },
      { pubkey: userCeusxAta, isSigner: false, isWritable: true },
      { pubkey: LEGACY_DELTA_MINT_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

/** Build governor::unwrap (ceUSX → eUSX). Burns ceUSX (no KYC check on
 *  burn) and transfers eUSX from the pool vault back to the user.
 *  Account layout from governor lib.rs::UnwrapTokens (9 accounts). */
export async function buildCeUsxToEusxUnwrapIx(args: {
  user: PublicKey;
  amount: bigint;
}): Promise<TransactionInstruction> {
  const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT, args.user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultAta = getAssociatedTokenAddressSync(EUSX_MINT, EUSX_POOL_PDA, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCeusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, args.user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const data = new Uint8Array(16);
  data.set(await sha256_8("global:unwrap"), 0);
  new DataView(data.buffer).setBigUint64(8, args.amount, true);

  return new TransactionInstruction({
    programId: LEGACY_GOVERNOR_PROGRAM,
    data: Buffer.from(data),
    keys: [
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: EUSX_POOL_PDA, isSigner: false, isWritable: false },
      { pubkey: EUSX_MINT, isSigner: false, isWritable: false },
      { pubkey: userEusxAta, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: CEUSX_MINT, isSigner: false, isWritable: true },
      { pubkey: userCeusxAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

/** Read the user's USDC / USX / eUSX balances in one batch. Used by
 *  the conversion pipeline UI to surface "what's available where". */
export async function readEusxBalances(
  conn: Connection,
  user: PublicKey,
  usdcMint: PublicKey,
): Promise<{ usdc: number; usx: number; eusx: number }> {
  const usdcAta = getAssociatedTokenAddressSync(usdcMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const usxAta = getAssociatedTokenAddressSync(USX_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const eusxAta = getAssociatedTokenAddressSync(EUSX_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [usdc, usx, eusx] = await Promise.all([
    conn.getTokenAccountBalance(usdcAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
    conn.getTokenAccountBalance(usxAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
    conn.getTokenAccountBalance(eusxAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
  ]);
  return { usdc, usx, eusx };
}
