/**
 * Single-vault roll execution.
 *
 * Flow:
 *   1. Decide whether any allocation has matured.
 *   2. If yes: build reallocate_from_market(matured) → reallocate_to_market(next).
 *   3. Sign with curator keypair. Send. Confirm.
 *
 * Slippage + amount sizing: this keeper uses minimal safe defaults.
 * Operators needing tighter economic parameters should fork this
 * module, or wait for the on-chain `RollDelegation` upgrade
 * (KEEPER_PERMISSIONS.md §4C) which moves per-user bounds to
 * on-chain state.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { fixedYield, CLEARSTONE_CORE_PROGRAM_ID } from "@delta/calldata-sdk-solana";
import type { CuratorVaultSnapshot } from "./edge.js";
import type { KeeperConfig } from "./config.js";

export type RollDecision =
  | { reason: "no-matured-allocation" }
  | { reason: "no-next-allocation" }
  | { reason: "curator-mismatch" }
  | {
      reason: "ready";
      maturedIndex: number;
      nextIndex: number;
      maturedMarket: string;
      nextMarket: string;
    };

export type ReadyRoll = Extract<RollDecision, { reason: "ready" }>;

export function decideRoll(
  vault: CuratorVaultSnapshot,
  curatorPk: string,
  nowTs: number,
  graceSec: number
): RollDecision {
  // The keeper must be the configured curator.
  if (vault.curator !== curatorPk) {
    return { reason: "curator-mismatch" };
  }

  // Find the matured allocation (earliest) — stable pick if multiple matured.
  // NOTE: nextAutoRollTs reflects the earliest-maturity allocation. Use
  // it to filter fast, then resolve the specific allocation index.
  if (
    !vault.nextAutoRollTs ||
    vault.nextAutoRollTs + graceSec > nowTs
  ) {
    return { reason: "no-matured-allocation" };
  }

  // Find allocations with nonzero deployment that the edge indexer has
  // reported as matured (we don't have per-allocation maturity in the
  // snapshot, so we pick the first with deployed_base > 0 under the
  // assumption the indexer's nextAutoRollTs points at it). A v1.1 step
  // surfaces per-allocation maturity in the snapshot.
  const maturedIdx = vault.allocations.findIndex(
    (a) => BigInt(a.deployedBase) > 0n
  );
  if (maturedIdx < 0) {
    return { reason: "no-matured-allocation" };
  }

  // Pick the next target — highest weight that isn't the matured one.
  let nextIdx = -1;
  let bestWeight = -1;
  for (let i = 0; i < vault.allocations.length; i++) {
    if (i === maturedIdx) continue;
    if (vault.allocations[i].weightBps > bestWeight) {
      bestWeight = vault.allocations[i].weightBps;
      nextIdx = i;
    }
  }
  if (nextIdx < 0) {
    return { reason: "no-next-allocation" };
  }

  return {
    reason: "ready",
    maturedIndex: maturedIdx,
    nextIndex: nextIdx,
    maturedMarket: vault.allocations[maturedIdx].market,
    nextMarket: vault.allocations[nextIdx].market,
  };
}

/**
 * Build the account set for one reallocate call. We derive ATAs + PDAs
 * from the snapshot — none of the adapter-level accounts are included
 * in the edge snapshot today, so the keeper fetches the target market
 * account to pull them. Accepts a pre-fetched `MarketTwo` data buffer
 * so tests / batches can avoid redundant RPC reads.
 */
async function deriveReallocateAccounts(
  conn: Connection,
  curatorKp: Keypair,
  vault: CuratorVaultSnapshot,
  marketPk: PublicKey
): Promise<{
  common: Parameters<
    typeof fixedYield.curatorAdmin.buildReallocateToMarket
  >[0];
}> {
  const vaultPk = new PublicKey(vault.vault);
  const baseMintPk = new PublicKey(vault.baseMint);
  const baseEscrowPk = new PublicKey(vault.baseEscrow);

  // Pull the MarketTwo to resolve its child pubkeys. On the keeper's
  // critical path this is ~1 RPC hop per roll; negligible.
  const marketInfo = await conn.getAccountInfo(marketPk);
  if (!marketInfo) throw new Error(`market ${marketPk.toBase58()} missing`);

  // MarketTwo header — see backend-edge/src/fixed-yield.ts offsets.
  const data = marketInfo.data;
  const mintPt = new PublicKey(data.slice(8 + 32 + 2 + 1 + 32, 8 + 32 + 2 + 1 + 32 + 32));
  const mintSy = new PublicKey(
    data.slice(8 + 32 + 2 + 1 + 32 + 32, 8 + 32 + 2 + 1 + 32 + 64)
  );
  // mint_lp @ 8 + 32 + 2 + 1 + 32 + 32 + 32 + 32 = 171
  const mintLp = new PublicKey(data.slice(171, 203));
  // token_pt_escrow @ 203, token_sy_escrow @ 235, token_fee_treasury_sy @ 267
  const marketEscrowPt = new PublicKey(data.slice(203, 235));
  const marketEscrowSy = new PublicKey(data.slice(235, 267));
  const tokenFeeTreasurySy = new PublicKey(data.slice(267, 299));
  // address_lookup_table stored earlier in the struct @ 8 + 32 + 2 + 1 = 43
  const marketAlt = new PublicKey(data.slice(43, 75));

  // Adapter accounts: sy_program + sy_market + adapter_base_vault. The
  // snapshot doesn't carry these yet (backend TODO). As a pragmatic
  // fallback, decode from the core Vault account pointed at by this
  // market (MarketTwo.vault offset). v1.1 surfaces these in
  // MarketAccountsDto.
  const coreVaultPk = new PublicKey(data.slice(8 + 32 + 2 + 1 + 32 + 32 + 32, 8 + 32 + 2 + 1 + 32 + 32 + 64));
  const coreVaultInfo = await conn.getAccountInfo(coreVaultPk);
  if (!coreVaultInfo) throw new Error("core vault missing");
  // Vault: sy_program @ 43, mint_sy @ 75 ... escrow_sy @ 235 ...
  const syProgram = new PublicKey(coreVaultInfo.data.slice(43, 75));

  // Core event authority is a known PDA of the core program.
  const [coreEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CLEARSTONE_CORE_PROGRAM_ID
  );

  // Prefer snapshot-supplied adapter keys (set by the backend-edge once
  // it populates `CuratorVaultSnapshot.adapter`). They're the only
  // correct path for non-generic adapters (Kamino, etc.) which don't
  // use the [b"sy_market", base_mint] seed.
  //
  // Fallback: derive against generic_exchange_rate_sy's seed. Works
  // for the dev stack; will produce ConstraintSeeds on Kamino markets.
  // See FOLLOWUPS.md :: KEEPER_SY_ADAPTER_SEED.
  const syMarket = vault.adapter
    ? new PublicKey(vault.adapter.syMarket)
    : PublicKey.findProgramAddressSync(
        [Buffer.from("sy_market"), baseMintPk.toBuffer()],
        syProgram
      )[0];
  const adapterBaseVault = vault.adapter
    ? new PublicKey(vault.adapter.adapterBaseVault)
    : getAssociatedTokenAddressSync(
        baseMintPk,
        syMarket,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

  // Vault-PDA-owned ATAs for SY/PT/LP. allowOwnerOffCurve=true
  // because the vault is itself a PDA.
  const vaultSyAta = getAssociatedTokenAddressSync(
    mintSy, vaultPk, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const vaultPtAta = getAssociatedTokenAddressSync(
    mintPt, vaultPk, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const vaultLpAta = getAssociatedTokenAddressSync(
    mintLp, vaultPk, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return {
    common: {
      curator: curatorKp.publicKey,
      vault: vaultPk,
      baseMint: baseMintPk,
      baseEscrow: baseEscrowPk,
      syMarket,
      syMint: mintSy,
      adapterBaseVault,
      vaultSyAta,
      market: marketPk,
      marketEscrowPt,
      marketEscrowSy,
      tokenFeeTreasurySy,
      marketAlt,
      mintPt,
      mintLp,
      vaultPtAta,
      vaultLpAta,
      coreEventAuthority,
      syProgram,
      // other fields default via SDK
      allocationIndex: 0,
      baseIn: new BN(0),
      ptBuyAmount: new BN(0),
      maxSyIn: new BN(0),
      ptIntent: new BN(0),
      syIntent: new BN(0),
      minLpOut: new BN(0),
    },
  };
}

async function loadLookupTable(
  conn: Connection,
  altPk: PublicKey
): Promise<AddressLookupTableAccount> {
  const res = await conn.getAddressLookupTable(altPk);
  if (!res.value) {
    throw new Error(
      `address_lookup_table ${altPk.toBase58()} not found — market is mis-provisioned`
    );
  }
  return res.value;
}

export async function executeRoll(
  conn: Connection,
  cfg: KeeperConfig,
  vault: CuratorVaultSnapshot,
  decision: ReadyRoll
): Promise<string | null> {
  const matured = new PublicKey(decision.maturedMarket);
  const next = new PublicKey(decision.nextMarket);

  // reallocate_from(matured): withdraw full LP, sell PT back to SY,
  // redeem SY → base. The keeper sets minimums to zero for v1 and
  // relies on on-chain slippage math. Operators with tight SLAs should
  // quote + set real min_*_out values.
  const { common: fromCommon } = await deriveReallocateAccounts(
    conn, cfg.curatorKeypair, vault, matured
  );

  const fromIx = fixedYield.curatorAdmin.buildReallocateFromMarket({
    ...fromCommon,
    allocationIndex: decision.maturedIndex,
    lpIn: new BN(vault.allocations[decision.maturedIndex].deployedBase),
    minPtOut: new BN(0),
    minSyOut: new BN(0),
    ptSellAmount: new BN(0),
    minSyForPt: new BN(0),
    syRedeemAmount: new BN(0),
    baseOutExpected: new BN(0),
  });

  // reallocate_to(next): wrap base → SY → buy PT → deposit liquidity.
  // baseIn = total matured allocation's deployed_base (best-effort — the
  // prior reallocate_from redeposits to base_escrow, and we sweep all).
  const { common: toCommon } = await deriveReallocateAccounts(
    conn, cfg.curatorKeypair, vault, next
  );

  const toIx = fixedYield.curatorAdmin.buildReallocateToMarket({
    ...toCommon,
    allocationIndex: decision.nextIndex,
    baseIn: new BN(vault.allocations[decision.maturedIndex].deployedBase),
    ptBuyAmount: new BN(0),
    maxSyIn: new BN(0),
    ptIntent: new BN(0),
    syIntent: new BN(0),
    minLpOut: new BN(0),
  });

  // Resolve the from/to markets' address_lookup_table accounts. The
  // reallocate tx carries ~34 unique pubkeys × 32 bytes + framing,
  // which exceeds Solana's 1232-byte packet cap without LUT compression.
  // Both LUTs are decoded from each market's header (slot 43..75).
  const [fromAlt, toAlt] = await Promise.all([
    loadLookupTable(conn, fromCommon.marketAlt),
    loadLookupTable(conn, toCommon.marketAlt),
  ]);

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: cfg.curatorKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      fromIx,
      toIx,
    ],
  }).compileToV0Message([fromAlt, toAlt]);
  const tx = new VersionedTransaction(msg);
  tx.sign([cfg.curatorKeypair]);

  if (cfg.dryRun) {
    console.log(
      JSON.stringify({
        event: "auto_roll.dry_run",
        vault: vault.id,
        maturedMarket: decision.maturedMarket,
        nextMarket: decision.nextMarket,
        serialized: tx.serialize().length,
      })
    );
    return null;
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}
