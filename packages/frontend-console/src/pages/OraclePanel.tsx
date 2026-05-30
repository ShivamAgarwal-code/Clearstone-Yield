import { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { usePrograms } from "../hooks/usePrograms";
import { Program, BN } from "@coral-xyz/anchor";
import { Button, Input } from "@clearstone/design-system";


const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");
const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");
const PRICE_UPDATE_V2_SIZE = 133;

function buildPriceUpdateV2(
  authority: PublicKey,
  price: number,
  expo: number,
  slot: number,
  timestamp: number
): Buffer {
  const buf = Buffer.alloc(PRICE_UPDATE_V2_SIZE);
  let off = 0;
  PRICE_UPDATE_V2_DISC.copy(buf, off); off += 8;
  authority.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(1, off); off += 1; // Full verification
  Buffer.from("TradeDesk Oracle Feed").copy(buf, off); off += 32;
  buf.writeBigInt64LE(BigInt(Math.round(price * Math.pow(10, Math.abs(expo)))), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeInt32LE(expo, off); off += 4;
  buf.writeBigInt64LE(BigInt(timestamp), off); off += 8;
  buf.writeBigInt64LE(BigInt(timestamp - 1), off); off += 8;
  buf.writeBigInt64LE(BigInt(Math.round(price * Math.pow(10, Math.abs(expo)))), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeBigUInt64LE(BigInt(slot), off);
  return buf;
}

interface FeedInfo {
  address: string;
  label: string;
  price: string;
  lastUpdate: string;
}

export default function OraclePanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { config, ready } = usePrograms();

  const [feeds, setFeeds] = useState<FeedInfo[]>([]);
  const [newLabel, setNewLabel] = useState("USDY/USD");
  const [newPrice, setNewPrice] = useState("1.08");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [updateAddr, setUpdateAddr] = useState("");
  const [updatePrice, setUpdatePrice] = useState("");

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 8000);
  };

  // Load feeds from config tokens + oracles
  useEffect(() => {
    if (!ready) return;

    const loadFeeds = async () => {
      const results: FeedInfo[] = [];

      // Load wrapped token oracles
      for (const token of config.tokens || []) {
        try {
          const info = await connection.getAccountInfo(token.oracle);
          if (!info) continue;
          const d = info.data;
          // PriceUpdateV2: disc(8) + authority(32) + verification(1) + feed_id(32) + price(8) + conf(8) + expo(4) + ts(8)
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const ts = d.readBigInt64LE(93);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: token.oracle.toBase58(),
            label: `d${token.symbol}/USD`,
            price: "$" + usd.toFixed(usd >= 100 ? 2 : 4),
            lastUpdate: new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        } catch {}
      }

      // Load wSOL Pyth feed (also re-used by the cSOL reserve since
      // cSOL is a 1:1 KYC wrapper around wSOL — same price source).
      try {
        const info = await connection.getAccountInfo(config.oracles.wsolOracle);
        if (info) {
          const d = info.data;
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: config.oracles.wsolOracle.toBase58(),
            label: "wSOL/USD (Pyth)",
            price: "$" + usd.toFixed(4),
            lastUpdate: new Date(Number(d.readBigInt64LE(93)) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        }
      } catch {}

      // Load csSOL oracle (keeper-cloud accrual output).
      try {
        const info = await connection.getAccountInfo(config.oracles.csSolOracle);
        if (info) {
          const d = info.data;
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: config.oracles.csSolOracle.toBase58(),
            label: "csSOL/USD (accrual)",
            price: "$" + usd.toFixed(4),
            lastUpdate: new Date(Number(d.readBigInt64LE(93)) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        }
      } catch {}

      // Load sUSDC oracle — the actual USDC price feed for the v3
      // sUSDC reserve (retail USDC supply target post-2026-05-06).
      try {
        const info = await connection.getAccountInfo(config.oracles.sUsdcOracle);
        if (info) {
          const d = info.data;
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: config.oracles.sUsdcOracle.toBase58(),
            label: "sUSDC/USD (Pyth)",
            price: "$" + usd.toFixed(4),
            lastUpdate: new Date(Number(d.readBigInt64LE(93)) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        }
      } catch {}

      setFeeds(results);
    };

    loadFeeds();
  }, [ready, connection, config]);

  // Create a new PriceUpdateV2 oracle
  const handleCreateOracle = useCallback(async () => {
    if (!publicKey || !newLabel || !newPrice) return;
    setLoading(true);
    showStatus("Creating PriceUpdateV2 oracle...");

    try {
      const price = parseFloat(newPrice);
      const oracleKp = Keypair.generate();
      const slot = await connection.getSlot();
      const ts = Math.floor(Date.now() / 1000);

      // Step 1: Create account owned by mock-oracle program
      const rent = await connection.getMinimumBalanceForRentExemption(PRICE_UPDATE_V2_SIZE);
      const createIx = SystemProgram.createAccount({
        fromPubkey: publicKey,
        newAccountPubkey: oracleKp.publicKey,
        lamports: rent,
        space: PRICE_UPDATE_V2_SIZE,
        programId: MOCK_ORACLE,
      });

      // Step 2: Write PriceUpdateV2 data via writeRaw
      const data = buildPriceUpdateV2(publicKey, price, -8, slot, ts);
      const writeRawDisc = Buffer.from(
        [65, 49, 227, 253, 55, 157, 222, 246]
      );
      // Borsh encode: offset(u32) + data(vec<u8> = len(u32) + bytes)
      const writeArgs = Buffer.alloc(4 + 4 + data.length);
      writeArgs.writeUInt32LE(0, 0); // offset
      writeArgs.writeUInt32LE(data.length, 4); // vec length
      data.copy(writeArgs, 8);

      const writeIx = new TransactionInstruction({
        programId: MOCK_ORACLE,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: oracleKp.publicKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([writeRawDisc, writeArgs]),
      });

      const tx = new Transaction().add(createIx, writeIx);
      const sig = await sendTransaction(tx, connection, { signers: [oracleKp] });
      await connection.confirmTransaction(sig, "confirmed");

      showStatus(`Oracle created: ${oracleKp.publicKey.toBase58()}`, "ok");

      // Add to feeds list
      setFeeds((prev) => [
        ...prev,
        {
          address: oracleKp.publicKey.toBase58(),
          label: `${newLabel} (PriceUpdateV2)`,
          price: "$" + price.toFixed(4),
          lastUpdate: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      ]);
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 80)}`, "err");
    }
    setLoading(false);
  }, [publicKey, connection, sendTransaction, newLabel, newPrice]);

  // Update price on an existing PriceUpdateV2 oracle
  const handleUpdatePrice = useCallback(async () => {
    if (!publicKey || !updateAddr || !updatePrice) return;
    setLoading(true);
    showStatus("Updating oracle price...");

    try {
      const price = parseFloat(updatePrice);
      const oraclePk = new PublicKey(updateAddr);
      const slot = await connection.getSlot();
      const ts = Math.floor(Date.now() / 1000);
      const data = buildPriceUpdateV2(publicKey, price, -8, slot, ts);

      const writeRawDisc = Buffer.from(
        [65, 49, 227, 253, 55, 157, 222, 246]
      );
      const writeArgs = Buffer.alloc(4 + 4 + data.length);
      writeArgs.writeUInt32LE(0, 0);
      writeArgs.writeUInt32LE(data.length, 4);
      data.copy(writeArgs, 8);

      const ix = new TransactionInstruction({
        programId: MOCK_ORACLE,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: oraclePk, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([writeRawDisc, writeArgs]),
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Price updated to $${price.toFixed(4)}`, "ok");

      setFeeds((prev) =>
        prev.map((f) =>
          f.address === updateAddr
            ? { ...f, price: "$" + price.toFixed(4), lastUpdate: new Date().toISOString().replace("T", " ").slice(0, 19) }
            : f
        )
      );
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 80)}`, "err");
    }
    setLoading(false);
  }, [publicKey, connection, sendTransaction, updateAddr, updatePrice]);

  if (!connected)
    return <p className="opacity-50">Connect wallet to manage oracles.</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="eyebrow">Operator</span>
        <h2 className="text-2xl mt-1">Oracles</h2>
        <p className="text-sm text-base-content/55 mt-1">
          Create and manage PriceUpdateV2 oracles for klend. Owned by the TradeDesk program and
          accepted by klend's Pyth parser.
        </p>
      </div>

      {status && (
        <div className={`alert text-sm break-all ${status.type === "err" ? "alert-error" : status.type === "ok" ? "alert-success" : "alert-info"}`}>
          {status.msg}
        </div>
      )}

      {/* Existing Feeds */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <h3 className="text-base">Active Feeds</h3>
          {feeds.length === 0 ? (
            <p className="opacity-40">No feeds found. Create one below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Last Update</th>
                    <th className="text-right">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {feeds.map((f) => (
                    <tr key={f.address}>
                      <td className="font-semibold">{f.label}</td>
                      <td className="text-right font-mono">{f.price}</td>
                      <td className="text-right opacity-50">{f.lastUpdate}</td>
                      <td
                        className="text-right font-mono text-xs opacity-40 cursor-pointer"
                        title={f.address}
                        onClick={() => { setUpdateAddr(f.address); setUpdatePrice(f.price.replace("$", "")); }}
                      >
                        {f.address.slice(0, 8)}...
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Create New Oracle */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <h3 className="text-base">Create PriceUpdateV2 Oracle</h3>
          <div className="flex gap-3 mb-2 items-start">
            <Input
              placeholder="Label (e.g. USDY/USD)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              wrapperClassName="flex-1 min-w-[200px]"
            />
            <Input
              inputMode="decimal" pattern="[0-9.]*"
              placeholder="Price (e.g. 1.08)"
              value={newPrice}
              onChange={(e) => setNewPrice(e.target.value)}
              numeric
              wrapperClassName="w-32"
            />
            <Button
              variant="primary"
              onClick={handleCreateOracle}
              disabled={loading || !newLabel || !newPrice}
              loading={loading}
            >
              Create
            </Button>
          </div>
          <p className="text-xs opacity-40">
            Creates a Pyth-compatible PriceUpdateV2 account (133 bytes). Accepted by klend without owner validation.
          </p>
        </div>
      </div>

      {/* Update Price */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <h3 className="text-base">Update Oracle Price</h3>
          <div className="flex gap-3 mb-2 items-start">
            <Input
              placeholder="Oracle address"
              value={updateAddr}
              onChange={(e) => setUpdateAddr(e.target.value)}
              numeric
              className="font-mono"
              wrapperClassName="flex-1 min-w-[200px]"
            />
            <Input
              inputMode="decimal" pattern="[0-9.]*"
              placeholder="New price"
              value={updatePrice}
              onChange={(e) => setUpdatePrice(e.target.value)}
              numeric
              wrapperClassName="w-32"
            />
            <Button
              variant="primary"
              onClick={handleUpdatePrice}
              disabled={loading || !updateAddr || !updatePrice}
              loading={loading}
            >
              Update
            </Button>
          </div>
          <p className="text-xs opacity-40">
            Click a feed address above to auto-fill. Updates the PriceUpdateV2 data with current timestamp and slot.
          </p>
        </div>
      </div>

      {/* Info */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <h3 className="text-sm font-semibold mb-2">How it works</h3>
          <ul className="list-disc pl-5 text-xs opacity-50 leading-relaxed">
            <li>Oracles are PriceUpdateV2 accounts (Pyth Receiver format) owned by the TradeDesk program</li>
            <li>klend only checks the 8-byte discriminator (<code>22f12363...</code>), not the account owner</li>
            <li>Price, confidence, exponent, and timestamps are written in the standard Pyth layout</li>
            <li>Set <code>maxAgePriceSeconds = u64::MAX</code> on the reserve for static oracles</li>
            <li>Oracles can be updated by the wallet that created them via <code>writeRaw</code></li>
          </ul>
        </div>
      </div>
    </div>
  );
}
