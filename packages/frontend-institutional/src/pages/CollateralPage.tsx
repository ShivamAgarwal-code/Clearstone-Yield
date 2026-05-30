import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { getObligationPda, findObligationReserves, OB_ID } from "../lib/obligation";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  KeyValue,
  PageHeader,
  Snackbar,
  Tabs,
} from "@clearstone/design-system";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");

// Governor / delta-mint for the ceUSX wrap path. These are the *v1*
// programs deliberately — EUSX_POOL and EUSX_DM_CONFIG below are
// v1-owned (the ceUSX pool was carried forward from v1 and never
// re-issued under v3). The csSOL pool used elsewhere is v3-native and
// goes through `DEVNET_CONFIG.programs.governor` separately. Do NOT
// "fix" these to v3 — the wrap will fail with ConstraintSeeds because
// the v3 governor doesn't own the ceUSX pool/dm-config PDAs.
const GOVERNOR_V1 = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT_V1 = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const EUSX_POOL = new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");
const EUSX_DM_CONFIG = new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD");
const EUSX_MINT = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const DEUSX_MINT = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

// Precomputed Anchor discriminators (sha256("global:<name>")[0..8])
const DISC = {
  init_user_metadata: Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]),
  init_obligation: Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]),
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refresh_obligation: Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]),
  deposit_reserve_liquidity_and_obligation_collateral: Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]),
  wrap: Buffer.from([178, 40, 10, 189, 228, 129, 186, 140]),
};

interface CollateralAsset {
  name: string;
  symbol: string;
  mint: PublicKey;
  reserve: PublicKey;
  oracle: PublicKey;
  tokenProgram: PublicKey;
  price: number;
  yieldApy?: string;
  borrowRate: string;
  ltvPct: number;
  liqThreshPct: number;
}

const COLLATERAL_ASSETS: CollateralAsset[] = [
  {
    name: "ceUSX (yield-bearing eUSX)",
    symbol: "ceUSX",
    mint: DEUSX_MINT,
    reserve: new PublicKey("88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU"),
    oracle: new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    price: 1.08,
    yieldApy: "~10% APY",
    borrowRate: "~5% APY",
    ltvPct: 75,
    liqThreshPct: 85,
  },
  {
    name: "csSOL (Jito-staked, KYC-wrapped)",
    symbol: "csSOL",
    mint: new PublicKey("6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt"),
    reserve: new PublicKey("eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w"),
    oracle: new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    price: 84,
    yieldApy: "Jito-restaking",
    borrowRate: "~4% APY",
    ltvPct: 90,
    liqThreshPct: 92,
  },
];

export default function CollateralPage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [selected, setSelected] = useState(0);
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [obligationAddr, setObligationAddr] = useState<string | null>(null);

  const asset = COLLATERAL_ASSETS[selected];
  const balance = balances[asset.symbol] || 0;

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  useEffect(() => {
    if (!publicKey) return;
    async function load() {
      const bals: Record<string, number> = {};
      for (const a of COLLATERAL_ASSETS) {
        try {
          const ata = getAssociatedTokenAddressSync(a.mint, publicKey!, false, a.tokenProgram);
          const info = await connection.getAccountInfo(ata);
          bals[a.symbol] = info ? Number(info.data.readBigUInt64LE(64)) / 1e6 : 0;
        } catch { bals[a.symbol] = 0; }
      }
      setBalances(bals);
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([0]), Buffer.from([OB_ID]), publicKey!.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
      const obInfo = await connection.getAccountInfo(obPda);
      if (obInfo) setObligationAddr(obPda.toBase58());
    }
    load();
  }, [publicKey, connection]);

  async function handleDeposit() {
    if (!publicKey || !amount) return;
    setLoading(true);
    setStatus({ msg: "Building deposit transaction...", type: "info" });
    try {
      const amountLamports = BigInt(Math.floor(parseFloat(amount) * 1e6));

      let freshBal = 0;
      try {
        const checkAta = getAssociatedTokenAddressSync(
          asset.symbol === "eUSX" ? DEUSX_MINT : asset.mint,
          publicKey, false,
          asset.symbol === "eUSX" ? TOKEN_2022_PROGRAM_ID : asset.tokenProgram
        );
        const checkInfo = await connection.getAccountInfo(checkAta);
        freshBal = checkInfo ? Number(checkInfo.data.readBigUInt64LE(64)) / 1e6 : 0;
      } catch {}

      if (parseFloat(amount) > freshBal) {
        setStatus({ msg: `Insufficient ${asset.symbol} balance. On-chain: ${freshBal.toFixed(2)}, requested: ${amount}. Go to Prepare Collateral to get more.`, type: "error" });
        setLoading(false);
        const bals: Record<string, number> = {};
        for (const a of COLLATERAL_ASSETS) {
          try {
            const ata = getAssociatedTokenAddressSync(a.mint, publicKey, false, a.tokenProgram);
            const info = await connection.getAccountInfo(ata);
            bals[a.symbol] = info ? Number(info.data.readBigUInt64LE(64)) / 1e6 : 0;
          } catch { bals[a.symbol] = 0; }
        }
        setBalances(bals);
        return;
      }
      const tx = new Transaction();
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([0]), Buffer.from([OB_ID]), publicKey.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
      const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);

      const obExistsOnChain = (await connection.getAccountInfo(obPda)) !== null;
      if (!obExistsOnChain) {
        const umInfo = await connection.getAccountInfo(userMeta);
        if (!umInfo) {
          tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_user_metadata, Buffer.alloc(32)]), keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: userMeta, isSigner: false, isWritable: true },
            { pubkey: KLEND, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]});
        }
        tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_obligation, Buffer.from([0, OB_ID])]), keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false }, { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: PublicKey.default, isSigner: false, isWritable: false }, { pubkey: PublicKey.default, isSigner: false, isWritable: false },
          { pubkey: userMeta, isSigner: false, isWritable: true }, { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]});
      }

      if (asset.symbol === "eUSX") {
        const [dmAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), DEUSX_MINT.toBuffer()], DELTA_MINT_V1);
        const [whitelistEntry] = PublicKey.findProgramAddressSync([Buffer.from("whitelist"), EUSX_DM_CONFIG.toBuffer(), publicKey.toBuffer()], DELTA_MINT_V1);
        const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT, publicKey, false, TOKEN_PROGRAM_ID);
        const vaultAta = getAssociatedTokenAddressSync(EUSX_MINT, EUSX_POOL, true, TOKEN_PROGRAM_ID);
        const userDeusxAta = getAssociatedTokenAddressSync(DEUSX_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);

        const deusxAtaInfo = await connection.getAccountInfo(userDeusxAta);
        if (!deusxAtaInfo) {
          tx.add(createAssociatedTokenAccountInstruction(publicKey, userDeusxAta, publicKey, DEUSX_MINT, TOKEN_2022_PROGRAM_ID));
        }

        const wrapAmtBuf = Buffer.alloc(8);
        wrapAmtBuf.writeBigUInt64LE(amountLamports, 0);
        tx.add({
          programId: GOVERNOR_V1,
          data: Buffer.concat([DISC.wrap, wrapAmtBuf]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: EUSX_POOL, isSigner: false, isWritable: true },
            { pubkey: EUSX_MINT, isSigner: false, isWritable: false },
            { pubkey: userEusxAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: EUSX_DM_CONFIG, isSigner: false, isWritable: false },
            { pubkey: DEUSX_MINT, isSigner: false, isWritable: true },
            { pubkey: dmAuthority, isSigner: false, isWritable: false },
            { pubkey: whitelistEntry, isSigner: false, isWritable: false },
            { pubkey: userDeusxAta, isSigner: false, isWritable: true },
            { pubkey: DELTA_MINT_V1, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
        });
      }

      const depositMint = asset.symbol === "eUSX" ? DEUSX_MINT : asset.mint;
      const depositTokenProgram = asset.symbol === "eUSX" ? TOKEN_2022_PROGRAM_ID : asset.tokenProgram;

      const RESERVE_ORACLES: Record<string, PublicKey> = {
        "eCrKcmHytENDieb3Ff5YLY7ATsmduXB4EDT4u6dPX9w": new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
        "94UQxxQfEVPCCpQsh9uyakHsPX9QqPoCBZnjHz4RU4iw": new PublicKey("3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P"),
        "CaPUL8sijx9Qw32Ao2PMdotEKqQLMneA5ZvRnvsa6VF8": new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
        "88XHsosaqq3bV9MW3gLtn3RozHuVKnvRcSbEq8fPcmXU": new PublicKey("3L8kkp8G6gxBmr7wdYJxvofEWxtUtUUAGJSokSLwzmyW"),
        "78kkPNAjS7pq9yk59spMGKYcFLAA3m2xHvNBokk8BFy9": new PublicKey("ETLQGfwHVfCYSqEG51ckf6h581e3k5CyoMnfz2WW45eD"),
      };
      const obData = await connection.getAccountInfo(obPda);
      const obligationReserves = obData ? findObligationReserves(Buffer.from(obData.data)) : [];
      const depositReserveAddr = asset.reserve.toBase58();
      const otherReserves = obligationReserves
        .map(r => r.toBase58())
        .filter(r => r !== depositReserveAddr);
      const refreshOrder = [...new Set(otherReserves), depositReserveAddr];
      for (const reserveAddr of refreshOrder) {
        const oracle = RESERVE_ORACLES[reserveAddr] || asset.oracle;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: new PublicKey(reserveAddr), isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...obligationReserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});

      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), asset.reserve.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), asset.reserve.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), asset.reserve.toBuffer()], KLEND);
      const userAta = getAssociatedTokenAddressSync(depositMint, publicKey, false, depositTokenProgram);
      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amountLamports, 0);

      tx.add({ programId: KLEND, data: Buffer.concat([DISC.deposit_reserve_liquidity_and_obligation_collateral, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: asset.reserve, isSigner: false, isWritable: true }, { pubkey: depositMint, isSigner: false, isWritable: false },
        { pubkey: liqSupply, isSigner: false, isWritable: true }, { pubkey: collMint, isSigner: false, isWritable: true },
        { pubkey: collSupply, isSigner: false, isWritable: true }, { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: depositTokenProgram, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;

      setStatus({ msg: "Sign deposit in wallet...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: "Deposited " + amount + " " + asset.symbol + " as collateral (tx: " + sig.slice(0, 16) + "...)", type: "success" });
      setObligationAddr(obPda.toBase58());
      setAmount("");
    } catch (e: any) {
      setStatus({ msg: "Failed: " + (e.message?.slice(0, 120) || "Unknown"), type: "error" });
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-8 pb-12">
      <PageHeader
        eyebrow="Lending"
        title="Supply Collateral"
        subtitle="Deposit KYC-wrapped tokens as collateral to borrow Solstice USDC."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card tone="elevated" size="lg">
          <CardHeader title="Deposit collateral" eyebrow="Action" />

          {/* Asset selector — segmented Tabs give a clear active state. */}
          <Tabs.Root
            variant="segmented"
            value={String(selected)}
            onValueChange={(v) => setSelected(parseInt(v))}
          >
            <Tabs.List className="w-full">
              {COLLATERAL_ASSETS.map((a, i) => (
                <Tabs.Trigger
                  key={a.symbol}
                  value={String(i)}
                  badge={a.yieldApy ? <Badge tone="warning" variant="soft" size="xs">yield</Badge> : undefined}
                >
                  {a.symbol}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs.Root>

          <div className="mt-5 space-y-4">
            <Card tone="muted" size="sm">
              <KeyValue
                label={`${asset.symbol} balance`}
                value={`${balance.toFixed(2)} ${asset.symbol}`}
              />
            </Card>

            <Input
              inputSize="md"
              placeholder="0.00"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              addonRight={
                <>
                  {asset.symbol}
                  <Button variant="link" size="xs" className="!font-bold !tracking-wider uppercase" onClick={() => setAmount(balance.toString())}>MAX</Button>
                </>
              }
              helperText={
                amount && parseFloat(amount) > balance
                  ? `Exceeds wallet balance (${balance.toFixed(2)}).`
                  : undefined
              }
              invalid={!!amount && parseFloat(amount) > balance}
            />

            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={loading}
              disabled={!amount || parseFloat(amount) <= 0 || parseFloat(amount) > balance}
              onClick={handleDeposit}
            >
              Deposit {asset.symbol}
            </Button>
          </div>
        </Card>

        <Card tone="elevated" size="lg">
          <CardHeader
            title={`${asset.symbol} details`}
            eyebrow="Reserve config"
            actions={asset.yieldApy && <Badge tone="success" variant="soft" size="md">{asset.yieldApy}</Badge>}
          />
          <div className="space-y-1">
            <KeyValue label="Asset" value={<span className="font-mono">{asset.name}</span>} />
            <KeyValue label="Oracle price" value={<span className="text-success">${asset.price.toFixed(2)}</span>} />
            <KeyValue label="LTV" value={`${asset.ltvPct}%`} />
            <KeyValue label="Liquidation threshold" value={`${asset.liqThreshPct}%`} />
            {asset.yieldApy && (
              <KeyValue label="Yield on collateral" value={<span className="text-success">{asset.yieldApy}</span>} />
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-base-300/70">
            <KeyValue label="Borrow asset" value="Solstice USDC" />
            <KeyValue label="Borrow rate" value={<span className="text-warning">{asset.borrowRate}</span>} />
            {asset.yieldApy && (
              <KeyValue
                label={<span className="text-success font-semibold">Net carry trade</span>}
                value={<span className="text-success font-semibold">~+5% APY</span>}
              />
            )}
          </div>

          <div className="mt-5 pt-5 border-t border-base-300/70">
            <KeyValue
              compact
              label="Obligation"
              value={
                obligationAddr
                  ? <span className="font-mono text-xs">{obligationAddr.slice(0, 16)}…</span>
                  : <span className="text-base-content/45">Not created yet</span>
              }
            />
          </div>
        </Card>
      </div>

      {/* Toast */}
      {status && (
        <Snackbar
          variant="toast"
          type={status.type === "success" ? "success" : status.type === "error" ? "error" : "info"}
          message={status.msg}
          dismissAfterMs={status.type === "success" ? 6000 : undefined}
          onDismiss={() => setStatus(null)}
        />
      )}
    </div>
  );
}
