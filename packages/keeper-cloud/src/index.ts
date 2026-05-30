/**
 * Cloudflare Worker — csSOL accrual-oracle refresher.
 *
 * Cron-triggered. Each fire is a single `accrual_oracle::refresh` call. The
 * accrual oracle reads SOL/USD from the Pyth-sponsored devnet push feed
 *
 *   7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE   (owner: Pyth Receiver)
 *
 * which is updated by Pyth's permissionless updater every ~30 seconds, and
 * writes `source_price * index_e9 / 1e9` into our stable accrual output. The
 * wSOL reserve reads `7UVi…` directly; only the csSOL reserve needs our
 * accrual output to stay fresh.
 *
 * Why so small: there's no VAA fetch, no Wormhole verification, no
 * post+close churn. Pyth's network does that work for free.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

interface Env {
  DEPLOY_KEYPAIR_JSON: string;
  SOLANA_RPC_URL: string;
  ACCRUAL_OUTPUT: string;
  ACCRUAL_CONFIG: string;
  ACCRUAL_ORACLE_PROGRAM: string;
  PYTH_PRICE_FEED: string; // 7UVi… on devnet

  // ── Optional Jito Vault state-tracker cranker. When CSSOL_VAULT +
  // JITO_VAULT_PROGRAM + JITO_VAULT_CONFIG are set, every cron fire
  // also tries to Initialize+Close the vault's per-epoch state
  // tracker so users don't need to run scripts/crank-vault-update.ts
  // before each enqueue/mature. Idempotent: if the tracker for the
  // current epoch already exists, init fails and we skip silently.
  // Mature-pass for csSOL-WT tickets was removed when maturation
  // became user-initiated (the user signs as Jito staker).
  JITO_VAULT_PROGRAM?: string;
  JITO_VAULT_CONFIG?: string;
  CSSOL_VAULT?: string;

  // ── Optional WT-specific accrual oracle (vault-backed). When all
  // three of WT_ACCRUAL_CONFIG / WT_ACCRUAL_OUTPUT / WT_BOUND_VAULT
  // are set, every cron fire also calls
  // `accrual_oracle::refresh_with_vault` so the WT-specific oracle
  // stays fresh in steady state alongside the csSOL one. The
  // bound_vault should equal CSSOL_VAULT — they're the same Jito
  // vault account, just exposed under two env names so the WT
  // oracle config is independently togglable.
  WT_ACCRUAL_CONFIG?: string;
  WT_ACCRUAL_OUTPUT?: string;
  WT_BOUND_VAULT?: string;
}

// First 8 bytes of sha256("global:refresh"), pre-computed.
const DISC_REFRESH = Uint8Array.from([0xaa, 0x9b, 0x16, 0xfe, 0x93, 0xb5, 0x31, 0xa1]);
// First 8 bytes of sha256("global:refresh_with_vault"), pre-computed
// (cross-checked against the accrual-oracle program's IDL).
const DISC_REFRESH_WITH_VAULT = Uint8Array.from([0x88, 0xa5, 0x32, 0x37, 0x65, 0x4f, 0x66, 0x49]);

// First 8 bytes of sha256("global:mature_withdrawal_tickets"). Computed
// off-thread via the standard formula (anchor.fetch-discriminator pattern).
async function disc(name: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(h).slice(0, 8);
}

function loadKeypair(raw: string): Keypair {
  // Accept either the JSON array form Solana CLI writes (`[12,34,...,255]`)
  // or a base58-encoded 64-byte secret string. Saves us re-uploading the
  // secret if the operator paste-formats it the wrong way.
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    if (arr.length !== 64) throw new Error(`DEPLOY_KEYPAIR_JSON JSON array must be 64 bytes, got ${arr.length}`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  // Base58 fallback. @solana/web3.js bundles bs58 transitively via tweetnacl;
  // we use Keypair.fromSecretKey on a manually-decoded buffer.
  const decoded = base58Decode(trimmed);
  if (decoded.length !== 64) throw new Error(`DEPLOY_KEYPAIR_JSON base58 must decode to 64 bytes, got ${decoded.length}`);
  return Keypair.fromSecretKey(decoded);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  const map = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) map.set(BASE58_ALPHABET[i], i);
  let bytes: number[] = [0];
  for (const c of s) {
    const v = map.get(c);
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading zero bytes for each leading '1'.
  for (const c of s) { if (c !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}

function buildRefreshIx(
  programId: PublicKey,
  feedConfig: PublicKey,
  source: PublicKey,
  output: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: feedConfig, isSigner: false, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: false },
      { pubkey: output, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(DISC_REFRESH),
  });
}

/** Vault-backed variant — feeds `index_e9 = vault.tokens_deposited /
 *  vault.vrt_supply * 1e9` into the output account instead of the
 *  authority-set time-based rate. Used by the WT oracle since its
 *  price tracks the pool's pending wSOL backing. */
function buildRefreshWithVaultIx(
  programId: PublicKey,
  feedConfig: PublicKey,
  source: PublicKey,
  vault: PublicKey,
  output: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: feedConfig, isSigner: false, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: output, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(DISC_REFRESH_WITH_VAULT),
  });
}

async function runOnce(env: Env): Promise<{ sig: string; signer: string; balanceSol: number; sourcePrice: number }> {
  const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const payer = loadKeypair(env.DEPLOY_KEYPAIR_JSON);
  const signer = payer.publicKey.toBase58();

  // Surface the signer's balance so a "no SOL" deploy is obvious from the
  // very first response instead of looking like a confirmation timeout.
  const balanceLamports = await conn.getBalance(payer.publicKey, "confirmed");
  const balanceSol = balanceLamports / 1e9;
  if (balanceLamports < 50_000) {
    throw new Error(`signer ${signer} has only ${balanceSol} SOL — airdrop with: solana airdrop 1 ${signer} --url devnet`);
  }

  const refresh = buildRefreshIx(
    new PublicKey(env.ACCRUAL_ORACLE_PROGRAM),
    new PublicKey(env.ACCRUAL_CONFIG),
    new PublicKey(env.PYTH_PRICE_FEED),
    new PublicKey(env.ACCRUAL_OUTPUT),
  );

  // Optional WT crank — packs into the same tx so a single fire keeps
  // both oracles fresh. The two ixes together fit comfortably inside
  // 200K CU + 1 priority-fee ix.
  const wtCrank = (env.WT_ACCRUAL_CONFIG && env.WT_ACCRUAL_OUTPUT && env.WT_BOUND_VAULT)
    ? buildRefreshWithVaultIx(
        new PublicKey(env.ACCRUAL_ORACLE_PROGRAM),
        new PublicKey(env.WT_ACCRUAL_CONFIG),
        new PublicKey(env.PYTH_PRICE_FEED),
        new PublicKey(env.WT_BOUND_VAULT),
        new PublicKey(env.WT_ACCRUAL_OUTPUT),
      )
    : null;

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: wtCrank ? 120_000 : 60_000 }))
    // 200_000 µL × 60k CU ≈ 12 priority lamports — tiny next to base fees,
    // but enough to clear devnet's leader queue most of the time.
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
    .add(refresh);
  if (wtCrank) tx.add(wtCrank);
  tx.sign(payer);

  // Fire-and-forget: the refresh is idempotent and the cron fires every
  // 5 min, so if a tx silently expires the next fire just re-runs. We
  // skip `sendAndConfirmTransaction` because its 60s confirmation window
  // races devnet's blockhash expiry — and an unconfirmed-but-submitted
  // sig still typically lands seconds later.
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: "confirmed",
  });

  // Read source price for log decoration only — failures here do not fail the fire.
  let sourcePrice = NaN;
  try {
    const acct = await conn.getAccountInfo(new PublicKey(env.PYTH_PRICE_FEED), "confirmed");
    if (acct?.data && acct.data.length >= 93) {
      const price = acct.data.readBigInt64LE(73);
      const expo = acct.data.readInt32LE(89);
      sourcePrice = Number(price) * Math.pow(10, expo);
    }
  } catch {
    /* swallow */
  }

  return { sig, signer, balanceSol, sourcePrice };
}

// ── Jito Vault state-tracker cranker ──
// Initializes + closes the per-epoch VaultUpdateStateTracker so the
// vault stays "updated" and EnqueueWithdrawal/BurnWithdrawalTicket
// don't reject with error 1020 ("Vault update is needed"). Idempotent:
// if the tracker for the current epoch already exists, the
// InitializeVaultUpdateStateTracker CPI fails and we skip closing.
// On mainnet/devnet defaults the epoch is ~48h, so cranking once on
// every 5-min cron fire is wasteful but safe; cheap enough to ignore.
async function crankVaultUpdate(env: Env): Promise<{ tried: boolean; sigs: string[] }> {
  if (!env.JITO_VAULT_PROGRAM || !env.JITO_VAULT_CONFIG || !env.CSSOL_VAULT) {
    return { tried: false, sigs: [] };
  }
  const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const payer = loadKeypair(env.DEPLOY_KEYPAIR_JSON);
  const jitoProg = new PublicKey(env.JITO_VAULT_PROGRAM);
  const config = new PublicKey(env.JITO_VAULT_CONFIG);
  const vault = new PublicKey(env.CSSOL_VAULT);

  // Compute current ncn_epoch from the vault's Config.epochLength.
  const cfgInfo = await conn.getAccountInfo(config, "confirmed");
  if (!cfgInfo) return { tried: false, sigs: [] };
  const epochLength = cfgInfo.data.readBigUInt64LE(8 + 32 + 32);
  const slot = await conn.getSlot("confirmed");
  const ncnEpoch = BigInt(slot) / epochLength;

  // Tracker PDA = ["vault_update_state_tracker", vault, ncn_epoch_le].
  const ncnEpochBytes = Buffer.alloc(8);
  ncnEpochBytes.writeBigUInt64LE(ncnEpoch);
  const [tracker] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_update_state_tracker"), vault.toBuffer(), ncnEpochBytes],
    jitoProg,
  );

  // If tracker already exists for this epoch, skip — already cranked.
  const existing = await conn.getAccountInfo(tracker, "confirmed");
  if (existing) return { tried: false, sigs: [] };

  const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
  const sigs: string[] = [];

  // Step 1: InitializeVaultUpdateStateTracker (disc=26, withdrawalAllocationMethod=0=Greedy)
  const initIx = new TransactionInstruction({
    programId: jitoProg,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tracker, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([26, 0]),
  });
  // Step 2: CloseVaultUpdateStateTracker (disc=28, ncn_epoch as u64 LE).
  const closeData = Buffer.alloc(1 + 8);
  closeData[0] = 28;
  closeData.writeBigUInt64LE(ncnEpoch, 1);
  const closeIx = new TransactionInstruction({
    programId: jitoProg,
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tracker, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    ],
    data: closeData,
  });

  for (const [name, ix] of [["init", initIx], ["close", closeIx]] as const) {
    try {
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash })
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
        .add(ix);
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      sigs.push(`${name}=${sig.slice(0, 12)}…`);
    } catch (e) {
      console.warn(`vault-update ${name} failed: ${(e as Error).message}`);
      break; // if init failed, close will fail too
    }
  }
  return { tried: true, sigs };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const { sig, signer, balanceSol, sourcePrice } = await runOnce(env);
          const priceLog = Number.isFinite(sourcePrice) ? `SOL=$${sourcePrice.toFixed(4)} ` : "";
          console.log(`refresh submitted  ${priceLog}signer=${signer} balance=${balanceSol.toFixed(4)} sig=${sig}`);
        } catch (e) {
          console.error(`oracle refresh failed: ${(e as Error).message}`);
        }
        try {
          const c = await crankVaultUpdate(env);
          if (c.tried) console.log(`vault-update crank: ${c.sigs.join(" ")}`);
        } catch (e) {
          console.error(`vault-update crank failed: ${(e as Error).message}`);
        }
      })(),
    );
  },

  async fetch(_req: Request, env: Env): Promise<Response> {
    try {
      const out = await runOnce(env);
      let vaultCrank: { tried: boolean; sigs: string[] } = { tried: false, sigs: [] };
      try {
        vaultCrank = await crankVaultUpdate(env);
      } catch (e) {
        console.warn(`vault-update crank failed: ${(e as Error).message}`);
      }
      return new Response(JSON.stringify({ ok: true, ...out, vaultCrank }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
