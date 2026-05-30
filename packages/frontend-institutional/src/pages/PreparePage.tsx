import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { DEVNET_CONFIG } from "../config/devnet";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Eyebrow,
  FieldGroupHeading,
  FormLabel,
  Input,
  KeyValue,
  PageHeader,
  Snackbar,
  Stat,
  Tabs,
  TokenAmountInput,
  TokenIcon,
  tokenBrandColor,
  TokenSymbol,
} from "@clearstone/design-system";

// Solstice tokens
const SOLSTICE_USDC = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const SOLSTICE_USDT = new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft");
const USX = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const EUSX = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const DEUSX = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

// Programs — these are the *v1* governor + delta-mint, deliberately.
// The ceUSX wrap path lives on v1 (EUSX_POOL + EUSX_DM_CONFIG below
// are owned by v1) because the ceUSX pool was carried forward from the
// v1 deploy and never re-issued under v3. The csSOL path elsewhere on
// this page wraps via `DEVNET_CONFIG.programs.governor` (v3) since
// that pool *is* v3-native. Do NOT "fix" these to v3 — the wrap will
// fail with ConstraintSeeds because the v3 governor does not own the
// ceUSX pool/dm-config PDAs.
const GOVERNOR_V1 = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT_V1 = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

// eUSX pool
const EUSX_POOL = new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");
const EUSX_DM_CONFIG = new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD");

// Solstice API — three candidates, tried in order until one returns 2xx:
//   1. backend-edge Worker `/solstice`            — production
//   2. Vite dev proxy `/api/solstice`             — local dev
//   3. https://instructions.solstice.finance/...  — last-resort direct
//
// The Solstice origin rejects browser CORS preflights with 401
// (server-side bug — preflights should be auth-free), so the direct
// URL only works server-to-server. Set `VITE_EDGE_URL` in the Pages
// dashboard so the deployed build hits the backend-edge proxy first;
// without it, deploys at `institutional.clearstone.ai` fall straight
// through to the direct URL and the USX-mint click bounces with
// `OPTIONS https://instructions.solstice.finance/v1/instructions →
// 401`. Same wiring as `lib/lib/solsticeApi.ts` (which other panels
// use); kept inline here for the legacy `callSolstice` shape that
// returns a `Transaction` rather than `TransactionInstruction[]`.
const EDGE_URL = (import.meta.env.VITE_EDGE_URL as string | undefined) ?? "";
const SOLSTICE_API_EDGE   = EDGE_URL ? `${EDGE_URL.replace(/\/$/, "")}/solstice` : null;
const SOLSTICE_API_PROXY  = "/api/solstice";
const SOLSTICE_API_DIRECT = "https://instructions.solstice.finance/v1/instructions";

type Step = "idle" | "minting_usx" | "locking_eusx" | "wrapping_deusx" | "done";

async function callSolstice(
  apiKey: string,
  body: object,
  connection: import("@solana/web3.js").Connection,
  publicKey: PublicKey,
): Promise<Transaction> {
  let resp: Response | null = null;
  let lastError = "";

  const candidates = [SOLSTICE_API_EDGE, SOLSTICE_API_PROXY, SOLSTICE_API_DIRECT].filter(
    (u): u is string => !!u,
  );
  for (const url of candidates) {
    const label = url === SOLSTICE_API_EDGE ? "edge"
      : url.startsWith("/") ? "proxy" : "direct";
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (resp.ok) break;
      const errBody = await resp.text();
      lastError = `${label} HTTP ${resp.status}: ${errBody.slice(0, 150)}`;
      resp = null;
    } catch (e: any) {
      lastError = `${label}: ${e.message || "Failed to fetch"}`;
      resp = null;
      continue;
    }
  }

  if (!resp || !resp.ok) {
    throw new Error(`Solstice API failed — ${lastError}`);
  }

  const result = await resp.json();

  if (result.transaction) {
    return Transaction.from(Buffer.from(result.transaction, "base64"));
  }

  if (result.instruction) {
    const ix = result.instruction;
    const programId = new PublicKey(Buffer.from(ix.program_id));
    const keys = ix.accounts.map((acc: any) => ({
      pubkey: new PublicKey(Buffer.from(acc.pubkey)),
      isSigner: acc.is_signer,
      isWritable: acc.is_writable,
    }));
    const data = Buffer.from(ix.data);

    const tx = new Transaction();
    tx.add({ programId, keys, data });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = publicKey;

    return tx;
  }

  throw new Error(`Unexpected Solstice API response: ${JSON.stringify(result).slice(0, 150)}`);
}

interface Balances {
  usdc: number;
  usdt: number;
  usx: number;
  eusx: number;
  deusx: number;
  sol: number;
  cssol: number;
}

const fmtUsd = (v: number) =>
  v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PreparePage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [balances, setBalances] = useState<Balances>({ usdc: 0, usdt: 0, usx: 0, eusx: 0, deusx: 0, sol: 0, cssol: 0 });
  const [amount, setAmount] = useState("");
  const [collateral, setCollateral] = useState<"usdc" | "usdt">("usdc");
  const [step, setStep] = useState<Step>("idle");
  const [pipeline, setPipeline] = useState<"stable" | "lst">("stable");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_SOLSTICE_API_KEY || "");

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  const loadBalances = useCallback(async () => {
    if (!publicKey) return;
    const bals: Balances = { usdc: 0, usdt: 0, usx: 0, eusx: 0, deusx: 0, sol: 0, cssol: 0 };

    const tokens: [keyof Balances, PublicKey, PublicKey, number][] = [
      ["usdc",  SOLSTICE_USDC,                 TOKEN_PROGRAM_ID,      6],
      ["usdt",  SOLSTICE_USDT,                 TOKEN_PROGRAM_ID,      6],
      ["usx",   USX,                            TOKEN_PROGRAM_ID,      6],
      ["eusx",  EUSX,                           TOKEN_PROGRAM_ID,      6],
      ["deusx", DEUSX,                          TOKEN_2022_PROGRAM_ID, 6],
      ["cssol", DEVNET_CONFIG.pool.wrappedMint, TOKEN_2022_PROGRAM_ID, 9],
    ];

    for (const [key, mint, prog, decimals] of tokens) {
      try {
        const ata = getAssociatedTokenAddressSync(mint, publicKey, false, prog);
        const info = await connection.getAccountInfo(ata);
        if (info) bals[key] = Number(info.data.readBigUInt64LE(64)) / 10 ** decimals;
      } catch {}
    }
    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      bals.sol = lamports / 1e9;
    } catch {}
    setBalances(bals);
  }, [publicKey, connection]);

  useEffect(() => { loadBalances(); }, [loadBalances]);

  async function handleMintUSX() {
    if (!publicKey || !amount || !apiKey) return;
    setLoading(true);
    setStep("minting_usx");
    setStatus({ msg: `Preparing USX mint from ${collateral.toUpperCase()}...`, type: "info" });

    try {
      const amountLamports = Math.floor(parseFloat(amount) * 1_000_000);
      const [reqTx, confTx] = await Promise.all([
        callSolstice(apiKey, {
          type: "RequestMint",
          data: { amount: amountLamports, collateral, user: publicKey.toBase58() },
        }, connection, publicKey),
        callSolstice(apiKey, {
          type: "ConfirmMint",
          data: { user: publicKey.toBase58(), collateral },
        }, connection, publicKey),
      ]);

      const usxAta = getAssociatedTokenAddressSync(USX, publicKey, false, TOKEN_PROGRAM_ID);
      const usxAtaInfo = await connection.getAccountInfo(usxAta);

      const combinedTx = new Transaction();
      if (!usxAtaInfo) {
        combinedTx.add(createAssociatedTokenAccountInstruction(publicKey, usxAta, publicKey, USX, TOKEN_PROGRAM_ID));
      }
      for (const ix of reqTx.instructions) combinedTx.add(ix);
      for (const ix of confTx.instructions) combinedTx.add(ix);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      combinedTx.recentBlockhash = blockhash;
      combinedTx.lastValidBlockHeight = lastValidBlockHeight;
      combinedTx.feePayer = publicKey;

      setStatus({ msg: "Sign mint transaction in your wallet...", type: "info" });
      const sig = await signAndSend(combinedTx);
      setStatus({ msg: `Minted ${amount} USX from ${collateral.toUpperCase()} (tx: ${sig.slice(0, 16)}...)`, type: "success" });

      await loadBalances();
    } catch (e: any) {
      const detail = e.message || "Unknown error";
      setStatus({ msg: `Mint failed: ${detail.slice(0, 150)}`, type: "error" });
    } finally {
      setLoading(false);
      setStep("idle");
    }
  }

  async function handleLockUSX() {
    if (!publicKey || !apiKey) return;
    setLoading(true);
    setStep("locking_eusx");
    setStatus({ msg: "Locking USX in YieldVault for eUSX...", type: "info" });

    try {
      const lockAmount = balances.usx;
      const lockLamports = Math.floor(lockAmount * 1_000_000);
      const lockIxTx = await callSolstice(apiKey, {
        type: "Lock",
        data: { amount: lockLamports, user: publicKey.toBase58() },
      }, connection, publicKey);

      const eusxAta = getAssociatedTokenAddressSync(EUSX, publicKey, false, TOKEN_PROGRAM_ID);
      const eusxAtaInfo = await connection.getAccountInfo(eusxAta);

      const tx = new Transaction();
      if (!eusxAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, eusxAta, publicKey, EUSX, TOKEN_PROGRAM_ID));
      }
      for (const ix of lockIxTx.instructions) tx.add(ix);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = publicKey;

      setStatus({ msg: "Sign lock transaction in your wallet...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: `Locked ${lockAmount.toFixed(2)} USX → eUSX (tx: ${sig.slice(0, 16)}...)`, type: "success" });
      await loadBalances();
    } catch (e: any) {
      const detail = e.message || "Unknown error";
      setStatus({ msg: `Lock failed: ${detail.slice(0, 150)}`, type: "error" });
    } finally {
      setLoading(false);
      setStep("idle");
    }
  }

  async function handleWrapEUSX() {
    if (!publicKey) return;
    setLoading(true);
    setStep("wrapping_deusx");
    setStatus({ msg: "Wrapping eUSX → ceUSX (KYC-gated)...", type: "info" });

    try {
      const wrapAmount = Math.floor(balances.eusx * 1e6);
      if (wrapAmount <= 0) throw new Error("No eUSX to wrap");

      const [dmAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority"), DEUSX.toBuffer()], DELTA_MINT_V1
      );
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), EUSX_DM_CONFIG.toBuffer(), publicKey.toBuffer()], DELTA_MINT_V1
      );

      const userEusxAta = getAssociatedTokenAddressSync(EUSX, publicKey, false, TOKEN_PROGRAM_ID);
      const vaultAta = getAssociatedTokenAddressSync(EUSX, EUSX_POOL, true, TOKEN_PROGRAM_ID);
      const userDeusxAta = getAssociatedTokenAddressSync(DEUSX, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const tx = new Transaction();

      const deusxAtaInfo = await connection.getAccountInfo(userDeusxAta);
      if (!deusxAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          publicKey, userDeusxAta, publicKey, DEUSX, TOKEN_2022_PROGRAM_ID
        ));
      }

      const wrapDisc = Buffer.from([178, 40, 10, 189, 228, 129, 186, 140]);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(BigInt(wrapAmount), 0);

      tx.add({
        programId: GOVERNOR_V1,
        data: Buffer.concat([wrapDisc, amountBuf]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: EUSX_POOL, isSigner: false, isWritable: true },
          { pubkey: EUSX, isSigner: false, isWritable: false },
          { pubkey: userEusxAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: EUSX_DM_CONFIG, isSigner: false, isWritable: false },
          { pubkey: DEUSX, isSigner: false, isWritable: true },
          { pubkey: dmAuthority, isSigner: false, isWritable: false },
          { pubkey: whitelistEntry, isSigner: false, isWritable: false },
          { pubkey: userDeusxAta, isSigner: false, isWritable: true },
          { pubkey: DELTA_MINT_V1, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = publicKey;

      setStatus({ msg: "Sign wrap transaction...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: `Wrapped ${(wrapAmount / 1e6).toFixed(2)} eUSX → ceUSX`, type: "success" });
      await loadBalances();
    } catch (e: any) {
      setStatus({ msg: e.message?.slice(0, 120) || "Wrap failed", type: "error" });
    } finally {
      setLoading(false);
      setStep("idle");
    }
  }

  const amountNum = parseFloat(amount || "0");
  const sourceBalance = balances[collateral];
  const overBalance = !!amount && amountNum > sourceBalance;

  return (
    <div className="space-y-8 pb-12">
      <PageHeader
        eyebrow="Portfolio"
        title="Overview"
        subtitle="Convert stablecoins or native SOL into yield-bearing, KYC-gated collateral, then supply it to the lending market."
        actions={
          apiKey
            ? <Badge tone="success" variant="soft">API key set</Badge>
            : <Badge tone="warning" variant="soft">API key required</Badge>
        }
      />

      {/* Institutional Lending Flow — orientation card. Two parallel
          paths (stablecoin EG-1 + LST EG-2) rendered with TokenIcons
          and inline arrow connectors, so the user can see at a glance
          which underlying asset feeds which collateral and which debt
          comes out the other side. Drops the old daisyUI `steps` strip
          which couldn't represent the two-track structure. */}
      <Card tone="elevated" size="lg">
        <CardHeader
          eyebrow="Flow"
          title="Institutional lending"
          subtitle="Two paths into the same lending market — pick a stablecoin or LST collateral, both end at a leveraged borrow with a positive carry."
        />

        <div className="space-y-5">
          <FlowPath
            label="Stablecoin path"
            badge={<Badge tone="primary" variant="soft" size="xs">EG-1 · 95% LTV · ~10% APY</Badge>}
            steps={[
              { kind: "asset", symbol: "USDC", caption: "Get stables" },
              { kind: "arrow", label: "mint" },
              { kind: "asset", symbol: "USX",  caption: "1:1 dollar" },
              { kind: "arrow", label: "lock" },
              { kind: "asset", symbol: "eUSX", caption: "yield-bearing" },
              { kind: "arrow", label: "KYC wrap" },
              { kind: "asset", symbol: "ceUSX", caption: "deposited" },
              { kind: "arrow", label: "borrow against" },
              { kind: "asset", symbol: "sUSDC", caption: "borrow" },
            ]}
          />

          <div className="border-t border-base-300/60" />

          <FlowPath
            label="LST path"
            badge={<Badge tone="primary" variant="soft" size="xs">EG-2 · 90% LTV · ~5.81% APY</Badge>}
            steps={[
              { kind: "asset", symbol: "SOL", caption: "Native SOL" },
              { kind: "arrow", label: "Jito stake + KYC wrap" },
              { kind: "asset", symbol: "csSOL", caption: "deposited" },
              { kind: "arrow", label: "borrow against" },
              { kind: "asset", symbol: "cSOL", caption: "borrow" },
            ]}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card tone="muted" size="sm">
            <div className="font-semibold text-sm text-success">Earn on collateral</div>
            <p className="mt-1 text-xs text-base-content/65 leading-relaxed">
              eUSX earns ~8–12% APY from funding-rate arbitrage, hedged
              staking, and tokenised US Treasuries; csSOL inherits Jito
              restaking yield (~5.81% APY) — yield accrues while the asset
              sits as collateral.
            </p>
          </Card>
          <Card tone="muted" size="sm">
            <div className="font-semibold text-sm text-warning">Carry trade</div>
            <p className="mt-1 text-xs text-base-content/65 leading-relaxed">
              Borrow USDC (EG-1) or wSOL (EG-2) at the reserve rate
              against collateral earning native yield. Net carry — collateral
              APY minus borrow APR — flows back to the desk on every dollar.
            </p>
          </Card>
        </div>
      </Card>

      {!apiKey && (
        <Card tone="muted" size="md">
          <CardHeader
            eyebrow="Required"
            title="Solstice API key"
            subtitle="Used by the USX mint + eUSX lock steps. Set VITE_SOLSTICE_API_KEY in .env to skip this prompt."
          />
          <FormLabel htmlFor="solstice-key" required>API key</FormLabel>
          <Input
            id="solstice-key"
            type="password"
            placeholder="Paste API key…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            helperText="Stored only in this tab — never sent to the chain."
          />
        </Card>
      )}

      {/* Wallet balances live in the global head bar (`<WalletBalancesBar>`)
          mounted in Layout, so the per-tab balance strip that used to
          live here has been removed. Hover any TokenIcon in the page
          (collateral selector, addons, EG flow, etc.) to see the
          live amount via the global tooltip. */}

      {/* Pipeline switcher — section-style tabs let the two onboarding
          paths sit at the same hierarchical level. */}
      <Tabs.Root variant="section" value={pipeline} onValueChange={(v) => setPipeline(v as "stable" | "lst")}>
        <Tabs.List>
          <Tabs.Trigger
            value="stable"
            icon={<TokenIcon symbol="ceUSX" size="md" />}
            badge={<Badge tone="primary" variant="soft" size="xs">EG-1</Badge>}
          >
            <Eyebrow>Stablecoin pipeline</Eyebrow>
            <div className="font-display text-base font-medium tracking-[-0.01em] mt-1.5">
              USDC / USDT → ceUSX
            </div>
            <p className="text-xs text-base-content/55 leading-relaxed mt-1 pr-2">
              Mint USX, lock for eUSX yield, wrap into KYC-gated collateral.
            </p>
          </Tabs.Trigger>
          <Tabs.Trigger
            value="lst"
            icon={<TokenIcon symbol="csSOL" size="md" />}
            badge={<Badge tone="primary" variant="soft" size="xs">EG-2</Badge>}
          >
            <Eyebrow>LST pipeline</Eyebrow>
            <div className="font-display text-base font-medium tracking-[-0.01em] mt-1.5">
              SOL → csSOL
            </div>
            <p className="text-xs text-base-content/55 leading-relaxed mt-1 pr-2">
              Single-signature Jito-vault stake, minted as KYC-gated csSOL.
            </p>
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="stable" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Step 1 — Mint */}
            <Card tone="elevated" size="lg">
              <CardHeader
                eyebrow="Step 1"
                title="Mint USX"
                subtitle={`Deposit ${collateral.toUpperCase()} → receive USX (1:1) via Solstice.`}
              />

              <FieldGroupHeading>Source collateral</FieldGroupHeading>
              <Tabs.Root
                variant="segmented"
                value={collateral}
                onValueChange={(v) => setCollateral(v as "usdc" | "usdt")}
              >
                <Tabs.List className="w-full">
                  <Tabs.Trigger value="usdc" icon={<TokenIcon symbol="USDC" size="xs" />}>
                    USDC <span className="opacity-55 ml-1.5">{balances.usdc.toFixed(0)}</span>
                  </Tabs.Trigger>
                  <Tabs.Trigger value="usdt" icon={<TokenIcon symbol="USDT" size="xs" />}>
                    USDT <span className="opacity-55 ml-1.5">{balances.usdt.toFixed(0)}</span>
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>

              <div className="mt-5">
                <TokenAmountInput
                  label="Amount"
                  symbol={collateral.toUpperCase()}
                  value={amount}
                  onChange={setAmount}
                  balance={sourceBalance}
                  balanceDecimals={2}
                  onMax={() => setAmount(sourceBalance.toFixed(2))}
                  invalid={overBalance || (!!amount && amountNum <= 0)}
                  errorText={
                    overBalance
                      ? `Exceeds wallet balance (${sourceBalance.toFixed(2)} ${collateral.toUpperCase()}).`
                      : "Enter an amount greater than zero."
                  }
                />
              </div>

              <CardFooter divider>
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={step === "minting_usx"}
                  disabled={!amount || !apiKey || amountNum <= 0 || sourceBalance < amountNum}
                  onClick={handleMintUSX}
                >
                  Mint USX from {collateral.toUpperCase()}
                </Button>
              </CardFooter>
            </Card>

            {/* Step 2 — Lock */}
            <Card tone="elevated" size="lg">
              <CardHeader
                eyebrow="Step 2"
                title="Lock for eUSX"
                subtitle="Lock USX in Solstice YieldVault to receive eUSX (yield-bearing, ~10% APY)."
              />

              <FieldGroupHeading>Position</FieldGroupHeading>
              <Card tone="muted" size="sm">
                <KeyValue label="Available USX" value={`${balances.usx.toFixed(2)} USX`} />
                <KeyValue label="Yield" value="≈ 10.00% APY" />
                <KeyValue label="Receive" value={`${balances.usx.toFixed(2)} eUSX`} />
              </Card>

              <CardFooter divider>
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={step === "locking_eusx"}
                  disabled={balances.usx <= 0 || !apiKey}
                  onClick={handleLockUSX}
                >
                  Lock {balances.usx.toFixed(2)} USX → eUSX
                </Button>
              </CardFooter>
            </Card>

            {/* Step 3 — Wrap */}
            <Card tone="elevated" size="lg">
              <CardHeader
                eyebrow="Step 3"
                title="KYC wrap"
                subtitle="Wrap eUSX → ceUSX (KYC-gated). Requires a delta-mint whitelist entry."
              />

              <FieldGroupHeading>Position</FieldGroupHeading>
              <Card tone="muted" size="sm">
                <KeyValue label="Available eUSX" value={`${balances.eusx.toFixed(2)} eUSX`} />
                <KeyValue label="Receive" value={`${balances.eusx.toFixed(2)} ceUSX`} />
                <KeyValue
                  label="Status"
                  value={<Badge tone="success" variant="soft" size="xs">whitelisted</Badge>}
                />
              </Card>

              <CardFooter divider>
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={step === "wrapping_deusx"}
                  disabled={balances.eusx <= 0}
                  onClick={handleWrapEUSX}
                >
                  Wrap {balances.eusx.toFixed(2)} eUSX → ceUSX
                </Button>
              </CardFooter>
            </Card>
          </div>
        </Tabs.Content>

        <Tabs.Content value="lst" keepMounted className="mt-6">
          <SolStakePanel
            solBalance={balances.sol}
            cssolBalance={balances.cssol}
            onStatusChange={setStatus}
            onComplete={() => loadBalances()}
          />
        </Tabs.Content>
      </Tabs.Root>

      {/* Helpful nudges based on wallet state. */}
      {balances.eusx > 0 && (
        <Snackbar
          type="info"
          message={`You have ${balances.eusx.toFixed(2)} eUSX. Skip to Step 3 to wrap directly into ceUSX collateral.`}
        />
      )}
      {balances.deusx > 0 && (
        <Snackbar
          type="success"
          message={`You have ${balances.deusx.toFixed(2)} ceUSX ready to deposit. Open the Supply Collateral tab.`}
        />
      )}

      {/* Toast — last so it floats above. */}
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

// ---------------------------------------------------------------------------
// SolStakePanel — 1-tx native SOL → csSOL flow.
// ---------------------------------------------------------------------------

const WRAP_WITH_JITO_VAULT_DISC = Buffer.from([65, 83, 9, 27, 94, 204, 161, 84]);

async function readJitoVaultFeeWallet(conn: import("@solana/web3.js").Connection, vault: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error(`Jito vault ${vault.toBase58()} not found`);
  return new PublicKey(info.data.subarray(696, 696 + 32));
}

function buildWrapWithJitoVaultIx(args: {
  user: PublicKey;
  amount: bigint;
  feeWallet: PublicKey;
}): TransactionInstruction {
  const { user, amount, feeWallet } = args;
  const cfg = DEVNET_CONFIG;
  const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrtAta = getAssociatedTokenAddressSync(cfg.pool.vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userCssolAta = getAssociatedTokenAddressSync(cfg.pool.wrappedMint, user, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const vaultFeeAta = getAssociatedTokenAddressSync(cfg.pool.vrtMint, feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [jitoVaultConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], cfg.programs.jitoVault);
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), cfg.pool.dmMintConfig.toBuffer(), user.toBuffer()],
    cfg.programs.deltaMint,
  );
  const data = Buffer.alloc(8 + 8);
  WRAP_WITH_JITO_VAULT_DISC.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return new TransactionInstruction({
    programId: cfg.programs.governor,
    keys: [
      { pubkey: user,                       isSigner: true,  isWritable: true  },
      { pubkey: cfg.pool.poolConfig,        isSigner: false, isWritable: true  },
      { pubkey: userWsolAta,                isSigner: false, isWritable: true  },
      { pubkey: cfg.programs.jitoVault,     isSigner: false, isWritable: false },
      { pubkey: jitoVaultConfig,            isSigner: false, isWritable: false },
      { pubkey: cfg.pool.jitoVault,         isSigner: false, isWritable: true  },
      { pubkey: cfg.pool.vrtMint,           isSigner: false, isWritable: true  },
      { pubkey: cfg.pool.vaultStTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userVrtAta,                 isSigner: false, isWritable: true  },
      { pubkey: cfg.pool.poolVrtAta,        isSigner: false, isWritable: true  },
      { pubkey: vaultFeeAta,                isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
      { pubkey: cfg.pool.dmMintConfig,      isSigner: false, isWritable: false },
      { pubkey: cfg.pool.wrappedMint,       isSigner: false, isWritable: true  },
      { pubkey: cfg.pool.dmMintAuthority,   isSigner: false, isWritable: false },
      { pubkey: whitelistEntry,             isSigner: false, isWritable: false },
      { pubkey: userCssolAta,               isSigner: false, isWritable: true  },
      { pubkey: cfg.programs.deltaMint,     isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID,      isSigner: false, isWritable: false },
    ],
    data,
  });
}

interface SolStakePanelProps {
  solBalance: number;
  cssolBalance: number;
  onStatusChange: (s: { msg: string; type: "info" | "success" | "error" }) => void;
  onComplete: () => void;
}
function SolStakePanel({ solBalance, cssolBalance, onStatusChange, onComplete }: SolStakePanelProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  // KYC gate: delta-mint's MintTo CPI requires a `whitelist_entry` PDA
  // for the wallet under the csSOL mint config. Without it, the tx
  // fails with Anchor's AccountNotInitialized (Custom 3012). Mirrors
  // the same check that CssolWsolCreditPanel runs before opening a
  // credit trade.
  const [whitelisted, setWhitelisted] = useState<boolean | null>(null);

  useEffect(() => {
    if (!publicKey) { setWhitelisted(null); return; }
    let cancelled = false;
    (async () => {
      const [wlPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), DEVNET_CONFIG.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
        DEVNET_CONFIG.programs.deltaMint,
      );
      const info = await connection.getAccountInfo(wlPda, "confirmed");
      if (!cancelled) setWhitelisted(!!info);
    })().catch(() => { if (!cancelled) setWhitelisted(null); });
    return () => { cancelled = true; };
  }, [publicKey, connection]);

  const amountNum = parseFloat(amount || "0");
  const spendable = Math.max(0, solBalance - 0.01);
  const overBalance = amountNum > spendable;

  const handleStake = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    const amt = parseFloat(amount || "0");
    if (amt <= 0) return;
    if (amt > solBalance - 0.01) {
      onStatusChange({ msg: `Need at least ${(amt + 0.01).toFixed(3)} SOL — leave 0.01 for fees/ATA rent.`, type: "error" });
      return;
    }
    if (whitelisted === false) {
      onStatusChange({ msg: "Wallet is not whitelisted on the csSOL pool — delta-mint will reject the MintTo CPI (Custom 3012 / AccountNotInitialized: whitelist_entry). Onboard via the institutional portal first.", type: "error" });
      return;
    }
    setBusy(true);
    try {
      onStatusChange({ msg: "Building stake tx (SOL → wSOL → csSOL via Jito vault) …", type: "info" });
      const lamports = BigInt(Math.round(amt * 1e9));
      const cfg = DEVNET_CONFIG;
      const feeWallet = await readJitoVaultFeeWallet(connection, cfg.pool.jitoVault);
      const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userVrtAta = getAssociatedTokenAddressSync(cfg.pool.vrtMint, publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userCssolAta = getAssociatedTokenAddressSync(cfg.pool.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const vaultFeeAta = getAssociatedTokenAddressSync(cfg.pool.vrtMint, feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(createAssociatedTokenAccountIdempotentInstruction(publicKey, userWsolAta, publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
        .add(createAssociatedTokenAccountIdempotentInstruction(publicKey, userVrtAta,  publicKey, cfg.pool.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
        .add(createAssociatedTokenAccountIdempotentInstruction(publicKey, userCssolAta, publicKey, cfg.pool.wrappedMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
        .add(createAssociatedTokenAccountIdempotentInstruction(publicKey, vaultFeeAta, feeWallet, cfg.pool.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))
        .add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: userWsolAta, lamports: Number(lamports) }))
        .add(createSyncNativeInstruction(userWsolAta))
        .add(buildWrapWithJitoVaultIx({ user: publicKey, amount: lamports, feeWallet }));

      const sig = await sendTransaction(tx, connection, { skipPreflight: true });
      await connection.confirmTransaction(sig, "confirmed");
      const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (receipt?.meta?.err) {
        const logs = receipt.meta.logMessages?.slice(-8).join("\n") ?? "";
        throw new Error(`klend rejected: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
      }
      onStatusChange({ msg: `Staked ${amt} SOL → csSOL (tx ${sig.slice(0, 16)}…)`, type: "success" });
      setAmount("");
      onComplete();
    } catch (e: any) {
      onStatusChange({ msg: `Stake failed: ${e.message ?? String(e)}`.slice(0, 240), type: "error" });
    } finally {
      setBusy(false);
    }
  }, [publicKey, sendTransaction, connection, amount, solBalance, whitelisted, onStatusChange, onComplete]);

  return (
    <Card tone="elevated" size="lg">
      <CardHeader
        eyebrow="Stake"
        title="Native SOL → csSOL"
        subtitle="One-tx Jito-vault stake, minted as KYC-gated csSOL collateral. Posts against cSOL borrows in EG-2 (90/92 LTV)."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-5">
          {/* SOL / csSOL balances live in the unified strip at the top
              of the page; this column only carries the eligibility
              callout so the operator can verify whitelist + LTV before
              committing a stake. */}
          <div>
            <FieldGroupHeading>Eligibility</FieldGroupHeading>
            <Card tone="muted" size="sm">
              <KeyValue label="MintConfig" value="csSOL" />
              <KeyValue
                label="Whitelist"
                value={
                  whitelisted === null
                    ? <Badge tone="info" variant="soft" size="xs">checking…</Badge>
                    : whitelisted
                      ? <Badge tone="success" variant="soft" size="xs">holder</Badge>
                      : <Badge tone="warning" variant="soft" size="xs">not onboarded</Badge>
                }
              />
              <KeyValue label="LTV (EG-2)" value="90 / 92" />
              <KeyValue label="Yield source" value="Jito-restaking" />
            </Card>
            {whitelisted === false && (
              <div className="mt-3">
                <Snackbar
                  variant="inline"
                  type="warning"
                  message="Wallet not whitelisted on the csSOL pool"
                  detail="The stake tx mints csSOL via delta-mint, which requires this wallet's whitelist_entry PDA. Onboard via the institutional portal before staking — otherwise the tx fails with AccountNotInitialized (3012)."
                />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          <TokenAmountInput
            label="Stake amount"
            symbol="SOL"
            value={amount}
            onChange={setAmount}
            balance={spendable}
            balanceUnit="SOL"
            balanceDecimals={4}
            onMax={() => setAmount(spendable.toFixed(4))}
            invalid={overBalance || (!!amount && amountNum <= 0)}
            errorText={
              overBalance
                ? "Exceeds spendable balance — leave 0.01 SOL for fees + ATA rent."
                : "Enter an amount greater than zero."
            }
            helperText="Leaves 0.01 SOL in your wallet for fees + ATA rent."
            inputSize="lg"
          />

          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={busy}
            disabled={!amount || amountNum <= 0 || overBalance || whitelisted === false}
            onClick={handleStake}
          >
            Stake {amount || "0"} SOL → csSOL
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// FlowPath — stablecoin / LST visualisation used in the Overview header.
// Reads as a deliberate left-to-right narrative on `md`+ screens, where
// the 9-step stablecoin row (~524px wide) comfortably fits. On mobile
// the row would otherwise wrap mid-flow, leaving arrows pointing at the
// next line instead of the next asset, so we switch to a vertical stack
// with the arrow rotated 90° (a clean ↓ between asset cards). Each
// breakpoint gets a layout that *can't* wrap awkwardly.
// ---------------------------------------------------------------------------

type FlowStep =
  | { kind: "asset"; symbol: TokenSymbol; caption: string }
  | { kind: "arrow"; label: string };

function FlowPath({
  label,
  badge,
  steps,
}: {
  label: string;
  badge?: React.ReactNode;
  steps: FlowStep[];
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Eyebrow>{label}</Eyebrow>
        {badge}
      </div>
      <div className="flex flex-col items-stretch gap-1 md:flex-row md:items-center md:gap-2 md:flex-wrap">
        {steps.map((s, i) =>
          s.kind === "asset" ? (
            <FlowAsset key={`${i}-${s.symbol}`} symbol={s.symbol} caption={s.caption} />
          ) : (
            <FlowArrow key={`${i}-arrow`} label={s.label} />
          ),
        )}
      </div>
    </div>
  );
}

function FlowAsset({ symbol, caption }: { symbol: TokenSymbol; caption: string }) {
  return (
    <div
      className="
        flex flex-row items-center gap-3 px-3 py-2 rounded-lg
        md:flex-col md:items-center md:gap-1.5 md:px-2 md:min-w-[68px]
      "
    >
      <TokenIcon symbol={symbol} size="md" />
      <div className="flex flex-col gap-0.5 md:items-center">
        <div className="text-xs md:text-[11px] font-mono font-semibold text-base-content leading-none">
          {symbol}
        </div>
        <div className="text-[11px] md:text-[10px] text-base-content/55 leading-tight md:leading-none md:whitespace-nowrap">
          {caption}
        </div>
      </div>
    </div>
  );
}

function FlowArrow({ label }: { label: string }) {
  return (
    <div
      className="
        flex flex-row items-center gap-2 text-base-content/45 pl-5 pr-3
        md:flex-col md:items-center md:justify-center md:gap-1.5 md:p-0 md:px-1
      "
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4 rotate-90 md:rotate-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5 12h14M13 5l7 7-7 7" />
      </svg>
      <div className="text-[10px] md:text-[9px] font-semibold uppercase tracking-[0.16em] text-base-content/40 leading-none whitespace-nowrap">
        {label}
      </div>
    </div>
  );
}
