/**
 * KYC routes for Cloudflare Workers — submit, check status, approve.
 * On-chain whitelisting builds raw Solana txns signed with admin key.
 */

import { Hono } from "hono";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import type { Env } from "./types.js";

// Set sha512 for noble/ed25519 using WebCrypto (available in CF Workers)
ed.hashes.sha512Async = async (msg: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-512", msg));

const kyc = new Hono<{ Bindings: Env }>();

interface KycRecord {
  walletAddress: string;
  entityType: string;
  name: string;
  email: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  approvedAt?: string;
  txSignatures?: string[];
}

async function getRecord(kv: KVNamespace, wallet: string): Promise<KycRecord | null> {
  const raw = await kv.get(`kyc:${wallet}`);
  return raw ? JSON.parse(raw) : null;
}

async function putRecord(kv: KVNamespace, record: KycRecord): Promise<void> {
  await kv.put(`kyc:${record.walletAddress}`, JSON.stringify(record), { expirationTtl: 86400 * 30 });
}

// POST /kyc/submit
kyc.post("/submit", async (c) => {
  const body = await c.req.json<{ walletAddress: string; entityType?: string; name?: string; email?: string }>();
  const { walletAddress, entityType, name, email } = body;
  if (!walletAddress || walletAddress.length < 32) return c.json({ success: false, error: "Invalid wallet address" }, 400);

  const existing = await getRecord(c.env.WHITELIST_CACHE, walletAddress);
  if (existing) return c.json({ success: true, data: existing, message: "Already submitted" });

  const record: KycRecord = {
    walletAddress, entityType: entityType || "individual", name: name || "Unknown",
    email: email || "", status: "pending", submittedAt: new Date().toISOString(),
  };
  await putRecord(c.env.WHITELIST_CACHE, record);
  return c.json({ success: true, data: record });
});

// GET /kyc/status/:wallet
kyc.get("/status/:wallet", async (c) => {
  const wallet = c.req.param("wallet");
  const record = await getRecord(c.env.WHITELIST_CACHE, wallet);
  if (!record) return c.json({ success: false, error: `No KYC record for ${wallet}` }, 404);
  return c.json({ success: true, data: record });
});

// POST /kyc/approve
kyc.post("/approve", async (c) => {
  const { walletAddress } = await c.req.json<{ walletAddress: string }>();
  if (!walletAddress) return c.json({ success: false, error: "walletAddress required" }, 400);

  let record = await getRecord(c.env.WHITELIST_CACHE, walletAddress);
  if (!record) {
    record = { walletAddress, entityType: "company", name: "Auto-registered", email: "", status: "pending", submittedAt: new Date().toISOString() };
  }
  if (record.status === "approved") {
    // Still attempt on-chain whitelist in case it wasn't written before
    const adminKey = c.env.ADMIN_KEYPAIR_JSON;
    if (adminKey) {
      try {
        record.txSignatures = await whitelistOnChain(c.env.SOLANA_RPC_URL, adminKey, walletAddress);
        await putRecord(c.env.WHITELIST_CACHE, record);
      } catch {}
    }
    return c.json({ success: true, data: record, message: "Already approved" });
  }

  await new Promise((r) => setTimeout(r, 500));

  let txSignatures: string[] = [];
  const adminKey = c.env.ADMIN_KEYPAIR_JSON;
  if (adminKey) {
    try {
      txSignatures = await whitelistOnChain(c.env.SOLANA_RPC_URL, adminKey, walletAddress);
    } catch (err: any) {
      txSignatures = [`error: ${err.message?.slice(0, 80)}`];
    }
  } else {
    txSignatures = ["no_admin_key_configured"];
  }

  record.status = "approved";
  record.approvedAt = new Date().toISOString();
  record.txSignatures = txSignatures;
  await putRecord(c.env.WHITELIST_CACHE, record);
  return c.json({ success: true, data: record });
});

// ── On-chain whitelisting ──────────────────────────────────────────
//
// Post-2026-05-06 the institutional + retail stacks both target the v3
// market. The whitelist set every Holder needs is mirrored from
// `configs/devnet/whitelist-bundle.json`:
//   * csSOL    — v3 csSOL host pool, ix=add_participant_via_pool
//   * csSOL-WT — same host pool, withdraw-ticket variant,
//                ix=add_wt_participant_via_pool (different seed shape
//                on the dm_mint_config side)
//   * cSOL     — v3 cSOL native-wrap pool,
//                ix=add_participant_native_via_pool (pool PDA derived
//                from ["native_pool", wrapped_mint], different from
//                the regular ["pool", underlying_mint])
//
// All three live under the v3 governor + v3 delta-mint, signed by the
// cSOL pool authority (the bootstrap keypair `DiDbnkw…` on devnet).
// The matching admin secret must be set via:
//   wrangler secret put ADMIN_KEYPAIR_JSON < ~/.config/solana/clearstone-devnet.json
const GOVERNOR = bs58.decode("6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi");
const DELTA_MINT_PID = bs58.decode("BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy");
const SYSTEM_PROGRAM = new Uint8Array(32);

// First-eight-byte Anchor discriminators (sha256("global:<ix>")[0..8]).
// Cross-checked against `target/idl/governor.json`.
const DISCS = {
  add_participant_via_pool:        new Uint8Array([200, 11, 127, 111, 117, 242, 194,  36]),
  add_wt_participant_via_pool:     new Uint8Array([175, 28, 135,  47,  36, 228,  98,  66]),
  add_participant_native_via_pool: new Uint8Array([ 39,129, 189, 223,  29, 143,  15,  98]),
} as const;

type IxName = keyof typeof DISCS;

interface PoolEntry {
  /** Human-readable label, used only in tx-signature logging. */
  label: string;
  /** PoolConfig PDA on chain. The governor's `seeds` constraint pins
   *  this to either ["pool", underlying] or ["native_pool", wrapped]
   *  depending on which ix dispatches; passing the wrong one trips
   *  ConstraintSeeds (Anchor 2006). */
  poolPda: string;
  /** delta-mint MintConfig that the whitelist PDA is keyed on. */
  dmConfig: string;
  /** Which add_participant variant to dispatch. */
  ix: IxName;
}

const POOLS: PoolEntry[] = [
  {
    label: "csSOL",
    poolPda:  "QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e",
    dmConfig: "FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2",
    ix: "add_participant_via_pool",
  },
  {
    label: "csSOL-WT",
    poolPda:  "QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e",
    dmConfig: "BQ4cqyRgJkhwfF477uUJsXhY7ga2Jp9VoKS2XsxfhtT4",
    ix: "add_wt_participant_via_pool",
  },
  {
    label: "cSOL",
    poolPda:  "7LrzKp9UHfgR3AVqDtdWeB5N9CaxLdVUVJGTzNGcUAeQ",
    dmConfig: "GJTRSUzfsXaroq4z4praK2Pu9VDZSmAkaj6h6XftEf3B",
    ix: "add_participant_native_via_pool",
  },
];

/** Derive PDA: seeds=[b"whitelist", dmConfig, wallet], program=DELTA_MINT */
async function deriveWhitelistPda(dmConfig: string, wallet: string): Promise<string> {
  const prefix = new TextEncoder().encode("whitelist");
  const dmBytes = bs58.decode(dmConfig);
  const walletBytes = bs58.decode(wallet);
  const pdaSuffix = new TextEncoder().encode("ProgramDerivedAddress");

  for (let bump = 255; bump >= 0; bump--) {
    const input = new Uint8Array([...prefix, ...dmBytes, ...walletBytes, bump, ...DELTA_MINT_PID, ...pdaSuffix]);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    try {
      ed.Point.fromHex(ed.etc.bytesToHex(hash));
      // On curve → not a valid PDA, try next bump
    } catch {
      return bs58.encode(hash);
    }
  }
  throw new Error("PDA not found");
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const url = rpcUrl || "https://api.devnet.solana.com";
  const resp = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await resp.json() as any;
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

async function whitelistOnChain(rpcUrl: string, adminKeypairJson: string, walletAddress: string): Promise<string[]> {
  const adminBytes = new Uint8Array(JSON.parse(adminKeypairJson));
  const adminPriv = adminBytes.slice(0, 32);
  const adminPub = adminBytes.slice(32, 64);
  const sigs: string[] = [];

  for (const pool of POOLS) {
    try {
      const wlPdaStr = await deriveWhitelistPda(pool.dmConfig, walletAddress);

      // Skip if already whitelisted
      const acctInfo = await rpcCall(rpcUrl, "getAccountInfo", [wlPdaStr, { encoding: "base64" }]);
      if (acctInfo?.value) { sigs.push(`already:${pool.label}`); continue; }

      const poolPda = bs58.decode(pool.poolPda);
      const dmConfig = bs58.decode(pool.dmConfig);
      const wallet = bs58.decode(walletAddress);
      const wlPda = bs58.decode(wlPdaStr);

      // Instruction accounts — same shape across all three add_participant
      // variants (the differences are seed constraints on `pool_config`
      // and which delta-mint helper the handler invokes internally).
      const ixKeys: IxKey[] = [
        { pk: adminPub, s: true, w: true },
        { pk: poolPda, s: false, w: true },
        { pk: GOVERNOR, s: false, w: false }, // admin_entry = None (placeholder pubkey)
        { pk: dmConfig, s: false, w: true },
        { pk: wallet, s: false, w: false },
        { pk: wlPda, s: false, w: true },
        { pk: DELTA_MINT_PID, s: false, w: false },
        { pk: SYSTEM_PROGRAM, s: false, w: false },
      ];
      // role=Holder is always 0 for these ixes' ParticipantRole enum.
      const ixData = new Uint8Array([...DISCS[pool.ix], 0]);

      // Blockhash
      const bh = await rpcCall(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
      const blockhash = bs58.decode(bh.value.blockhash);

      // Build + sign + send
      const msg = buildMessage(blockhash, adminPub, GOVERNOR, ixKeys, ixData);
      const sig = await ed.signAsync(msg, adminPriv);

      const signedTx = new Uint8Array(1 + 64 + msg.length);
      signedTx[0] = 1; // 1 signature
      signedTx.set(sig, 1);
      signedTx.set(msg, 65);

      const b64 = uint8ToBase64(signedTx);
      const sendResult = await rpcCall(rpcUrl, "sendTransaction", [b64, { encoding: "base64", skipPreflight: true }]);
      sigs.push(`${pool.label}:${sendResult || "sent_no_sig"}`);
    } catch (err: any) {
      sigs.push(`${pool.label}:error:${err.message?.slice(0, 60)}`);
    }
  }
  return sigs.length > 0 ? sigs : ["no_pools"];
}

// ── Helpers ────────────────────────────────────────────────────────

type IxKey = { pk: Uint8Array; s: boolean; w: boolean };

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function compact(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x4000) return [n & 0x7f | 0x80, n >> 7];
  return [n & 0x7f | 0x80, (n >> 7) & 0x7f | 0x80, n >> 14];
}

function buildMessage(blockhash: Uint8Array, feePayer: Uint8Array, programId: Uint8Array, ixKeys: IxKey[], ixData: Uint8Array): Uint8Array {
  const seen = new Map<string, { pk: Uint8Array; s: boolean; w: boolean }>();
  const fpStr = bs58.encode(feePayer);
  seen.set(fpStr, { pk: feePayer, s: true, w: true });

  for (const k of ixKeys) {
    const str = bs58.encode(k.pk);
    const ex = seen.get(str);
    if (ex) { ex.s = ex.s || k.s; ex.w = ex.w || k.w; }
    else seen.set(str, { ...k });
  }
  const pidStr = bs58.encode(programId);
  if (!seen.has(pidStr)) seen.set(pidStr, { pk: programId, s: false, w: false });

  const accts = [...seen.values()].sort((a, b) => {
    if (a.s !== b.s) return a.s ? -1 : 1;
    return a.w !== b.w ? (a.w ? -1 : 1) : 0;
  });
  const fpIdx = accts.findIndex(a => bs58.encode(a.pk) === fpStr);
  if (fpIdx > 0) { const [fp] = accts.splice(fpIdx, 1); accts.unshift(fp); }

  const idx = new Map<string, number>();
  accts.forEach((a, i) => idx.set(bs58.encode(a.pk), i));

  const numSig = accts.filter(a => a.s).length;
  const numROSig = accts.filter(a => a.s && !a.w).length;
  const numRONonSig = accts.filter(a => !a.s && !a.w).length;

  const keys = new Uint8Array(accts.length * 32);
  accts.forEach((a, i) => keys.set(a.pk, i * 32));

  const ix = [
    idx.get(pidStr)!,
    ...compact(ixKeys.length),
    ...ixKeys.map(k => idx.get(bs58.encode(k.pk))!),
    ...compact(ixData.length),
    ...ixData,
  ];

  return new Uint8Array([
    numSig, numROSig, numRONonSig,
    ...compact(accts.length),
    ...keys,
    ...blockhash,
    ...compact(1),
    ...new Uint8Array(ix),
  ]);
}

export { kyc };
