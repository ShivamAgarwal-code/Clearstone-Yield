/**
 * KYC routes for Cloudflare Workers — submit, check status, approve.
 * On-chain whitelisting builds raw Solana txns signed with admin key.
 */
import { Hono } from "hono";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
// Set sha512 for noble/ed25519 using WebCrypto (available in CF Workers)
ed.hashes.sha512Async = async (msg) => new Uint8Array(await crypto.subtle.digest("SHA-512", msg));
const kyc = new Hono();
async function getRecord(kv, wallet) {
    const raw = await kv.get(`kyc:${wallet}`);
    return raw ? JSON.parse(raw) : null;
}
async function putRecord(kv, record) {
    await kv.put(`kyc:${record.walletAddress}`, JSON.stringify(record), { expirationTtl: 86400 * 30 });
}
// POST /kyc/submit
kyc.post("/submit", async (c) => {
    const body = await c.req.json();
    const { walletAddress, entityType, name, email } = body;
    if (!walletAddress || walletAddress.length < 32)
        return c.json({ success: false, error: "Invalid wallet address" }, 400);
    const existing = await getRecord(c.env.WHITELIST_CACHE, walletAddress);
    if (existing)
        return c.json({ success: true, data: existing, message: "Already submitted" });
    const record = {
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
    if (!record)
        return c.json({ success: false, error: `No KYC record for ${wallet}` }, 404);
    return c.json({ success: true, data: record });
});
// POST /kyc/approve
kyc.post("/approve", async (c) => {
    const { walletAddress } = await c.req.json();
    if (!walletAddress)
        return c.json({ success: false, error: "walletAddress required" }, 400);
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
            }
            catch { }
        }
        return c.json({ success: true, data: record, message: "Already approved" });
    }
    await new Promise((r) => setTimeout(r, 500));
    let txSignatures = [];
    const adminKey = c.env.ADMIN_KEYPAIR_JSON;
    if (adminKey) {
        try {
            txSignatures = await whitelistOnChain(c.env.SOLANA_RPC_URL, adminKey, walletAddress);
        }
        catch (err) {
            txSignatures = [`error: ${err.message?.slice(0, 80)}`];
        }
    }
    else {
        txSignatures = ["no_admin_key_configured"];
    }
    record.status = "approved";
    record.approvedAt = new Date().toISOString();
    record.txSignatures = txSignatures;
    await putRecord(c.env.WHITELIST_CACHE, record);
    return c.json({ success: true, data: record });
});
// ── On-chain whitelisting ──────────────────────────────────────────
const GOVERNOR = bs58.decode("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT_PID = bs58.decode("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const SYSTEM_PROGRAM = new Uint8Array(32);
// sha256("global:add_participant_via_pool")[0..8]
const ADD_VIA_POOL_DISC = new Uint8Array([200, 11, 127, 111, 117, 242, 194, 36]);
const POOLS = [
    { poolPda: "5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj", dmConfig: "JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD" }, // eUSX
    { poolPda: "DC3Cnrz84qS9p2PtBhAkgbsAnJXG2amgbsaxpAE4NT8u", dmConfig: "GjKooeks153zrhHSyxjnigWukHANbg2ydKZ8qMrY9SAg" }, // USX
    { poolPda: "7LyKDm9fq49ExBVWYEnjpxh13Z7jD8MJZXztY8uCrFY2", dmConfig: "9mFCzbnAUSM5fUgCbkvbSoKiXizpRePhWcCQr7RpyQMo" }, // tUSDY
];
/** Derive PDA: seeds=[b"whitelist", dmConfig, wallet], program=DELTA_MINT */
async function deriveWhitelistPda(dmConfig, wallet) {
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
        }
        catch {
            return bs58.encode(hash);
        }
    }
    throw new Error("PDA not found");
}
async function rpcCall(rpcUrl, method, params) {
    const url = rpcUrl || "https://api.devnet.solana.com";
    const resp = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await resp.json();
    if (json.error)
        throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
}
async function whitelistOnChain(rpcUrl, adminKeypairJson, walletAddress) {
    const adminBytes = new Uint8Array(JSON.parse(adminKeypairJson));
    const adminPriv = adminBytes.slice(0, 32);
    const adminPub = adminBytes.slice(32, 64);
    const sigs = [];
    for (const pool of POOLS) {
        try {
            const wlPdaStr = await deriveWhitelistPda(pool.dmConfig, walletAddress);
            // Skip if already whitelisted
            const acctInfo = await rpcCall(rpcUrl, "getAccountInfo", [wlPdaStr, { encoding: "base64" }]);
            if (acctInfo?.value) {
                sigs.push(`already:${pool.dmConfig.slice(0, 8)}`);
                continue;
            }
            const poolPda = bs58.decode(pool.poolPda);
            const dmConfig = bs58.decode(pool.dmConfig);
            const wallet = bs58.decode(walletAddress);
            const wlPda = bs58.decode(wlPdaStr);
            // Instruction accounts
            const ixKeys = [
                { pk: adminPub, s: true, w: true },
                { pk: poolPda, s: false, w: true },
                { pk: GOVERNOR, s: false, w: false }, // admin_entry = None
                { pk: dmConfig, s: false, w: true },
                { pk: wallet, s: false, w: false },
                { pk: wlPda, s: false, w: true },
                { pk: DELTA_MINT_PID, s: false, w: false },
                { pk: SYSTEM_PROGRAM, s: false, w: false },
            ];
            const ixData = new Uint8Array([...ADD_VIA_POOL_DISC, 0]); // role=Holder
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
            sigs.push(sendResult || "sent_no_sig");
        }
        catch (err) {
            sigs.push(`error:${err.message?.slice(0, 60)}`);
        }
    }
    return sigs.length > 0 ? sigs : ["no_pools"];
}
function uint8ToBase64(bytes) {
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoa(bin);
}
function compact(n) {
    if (n < 0x80)
        return [n];
    if (n < 0x4000)
        return [n & 0x7f | 0x80, n >> 7];
    return [n & 0x7f | 0x80, (n >> 7) & 0x7f | 0x80, n >> 14];
}
function buildMessage(blockhash, feePayer, programId, ixKeys, ixData) {
    const seen = new Map();
    const fpStr = bs58.encode(feePayer);
    seen.set(fpStr, { pk: feePayer, s: true, w: true });
    for (const k of ixKeys) {
        const str = bs58.encode(k.pk);
        const ex = seen.get(str);
        if (ex) {
            ex.s = ex.s || k.s;
            ex.w = ex.w || k.w;
        }
        else
            seen.set(str, { ...k });
    }
    const pidStr = bs58.encode(programId);
    if (!seen.has(pidStr))
        seen.set(pidStr, { pk: programId, s: false, w: false });
    const accts = [...seen.values()].sort((a, b) => {
        if (a.s !== b.s)
            return a.s ? -1 : 1;
        return a.w !== b.w ? (a.w ? -1 : 1) : 0;
    });
    const fpIdx = accts.findIndex(a => bs58.encode(a.pk) === fpStr);
    if (fpIdx > 0) {
        const [fp] = accts.splice(fpIdx, 1);
        accts.unshift(fp);
    }
    const idx = new Map();
    accts.forEach((a, i) => idx.set(bs58.encode(a.pk), i));
    const numSig = accts.filter(a => a.s).length;
    const numROSig = accts.filter(a => a.s && !a.w).length;
    const numRONonSig = accts.filter(a => !a.s && !a.w).length;
    const keys = new Uint8Array(accts.length * 32);
    accts.forEach((a, i) => keys.set(a.pk, i * 32));
    const ix = [
        idx.get(pidStr),
        ...compact(ixKeys.length),
        ...ixKeys.map(k => idx.get(bs58.encode(k.pk))),
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
//# sourceMappingURL=kyc.js.map