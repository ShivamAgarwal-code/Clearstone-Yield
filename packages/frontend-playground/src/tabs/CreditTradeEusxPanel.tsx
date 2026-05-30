import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CEUSX_MINT,
  CEUSX_RESERVE,
  CEUSX_RESERVE_ORACLE,
  ELEVATION_GROUP_STABLES,
  EUSX_MINT,
  SUSDC_MINT,
  SUSDC_RESERVE,
  SUSDC_RESERVE_ORACLE,
  USX_FLOW_LUT,
  USX_MINT,
} from "../lib/addresses";
import {
  buildCeUsxToEusxUnwrapIx,
  buildEusxToCeUsxWrapIx,
  callSolstice,
  readEusxBalances,
} from "../lib/eusxConversions";
import {
  buildConvertCeusxIxes,
  buildUnwindCeusxWtIxes,
} from "../lib/eusxConvertWt";
import { CEUSX_WT_MINT, DELTA_MINT_PROGRAM, CEUSX_WT_RESERVE } from "../lib/addresses";
import {
  buildBorrowObligationLiquidityIx,
  buildDepositLiquidityAndCollateralIx,
  buildInitObligationIx,
  buildInitUserMetadataIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRepayObligationLiquidityIx,
  buildRequestElevationGroupIx,
  buildWithdrawCollateralAndRedeemIx,
  obligationPda,
  userMetadataPda,
} from "../lib/klend";
import { readObligation, readReserve, sfToNumber } from "../lib/obligationView";

type Action = "deposit" | "borrow" | "repay" | "withdraw" | null;

// Conversion-pipeline action — the "Prepare ceUSX" / "Off-ramp" card.
// `mint`/`redeem` go through Solstice REST API (Squads-gated USX program);
// `lock`/`unlock` likewise (no native YieldVault builders yet, the API
// returns user-signable ixes either way); `wrap`/`unwrap` are native ixes
// against the legacy governor program that owns the eUSX→ceUSX pool.
type Conv = "mint" | "lock" | "wrap" | "unwrap" | "unlock" | "withdraw" | "redeem" | "bundle_in" | "bundle_out" | null;

const SUSDC_DECIMALS = 6;
const CEUSX_DECIMALS = 6;
const USX_DECIMALS = 6;
const EUSX_DECIMALS = 6;
const USDC_DECIMALS = 6;
// Persist the Solstice API key in localStorage so the user only enters
// it once per browser. Plain text — devnet only.
const SOLSTICE_API_KEY_STORAGE = "playground.solsticeApiKey";

function fmt(n: number, dp = 6): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtErr(e: any): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return e?.message ?? JSON.stringify(e);
}

export default function CreditTradeEusxPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reserves
  const [ceusxPrice, setCeusxPrice] = useState(0);
  const [susdcPrice, setSusdcPrice] = useState(0);
  const [susdcAvailable, setSusdcAvailable] = useState(0);

  // Wallet balances
  const [ceusxBal, setCeusxBal] = useState(0);
  const [susdcBal, setSusdcBal] = useState(0);

  // Obligation
  const [ceusxCollateral, setCeusxCollateral] = useState(0);
  const [susdcDebt, setSusdcDebt] = useState(0);
  const [elevationGroup, setElevationGroup] = useState(0);
  const [obligationExists, setObligationExists] = useState(false);
  const [userMetaExists, setUserMetaExists] = useState(false);

  // Action panel
  const [action, setAction] = useState<Action>(null);
  const [amountStr, setAmountStr] = useState("");

  // Conversion pipeline (USDC ↔ USX ↔ eUSX ↔ ceUSX)
  const [usdcBal, setUsdcBal] = useState(0);
  const [usxBal, setUsxBal] = useState(0);
  const [eusxBal, setEusxBal] = useState(0);
  const [conv, setConv] = useState<Conv>(null);
  const [convAmountStr, setConvAmountStr] = useState("");
  // Seed precedence: localStorage (user-saved override) → VITE env var
  // (matches frontend-institutional/PreparePage convention) → empty.
  const [apiKey, setApiKey] = useState<string>(() => {
    try {
      const fromLs = localStorage.getItem(SOLSTICE_API_KEY_STORAGE);
      if (fromLs) return fromLs;
    } catch {}
    return (import.meta.env.VITE_SOLSTICE_API_KEY as string | undefined) ?? "";
  });
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const apiKeyFromEnv = !!(import.meta.env.VITE_SOLSTICE_API_KEY as string | undefined);

  async function refresh() {
    if (!wallet.publicKey) return;
    setError(null);
    try {
      const owner = wallet.publicKey;
      const [ceusxRes, susdcRes, obligation] = await Promise.all([
        readReserve(connection, CEUSX_RESERVE, CEUSX_RESERVE_ORACLE),
        readReserve(connection, SUSDC_RESERVE, SUSDC_RESERVE_ORACLE),
        readObligation(connection, owner),
      ]);
      if (ceusxRes) setCeusxPrice(sfToNumber(ceusxRes.marketPriceSf));
      if (susdcRes) {
        setSusdcPrice(sfToNumber(susdcRes.marketPriceSf));
        setSusdcAvailable(Number(susdcRes.availableAmount) / 10 ** SUSDC_DECIMALS);
      }

      // Obligation deposits/borrows for ceUSX & sUSDC. depositedCtokens are
      // cTokens; we approximate the underlying via the reserve's marketValueSf
      // (USD) divided by its price — same approach the credit-trade tab uses.
      const dep = obligation.deposits.find((d) => d.reserve.equals(CEUSX_RESERVE));
      const bor = obligation.borrows.find((b) => b.reserve.equals(SUSDC_RESERVE));
      const ceusxPx = ceusxRes ? sfToNumber(ceusxRes.marketPriceSf) : 0;
      const susdcPx = susdcRes ? sfToNumber(susdcRes.marketPriceSf) : 1;
      setCeusxCollateral(dep && ceusxPx > 0 ? sfToNumber(dep.marketValueSf) / ceusxPx : 0);
      setSusdcDebt(bor && susdcPx > 0 ? sfToNumber(bor.marketValueSf) / susdcPx : 0);
      setElevationGroup(obligation.elevationGroup);
      setObligationExists(obligation.exists);

      // Wallet balances
      const ceusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const susdcAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [ceusxBalRaw, susdcBalRaw] = await Promise.all([
        connection.getTokenAccountBalance(ceusxAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
        connection.getTokenAccountBalance(susdcAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
      ]);
      setCeusxBal(ceusxBalRaw);
      setSusdcBal(susdcBalRaw);

      // Conversion-pipeline wallet balances (USDC, USX, eUSX). USDC is
      // SUSDC_MINT — Solstice's "Solstice devnet USDC" mint is the same
      // mint as our sUSDC reserve liquidity, just different label. So
      // for the chain `USDC → USX → eUSX → ceUSX` the head-of-chain
      // balance is the user's sUSDC ATA balance.
      const conv = await readEusxBalances(connection, owner, SUSDC_MINT);
      setUsdcBal(conv.usdc);
      setUsxBal(conv.usx);
      setEusxBal(conv.eusx);

      // user_metadata existence — needed because the first deposit also
      // creates the obligation, but klend requires user_metadata to exist
      // before the obligation init.
      const metaInfo = await connection.getAccountInfo(userMetadataPda(owner), "confirmed");
      setUserMetaExists(!!metaInfo);
    } catch (e: any) {
      setError(fmtErr(e));
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wallet.publicKey?.toBase58()]);

  // Re-fetch balances whenever an action / conversion panel is opened so
  // the "Available" hint reflects fresh state — the user may have just
  // sent funds in another tab. Only refreshes when the panel transitions
  // into a non-null value (closing doesn't trigger a re-read).
  useEffect(() => {
    if (action || conv) void refresh();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [action, conv]);

  /** Lookup table: which balance bounds each panel's input, and its
   *  display label. `borrow` is special — it isn't bounded by a wallet
   *  balance but by reserve liquidity (the user receives sUSDC). */
  function availableForAction(): { value: number; label: string } | null {
    switch (action) {
      case "deposit":  return { value: ceusxBal,        label: "ceUSX in wallet" };
      case "borrow":   return { value: susdcAvailable,  label: "sUSDC in reserve" };
      case "repay":    return { value: Math.min(susdcBal, susdcDebt), label: "min(sUSDC in wallet, debt)" };
      case "withdraw": return { value: ceusxCollateral, label: "ceUSX in klend collateral" };
      default:         return null;
    }
  }
  function availableForConv(): { value: number; label: string } | null {
    switch (conv) {
      case "bundle_in":  return { value: usdcBal,  label: "USDC in wallet (drives full chain)" };
      case "bundle_out": return { value: ceusxBal, label: "ceUSX in wallet (drives full chain)" };
      case "mint":       return { value: usdcBal,  label: "USDC in wallet" };
      case "lock":       return { value: usxBal,   label: "USX in wallet" };
      case "wrap":       return { value: eusxBal,  label: "eUSX in wallet" };
      case "unwrap":     return { value: ceusxBal, label: "ceUSX in wallet" };
      case "unlock":     return { value: eusxBal,  label: "eUSX in wallet" };
      case "withdraw":   return { value: 0,        label: "queued USX (on-chain pending PDA — read directly to see actual)" };
      case "redeem":     return { value: usxBal,   label: "USX in wallet" };
      default:           return null;
    }
  }

  async function buildInitIxesIfNeeded(): Promise<TransactionInstruction[]> {
    if (!wallet.publicKey) return [];
    const out: TransactionInstruction[] = [];
    if (!userMetaExists) out.push(await buildInitUserMetadataIx(wallet.publicKey, wallet.publicKey));
    if (!obligationExists) out.push(await buildInitObligationIx(wallet.publicKey, wallet.publicKey));
    return out;
  }

  /** Standard refresh chain: refresh every active reserve, plus the
   *  target reserve last (klend's `check_refresh` requires the action's
   *  target reserve at N-2 of the action ix), then refresh_obligation.
   *  Identical shape to LendingPositionTab.buildRefreshChain. */
  async function buildRefreshChain(targetReserve: PublicKey): Promise<TransactionInstruction[]> {
    const owner = wallet.publicKey!;
    const obligation = await readObligation(connection, owner);
    const out: TransactionInstruction[] = [];
    const seen = new Set<string>();
    const allRefs = [
      ...obligation.deposits.map((d) => d.reserve),
      ...obligation.borrows.map((b) => b.reserve),
      targetReserve,
    ];
    for (const r of allRefs) {
      const key = r.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      const oracle = r.equals(CEUSX_RESERVE) ? CEUSX_RESERVE_ORACLE : SUSDC_RESERVE_ORACLE;
      out.push(await buildRefreshReserveIx(r, oracle));
    }
    // Move targetReserve's refresh to N-2 by re-pushing it last
    const oracle = targetReserve.equals(CEUSX_RESERVE) ? CEUSX_RESERVE_ORACLE : SUSDC_RESERVE_ORACLE;
    out.push(await buildRefreshReserveIx(targetReserve, oracle));
    out.push(await buildRefreshObligationIx(owner, [
      ...obligation.deposits.map((d) => d.reserve),
      ...obligation.borrows.map((b) => b.reserve),
    ]));
    return out;
  }

  async function send(ixes: TransactionInstruction[], label: string) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not ready");
    const owner = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixes }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    setLog((l) => [...l, `${label}: signing…`]);
    const signed = await wallet.signTransaction(vtx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    setLog((l) => [...l, `${label}: sent ${sig.slice(0, 20)}…`]);
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)}`);
    setLog((l) => [...l, `${label}: confirmed`]);
  }

  function getLamports(decimals: number): bigint {
    const n = Number(amountStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * 10 ** decimals));
  }

  async function handleDeposit() {
    if (!wallet.publicKey) return;
    const amount = getLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(ceusxBal * 10 ** CEUSX_DECIMALS)) < amount) {
      setError(`Insufficient ceUSX: have ${ceusxBal}, need ${amountStr}. Mint USX → ceUSX via the institutional portal first.`);
      return;
    }
    setBusy(true); setError(null); setLog([`deposit ${amountStr} ceUSX …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...await buildRefreshChain(CEUSX_RESERVE),
      ];
      ixes.push(await buildDepositLiquidityAndCollateralIx({
        user: owner, reserve: CEUSX_RESERVE,
        liquidityMint: CEUSX_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userSourceLiquidity: userAta, amount,
      }));
      await send(ixes, "deposit ceUSX");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleBorrow() {
    if (!wallet.publicKey) return;
    const amount = getLamports(SUSDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (Number(amount) > susdcAvailable * 10 ** SUSDC_DECIMALS) {
      setError(`Reserve only has ${susdcAvailable.toFixed(2)} sUSDC available.`);
      return;
    }
    setBusy(true); setError(null); setLog([`borrow ${amountStr} sUSDC …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      // Auto-enter EG-1 (stables) if the obligation has only ceUSX
      // collateral and isn't already in the group. Without EG-1 the
      // ceUSX/sUSDC pair sits at the base LTV (much lower than 90%);
      // entering the group is the whole point of leveraging here.
      const onlyCeusxCollateral =
        obligation.deposits.length === 0 ||
        obligation.deposits.every((d) => d.reserve.equals(CEUSX_RESERVE));
      const noBorrowsYet = obligation.borrows.length === 0;
      if (obligation.elevationGroup !== ELEVATION_GROUP_STABLES && onlyCeusxCollateral && noBorrowsYet) {
        // Refresh + obligation refresh + request_elevation_group + obligation refresh again
        // before the borrow's refresh chain. klend validates LTV under the new group.
        ixes.push(await buildRefreshReserveIx(CEUSX_RESERVE, CEUSX_RESERVE_ORACLE));
        ixes.push(await buildRefreshReserveIx(SUSDC_RESERVE, SUSDC_RESERVE_ORACLE));
        ixes.push(await buildRefreshObligationIx(owner, obligation.deposits.map((d) => d.reserve)));
        ixes.push(await buildRequestElevationGroupIx(
          owner,
          ELEVATION_GROUP_STABLES,
          obligation.deposits.map((d) => d.reserve),
          [], // no borrows yet
        ));
      }
      ixes.push(...await buildRefreshChain(SUSDC_RESERVE));
      ixes.push(await buildBorrowObligationLiquidityIx({
        user: owner, borrowReserve: SUSDC_RESERVE,
        liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userDestinationLiquidity: userAta, amount,
        obligationDepositReserves: obligation.deposits.map((d) => d.reserve),
      }));
      await send(ixes, "borrow sUSDC");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleRepay() {
    if (!wallet.publicKey) return;
    const amount = getLamports(SUSDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(susdcBal * 10 ** SUSDC_DECIMALS)) < amount) {
      setError(`Insufficient sUSDC: have ${susdcBal}, need ${amountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`repay ${amountStr} sUSDC …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...await buildRefreshChain(SUSDC_RESERVE),
      ];
      ixes.push(await buildRepayObligationLiquidityIx({
        user: owner, repayReserve: SUSDC_RESERVE,
        liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userSourceLiquidity: userAta, amount,
      }));
      await send(ixes, "repay sUSDC");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleWithdraw() {
    if (!wallet.publicKey) return;
    const amount = getLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    setBusy(true); setError(null); setLog([`withdraw ${amountStr} ceUSX …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...await buildRefreshChain(CEUSX_RESERVE),
      ];
      ixes.push(await buildWithdrawCollateralAndRedeemIx({
        user: owner, reserve: CEUSX_RESERVE,
        liquidityMint: CEUSX_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userDestinationLiquidity: userAta, collateralAmount: amount,
        refreshObligationDeposits: obligation.deposits.map((d) => d.reserve),
      }));
      await send(ixes, "withdraw ceUSX");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  // ── Conversion pipeline ──
  // USDC ↔ USX ↔ eUSX ↔ ceUSX. The USDC↔USX leg goes through Solstice's
  // REST API (USX program is gated behind their operator multisig). The
  // USX↔eUSX leg also goes through the API (no native YieldVault builder
  // wired in yet — Lock/Unlock are user-signable but we let the API
  // assemble accounts to stay in lockstep with PreparePage). The
  // eUSX↔ceUSX leg uses the legacy governor wrap/unwrap directly.

  function getConvLamports(decimals: number): bigint {
    const n = Number(convAmountStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * 10 ** decimals));
  }

  function ensureApiKey(): boolean {
    if (!apiKey) {
      setError("Solstice API key required for USDC↔USX and USX↔eUSX flows. Paste yours into the field above (key is stored in localStorage, devnet-only).");
      return false;
    }
    return true;
  }

  async function sendIxes(label: string, ixes: TransactionInstruction[], luts: AddressLookupTableAccount[] = []) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not ready");
    const owner = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixes }).compileToV0Message(luts);
    const vtx = new VersionedTransaction(msg);
    setLog((l) => [...l, `${label}: signing… (${ixes.length} ixes${luts.length ? `, ${luts.length} LUT` : ""})`]);
    const signed = await wallet.signTransaction(vtx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    setLog((l) => [...l, `${label}: sent ${sig.slice(0, 20)}…`]);
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)}`);
    setLog((l) => [...l, `${label}: confirmed`]);
  }

  /** Resolve the bundled-flow LUT (if configured) to an
   *  AddressLookupTableAccount. Returns [] if VITE_USX_FLOW_LUT isn't
   *  set or the on-chain account hasn't materialized yet, in which case
   *  the bundle compiles without an ALT (likely failing tx-size). */
  async function resolveUsxFlowLut(): Promise<AddressLookupTableAccount[]> {
    const lutAddr = USX_FLOW_LUT;
    if (!lutAddr) return [];
    const res = await connection.getAddressLookupTable(lutAddr);
    if (!res.value) {
      setLog((l) => [...l, `warn: VITE_USX_FLOW_LUT=${lutAddr.toBase58()} not resolvable on-chain (yet?)`]);
      return [];
    }
    return [res.value];
  }

  async function handleMintUsx() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    const amount = getConvLamports(USDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(usdcBal * 10 ** USDC_DECIMALS)) < amount) {
      setError(`Insufficient USDC: have ${usdcBal}, need ${convAmountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`mint USX from ${convAmountStr} USDC via Solstice …`]);
    try {
      const owner = wallet.publicKey;
      const usxAta = getAssociatedTokenAddressSync(USX_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [reqIxes, confIxes] = await Promise.all([
        callSolstice(apiKey, { type: "RequestMint", data: { amount: Number(amount), collateral: "usdc", user: owner.toBase58() } }),
        callSolstice(apiKey, { type: "ConfirmMint", data: { user: owner.toBase58(), collateral: "usdc" } }),
      ]);
      await sendIxes("mint USX", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, usxAta, owner, USX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...reqIxes,
        ...confIxes,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleLockEusx() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    const amount = getConvLamports(USX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(usxBal * 10 ** USX_DECIMALS)) < amount) {
      setError(`Insufficient USX: have ${usxBal}, need ${convAmountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`lock ${convAmountStr} USX → eUSX via Solstice …`]);
    try {
      const owner = wallet.publicKey;
      const eusxAta = getAssociatedTokenAddressSync(EUSX_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const lockIxes = await callSolstice(apiKey, { type: "Lock", data: { amount: Number(amount), user: owner.toBase58() } });
      await sendIxes("lock USX", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, eusxAta, owner, EUSX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...lockIxes,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleWrapCeusx() {
    if (!wallet.publicKey) return;
    const amount = getConvLamports(EUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(eusxBal * 10 ** EUSX_DECIMALS)) < amount) {
      setError(`Insufficient eUSX: have ${eusxBal}, need ${convAmountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`wrap ${convAmountStr} eUSX → ceUSX (KYC-gated) …`]);
    try {
      const owner = wallet.publicKey;
      const ceusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const wrapIx = await buildEusxToCeUsxWrapIx({ user: owner, amount });
      await sendIxes("wrap eUSX", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, ceusxAta, owner, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        wrapIx,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleUnwrapCeusx() {
    if (!wallet.publicKey) return;
    const amount = getConvLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(ceusxBal * 10 ** CEUSX_DECIMALS)) < amount) {
      setError(`Insufficient ceUSX in wallet: have ${ceusxBal}, need ${convAmountStr}. (Withdraw from klend first if your ceUSX is collateral.)`);
      return;
    }
    setBusy(true); setError(null); setLog([`unwrap ${convAmountStr} ceUSX → eUSX …`]);
    try {
      const owner = wallet.publicKey;
      const eusxAta = getAssociatedTokenAddressSync(EUSX_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const unwrapIx = await buildCeUsxToEusxUnwrapIx({ user: owner, amount });
      await sendIxes("unwrap ceUSX", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, eusxAta, owner, EUSX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        unwrapIx,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleUnlockEusx() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    const amount = getConvLamports(EUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(eusxBal * 10 ** EUSX_DECIMALS)) < amount) {
      setError(`Insufficient eUSX: have ${eusxBal}, need ${convAmountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`unlock ${convAmountStr} eUSX → USX via Solstice …`]);
    try {
      const owner = wallet.publicKey;
      const usxAta = getAssociatedTokenAddressSync(USX_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const unlockIxes = await callSolstice(apiKey, { type: "Unlock", data: { amount: Number(amount), user: owner.toBase58() } });
      await sendIxes("unlock eUSX", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, usxAta, owner, USX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...unlockIxes,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleWithdrawClaim() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    // The on-chain `Withdraw` ix takes no amount — it claims everything
    // queued in the user's pending-unlock PDA. The Solstice API requires
    // some `amount` field in the request body but ignores it in the
    // returned ix data (we verified via probe). Pass through the user's
    // input for accounting; on-chain effect is unconditional full-claim.
    const amount = getConvLamports(USX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0 (the on-chain ix claims everything; this number is just for the API to accept the call)."); return; }
    setBusy(true); setError(null);
    setLog([`claim pending unlock (Withdraw) via Solstice …`]);
    try {
      const owner = wallet.publicKey;
      const usxAta = getAssociatedTokenAddressSync(USX_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const withdrawIxes = await callSolstice(apiKey, { type: "Withdraw", data: { amount: Number(amount), user: owner.toBase58() } });
      await sendIxes("withdraw (claim unlock)", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, usxAta, owner, USX_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...withdrawIxes,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleRedeemUsx() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    const amount = getConvLamports(USX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(usxBal * 10 ** USX_DECIMALS)) < amount) {
      setError(`Insufficient USX: have ${usxBal}, need ${convAmountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`redeem ${convAmountStr} USX → USDC via Solstice …`]);
    try {
      const owner = wallet.publicKey;
      const usdcAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [reqIxes, confIxes] = await Promise.all([
        callSolstice(apiKey, { type: "RequestRedeem", data: { amount: Number(amount), collateral: "usdc", user: owner.toBase58() } }),
        callSolstice(apiKey, { type: "ConfirmRedeem", data: { user: owner.toBase58(), collateral: "usdc" } }),
      ]);
      await sendIxes("redeem USX", [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...reqIxes,
        ...confIxes,
      ]);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  function persistApiKey() {
    try { localStorage.setItem(SOLSTICE_API_KEY_STORAGE, apiKey); } catch {}
    setApiKeyDirty(false);
  }

  // ── Bundled flows ──
  // Atomic-in-one-tx variants of the 3-step manual chains. The Solstice
  // API returns user-signable instructions — confirmed by probe — so we
  // can fan out the 3 API calls in parallel, concatenate their ixes
  // in-order with the native governor wrap / unwrap, and submit a single
  // VersionedTransaction.
  //
  // Amount passthrough is 1:1 across every leg on devnet:
  //   - Solstice Mint: 1 USDC → 1 USX (oracle-pegged 1:1)
  //   - YieldVault Lock/Unlock: 1 USX ↔ 1 eUSX on devnet (the visible
  //     $1.08 ceUSX price comes from the accrual-oracle keeper feeding
  //     the klend reserve, NOT from the YieldVault's mint index — the
  //     vault has no actual yield accrued on devnet)
  //   - Governor wrap/unwrap: 1 eUSX ↔ 1 ceUSX (always 1:1 by design)
  //   - Solstice Redeem: 1 USX → 1 USDC
  // We undersize each downstream amount by 0.1% so any drift between
  // API-call time and tx-execution time leaves dust rather than reverts.
  // On mainnet (where the YieldVault may actually accrue index growth)
  // the bundled handlers will need a balance-read post-Unlock, or a
  // dynamic index lookup, before being shipped.

  async function handleBundleIn() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    const usdcLamports = getConvLamports(USDC_DECIMALS);
    if (usdcLamports <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(usdcBal * 10 ** USDC_DECIMALS)) < usdcLamports) {
      setError(`Insufficient USDC: have ${usdcBal}, need ${convAmountStr}.`);
      return;
    }
    setBusy(true); setError(null);
    setLog([`bundle USDC → ceUSX: ${convAmountStr} USDC (Mint + ConfirmMint + Lock + Wrap, single tx) …`]);
    try {
      const owner = wallet.publicKey;

      // 1:1 passthrough on devnet (see comment block above). Each
      // downstream amount is undersized 0.1% so drift between API call
      // and tx execution leaves dust rather than reverts.
      const usxLamports  = usdcLamports;
      const eusxLamports = BigInt(Math.floor(Number(usxLamports) * 0.999));
      if (eusxLamports <= 0n) { setError("Computed eUSX amount is zero — try a larger USDC amount."); return; }

      const [reqMintIxes, confMintIxes, lockIxes] = await Promise.all([
        callSolstice(apiKey, { type: "RequestMint",  data: { amount: Number(usxLamports), collateral: "usdc", user: owner.toBase58() } }),
        callSolstice(apiKey, { type: "ConfirmMint",  data: { user: owner.toBase58(), collateral: "usdc" } }),
        callSolstice(apiKey, { type: "Lock",         data: { amount: Number(usxLamports), user: owner.toBase58() } }),
      ]);
      const wrapIx = await buildEusxToCeUsxWrapIx({ user: owner, amount: eusxLamports });

      const usxAta   = getAssociatedTokenAddressSync(USX_MINT,   owner, false, TOKEN_PROGRAM_ID,         ASSOCIATED_TOKEN_PROGRAM_ID);
      const eusxAta  = getAssociatedTokenAddressSync(EUSX_MINT,  owner, false, TOKEN_PROGRAM_ID,         ASSOCIATED_TOKEN_PROGRAM_ID);
      const ceusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID,    ASSOCIATED_TOKEN_PROGRAM_ID);

      // Pre-flight: only emit create-idempotent for ATAs that don't
      // already exist. Each create ix costs ~6 accounts in the static
      // keys table; trimming pre-existing ones is the cheapest tx-size
      // win short of an ALT.
      const [usxAtaInfo, eusxAtaInfo, ceusxAtaInfo] = await connection.getMultipleAccountsInfo(
        [usxAta, eusxAta, ceusxAta], "confirmed",
      );
      const ataIxes: TransactionInstruction[] = [];
      if (!usxAtaInfo)   ataIxes.push(createAssociatedTokenAccountIdempotentInstruction(owner, usxAta,   owner, USX_MINT,   TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!eusxAtaInfo)  ataIxes.push(createAssociatedTokenAccountIdempotentInstruction(owner, eusxAta,  owner, EUSX_MINT,  TOKEN_PROGRAM_ID,      ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!ceusxAtaInfo) ataIxes.push(createAssociatedTokenAccountIdempotentInstruction(owner, ceusxAta, owner, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
        ...ataIxes,
        ...reqMintIxes,
        ...confMintIxes,
        ...lockIxes,
        wrapIx,
      ];
      const luts = await resolveUsxFlowLut();
      setLog((l) => [
        ...l,
        `bundle ix count: ${ixes.length} (skipped ${3 - ataIxes.length} pre-existing ATA-creates), wrap amount: ${(Number(eusxLamports) / 1e6).toFixed(4)} eUSX, lut: ${luts.length ? "resolved" : "none"}`,
      ]);
      await sendIxes("bundle USDC → ceUSX", ixes, luts);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleBundleOut() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    const ceusxLamports = getConvLamports(CEUSX_DECIMALS);
    if (ceusxLamports <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(ceusxBal * 10 ** CEUSX_DECIMALS)) < ceusxLamports) {
      setError(`Insufficient ceUSX in wallet: have ${ceusxBal}, need ${convAmountStr}. Withdraw from klend first if your ceUSX is collateral.`);
      return;
    }
    setBusy(true); setError(null);
    setLog([`bundle ceUSX → USDC: ${convAmountStr} ceUSX (Unwrap + Unlock + RequestRedeem + ConfirmRedeem, single tx) …`]);
    try {
      const owner = wallet.publicKey;

      // 1:1 passthrough on devnet (see comment block above). Each
      // downstream amount is undersized 0.1% so drift between API call
      // and tx execution leaves dust rather than reverts.
      const eusxLamports   = ceusxLamports;
      const usxOutLamports = BigInt(Math.floor(Number(eusxLamports) * 0.999));
      if (usxOutLamports <= 0n) { setError("Computed USX redeem amount is zero — try a larger ceUSX amount."); return; }

      const unwrapIx = await buildCeUsxToEusxUnwrapIx({ user: owner, amount: ceusxLamports });
      const [unlockIxes, reqRedeemIxes, confRedeemIxes] = await Promise.all([
        callSolstice(apiKey, { type: "Unlock",        data: { amount: Number(eusxLamports),    user: owner.toBase58() } }),
        callSolstice(apiKey, { type: "RequestRedeem", data: { amount: Number(usxOutLamports), collateral: "usdc", user: owner.toBase58() } }),
        callSolstice(apiKey, { type: "ConfirmRedeem", data: { user: owner.toBase58(), collateral: "usdc" } }),
      ]);

      const usdcAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const usxAta  = getAssociatedTokenAddressSync(USX_MINT,   owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const eusxAta = getAssociatedTokenAddressSync(EUSX_MINT,  owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const [usdcAtaInfo, usxAtaInfo, eusxAtaInfo] = await connection.getMultipleAccountsInfo(
        [usdcAta, usxAta, eusxAta], "confirmed",
      );
      const ataIxes: TransactionInstruction[] = [];
      if (!usdcAtaInfo) ataIxes.push(createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!usxAtaInfo)  ataIxes.push(createAssociatedTokenAccountIdempotentInstruction(owner, usxAta,  owner, USX_MINT,   TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      if (!eusxAtaInfo) ataIxes.push(createAssociatedTokenAccountIdempotentInstruction(owner, eusxAta, owner, EUSX_MINT,  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));

      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
        ...ataIxes,
        unwrapIx,
        ...unlockIxes,
        ...reqRedeemIxes,
        ...confRedeemIxes,
      ];
      const luts = await resolveUsxFlowLut();
      setLog((l) => [
        ...l,
        `bundle ix count: ${ixes.length} (skipped ${3 - ataIxes.length} pre-existing ATA-creates), redeem amount: ${(Number(usxOutLamports) / 1e6).toFixed(4)} USX, lut: ${luts.length ? "resolved" : "none"}`,
      ]);
      await sendIxes("bundle ceUSX → USDC", ixes, luts);
      setConv(null);
      setConvAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  // ── Convert / Wait / Unwind (leveraged) ──
  // Atomic flash-loan collateral swap: ceUSX → ceUSX-WT (convert) and
  // later ceUSX-WT → USDC (unwind). Mirrors the csSOL flow on the
  // credit-trade tab. See packages/programs/CEUSX_WITHDRAWAL.md.

  async function handleConvert() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    if (ceusxCollateral <= 0) { setError("No ceUSX collateral to convert."); return; }
    setBusy(true); setError(null);
    setLog([`convert ${ceusxCollateral.toFixed(4)} ceUSX → ceUSX-WT (atomic flash-loan swap)…`]);
    try {
      const owner = wallet.publicKey;
      const amount = BigInt(Math.floor(ceusxCollateral * 1e6));
      const obligation = await readObligation(connection, owner);
      const ixes = await buildConvertCeusxIxes({
        user: owner,
        amount,
        apiKey,
        newDeltaMintProgram: DELTA_MINT_PROGRAM,
        obligationDeposits: obligation.deposits.map((d) => d.reserve),
      });
      setLog((l) => [...l, `convert ix count: ${ixes.length}`]);
      await sendIxes("convert ceUSX → ceUSX-WT", ixes);
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleUnwind() {
    if (!wallet.publicKey || !ensureApiKey()) return;
    setBusy(true); setError(null);
    setLog([`unwind ceUSX-WT → USDC (atomic flash-loan + Solstice claim+redeem)…`]);
    try {
      const owner = wallet.publicKey;
      const obligation = await readObligation(connection, owner);
      const wtPos = obligation.deposits.find((d) => d.reserve.equals(CEUSX_WT_RESERVE));
      if (!wtPos) { setError("No ceUSX-WT collateral in obligation. Did you convert?"); return; }
      // Use the deposited cToken count converted to underlying as the
      // amount — caller can refine later if partial unwinds are needed.
      const ceusxPx = ceusxPrice > 0 ? ceusxPrice : 1;
      const wtUnderlying = Number(sfToNumber(wtPos.marketValueSf)) / ceusxPx;
      const amount = BigInt(Math.floor(wtUnderlying * 1e6));
      if (amount <= 0n) { setError("Computed unwind amount is zero."); return; }

      const ixes = await buildUnwindCeusxWtIxes({
        user: owner,
        amount,
        apiKey,
        obligationDeposits: obligation.deposits.map((d) => d.reserve),
      });
      setLog((l) => [...l, `unwind ix count: ${ixes.length}, amount: ${(Number(amount) / 1e6).toFixed(4)} ceUSX-WT`]);
      await sendIxes("unwind ceUSX-WT → USDC", ixes);
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  // ── UI ──

  if (!wallet.publicKey) {
    return <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>;
  }

  const collateralUsd = ceusxCollateral * ceusxPrice;
  const debtUsd = susdcDebt * susdcPrice;
  const equityUsd = collateralUsd - debtUsd;
  const ltvPct = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Constraint banner — explain why this is manual, not 1-tx */}
      <div className="alert alert-warning">
        <div className="text-xs">
          <div className="font-bold mb-1">Manual deposit + borrow flow</div>
          <div>
            The atomic flash-loan loop available for csSOL/wSOL is not possible
            here — Solstice's USX program gates <code>RequestMint</code> /
            <code>RequestRedeem</code> behind their operator multisig, so
            sUSDC↔USX cannot be CPI'd from a user-signed tx. The conversion
            pipeline below routes those steps through Solstice's REST API
            (user-signable instructions returned over HTTP); the eUSX↔ceUSX
            wrap/unwrap is native CPI on the legacy governor.
          </div>
        </div>
      </div>

      {/* Conversion pipeline — USDC ↔ USX ↔ eUSX ↔ ceUSX. The full chain
          a user must walk to get from raw devnet USDC to klend-depositable
          ceUSX collateral, and back. Each step is its own transaction. */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between mb-2">
            <span className="font-bold text-sm">Convert: USDC ↔ USX ↔ eUSX ↔ ceUSX</span>
            <span className="text-[11px] opacity-60">
              {apiKey ? (apiKeyFromEnv && !apiKeyDirty ? "API key from env" : "API key set") : "API key not set"}
            </span>
          </div>

          {/* API key input — needed for the four Solstice-API legs. Seed
              precedence: localStorage save → VITE_SOLSTICE_API_KEY env var
              (set in .env.local, mirrors frontend-institutional convention)
              → empty. Save button persists to localStorage so the override
              survives across reloads. */}
          <div className="mb-3 flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs opacity-60 block mb-1">
                Solstice API key (devnet){" "}
                {apiKeyFromEnv ? (
                  <span className="opacity-60">— autoloaded from <code>VITE_SOLSTICE_API_KEY</code></span>
                ) : (
                  <span className="opacity-60">— or set <code>VITE_SOLSTICE_API_KEY</code> in <code>.env.local</code></span>
                )}
              </label>
              <input
                type="password"
                className="input input-sm input-bordered w-full font-mono"
                placeholder="paste key (stays in browser localStorage)"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setApiKeyDirty(true); }}
                disabled={busy}
              />
            </div>
            <button
              className="btn btn-sm btn-outline"
              disabled={busy || !apiKeyDirty}
              onClick={persistApiKey}
            >
              Save
            </button>
          </div>

          {/* Balance grid — what's in the user's wallet at each rung. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-3">
            <div>
              <div className="opacity-60 text-[11px]">USDC (sUSDC mint)</div>
              <div className="font-mono">{fmt(usdcBal, 2)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">USX</div>
              <div className="font-mono">{fmt(usxBal, 2)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">eUSX</div>
              <div className="font-mono">{fmt(eusxBal, 2)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">ceUSX</div>
              <div className="font-mono">{fmt(ceusxBal, 2)}</div>
            </div>
          </div>

          {/* Bundled flows — atomic 3-step chains in a single tx. The
              Solstice API returns user-signable instructions, so we can
              fan out the API calls in parallel and concatenate them with
              the native governor wrap/unwrap. One signature, all hops
              succeed-or-roll-back atomically. */}
          <div className="text-[11px] opacity-60 mb-1">One-click (bundled, atomic):</div>
          <div className="flex gap-2 flex-wrap mb-3">
            <button
              className={`btn btn-xs ${conv === "bundle_in" ? "btn-primary" : "btn-secondary btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "bundle_in" ? null : "bundle_in"); setConvAmountStr(""); setError(null); }}
            >
              ⚡ USDC → ceUSX (Mint+Lock+Wrap)
            </button>
            <button
              className={`btn btn-xs ${conv === "bundle_out" ? "btn-primary" : "btn-secondary btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "bundle_out" ? null : "bundle_out"); setConvAmountStr(""); setError(null); }}
            >
              ⚡ ceUSX → USDC (Unwrap+Unlock+Redeem)
            </button>
          </div>

          {/* Forward direction (USDC → ceUSX) */}
          <div className="text-[11px] opacity-60 mb-1">Forward, step-by-step (debugging):</div>
          <div className="flex gap-2 flex-wrap mb-3">
            <button
              className={`btn btn-xs ${conv === "mint" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "mint" ? null : "mint"); setConvAmountStr(""); setError(null); }}
            >
              1. Mint USX (USDC→USX)
            </button>
            <button
              className={`btn btn-xs ${conv === "lock" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "lock" ? null : "lock"); setConvAmountStr(""); setError(null); }}
            >
              2. Lock (USX→eUSX)
            </button>
            <button
              className={`btn btn-xs ${conv === "wrap" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "wrap" ? null : "wrap"); setConvAmountStr(""); setError(null); }}
            >
              3. Wrap (eUSX→ceUSX)
            </button>
          </div>

          {/* Reverse direction (ceUSX → USDC) */}
          <div className="text-[11px] opacity-60 mb-1">Reverse, step-by-step (debugging):</div>
          <div className="flex gap-2 flex-wrap">
            <button
              className={`btn btn-xs ${conv === "unwrap" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "unwrap" ? null : "unwrap"); setConvAmountStr(""); setError(null); }}
            >
              1. Unwrap (ceUSX→eUSX)
            </button>
            <button
              className={`btn btn-xs ${conv === "unlock" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "unlock" ? null : "unlock"); setConvAmountStr(""); setError(null); }}
            >
              2. Unlock (eUSX→queued)
            </button>
            <button
              className={`btn btn-xs ${conv === "withdraw" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "withdraw" ? null : "withdraw"); setConvAmountStr(""); setError(null); }}
            >
              3. Claim (queued→USX)
            </button>
            <button
              className={`btn btn-xs ${conv === "redeem" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setConv(conv === "redeem" ? null : "redeem"); setConvAmountStr(""); setError(null); }}
            >
              4. Redeem (USX→USDC)
            </button>
          </div>

          {conv ? (() => {
            const avail = availableForConv();
            return (
            <div className="mt-4 p-3 bg-base-300/50 rounded">
              <div className="text-xs opacity-70 mb-2">
                {conv === "bundle_in" && "Atomic USDC → ceUSX in one tx. Fetches RequestMint / ConfirmMint / Lock from Solstice's REST API in parallel, builds the native governor wrap, submits all four ixes with one signature. Devnet's YieldVault is 1:1 (no actual yield accrued — the visible $1.08 ceUSX price is from the accrual oracle, not the vault index), so amounts pass through with a 0.1% undersize for drift. Tiny eUSX dust may stay in your ATA."}
                {conv === "bundle_out" && "Atomic ceUSX → USDC in one tx. Builds the native governor unwrap, fetches Unlock / RequestRedeem / ConfirmRedeem from Solstice's REST API in parallel, submits all four ixes with one signature. Devnet's YieldVault is 1:1, so amounts pass through with a 0.1% undersize for drift. Tiny USX dust may stay in your ATA."}
                {conv === "mint" && "Mint USX 1:1 from devnet USDC. Two ix bundle (RequestMint + ConfirmMint), both fetched from Solstice's REST API and submitted by your wallet."}
                {conv === "lock" && "Lock USX in the YieldVault — receive eUSX (yield-bearing wrapper, ~8-12% APY on mainnet)."}
                {conv === "wrap" && "Wrap eUSX → ceUSX via the legacy governor pool. KYC-gated: requires a whitelist_entry on the eUSX delta-mint config; the wrap CPI fails with AccountNotInitialized if you're not onboarded."}
                {conv === "unwrap" && "Burn ceUSX, receive eUSX back from the pool vault. No KYC check (burn-only)."}
                {conv === "unlock" && "Burn eUSX and queue an equivalent USX amount in your pending-unlock PDA — the YieldVault has an asynchronous claim pattern (the burned eUSX does NOT immediately mint USX into your wallet). After Unlock, click step 3 (Claim) to actually receive USX."}
                {conv === "withdraw" && "Claim the queued USX from your pending-unlock PDA via Solstice's `Withdraw` ix (disc 0xb712469c946da122) — mints USX from the vault's USX vault into your wallet and clears your pending PDA. The on-chain ix is amount-less (claims everything queued); the amount you enter is only required by the REST API and doesn't bound the on-chain effect. If this errors with a wait/cooldown code, the timelock hasn't elapsed — try again later."}
                {conv === "redeem" && "Redeem USX 1:1 for devnet USDC. Two ix bundle (RequestRedeem + ConfirmRedeem) via Solstice's REST API."}
              </div>
              {avail ? (
                <div className="flex items-baseline justify-between text-[11px] mb-1">
                  <span className="opacity-60">Available — {avail.label}</span>
                  <span className="font-mono">{fmt(avail.value, 4)}</span>
                </div>
              ) : null}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-xs opacity-60 block mb-1">Amount</label>
                  <input
                    type="number" step="any" min="0"
                    className="input input-sm input-bordered w-full"
                    value={convAmountStr}
                    onChange={(e) => setConvAmountStr(e.target.value)}
                    disabled={busy}
                  />
                </div>
                {avail && avail.value > 0 ? (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => setConvAmountStr(String(avail.value))}
                  >
                    Max
                  </button>
                ) : null}
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy || !convAmountStr || Number(convAmountStr) <= 0}
                  onClick={() => {
                    if (conv === "bundle_in") void handleBundleIn();
                    else if (conv === "bundle_out") void handleBundleOut();
                    else if (conv === "mint") void handleMintUsx();
                    else if (conv === "lock") void handleLockEusx();
                    else if (conv === "wrap") void handleWrapCeusx();
                    else if (conv === "unwrap") void handleUnwrapCeusx();
                    else if (conv === "unlock") void handleUnlockEusx();
                    else if (conv === "withdraw") void handleWithdrawClaim();
                    else if (conv === "redeem") void handleRedeemUsx();
                  }}
                >
                  {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                  Run
                </button>
              </div>
            </div>
            );
          })() : null}
        </div>
      </div>

      {/* Pool liquidity card */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between">
            <span className="font-bold text-sm">Pool liquidity (sUSDC)</span>
            <span className="text-[11px] opacity-60">single ix borrow capacity</span>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-2 text-sm">
            <div>
              <div className="opacity-60 text-[11px]">Available sUSDC</div>
              <div className="font-mono">{fmt(susdcAvailable, 2)}</div>
              <div className="text-[10px] opacity-50">{fmtUsd(susdcAvailable * susdcPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">ceUSX price</div>
              <div className="font-mono">{fmtUsd(ceusxPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">sUSDC price</div>
              <div className="font-mono">{fmtUsd(susdcPrice)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Position card */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between mb-2">
            <span className="font-bold text-sm">Position</span>
            <span className="text-[11px] opacity-60">
              eMode group {elevationGroup} {elevationGroup === ELEVATION_GROUP_STABLES ? "(Stables, 90% LTV)" : "(base LTV)"}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="opacity-60 text-xs">Collateral (ceUSX)</div>
              <div className="font-mono">{fmt(ceusxCollateral, 4)}</div>
              <div className="text-xs opacity-50">{fmtUsd(collateralUsd)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">Debt (sUSDC)</div>
              <div className="font-mono">{fmt(susdcDebt, 4)}</div>
              <div className="text-xs opacity-50">{fmtUsd(debtUsd)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">Equity</div>
              <div className="font-mono">{fmtUsd(equityUsd)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">Current LTV</div>
              <div className="font-mono">{ltvPct.toFixed(2)}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Leveraged Convert / Wait / Unwind — atomic flash-loan collateral
          swap for users who want to start a Solstice unlock without
          deleveraging first. See CEUSX_WITHDRAWAL.md for the full design. */}
      <div className="card bg-base-300/60">
        <div className="card-body p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <span className="font-bold text-sm">Leveraged unwind (Convert → Wait → Unwind)</span>
            <span className="text-[11px] opacity-60">flash-loan collateral swap, single tx per step</span>
          </div>
          <div className="text-xs opacity-70">
            Atomic alternative to manual unwind. Step 1 swaps your ceUSX
            collateral for ceUSX-WT (a placeholder representing your
            queued Solstice unlock) — your leverage is preserved. Step 2
            is the Solstice unlock wait period (their pending-unlock
            PDA matures asynchronously). Step 3 burns ceUSX-WT, claims
            USX from Solstice, redeems to USDC, repays your sUSDC debt
            — all in one tx via a sUSDC flash-loan.
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <div className="opacity-60 text-[11px]">ceUSX collateral</div>
              <div className="font-mono">{fmt(ceusxCollateral, 4)}</div>
              <div className="text-[10px] opacity-50">{fmtUsd(ceusxCollateral * ceusxPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">sUSDC debt</div>
              <div className="font-mono">{fmt(susdcDebt, 4)}</div>
              <div className="text-[10px] opacity-50">{fmtUsd(susdcDebt * susdcPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">eMode</div>
              <div className="font-mono">{elevationGroup === ELEVATION_GROUP_STABLES ? "Stables (1)" : "base"}</div>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              className="btn btn-sm btn-warning"
              disabled={busy || ceusxCollateral <= 0}
              onClick={() => void handleConvert()}
            >
              {busy ? <span className="loading loading-spinner loading-xs" /> : null}
              1. Convert all ceUSX → ceUSX-WT
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void handleUnwind()}
            >
              {busy ? <span className="loading loading-spinner loading-xs" /> : null}
              3. Unwind ceUSX-WT → USDC (after wait)
            </button>
          </div>

          <div className="text-[11px] opacity-50 italic">
            ⚠️ Experimental — Solstice CPI account ordering not yet
            verified end-to-end. First-run errors expected; logs will
            surface the specific account-mismatch for iteration.
            Convert size = full ceUSX collateral; partial conversion
            not yet wired. Mode-45 borrow caps for sUSDC against
            ceUSX-WT may need a follow-up update_reserve_config run.
          </div>
        </div>
      </div>

      {/* Wallet balances + action picker */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between mb-3">
            <span className="font-bold text-sm">Wallet</span>
            <span className="text-[11px] opacity-60">connected: {wallet.publicKey.toBase58().slice(0, 8)}…</span>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm mb-4">
            <div>
              <div className="opacity-60 text-xs">ceUSX balance</div>
              <div className="font-mono">{fmt(ceusxBal, 4)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">sUSDC balance</div>
              <div className="font-mono">{fmt(susdcBal, 4)}</div>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              className={`btn btn-sm ${action === "deposit" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setAction(action === "deposit" ? null : "deposit"); setAmountStr(""); setError(null); }}
            >
              Deposit ceUSX
            </button>
            <button
              className={`btn btn-sm ${action === "borrow" ? "btn-primary" : "btn-outline"}`}
              disabled={busy || ceusxCollateral <= 0}
              onClick={() => { setAction(action === "borrow" ? null : "borrow"); setAmountStr(""); setError(null); }}
            >
              Borrow sUSDC
            </button>
            <button
              className={`btn btn-sm ${action === "repay" ? "btn-primary" : "btn-outline"}`}
              disabled={busy || susdcDebt <= 0}
              onClick={() => { setAction(action === "repay" ? null : "repay"); setAmountStr(""); setError(null); }}
            >
              Repay sUSDC
            </button>
            <button
              className={`btn btn-sm ${action === "withdraw" ? "btn-primary" : "btn-outline"}`}
              disabled={busy || ceusxCollateral <= 0}
              onClick={() => { setAction(action === "withdraw" ? null : "withdraw"); setAmountStr(""); setError(null); }}
            >
              Withdraw ceUSX
            </button>
          </div>

          {action ? (() => {
            const avail = availableForAction();
            return (
            <div className="mt-4 p-3 bg-base-300/50 rounded">
              <div className="text-xs opacity-70 mb-2">
                {action === "deposit" && "Move ceUSX from your wallet into klend collateral. First borrow auto-enters Stables eMode (90% LTV)."}
                {action === "borrow" && "Borrow sUSDC against your ceUSX collateral. If not in Stables eMode yet, this tx will request it before the borrow."}
                {action === "repay" && "Pull sUSDC from your wallet to pay down the obligation's debt."}
                {action === "withdraw" && "Pull ceUSX out of klend back to your wallet. Subject to LTV constraints if you have outstanding debt."}
              </div>
              {avail ? (
                <div className="flex items-baseline justify-between text-[11px] mb-1">
                  <span className="opacity-60">Available — {avail.label}</span>
                  <span className="font-mono">{fmt(avail.value, 4)}</span>
                </div>
              ) : null}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-xs opacity-60 block mb-1">Amount</label>
                  <input
                    type="number" step="any" min="0"
                    className="input input-sm input-bordered w-full"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    disabled={busy}
                  />
                </div>
                {avail && avail.value > 0 ? (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy}
                    onClick={() => setAmountStr(String(avail.value))}
                  >
                    Max
                  </button>
                ) : null}
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy || !amountStr || Number(amountStr) <= 0}
                  onClick={() => {
                    if (action === "deposit") void handleDeposit();
                    else if (action === "borrow") void handleBorrow();
                    else if (action === "repay") void handleRepay();
                    else if (action === "withdraw") void handleWithdraw();
                  }}
                >
                  {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                  {action === "deposit" && "Deposit"}
                  {action === "borrow" && "Borrow"}
                  {action === "repay" && "Repay"}
                  {action === "withdraw" && "Withdraw"}
                </button>
              </div>
            </div>
            );
          })() : null}
        </div>
      </div>

      {/* Tx console */}
      {(log.length > 0 || error) ? (
        <div className="card bg-base-300/60">
          <div className="card-body p-4">
            <div className="font-bold text-sm mb-2">Transaction console</div>
            {error ? (
              <div className="alert alert-error text-xs mb-2">
                <pre className="whitespace-pre-wrap break-all">{error}</pre>
              </div>
            ) : null}
            <pre className="text-xs whitespace-pre-wrap break-all opacity-70">
              {log.join("\n")}
            </pre>
          </div>
        </div>
      ) : null}

      <div className="text-[11px] opacity-50">
        Reserves — ceUSX: {CEUSX_RESERVE.toBase58().slice(0, 8)}… · sUSDC:{" "}
        {SUSDC_RESERVE.toBase58().slice(0, 8)}… · obligation:{" "}
        {obligationPda(wallet.publicKey).toBase58().slice(0, 8)}…
      </div>
    </div>
  );
}
