import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  DEPOSIT_LUT,
  ELEVATION_GROUP_LST_SOL,
  JITO_VAULT_PROGRAM,
  KLEND_MARKET,
} from "../lib/addresses";
import {
  buildDepositCsSolIx,
  buildInitObligationIx,
  buildInitUserMetadataIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRequestElevationGroupIx,
  obligationPda,
  userMetadataPda,
} from "../lib/klend";
import {
  buildWrapWithJitoVaultIx,
  isWhitelisted,
  readVaultState,
} from "../lib/jitoVault";

function short(p: string | PublicKey, n = 6): string {
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

interface KlendState {
  userMetaExists: boolean;
  obligationExists: boolean;
  obligationAddr: PublicKey;
  userMetaAddr: PublicKey;
  // Decoded only when obligationExists. Layout offsets derived from
  // klend-sdk@7.3.20's Obligation borsh schema.
  obligationHasDeposits: boolean;
  obligationElevationGroup: number;
  obligationCsSolCollateral: bigint;
  // All non-zero deposit reserve addresses on the obligation. klend's
  // refresh_obligation requires every active deposit reserve to be
  // passed as a writable remaining account, otherwise it errors with
  // InvalidAccountInput (6006) "expected_remaining_accounts=N,
  // actual=M". After a leveraged-unwind, the obligation has both
  // csSOL and csSOL-WT — passing only csSOL trips this guard.
  obligationDepositReserves: PublicKey[];
}

const OBLIGATION_DEPOSIT_SLOT_SIZE = 136; // ObligationCollateral struct
const OBLIGATION_DEPOSITS_OFFSET = 96;     // start of deposits[8] array
const OBLIGATION_DEPOSIT0_RESERVE_OFFSET = 96;
const OBLIGATION_DEPOSIT0_AMOUNT_OFFSET = 96 + 32;
const OBLIGATION_ELEVATION_GROUP_OFFSET = 2285;

async function readKlendState(conn: ReturnType<typeof useConnection>["connection"], owner: PublicKey): Promise<KlendState> {
  const userMetaAddr = userMetadataPda(owner);
  const obligationAddr = obligationPda(owner);
  const [userMeta, obligation] = await conn.getMultipleAccountsInfo([userMetaAddr, obligationAddr], "confirmed");

  let obligationHasDeposits = false;
  let obligationElevationGroup = 0;
  let obligationCsSolCollateral = 0n;
  let obligationDepositReserves: PublicKey[] = [];
  if (obligation && obligation.data.length >= OBLIGATION_ELEVATION_GROUP_OFFSET + 1) {
    const firstReserveBytes = obligation.data.subarray(OBLIGATION_DEPOSIT0_RESERVE_OFFSET, OBLIGATION_DEPOSIT0_RESERVE_OFFSET + 32);
    obligationHasDeposits = firstReserveBytes.some((b) => b !== 0);
    obligationElevationGroup = obligation.data[OBLIGATION_ELEVATION_GROUP_OFFSET];
    obligationCsSolCollateral = obligation.data.readBigUInt64LE(OBLIGATION_DEPOSIT0_AMOUNT_OFFSET);

    // Walk all 8 deposit slots; collect non-zero reserve addresses.
    for (let i = 0; i < 8; i++) {
      const off = OBLIGATION_DEPOSITS_OFFSET + i * OBLIGATION_DEPOSIT_SLOT_SIZE;
      const reserveBytes = obligation.data.subarray(off, off + 32);
      if (reserveBytes.some((b) => b !== 0)) {
        obligationDepositReserves.push(new PublicKey(reserveBytes));
      }
    }
  }

  return {
    userMetaExists: !!userMeta,
    obligationExists: !!obligation,
    userMetaAddr,
    obligationAddr,
    obligationHasDeposits,
    obligationElevationGroup,
    obligationCsSolCollateral,
    obligationDepositReserves,
  };
}

export default function OneStepDepositTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [klend, setKlend] = useState<KlendState | null>(null);
  const [whitelisted, setWhitelisted] = useState<boolean | null>(null);
  const [solBal, setSolBal] = useState<bigint>(0n);
  const [cssolBal, setCssolBal] = useState<bigint>(0n);
  const [amount, setAmount] = useState<string>("0.005");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lutAccount, setLutAccount] = useState<AddressLookupTableAccount | null>(null);

  const refresh = async () => {
    if (!wallet.publicKey) return;
    try {
      const [k, wl, lamports] = await Promise.all([
        readKlendState(connection, wallet.publicKey),
        isWhitelisted(connection, wallet.publicKey),
        connection.getBalance(wallet.publicKey).then(BigInt),
      ]);
      setKlend(k); setWhitelisted(wl); setSolBal(lamports);
      const cssolAta = getAssociatedTokenAddressSync(CSSOL_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      try {
        const bal = await connection.getTokenAccountBalance(cssolAta, "confirmed");
        setCssolBal(BigInt(bal.value.amount));
      } catch { setCssolBal(0n); }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  // Cache the LUT account once. The set of static accounts in it doesn't
  // change, so re-fetching per click would be wasteful.
  useEffect(() => {
    if (!DEPOSIT_LUT) return;
    let cancelled = false;
    void connection.getAddressLookupTable(DEPOSIT_LUT, { commitment: "confirmed" })
      .then((r) => { if (!cancelled) setLutAccount(r.value ?? null); })
      .catch((e) => { if (!cancelled) setError(`failed to load LUT: ${e.message ?? e}`); });
    return () => { cancelled = true; };
  }, [connection]);

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  async function sendV0(ixes: TransactionInstruction[], label: string) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    if (!DEPOSIT_LUT) throw new Error("VITE_DEPOSIT_LUT not configured. Run packages/programs/scripts/init-deposit-lut.ts first.");
    if (!lutAccount) throw new Error("LUT not loaded yet — wait a moment and retry");

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixes,
    }).compileToV0Message([lutAccount]);

    const vtx = new VersionedTransaction(message);
    const serializedSize = vtx.serialize().length;
    setLog((l) => [...l, `tx assembled: ${ixes.length} ixes, ~${serializedSize} bytes (limit 1232)`]);
    if (serializedSize > 1232) throw new Error(`tx too large: ${serializedSize} > 1232 bytes`);

    setLog((l) => [...l, `signing ${label} …`]);
    const signed = await wallet.signTransaction(vtx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    setLog((l) => [...l, `submitted ${label}: ${sig}`]);
    await connection.confirmTransaction(sig, "confirmed");
    const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (receipt?.meta?.err) {
      const logs = receipt.meta.logMessages?.slice(-10).join("\n") ?? "";
      throw new Error(`${label} on-chain err: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
    return sig;
  }

  async function oneShotDeposit() {
    if (!wallet.publicKey) return;
    setBusy(true); setError(null);
    setLog([`assembling 1-signature deposit for ${amount} SOL …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");

      const [k, vaultState] = await Promise.all([
        readKlendState(connection, owner),
        readVaultState(connection, CSSOL_VAULT),
      ]);
      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        JITO_VAULT_PROGRAM,
      );

      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userVrt = getAssociatedTokenAddressSync(vaultState.vrtMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userCssol = getAssociatedTokenAddressSync(CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const feeVrt = getAssociatedTokenAddressSync(vaultState.vrtMint, vaultState.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const ixes: TransactionInstruction[] = [];

      // Compute budget — wrap + deposit + (optional) elevation tail can hit
      // ~700k CU on a cold cache. Set high once and forget.
      ixes.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
      ixes.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));

      // ATA idempotents — cheap, always run. The wrap + deposit ixes
      // need these as keyed accounts anyway, so they don't add unique
      // accounts to the message; only ~8 bytes of ix-body overhead each.
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userWsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userVrt, owner, vaultState.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userCssol, owner, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, feeVrt, vaultState.feeWallet, vaultState.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));

      // Klend account init — only when missing. Both ixes have
      // anchor `init` constraints that fail if accounts already exist.
      if (!k.userMetaExists) {
        ixes.push(await buildInitUserMetadataIx(owner, owner));
      }
      if (!k.obligationExists) {
        ixes.push(await buildInitObligationIx(owner, owner));
      }

      // Wrap leg: SOL → wSOL → governor::wrap_with_jito_vault.
      ixes.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsol, lamports: Number(lamports) }));
      ixes.push(createSyncNativeInstruction(userWsol));
      ixes.push(await buildWrapWithJitoVaultIx({
        user: owner, amount: lamports,
        vrtMint: vaultState.vrtMint, feeWallet: vaultState.feeWallet,
        jitoVaultConfig: jitoConfig, vaultStTokenAccount: CSSOL_VAULT_ST_TOKEN_ACCOUNT,
      }));

      // Klend deposit. check_refresh requires the ix at N-2 to be
      // refresh_reserve and the ix at N-1 to be refresh_obligation. The
      // remaining_accounts of refresh_obligation here mirror the deposit
      // slots that already exist on the obligation: empty for the first
      // deposit, [csSOL] thereafter.
      // refresh_obligation must include EVERY non-zero deposit
      // reserve on the obligation as a writable remaining account.
      // After a leveraged-unwind the obligation has both csSOL and
      // csSOL-WT — passing only csSOL trips InvalidAccountInput
      // (6006) "expected_remaining_accounts=N, actual=M". For each
      // extra reserve we also need an upstream refresh_reserve in the
      // same slot.
      const allDepositReserves = k.obligationDepositReserves;
      for (const r of allDepositReserves) {
        if (!r.equals(CSSOL_RESERVE)) {
          // csSOL-WT (and any other future eMode-2 collateral) uses
          // the same csSOL accrual oracle in v1, so passing
          // CSSOL_RESERVE_ORACLE is correct for now. If a per-mint
          // oracle is added in v2, parametrize this lookup.
          ixes.push(await buildRefreshReserveIx(r, CSSOL_RESERVE_ORACLE));
        }
      }
      ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, allDepositReserves));
      ixes.push(await buildDepositCsSolIx(owner, lamports));

      // Elevation join — only when not yet in group 2 AND the
      // obligation already has at least one deposit (the
      // ObligationDepositsEmpty=6020 guard). After this ix's deposit
      // lands, the obligation has csSOL plus whatever else was there;
      // include all of them in the refresh_obligation.
      if (k.obligationElevationGroup !== ELEVATION_GROUP_LST_SOL) {
        const postDeposit = allDepositReserves.some((r) => r.equals(CSSOL_RESERVE))
          ? allDepositReserves
          : [...allDepositReserves, CSSOL_RESERVE];
        ixes.push(await buildRefreshObligationIx(owner, postDeposit));
        ixes.push(await buildRequestElevationGroupIx(owner, ELEVATION_GROUP_LST_SOL, postDeposit));
      }

      await sendV0(ixes, "1-sig deposit");
      await refresh();
    } catch (e: any) {
      // Better error rendering: pull on-chain log tail if present and
      // serialize structured InstructionError objects to JSON.
      const onchainLogs = e?.transactionLogs ?? e?.logs ?? null;
      const baseMsg = typeof e === "string"
        ? e
        : e?.message ?? (e ? JSON.stringify(e, null, 2) : "unknown error");
      setError(`${baseMsg}${onchainLogs ? "\n\n" + onchainLogs.slice(-10).join("\n") : ""}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-bold mb-2">1-tx Deposit — SOL → csSOL → klend collateral</h2>
        <p className="opacity-70 mb-6">
          One signature wraps native SOL into Jito-backed csSOL and deposits it as klend
          collateral inside elevation group 2 (csSOL/wSOL eMode, 90% LTV) — including
          first-time klend obligation init + ATA creation if needed. Whitelist-only at
          the delta-mint layer.
        </p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  const lutMissing = !DEPOSIT_LUT;
  const lutLoading = !!DEPOSIT_LUT && !lutAccount;
  const canDeposit = !!whitelisted && !lutMissing && !lutLoading;

  return (
    <section className="max-w-3xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">1-signature Deposit — SOL → csSOL → klend collateral</h2>
        <p className="opacity-70 mt-1 text-sm">
          One user signature: ATA create + (optional) klend obligation init + wrap SOL → csSOL
          via the Jito vault + deposit csSOL as klend collateral + (optional) join elevation
          group {ELEVATION_GROUP_LST_SOL} (90% LTV csSOL → wSOL borrow). Compressed via the
          deposit Address Lookup Table.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Klend account</div>
            {klend ? (
              <>
                <div>obligation: <code>{short(klend.obligationAddr)}</code> {klend.obligationExists ? "✓" : "(will be init'd in tx)"}</div>
                <div>userMetadata: <code>{short(klend.userMetaAddr)}</code> {klend.userMetaExists ? "✓" : "(will be init'd in tx)"}</div>
                <div>
                  elevation group: <code>{klend.obligationElevationGroup}</code>{" "}
                  {klend.obligationElevationGroup === ELEVATION_GROUP_LST_SOL ? (
                    <span className="text-success">✓ csSOL/wSOL eMode active (90% LTV)</span>
                  ) : klend.obligationElevationGroup === 0 ? (
                    <span className="text-warning">default group (55% LTV) — will join in next deposit tx</span>
                  ) : (
                    <span className="opacity-60">group {klend.obligationElevationGroup}</span>
                  )}
                </div>
                <div>csSOL collateral: <code>{(Number(klend.obligationCsSolCollateral) / LAMPORTS_PER_SOL).toFixed(6)}</code> <span className="opacity-60">({klend.obligationCsSolCollateral.toString()} cToken)</span></div>
                <div>market: <code>{short(KLEND_MARKET)}</code></div>
                <div>csSOL reserve: <code>{short(CSSOL_RESERVE)}</code></div>
                <div>csSOL oracle: <code>{short(CSSOL_RESERVE_ORACLE)}</code></div>
                <div>deposit LUT: {DEPOSIT_LUT ? <code>{short(DEPOSIT_LUT)}</code> : <span className="text-error">not set (set VITE_DEPOSIT_LUT)</span>} {DEPOSIT_LUT && lutAccount ? <span className="opacity-60">— {lutAccount.state.addresses.length} entries</span> : null}</div>
              </>
            ) : <div className="opacity-60">loading …</div>}
          </div>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Wallet</div>
            <div>pubkey: <code>{short(wallet.publicKey)}</code></div>
            <div>SOL: <code>{(Number(solBal) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
            <div>csSOL (free): <code>{(Number(cssolBal) / LAMPORTS_PER_SOL).toFixed(6)}</code> <span className="opacity-60">({cssolBal.toString()} raw)</span></div>
            <div className={`text-xs mt-2 ${whitelisted ? "text-success" : "text-warning"}`}>
              {whitelisted === null ? "checking whitelist…"
                : whitelisted ? "✓ KYC-whitelisted on delta-mint."
                : "⚠ NOT whitelisted. The wrap will fail at delta-mint::mint_to."}
            </div>
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-3">
          <div className="font-bold">Wrap & deposit</div>
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="input input-bordered w-48"
              value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            <span className="text-sm opacity-70">SOL</span>
            <button className="btn btn-primary" onClick={oneShotDeposit}
              disabled={busy || !canDeposit}
              title={
                lutMissing ? "VITE_DEPOSIT_LUT not configured"
                  : lutLoading ? "Waiting for LUT to load…"
                  : !whitelisted ? "Wallet is not KYC-whitelisted"
                  : undefined
              }>
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              Wrap & deposit as collateral
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          </div>
          {lutMissing ? (
            <div className="alert alert-warning text-xs">
              VITE_DEPOSIT_LUT is not set. Run <code>packages/programs/scripts/init-deposit-lut.ts</code>,
              then add the printed address to your <code>.env.local</code> as <code>VITE_DEPOSIT_LUT</code>.
            </div>
          ) : null}
          {error ? <pre className="alert alert-error text-xs whitespace-pre-wrap">{error}</pre> : null}
          {log.length > 0 ? <pre className="bg-base-300 p-2 text-xs whitespace-pre-wrap rounded">{log.join("\n")}</pre> : null}
        </div>
      </div>

      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">What this tx actually does</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1">
          <li>Idempotently creates user's wSOL, VRT, csSOL, and fee-VRT ATAs.</li>
          <li><em>(first time only)</em> klend <code>init_user_metadata</code> + <code>init_obligation</code>.</li>
          <li>Transfers <code>amount</code> lamports of SOL into the user's wSOL ATA + <code>sync_native</code>.</li>
          <li><code>governor::wrap_with_jito_vault(amount)</code> — Jito MintTo via PDA-signed CPI,
            VRT swept to pool, csSOL minted to user (KYC-checked).</li>
          <li>klend <code>refresh_reserve(csSOL_RESERVE)</code> reading the accrual-oracle output.</li>
          <li>klend <code>refresh_obligation</code>.</li>
          <li>klend <code>deposit_reserve_liquidity_and_obligation_collateral(amount)</code> —
            csSOL leaves user's ATA into the reserve, cTokens recorded as obligation collateral.</li>
          <li><em>(first time only)</em> klend <code>refresh_obligation([csSOL])</code>
            + <code>request_elevation_group({ELEVATION_GROUP_LST_SOL})</code> — joins csSOL/wSOL eMode (90% LTV).</li>
        </ol>
        <p className="mt-2 opacity-70">
          All ~37 unique pubkeys are compressed via the deposit Address Lookup Table —
          static program / market / reserve / vault / mint addresses are 1-byte indices,
          leaving room under the 1232-byte tx limit even for the first-time bundled path.
        </p>
      </details>
    </section>
  );
}
