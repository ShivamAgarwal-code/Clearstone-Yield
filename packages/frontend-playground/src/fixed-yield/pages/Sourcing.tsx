import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { useStack } from "../lib/stack-context.js";
import { useAnchorProvider, idl } from "../lib/anchor.js";
import {
  detectTokenProgram,
  readPosition,
  syCpiRemainingAccounts,
  userAta,
} from "../lib/accounts.js";
import {
  DELTA_MINT_PROGRAM_ID,
  checkWhitelist,
} from "../lib/whitelist.js";
import { formatError } from "../lib/format.js";
import { useTxLog } from "../components/TxLog.js";

// Sourcing helpers — get from "wallet holds USDC only" → "wallet holds PT + SY".
//
// Two ixs, one per flow:
//   1. Mint SY: kamino_sy_adapter.mint_sy(amount_underlying)
//        — pulls user.USDC → klend reserve, returns SY 1:1 with ctokens.
//   2. Strip SY → PT+YT: core.strip(amount_sy)
//        — burns SY into the vault, mints paired PT + YT to user.
//
// Position banner re-reads after each successful tx so the user can
// follow what they have. Keep CU budgets generous — these are infrequent
// "I'm onboarding" txs, not hot-path solver flows.

const MINT_SY_CU = 600_000;
const STRIP_CU = 600_000;

export function Sourcing() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { stack } = useStack();
  const provider = useAnchorProvider();

  const [position, setPosition] = useState<{
    base: bigint;
    sy: bigint;
    pt: bigint;
    yt: bigint;
    lp: bigint;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // KYC onboarding affordance: when the connected wallet hits the
  // delta_mint whitelist gate (the base mint is a d-token AND
  // WhitelistEntry doesn't exist), surface the operator command
  // they need to send. Lets a non-operator user copy it and ask
  // the curator to run it.
  const [whitelistAsk, setWhitelistAsk] = useState<{
    dmMintConfig: PublicKey;
    wrappedMint: PublicKey;
    wallet: PublicKey;
  } | null>(null);

  // Reusable tx-log hook — co-locates flow steps, warnings, and on-chain
  // reverts. Replaces the previously scattered status / error / whitelist
  // banners. Drop `useTxLog()` into any other page (or another project)
  // for the same uniform pattern.
  const { log, LogPanel } = useTxLog();
  // Adapter shims so the existing setStatus / setError call sites flow
  // through the same pipe without a wider refactor.
  const setStatus = (m: string | null) => {
    if (m) log("info", m);
  };
  const setError = (m: string | null) => {
    if (m) log("error", m);
  };

  // Per-row amount inputs. Each balance row owns its own input so the
  // action buttons can act on it without sharing state across rows.
  const [amounts, setAmounts] = useState<Record<string, string>>({
    base: "1000000",
    sy: "500000",
    pt: "100000",
    yt: "100000",
    lp: "100000",
  });
  function setAmt(key: string, v: string) {
    setAmounts((prev) => ({ ...prev, [key]: v }));
  }

  async function refresh() {
    if (!publicKey) return;
    try {
      const pos = await readPosition({
        connection,
        owner: publicKey,
        baseMint: stack.kaminoStack.baseMint,
        syMint: stack.kaminoStack.syMint,
        ptMint: stack.kaminoStack.mintPt,
        ytMint: stack.kaminoStack.mintYt,
        lpMint: stack.kaminoStack.mintLp,
      });
      setPosition(pos);
    } catch (e) {
      setError(formatError(e));
      return;
    }

    // delta_mint whitelist pre-flight on the BASE mint. Only fires when
    // the base mint's authority chain points at delta_mint — pure SPL/
    // T2022 mints don't have this gate. We sniff by deriving the
    // candidate `dm_mint_config` PDA (delta_mint's `["mint_config",
    // wrappedMint]`) and checking if it exists. If it does, the
    // wrappedMint IS a delta-mint d-token and the user needs a
    // WhitelistEntry to mint or receive transfers.
    try {
      const [dmMintConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_config"), stack.kaminoStack.baseMint.toBuffer()],
        DELTA_MINT_PROGRAM_ID
      );
      const dmCfgInfo = await connection.getAccountInfo(dmMintConfig, "confirmed");
      if (!dmCfgInfo) {
        log("info", "base mint is not a delta-mint d-token (no MintConfig PDA) — no whitelist gate");
        setWhitelistAsk(null);
      } else {
        const w = await checkWhitelist({
          connection,
          dmMintConfig,
          wallet: publicKey,
        });
        if (!w.initialized) {
          log(
            "warn",
            `delta-mint whitelist NOT initialized for this wallet. dm_mint_config=${dmMintConfig.toBase58()} entry=${w.entry.toBase58()}. Upstream wraps that call delta_mint.mint_to will revert with AccountNotInitialized (3012/0xbc4) until the pool authority calls governor.add_participant_via_pool(role: Holder). Use Setup → "Use test stack" to bypass, or copy the operator command below to send to your curator.`
          );
          setWhitelistAsk({
            dmMintConfig,
            wrappedMint: stack.kaminoStack.baseMint,
            wallet: publicKey,
          });
        } else {
          log(
            "info",
            `delta-mint whitelist OK (entry ${w.entry.toBase58().slice(0, 8)}…)`
          );
          setWhitelistAsk(null);
        }
      }
    } catch (e) {
      // Best-effort; whitelist diagnostic is informational, not blocking.
      log("info", `whitelist diagnostic skipped: ${formatError(e)}`);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey?.toBase58(), stack.kaminoStack.syMint.toBase58()]);

  async function handleMintSy() {
    const mintAmt = amounts.base;
    if (!publicKey || !provider || !sendTransaction) {
      setError("connect a wallet");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const adapter = new Program(
        idl.kaminoSyAdapter,
        provider
      ) as unknown as Program;
      const ks = stack.kaminoStack;
      const { ata: userBaseAta, tokenProgram: baseTokenProgram } = await userAta(
        connection,
        publicKey,
        ks.baseMint
      );
      const { ata: userSyAta } = await userAta(connection, publicKey, ks.syMint);

      // Read the reserve to discover its lending_market + market authority
      // (needed by real-klend mint_sy paths). Mock-klend reserves don't
      // need them but the field is optional in the IDL — passing the
      // adapter program id as a "skip" sentinel is the convention.
      const reserveInfo = await connection.getAccountInfo(ks.klendReserve);
      if (!reserveInfo) throw new Error("klend reserve not found on-chain");
      // Real klend Reserve: lending_market starts at offset 32 of the
      // body (after the 8-byte discriminator). For mock-klend the
      // lending_market is also at offset 32.
      const lendingMarket = new PublicKey(reserveInfo.data.subarray(32, 64));
      // klend's lending_market_authority is a PDA: ["lma", lending_market].
      const klendProgramId = ks.klendReserve // placeholder; we don't have klend program id in the stack
        ? new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD")
        : new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
      const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("lma"), lendingMarket.toBuffer()],
        klendProgramId
      );

      // klend's liquidity_supply PDA: ["reserve_liq_supply", reserve]
      // (mock-klend constant; real-klend reads from reserve.collateral.supply_vault).
      const [klendLiquiditySupply] = PublicKey.findProgramAddressSync(
        [Buffer.from("reserve_liq_supply"), ks.klendReserve.toBuffer()],
        klendProgramId
      );

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: MINT_SY_CU }))
        // Idempotent ATA inits — first-time users won't have them yet.
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            userSyAta,
            publicKey,
            ks.syMint,
            await detectTokenProgram(connection, ks.syMint)
          )
        );

      const ix = await adapter.methods
        .mintSy(new BN(mintAmt))
        .accounts({
          owner: publicKey,
          syMetadata: ks.syMetadata,
          underlyingMint: ks.baseMint,
          syMint: ks.syMint,
          userUnderlying: userBaseAta,
          syDst: userSyAta,
          collateralVault: ks.collateralVault,
          klendReserve: ks.klendReserve,
          klendLiquiditySupply,
          klendCollateralMint: ks.klendCollateralMint,
          klendProgram: klendProgramId,
          tokenProgram: baseTokenProgram,
          // Real-klend optional accounts. Pass them when the reserve
          // is real-klend (8624-byte data); mock-klend doesn't need
          // them, but providing them is harmless (the adapter only
          // uses them on the dispatch path).
          klendLendingMarket: lendingMarket,
          klendLendingMarketAuthority: lendingMarketAuthority,
          klendInstructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          klendLiquidityTokenProgram: baseTokenProgram,
          klendPythOracle: ks.klendPyth,
          klendSwitchboardPrice: null,
          klendSwitchboardTwap: null,
          klendScopePrices: null,
        } as never)
        .instruction();
      tx.add(ix);

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus(`mint_sy confirmed: ${sig}`);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStrip() {
    const stripAmt = amounts.sy;
    if (!publicKey || !provider || !sendTransaction) {
      setError("connect a wallet");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const core = new Program(idl.clearstoneCore, provider) as unknown as Program;
      const ks = stack.kaminoStack;
      const { ata: userSyAta } = await userAta(connection, publicKey, ks.syMint);
      const { ata: userPtAta, tokenProgram: ptTokenProgram } = await userAta(
        connection,
        publicKey,
        ks.mintPt
      );
      const { ata: userYtAta } = await userAta(connection, publicKey, ks.mintYt);

      // Read the vault to pull cpi_accounts + ALT for SY-CPI extras.
      const vaultAcct = (await (core.account as Record<string, { fetch: (pk: PublicKey) => Promise<unknown> }>).vault.fetch(
        ks.ptVault
      )) as {
        cpiAccounts: {
          getSyState: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
          depositSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
          withdrawSy: { altIndex: number; isWritable: boolean; isSigner: boolean }[];
        };
        addressLookupTable: PublicKey;
        authority: PublicKey;
        yieldPosition: PublicKey;
        syProgram: PublicKey;
      };
      const remainingAccounts = await syCpiRemainingAccounts({
        connection,
        cpiAccounts: vaultAcct.cpiAccounts,
        alt: vaultAcct.addressLookupTable,
      });

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: STRIP_CU }))
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            userPtAta,
            publicKey,
            ks.mintPt,
            ptTokenProgram
          )
        )
        .add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            userYtAta,
            publicKey,
            ks.mintYt,
            ptTokenProgram
          )
        );

      const ix = await core.methods
        .strip(new BN(stripAmt))
        .accounts({
          depositor: publicKey,
          authority: vaultAcct.authority,
          vault: ks.ptVault,
          sySrc: userSyAta,
          escrowSy: ks.poolEscrow,
          ytDst: userYtAta,
          ptDst: userPtAta,
          mintYt: ks.mintYt,
          mintPt: ks.mintPt,
          mintSy: ks.syMint,
          tokenProgram: ptTokenProgram,
          addressLookupTable: vaultAcct.addressLookupTable,
          syProgram: vaultAcct.syProgram,
          yieldPosition: vaultAcct.yieldPosition,
        } as never)
        .remainingAccounts(remainingAccounts)
        .instruction();
      tx.add(ix);

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus(`strip confirmed: ${sig}`);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  function handleStub(name: string) {
    setStatus(
      `[stub] "${name}" not wired yet — see ui/README.md "Next steps for a real UI" §3 (LP submission), §6 (Buy PT submission). The on-chain entrypoint exists, just the tx-build is pending in the UI.`
    );
  }

  // Row schema. Every row has TWO action buttons; both are always
  // enabled (clickable) — no balance-gated disabling. Wired actions
  // call into the real handlers; stubs surface a "not wired yet"
  // status. The user requested both buttons always activatable so the
  // operator can drive any flow regardless of current balance.
  const rows: {
    key: string;
    label: string;
    side: "asset" | "lp";
    value: bigint | undefined;
    actions: [
      { label: string; onClick: () => void | Promise<void> },
      { label: string; onClick: () => void | Promise<void> },
    ];
  }[] = [
    {
      key: "base",
      label: "base (USDC)",
      side: "asset",
      value: position?.base,
      actions: [
        { label: "mint SY", onClick: handleMintSy },
        { label: "redeem (—)", onClick: () => handleStub("redeem base from SY") },
      ],
    },
    {
      key: "sy",
      label: "SY",
      side: "asset",
      value: position?.sy,
      actions: [
        { label: "strip → PT+YT", onClick: handleStrip },
        { label: "redeem → base", onClick: () => handleStub("redeem_sy → base") },
      ],
    },
    {
      key: "pt",
      label: "PT",
      side: "asset",
      value: position?.pt,
      actions: [
        { label: "provide LP", onClick: () => handleStub("wrapper_provide_liquidity_classic") },
        { label: "sell → SY", onClick: () => handleStub("wrapper_sell_pt") },
      ],
    },
    {
      key: "yt",
      label: "YT",
      side: "asset",
      value: position?.yt,
      actions: [
        { label: "deposit (rewards)", onClick: () => handleStub("deposit_yt") },
        { label: "sell → SY", onClick: () => handleStub("sell_yt") },
      ],
    },
    {
      key: "lp",
      label: "LP",
      side: "lp",
      value: position?.lp,
      actions: [
        { label: "stake (rewards)", onClick: () => handleStub("stake_lp") },
        { label: "withdraw → PT+SY", onClick: () => handleStub("wrapper_withdraw_liquidity_classic") },
      ],
    },
  ];

  return (
    <div>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Position</h2>
      <p style={{ color: "#8a8a8a", fontSize: 13 }}>
        Each row carries an amount input + two action buttons. Both
        buttons are always activatable; non-wired actions surface a
        clear "[stub]" status so the operator can sequence flows
        without UI guessing about balance preconditions.
      </p>

      {/* Whitelist + status + error banners moved into the unified
          tx-log panel below; do not render scattered banners here.
          Exception: the KYC onboarding CTA renders inline so a
          non-operator user can copy the operator command in one click. */}

      {whitelistAsk && (
        <WhitelistRequestBanner
          dmMintConfig={whitelistAsk.dmMintConfig}
          wrappedMint={whitelistAsk.wrappedMint}
          wallet={whitelistAsk.wallet}
          onCopied={() => log("info", "kyc_whitelist command copied to clipboard")}
          onError={(m) => log("error", `clipboard write failed: ${m}`)}
        />
      )}

      <div style={{ ...box, marginBottom: 16, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a2a2e" }}>
              <th style={th}>asset</th>
              <th style={th}>balance</th>
              <th style={th}>amount</th>
              <th style={th} colSpan={2}>actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderBottom: "1px solid #1a1a1c" }}>
                <td style={{ ...td, color: "#8a8a8a", width: 120 }}>{r.label}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace", width: 160 }}>
                  {r.value === undefined ? "—" : r.value.toString()}
                </td>
                <td style={{ ...td, width: 240 }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <input
                      value={amounts[r.key] ?? ""}
                      onChange={(e) => setAmt(r.key, e.target.value)}
                      style={inlineInput}
                    />
                    <PercentButtons
                      balance={r.value}
                      onPick={(amount) => setAmt(r.key, amount)}
                    />
                  </div>
                </td>
                <td style={td}>
                  <button onClick={() => void r.actions[0].onClick()} style={rowBtn}>
                    {r.actions[0].label}
                  </button>
                </td>
                <td style={td}>
                  <button onClick={() => void r.actions[1].onClick()} style={rowBtn}>
                    {r.actions[1].label}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={refresh} style={btnSecondary} disabled={!publicKey}>
          refresh balances
        </button>
        {busy && <span style={{ color: "#8a8a8a", fontSize: 12, alignSelf: "center" }}>busy…</span>}
      </div>

      <LogPanel />
    </div>
  );
}

/** Quick-fill percentages of a balance. Always renders all four — they
 *  go inactive (rendered with a muted style + onClick no-op) only when
 *  the balance is unknown (`undefined`); when balance is 0n they
 *  remain clickable but produce "0" so the user can still test the
 *  flow on a wallet with no inventory. */
function PercentButtons({
  balance,
  onPick,
}: {
  balance: bigint | undefined;
  onPick: (amount: string) => void;
}) {
  const unknown = balance === undefined;
  const pick = (numerator: bigint) => {
    if (balance === undefined) return;
    onPick(((balance * numerator) / 100n).toString());
  };
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {[25n, 50n, 75n, 100n].map((n) => (
        <button
          key={n.toString()}
          onClick={() => pick(n)}
          style={{
            ...pctBtn,
            opacity: unknown ? 0.4 : 1,
            cursor: unknown ? "default" : "pointer",
          }}
          title={unknown ? "balance unknown" : `${n}% of ${balance!.toString()}`}
        >
          {n === 100n ? "max" : `${n}%`}
        </button>
      ))}
    </div>
  );
}

const pctBtn: React.CSSProperties = {
  background: "transparent",
  color: "#888",
  border: "1px solid #2a2a2e",
  padding: "2px 8px",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 10,
  flex: 1,
};

const box: React.CSSProperties = {
  background: "#161618",
  border: "1px solid #2a2a2e",
  borderRadius: 4,
  padding: 16,
};
const th: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 500,
  color: "#666",
  padding: "10px 12px",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "middle",
};
const inlineInput: React.CSSProperties = {
  background: "#0e0e10",
  color: "#e8e8e8",
  border: "1px solid #2a2a2e",
  padding: "6px 8px",
  borderRadius: 4,
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  width: "100%",
  boxSizing: "border-box",
};
const rowBtn: React.CSSProperties = {
  background: "transparent",
  color: "#6cf",
  border: "1px solid #2a2a2e",
  padding: "6px 10px",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "#e8e8e8",
  border: "1px solid #2a2a2e",
  padding: "6px 12px",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
  marginTop: 12,
};
const statusBox: React.CSSProperties = {
  fontSize: 12,
  color: "#8a8a8a",
  background: "#161618",
  border: "1px solid #2a2a2e",
  padding: "10px 12px",
  borderRadius: 4,
  wordBreak: "break-all",
};

// KYC onboarding banner. Renders inline above the position table when
// the connected wallet hits the delta_mint whitelist gate. Builds the
// `kyc_whitelist.ts` invocation the operator needs to run and offers a
// one-click clipboard copy. The banner stays IDL-free: pubkeys come
// from props, no on-chain reads here.
function WhitelistRequestBanner(props: {
  dmMintConfig: PublicKey;
  wrappedMint: PublicKey;
  wallet: PublicKey;
  onCopied: () => void;
  onError: (m: string) => void;
}): JSX.Element {
  // Build the operator command. We pass --wrapped-mint so the operator
  // doesn't need to look up dm_mint_config, and ask them to fill in
  // --pool-config (we don't have it from on-chain reads alone — the
  // pool authority knows it from kyc_pool_setup output).
  const cmd =
    `tsx scripts/kyc_whitelist.ts \\\n` +
    `  --rpc <RPC> \\\n` +
    `  --keypair <CURATOR_KEYPAIR> \\\n` +
    `  --pool-config <POOL_CONFIG_PDA_FROM_KYC_POOL_SETUP> \\\n` +
    `  --wrapped-mint ${props.wrappedMint.toBase58()} \\\n` +
    `  --wallet ${props.wallet.toBase58()} \\\n` +
    `  --role Holder`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      props.onCopied();
    } catch (e) {
      props.onError(String(e));
    }
  }

  return (
    <div
      style={{
        marginBottom: 16,
        padding: "12px 14px",
        background: "#1a1410",
        border: "1px solid #6a3a14",
        borderRadius: 4,
        fontSize: 12,
        color: "#fab985",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        KYC onboarding required for this stack
      </div>
      <div style={{ marginBottom: 10, color: "#cabaa8" }}>
        Your wallet (<code>{props.wallet.toBase58().slice(0, 8)}…</code>) isn't
        whitelisted on the delta-mint d-token (
        <code>dm_mint_config={props.dmMintConfig.toBase58().slice(0, 8)}…</code>
        ). Send the command below to your curator — once they run it, the
        wrap/mint flows in this tab will succeed.
      </div>
      <pre
        style={{
          background: "#0d0d0e",
          padding: 10,
          borderRadius: 4,
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          overflowX: "auto",
          color: "#cfd",
          margin: 0,
        }}
      >
        {cmd}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        style={{
          marginTop: 8,
          background: "transparent",
          color: "#fab985",
          border: "1px solid #6a3a14",
          padding: "4px 10px",
          borderRadius: 4,
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        Copy command
      </button>
    </div>
  );
}
