/**
 * CeusxSusdcCreditPanel — manual deposit + borrow on EG-1 (ceUSX
 * collateral, sUSDC debt). Atomic flash-loop is impossible here because
 * Solstice's USX program gates RequestMint/RequestRedeem behind an
 * operator multisig — sUSDC↔USX can't be CPI'd from a user-signed tx.
 * Close uses the existing redeemCeusx flash loop (Convert → epoch wait
 * → Unwind), reusing builders already shared with PositionsPage.
 */

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  FormLabel,
  Input,
  SectionHeader,
  Snackbar,
  Stat,
  TokenAmountInput,
  TokenIcon,
  TokenSymbol,
  cn,
} from "@clearstone/design-system";

import {
  CEUSX_MINT,
  CEUSX_RESERVE,
  CEUSX_RESERVE_ORACLE,
  CEUSX_WT_RESERVE,
  ELEVATION_GROUP_STABLES,
  SUSDC_MINT,
  SUSDC_RESERVE,
  SUSDC_RESERVE_ORACLE,
} from "../../lib/credit-trade/addresses";
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
} from "../../lib/credit-trade/klendIx";
import { readObligation, readReserve, sfToNumber } from "../../lib/credit-trade/obligationView";
import {
  buildConvertCeusxIxes,
  buildUnwindCeusxWtIxes,
} from "../../lib/lib/redeemCeusx";
import { ObligationSwitcher } from "../ObligationSwitcher";
import { useObligationCatalog } from "../../hooks/useObligationCatalog";

type Action = "deposit" | "borrow" | "repay" | "withdraw" | null;

const CEUSX_DECIMALS = 6;
const SUSDC_DECIMALS = 6;
const SOLSTICE_API_KEY_STORAGE = "frontend-institutional.solsticeApiKey";

function fmt(n: number, dp = 4): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtErr(e: unknown): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return (e as { message?: string }).message ?? JSON.stringify(e);
}

interface CeusxSusdcCreditPanelProps {
  /** Controlled obligation id from the parent page. When supplied the
   *  panel hands selection back to the parent (so the page can snap
   *  the credit-trade variant when the user picks an EG-1 / EG-2
   *  obligation, etc.). Falls back to internal state for standalone
   *  usage. */
  obligationId?: number;
  onObligationChange?: (id: number) => void;
}

export default function CeusxSusdcCreditPanel({ obligationId, onObligationChange }: CeusxSusdcCreditPanelProps = {}) {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Klend obligation seed-id this panel drives. Defaults to 0 (the
  // canonical credit-trade obligation) but the ObligationSwitcher
  // below lets the user pick any sibling obligation — every read
  // (`readObligation`) and every klend ix builder takes this as
  // `obligationId`. Catalog comes from the same shared hook the
  // LST/SOL panel + PositionsPage use, so a deposit fired in any
  // surface re-populates every other surface's switcher pills.
  // Controlled-with-fallback: prefers the parent's `obligationId`
  // when provided so CreditTradePage can snap variant on EG change.
  const [internalObligationId, setInternalObligationId] = useState<number>(0);
  const selectedObligationId = obligationId ?? internalObligationId;
  const setSelectedObligationId = (id: number) => {
    setInternalObligationId(id);
    onObligationChange?.(id);
  };
  const [catalogNonce, setCatalogNonce] = useState(0);
  const { catalog: obligationCatalog } = useObligationCatalog({
    selected: selectedObligationId,
    nonce: catalogNonce,
  });

  // Reserves
  const [ceusxPrice, setCeusxPrice] = useState(0);
  const [susdcPrice, setSusdcPrice] = useState(0);
  const [susdcAvailable, setSusdcAvailable] = useState(0);

  // Wallet balances
  const [ceusxBal, setCeusxBal] = useState(0);
  const [susdcBal, setSusdcBal] = useState(0);

  // Obligation
  const [ceusxCollateral, setCeusxCollateral] = useState(0);
  const [ceusxWtCollateral, setCeusxWtCollateral] = useState(0);
  const [susdcDebt, setSusdcDebt] = useState(0);
  const [elevationGroup, setElevationGroup] = useState(0);
  const [obligationExists, setObligationExists] = useState(false);
  const [userMetaExists, setUserMetaExists] = useState(false);
  const [obligationDeposits, setObligationDeposits] = useState<PublicKey[]>([]);

  // Forms
  const [action, setAction] = useState<Action>(null);
  const [amountStr, setAmountStr] = useState("");

  // Solstice API key. Seed precedence: localStorage → VITE env → empty.
  const [apiKey, setApiKey] = useState<string>(() => {
    try {
      const fromLs = localStorage.getItem(SOLSTICE_API_KEY_STORAGE);
      if (fromLs) return fromLs;
    } catch {/* */}
    return ((import.meta.env as Record<string, string | undefined>).VITE_SOLSTICE_API_KEY) ?? "";
  });
  const [apiKeyDirty, setApiKeyDirty] = useState(false);

  async function refresh() {
    if (!wallet.publicKey) return;
    setError(null);
    try {
      const owner = wallet.publicKey;
      const [ceusxRes, susdcRes, obligation] = await Promise.all([
        readReserve(connection, CEUSX_RESERVE, CEUSX_RESERVE_ORACLE),
        readReserve(connection, SUSDC_RESERVE, SUSDC_RESERVE_ORACLE),
        readObligation(connection, owner, selectedObligationId),
      ]);
      if (ceusxRes) setCeusxPrice(sfToNumber(ceusxRes.marketPriceSf));
      if (susdcRes) {
        setSusdcPrice(sfToNumber(susdcRes.marketPriceSf));
        setSusdcAvailable(Number(susdcRes.availableAmount) / 10 ** SUSDC_DECIMALS);
      }

      const dep = obligation.deposits.find((d) => d.reserve.equals(CEUSX_RESERVE));
      const wtDep = obligation.deposits.find((d) => d.reserve.equals(CEUSX_WT_RESERVE));
      const bor = obligation.borrows.find((b) => b.reserve.equals(SUSDC_RESERVE));
      // Decode the raw on-chain amount fields directly instead of going
      // via `market_value_sf / price`. The market-value field can read
      // as 0 inside an elevation group (klend's borrow-factor accounting
      // shifts depending on EG state), which is why the Manage tab's
      // byte-scan correctly showed 12 sUSDC while this panel showed
      // 0.0000 for the same obligation. Same approach as the LST/SOL
      // panel — `borrowedAmountSf >> 60 / 10**decimals` for borrows,
      // `depositedCtokens / 10**decimals` for deposits (cToken supply
      // is 1:1 with underlying for fresh reserves; for accrued reserves
      // we'd multiply by exchange rate, but ceUSX's WT path keeps both
      // 1:1 by design). */
      setCeusxCollateral(dep ? Number(dep.depositedCtokens) / 10 ** CEUSX_DECIMALS : 0);
      setCeusxWtCollateral(wtDep ? Number(wtDep.depositedCtokens) / 10 ** CEUSX_DECIMALS : 0);
      setSusdcDebt(bor ? sfToNumber(bor.borrowedAmountSf) / 10 ** SUSDC_DECIMALS : 0);
      setElevationGroup(obligation.elevationGroup);
      setObligationExists(obligation.exists);
      setObligationDeposits(obligation.deposits.map((d) => d.reserve));

      const ceusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const susdcAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [ceusxBalRaw, susdcBalRaw] = await Promise.all([
        connection.getTokenAccountBalance(ceusxAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
        connection.getTokenAccountBalance(susdcAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
      ]);
      setCeusxBal(ceusxBalRaw);
      setSusdcBal(susdcBalRaw);

      const metaInfo = await connection.getAccountInfo(userMetadataPda(owner), "confirmed");
      setUserMetaExists(!!metaInfo);
    } catch (e) {
      setError(fmtErr(e));
    }
  }

  useEffect(() => {
    void refresh();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [wallet.publicKey?.toBase58(), selectedObligationId]);

  function getLamports(decimals: number): bigint {
    const n = Number(amountStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * 10 ** decimals));
  }

  async function buildInitIxesIfNeeded(): Promise<TransactionInstruction[]> {
    if (!wallet.publicKey) return [];
    const out: TransactionInstruction[] = [];
    if (!userMetaExists) out.push(await buildInitUserMetadataIx(wallet.publicKey, wallet.publicKey));
    // Pass `(tag=0, id=selectedObligationId)` so init lazily creates the
    // active obligation PDA — without this, every action would init
    // obligation #0 regardless of which pill the user selected.
    if (!obligationExists) {
      out.push(await buildInitObligationIx(wallet.publicKey, wallet.publicKey, 0, selectedObligationId));
    }
    return out;
  }

  /** Standard refresh chain — refresh every active reserve plus the
   *  target reserve last (klend's check_refresh requires the target at
   *  N-2 of the action ix), then refresh_obligation. */
  async function buildRefreshChain(targetReserve: PublicKey): Promise<TransactionInstruction[]> {
    const owner = wallet.publicKey!;
    const obligation = await readObligation(connection, owner, selectedObligationId);
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
      const oracle = r.equals(CEUSX_RESERVE) || r.equals(CEUSX_WT_RESERVE) ? CEUSX_RESERVE_ORACLE : SUSDC_RESERVE_ORACLE;
      out.push(await buildRefreshReserveIx(r, oracle));
    }
    const oracle = targetReserve.equals(CEUSX_RESERVE) || targetReserve.equals(CEUSX_WT_RESERVE)
      ? CEUSX_RESERVE_ORACLE : SUSDC_RESERVE_ORACLE;
    out.push(await buildRefreshReserveIx(targetReserve, oracle));
    out.push(await buildRefreshObligationIx(
      owner,
      [...obligation.deposits.map((d) => d.reserve), ...obligation.borrows.map((b) => b.reserve)],
      [],
      selectedObligationId,
    ));
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

  async function handleDeposit() {
    if (!wallet.publicKey) return;
    const amount = getLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(ceusxBal * 10 ** CEUSX_DECIMALS)) < amount) {
      setError(`Insufficient ceUSX: have ${ceusxBal}, need ${amountStr}. Mint USX → ceUSX via the Prepare tab first.`);
      return;
    }
    setBusy(true); setError(null); setLog([`deposit ${amountStr} ceUSX…`]);
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
        obligationId: selectedObligationId,
      }));
      await send(ixes, "deposit ceUSX");
      setAction(null); setAmountStr("");
      await refresh();
    } catch (e) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleBorrow() {
    if (!wallet.publicKey) return;
    const amount = getLamports(SUSDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (Number(amount) > susdcAvailable * 10 ** SUSDC_DECIMALS) {
      setError(`Reserve only has ${susdcAvailable.toFixed(2)} sUSDC available.`);
      return;
    }
    setBusy(true); setError(null); setLog([`borrow ${amountStr} sUSDC…`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner, selectedObligationId);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      // Auto-enter EG-1 (Stables) if not already and only ceUSX collateral.
      const onlyCeusxCollateral =
        obligation.deposits.length === 0 ||
        obligation.deposits.every((d) => d.reserve.equals(CEUSX_RESERVE));
      const noBorrowsYet = obligation.borrows.length === 0;
      if (obligation.elevationGroup !== ELEVATION_GROUP_STABLES && onlyCeusxCollateral && noBorrowsYet) {
        ixes.push(await buildRefreshReserveIx(CEUSX_RESERVE, CEUSX_RESERVE_ORACLE));
        ixes.push(await buildRefreshReserveIx(SUSDC_RESERVE, SUSDC_RESERVE_ORACLE));
        ixes.push(await buildRefreshObligationIx(
          owner,
          obligation.deposits.map((d) => d.reserve),
          [],
          selectedObligationId,
        ));
        ixes.push(await buildRequestElevationGroupIx(
          owner,
          ELEVATION_GROUP_STABLES,
          obligation.deposits.map((d) => d.reserve),
          [],
          selectedObligationId,
        ));
      }
      ixes.push(...await buildRefreshChain(SUSDC_RESERVE));
      ixes.push(await buildBorrowObligationLiquidityIx({
        user: owner, borrowReserve: SUSDC_RESERVE,
        liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userDestinationLiquidity: userAta, amount,
        obligationDepositReserves: obligation.deposits.map((d) => d.reserve),
        obligationId: selectedObligationId,
      }));
      await send(ixes, "borrow sUSDC");
      setAction(null); setAmountStr("");
      await refresh();
    } catch (e) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleRepay() {
    if (!wallet.publicKey) return;
    const amount = getLamports(SUSDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(susdcBal * 10 ** SUSDC_DECIMALS)) < amount) {
      setError(`Insufficient sUSDC: have ${susdcBal}, need ${amountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`repay ${amountStr} sUSDC…`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner, selectedObligationId);
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
        obligationDepositReserves: obligation.deposits.map((d) => d.reserve),
        obligationId: selectedObligationId,
      }));
      await send(ixes, "repay sUSDC");
      setAction(null); setAmountStr("");
      await refresh();
    } catch (e) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleWithdraw() {
    if (!wallet.publicKey) return;
    const amount = getLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    setBusy(true); setError(null); setLog([`withdraw ${amountStr} ceUSX…`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner, selectedObligationId);
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
        obligationId: selectedObligationId,
      }));
      await send(ixes, "withdraw ceUSX");
      setAction(null); setAmountStr("");
      await refresh();
    } catch (e) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  // ── Convert / Unwind (leveraged close via ceUSX-WT) ──
  async function handleConvert() {
    if (!wallet.publicKey) return;
    if (!apiKey) { setError("Solstice API key required for the convert flow."); return; }
    if (ceusxCollateral <= 0) { setError("No ceUSX collateral to convert."); return; }
    setBusy(true); setError(null);
    setLog([`convert ${ceusxCollateral.toFixed(4)} ceUSX → ceUSX-WT (atomic flash-loan swap)…`]);
    try {
      const owner = wallet.publicKey;
      const amount = BigInt(Math.floor(ceusxCollateral * 10 ** CEUSX_DECIMALS));
      const ixes = await buildConvertCeusxIxes({
        user: owner,
        amount,
        apiKey,
        obligationDeposits,
      });
      setLog((l) => [...l, `convert ix count: ${ixes.length}`]);
      await send(ixes, "convert ceUSX → ceUSX-WT");
      await refresh();
    } catch (e) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleUnwind() {
    if (!wallet.publicKey) return;
    if (!apiKey) { setError("Solstice API key required for the unwind flow."); return; }
    setBusy(true); setError(null);
    setLog([`unwind ceUSX-WT → USDC (atomic flash-loan + Solstice claim+redeem)…`]);
    try {
      const owner = wallet.publicKey;
      if (ceusxWtCollateral <= 0) { setError("No ceUSX-WT collateral in obligation. Did you convert?"); return; }
      const amount = BigInt(Math.floor(ceusxWtCollateral * 10 ** CEUSX_DECIMALS));
      if (amount <= 0n) { setError("Computed unwind amount is zero."); return; }
      const ixes = await buildUnwindCeusxWtIxes({
        user: owner,
        amount,
        apiKey,
        obligationDeposits,
      });
      setLog((l) => [...l, `unwind ix count: ${ixes.length}, amount: ${(Number(amount) / 10 ** CEUSX_DECIMALS).toFixed(4)} ceUSX-WT`]);
      await send(ixes, "unwind ceUSX-WT → USDC");
      await refresh();
    } catch (e) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  function persistApiKey() {
    try { localStorage.setItem(SOLSTICE_API_KEY_STORAGE, apiKey); } catch {/* */}
    setApiKeyDirty(false);
  }

  if (!wallet.publicKey) {
    return (
      <Card tone="muted" size="md">
        <p className="text-sm text-base-content/65">Connect a wallet to start a credit trade.</p>
      </Card>
    );
  }

  const collateralUsd = ceusxCollateral * ceusxPrice;
  const debtUsd = susdcDebt * susdcPrice;
  const equityUsd = collateralUsd - debtUsd;
  const ltvPct = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;
  const hasPosition = ceusxCollateral > 0 || susdcDebt > 0 || ceusxWtCollateral > 0;
  const hasWtTicket = ceusxWtCollateral > 0;

  function inputForAction(): { decimals: number; balance: number; symbol: TokenSymbol; balanceUnit: string } | null {
    switch (action) {
      case "deposit":  return { decimals: CEUSX_DECIMALS, balance: ceusxBal, symbol: "ceUSX" as TokenSymbol, balanceUnit: "ceUSX in wallet" };
      case "borrow":   return { decimals: SUSDC_DECIMALS, balance: susdcAvailable, symbol: "USDC" as TokenSymbol, balanceUnit: "sUSDC available" };
      case "repay":    return { decimals: SUSDC_DECIMALS, balance: Math.min(susdcBal, susdcDebt), symbol: "USDC" as TokenSymbol, balanceUnit: "min(wallet, debt)" };
      case "withdraw": return { decimals: CEUSX_DECIMALS, balance: ceusxCollateral, symbol: "ceUSX" as TokenSymbol, balanceUnit: "ceUSX collateral" };
      default: return null;
    }
  }
  const actionInput = inputForAction();
  const actionHandler = action === "deposit" ? handleDeposit
    : action === "borrow"  ? handleBorrow
    : action === "repay"   ? handleRepay
    : action === "withdraw"? handleWithdraw
    : null;

  return (
    <div className="space-y-6 pb-12">
      {/* Obligation switcher — same pill row the LST/SOL variant +
          PositionsPage use, so the user can drive any obligation from
          this panel rather than being silently pinned to id=0.
          Selection threads through `selectedObligationId` into every
          readObligation + ix builder call below. */}
      {wallet.publicKey && (
        <ObligationSwitcher
          value={selectedObligationId}
          onChange={(id) => { setSelectedObligationId(id); setCatalogNonce((n) => n + 1); }}
          catalog={obligationCatalog}
          onCreate={() => {
            const used = new Set(obligationCatalog.map((e) => e.id));
            for (let i = 0; i < 256; i++) {
              if (!used.has(i)) { setSelectedObligationId(i); return; }
            }
          }}
        />
      )}

      {/* Constraint banner */}
      <Snackbar
        variant="inline"
        type="warning"
        message="Manual deposit + borrow flow"
        detail="Solstice's USX program gates RequestMint/RequestRedeem behind their operator multisig — the open leg can't be CPI'd from a user-signed tx like the csSOL/wSOL variant. Each step below is its own tx. The close mechanic (Convert → Wait → Unwind) IS atomic via flash-loan."
      />

      {/* Solstice API key prompt — needed for Convert/Unwind close flow */}
      {!apiKey && (
        <Card tone="muted" size="md">
          <SectionHeader
            title="Solstice API key"
            subtitle="Required for the leveraged close mechanic (Convert + Unwind). Set VITE_SOLSTICE_API_KEY in .env to skip this prompt across reloads."
            actions={
              <Badge tone="warning" variant="soft">key required for close</Badge>
            }
          />
          <div className="space-y-2">
            <FormLabel htmlFor="solstice-key" required>API key</FormLabel>
            <div className="flex gap-2">
              <Input
                id="solstice-key"
                type="password"
                placeholder="Paste API key…"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setApiKeyDirty(true); }}
                disabled={busy}
              />
              <Button variant="secondary" size="md" disabled={busy || !apiKeyDirty} onClick={persistApiKey}>Save</Button>
            </div>
            <p className="text-[11px] text-base-content/55">Stored in browser localStorage. Devnet only.</p>
          </div>
        </Card>
      )}

      {/* Stats — pool + obligation summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat size="sm" label="ceUSX price" value={fmtUsd(ceusxPrice)} accent="info" />
        <Stat size="sm" label="sUSDC available" value={fmt(susdcAvailable, 2)} accent="primary" />
        <Stat size="sm" label="Active EG" value={elevationGroup === 1 ? "EG-1 stables" : elevationGroup === 0 ? "no EG" : `EG-${elevationGroup}`} accent="accent" />
        <Stat size="sm" label="Current LTV" value={hasPosition ? `${ltvPct.toFixed(2)}%` : "—"} accent="info" />
      </div>

      {/* Open position — split-ledger card. Mirrors the LST/SOL panel's
          structure (collateral side stacks ceUSX + ceUSX-WT entries,
          debt side carries sUSDC) so the two credit-trade variants
          read as the same product. Inline buttons cover the limited
          set of actions this panel exposes:
            - ceUSX row     → "Convert to ceUSX-WT →" (handleConvert)
            - ceUSX-WT row  → "Unwind to USDC →"      (handleUnwind)
            - sUSDC debt    → "Repay →"               (opens the manage form)
          The "open" / leverage flow lives in the Manage card below as
          a plain Borrow — Solstice's USX program is multisig-gated so
          the LST/SOL flash-bundle pattern doesn't apply here. */}
      {(hasPosition || hasWtTicket) && (() => {
        // ceUSX-WT is priced ≈ 1:1 by the same oracle as ceUSX during
        // the unlock window, so the USD valuation reuses ceusxPrice.
        const ceusxWtUsdLocal = ceusxWtCollateral * ceusxPrice;
        const collValueUsd = collateralUsd + ceusxWtUsdLocal;
        const debtValueUsd = debtUsd;
        const equityValueUsd = collValueUsd - debtValueUsd;
        const currentLtvPct = collValueUsd > 0 ? (debtValueUsd / collValueUsd) * 100 : 0;
        const liqThresholdPct = 92;
        const ltvCapPct = 90;
        const healthFactor = debtValueUsd > 0
          ? (collValueUsd * (liqThresholdPct / 100)) / debtValueUsd
          : Infinity;
        const ltvBarPct = Math.min(currentLtvPct, 100);
        const ltvBarTone =
          currentLtvPct < ltvCapPct * 0.7 ? "bg-success" :
          currentLtvPct < ltvCapPct * 0.95 ? "bg-warning" : "bg-error";
        const hfTone =
          !Number.isFinite(healthFactor) ? "text-base-content/40" :
          healthFactor > 1.5 ? "text-success" :
          healthFactor > 1.1 ? "text-warning" : "text-error";

        return (
          <Card tone="elevated" size="lg">
            <CardHeader
              title="Open position"
              eyebrow="EG-1 · Stables · 90% LTV cap · 92% liq threshold"
              actions={
                elevationGroup === ELEVATION_GROUP_STABLES
                  ? <Badge tone="primary" variant="solid" size="md">EG-1 active</Badge>
                  : <Badge tone="neutral" variant="soft" size="md">EG-{elevationGroup} · base LTV</Badge>
              }
            />

            <div className="grid md:grid-cols-2 gap-3 items-start">
              {/* COLLATERAL side */}
              <div className="relative rounded-2xl border border-success/30 bg-gradient-to-br from-success/10 via-success/[0.04] to-transparent">
                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl overflow-hidden">
                  <span className="absolute -top-10 -right-10 h-32 w-32 rounded-full opacity-25 blur-2xl"
                    style={{ background: "radial-gradient(closest-side, var(--color-success, #2E7D5B), transparent 70%)" }} />
                </span>
                <div className="relative">
                  <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <Badge tone="success" variant="soft" size="xs">collateral</Badge>
                    <span className="text-[10px] text-base-content/40 font-mono uppercase tracking-[0.18em]">supplied</span>
                  </div>

                  {/* ceUSX row — primary collateral. Convert button
                      atomically swaps ceUSX → ceUSX-WT collateral via
                      the redeemCeusx flash loop and queues the
                      Solstice unlock. Disabled without the Solstice
                      API key. */}
                  {ceusxCollateral > 0 && (
                    <div className="px-5 py-3 border-t border-success/20">
                      <div className="flex items-center gap-3">
                        <TokenIcon symbol={"ceUSX" as TokenSymbol} size="md" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-display text-xl tabular-nums leading-none tracking-tight">
                              {fmt(ceusxCollateral)}
                            </span>
                            <span className="text-xs text-base-content/55 font-mono tabular-nums">{fmtUsd(collateralUsd)}</span>
                          </div>
                          <div className="flex items-center justify-between mt-1 gap-2">
                            <span className="text-[11px] text-base-content/55 font-mono">
                              ceUSX · KYC USD Coin · <span className="text-success">~10% APY</span>
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy || !apiKey}
                              title={!apiKey ? "Solstice API key required for the Convert flow" : undefined}
                              onClick={() => void handleConvert()}
                            >
                              Convert to ceUSX-WT →
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ceUSX-WT row — Solstice unlock ticket. Unwind
                      button atomically redeems WT → USDC and repays
                      the sUSDC debt. The Solstice pending-unlock PDA
                      isn't externally queryable, so we don't gate the
                      button on maturity — the user retries until the
                      tx lands (panel surfaces the revert message). */}
                  {ceusxWtCollateral > 0 && (
                    <div className="px-5 py-3 border-t border-success/20 bg-warning/[0.04]">
                      <div className="flex items-start gap-3">
                        <TokenIcon symbol={"ceUSX" as TokenSymbol} size="md" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0 space-y-2">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="font-display text-xl tabular-nums leading-none tracking-tight">
                                  {fmt(ceusxWtCollateral)}
                                </span>
                                <span className="text-xs text-base-content/55 font-mono tabular-nums">
                                  ≈ {fmtUsd(ceusxWtUsdLocal)}
                                </span>
                              </div>
                              <div className="text-[11px] text-base-content/55 font-mono">
                                ceUSX-WT · withdraw ticket ·{" "}
                                <span className="text-base-content/40">Solstice unlock pending</span>
                              </div>
                              <div className="pt-1">
                                <Badge tone="warning" variant="solid" size="xs">QUEUED</Badge>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-2 flex-shrink-0">
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy || !apiKey || ceusxWtCollateral <= 0}
                                title={!apiKey ? "Solstice API key required for the Unwind flow" : undefined}
                                onClick={() => void handleUnwind()}
                              >
                                Unwind to USDC →
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* DEBT side — single-asset (sUSDC). Repay button toggles
                  the manage-card's repay form below so the user has a
                  precise amount input rather than a one-shot full-repay. */}
              <div className="relative rounded-2xl border border-warning/30 bg-gradient-to-br from-warning/10 via-warning/[0.04] to-transparent">
                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl overflow-hidden">
                  <span className="absolute -top-10 -right-10 h-32 w-32 rounded-full opacity-25 blur-2xl"
                    style={{ background: "radial-gradient(closest-side, var(--color-warning, #B57F3A), transparent 70%)" }} />
                </span>
                <div className="relative">
                  <div className="flex items-center justify-between px-5 pt-4 pb-3">
                    <Badge tone="warning" variant="soft" size="xs">debt</Badge>
                    <span className="text-[10px] text-base-content/40 font-mono uppercase tracking-[0.18em]">borrowed</span>
                  </div>

                  <div className="px-5 py-3 border-t border-warning/20">
                    <div className="flex items-center gap-3">
                      <TokenIcon symbol={"USDC" as TokenSymbol} size="md" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-display text-xl tabular-nums leading-none tracking-tight">
                            {fmt(susdcDebt)}
                          </span>
                          <span className="text-xs text-base-content/55 font-mono tabular-nums">
                            {fmtUsd(debtValueUsd)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-1 gap-2">
                          <span className="text-[11px] text-base-content/55 font-mono">
                            sUSDC · Solstice savings · <span className="text-warning">borrow APR</span>
                          </span>
                          {susdcDebt > 0 && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                setAction(action === "repay" ? null : "repay");
                                setAmountStr("");
                              }}
                            >
                              {action === "repay" ? "Cancel" : "Repay →"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Equity / LTV / Health summary — same shape as LST/SOL */}
            <div className="mt-4 pt-4 border-t border-base-300/60 space-y-3">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Equity</div>
                  <div className="font-mono tabular-nums text-base mt-1">{fmtUsd(equityValueUsd)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Current LTV</div>
                  <div className="font-mono tabular-nums text-base mt-1">{currentLtvPct.toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-base-content/50 font-bold leading-none">Health factor</div>
                  <div className={cn("font-mono tabular-nums text-base mt-1", hfTone)}>
                    {Number.isFinite(healthFactor) ? healthFactor.toFixed(2) : "∞"}
                  </div>
                </div>
              </div>

              <div>
                <div className="relative h-2 rounded-full bg-base-300 overflow-hidden">
                  <div className={cn("h-full transition-all duration-500", ltvBarTone)} style={{ width: `${ltvBarPct}%` }} />
                  <div aria-hidden className="absolute top-0 bottom-0 w-px bg-warning/70"
                    style={{ left: `${ltvCapPct}%` }} title={`${ltvCapPct}% LTV cap`} />
                  <div aria-hidden className="absolute top-0 bottom-0 w-px bg-error/80"
                    style={{ left: `${liqThresholdPct}%` }} title={`${liqThresholdPct}% liq threshold`} />
                </div>
                <div className="flex justify-between text-[10px] text-base-content/45 font-mono mt-1">
                  <span>0%</span>
                  <span className="text-warning/80">cap {ltvCapPct}%</span>
                  <span className="text-error/80">liq {liqThresholdPct}%</span>
                </div>
              </div>
            </div>
          </Card>
        );
      })()}

      {/* Open / manage actions */}
      <Card tone="elevated" size="lg">
        <CardHeader
          title={hasPosition ? "Manage position" : "Open position"}
          eyebrow="Manual flow — each leg is its own tx"
          actions={
            <div className="flex gap-1.5 flex-wrap">
              <Button variant={action === "deposit" ? "primary" : "secondary"} size="sm" disabled={busy} onClick={() => { setAction(action === "deposit" ? null : "deposit"); setAmountStr(""); }}>Deposit</Button>
              <Button variant={action === "borrow" ? "primary" : "secondary"} size="sm" disabled={busy} onClick={() => { setAction(action === "borrow" ? null : "borrow"); setAmountStr(""); }}>Borrow</Button>
              {susdcDebt > 0 && (
                <Button variant={action === "repay" ? "primary" : "secondary"} size="sm" disabled={busy} onClick={() => { setAction(action === "repay" ? null : "repay"); setAmountStr(""); }}>Repay</Button>
              )}
              {ceusxCollateral > 0 && (
                <Button variant={action === "withdraw" ? "primary" : "secondary"} size="sm" disabled={busy} onClick={() => { setAction(action === "withdraw" ? null : "withdraw"); setAmountStr(""); }}>Withdraw</Button>
              )}
            </div>
          }
        />

        {action && actionInput && actionHandler && (
          <div className="space-y-3 mt-4">
            <TokenAmountInput
              symbol={actionInput.symbol}
              value={amountStr}
              onChange={setAmountStr}
              balance={actionInput.balance}
              balanceDecimals={2}
              balanceUnit={actionInput.balanceUnit}
              onMax={() => setAmountStr(actionInput.balance.toFixed(actionInput.decimals === 6 ? 4 : 6))}
            />
            {action === "borrow" && elevationGroup !== ELEVATION_GROUP_STABLES && ceusxCollateral > 0 && (
              <Snackbar
                variant="inline"
                type="info"
                message="EG-1 (Stables) auto-entry"
                detail="Your obligation will be moved into elevation group 1 in this tx (90% LTV / 92% liq) so the borrow can clear klend's per-collateral LTV check."
              />
            )}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={busy}
              disabled={busy || !amountStr || parseFloat(amountStr) <= 0}
              onClick={() => void actionHandler()}
            >
              {action === "deposit" ? "Deposit ceUSX"
                : action === "borrow"  ? "Borrow sUSDC"
                : action === "repay"   ? "Repay sUSDC"
                : "Withdraw ceUSX"}
            </Button>
          </div>
        )}
      </Card>

      {/* Tx console */}
      {(busy || log.length > 0 || error) && (
        <Card tone="muted" size="md">
          <SectionHeader
            title="Transaction console"
            actions={
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setLog([]); setError(null); }}>Clear</Button>
            }
          />
          {log.length > 0 && (
            <pre className="bg-base-300 rounded p-2 text-[11px] whitespace-pre-wrap font-mono max-h-40 overflow-auto">{log.join("\n")}</pre>
          )}
          {error && <Snackbar variant="inline" type="error" message="Transaction failed" detail={error} />}
        </Card>
      )}
    </div>
  );
}

