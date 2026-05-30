/**
 * Delegated (user-signed, permissionless) roll execution.
 *
 * This path is the v2 permissioning — a keeper with no curator key
 * cranks a user's roll under bounds the user signed at deposit time.
 * See KEEPER_PERMISSIONS.md §4C + CURATOR_ROLL_DELEGATION.md.
 *
 * Semantics vs. the curator-signed path (`roll.ts`):
 *   - one delegated ix rebalances ONE user's position, not the whole
 *     vault — `crank_roll_delegated` operates on the allocation-slot
 *     level, not per-user share accounting (the vault still aggregates
 *     via total_shares/total_assets post-roll).
 *   - the keeper can be any wallet; `keeper: Signer` has zero privilege.
 *   - slippage floor is enforced on-chain against the user's delegation.
 *
 * v1 limitation: the curator's `allocations` are vault-level, so one
 * delegated crank effectively rolls the whole position on that
 * allocation slot — not just the delegating user's share. That's fine
 * for single-user vaults and for vaults where all users have delegated.
 * Mixed (some delegated, some not) requires per-user accounting; it
 * falls back to the curator-signed path for now.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { fixedYield, CLEARSTONE_CORE_PROGRAM_ID } from "@delta/calldata-sdk-solana";
import type { CuratorVaultSnapshot } from "./edge.js";
import type { KeeperConfig } from "./config.js";
import type { LiveDelegation } from "./delegations.js";

export type DelegatedRollDecision =
  | { reason: "no-matured-allocation" }
  | { reason: "no-next-allocation" }
  | { reason: "delegation-expired" }
  | { reason: "hash-mismatch" }
  | {
      reason: "ready";
      fromIndex: number;
      toIndex: number;
      fromMarket: string;
      toMarket: string;
      deployedBase: bigint;
      minBaseOut: bigint;
    };

export function decideDelegatedRoll(
  vault: CuratorVaultSnapshot,
  delegation: LiveDelegation,
  nowTs: number,
  nowSlot: bigint,
  graceSec: number
): DelegatedRollDecision {
  if (nowSlot >= delegation.expiresAtSlot) {
    return { reason: "delegation-expired" };
  }

  if (
    !vault.nextAutoRollTs ||
    vault.nextAutoRollTs + graceSec > nowTs
  ) {
    return { reason: "no-matured-allocation" };
  }

  const maturedIdx = vault.allocations.findIndex(
    (a) => BigInt(a.deployedBase) > 0n
  );
  if (maturedIdx < 0) {
    return { reason: "no-matured-allocation" };
  }

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

  const deployed = BigInt(vault.allocations[maturedIdx].deployedBase);
  const floor = fixedYield.delegation.slippageFloor(
    deployed,
    delegation.maxSlippageBps
  );

  return {
    reason: "ready",
    fromIndex: maturedIdx,
    toIndex: nextIdx,
    fromMarket: vault.allocations[maturedIdx].market,
    toMarket: vault.allocations[nextIdx].market,
    deployedBase: deployed,
    minBaseOut: floor,
  };
}

/**
 * Derive the full account set for one side of a crank. Reuses the
 * market-header decode from the curator-signed path — same layout.
 */
async function deriveCrankAccountsFor(
  conn: Connection,
  vault: CuratorVaultSnapshot,
  marketPk: PublicKey
) {
  const vaultPk = new PublicKey(vault.vault);
  const baseMintPk = new PublicKey(vault.baseMint);

  const marketInfo = await conn.getAccountInfo(marketPk);
  if (!marketInfo) return null;
  const data = marketInfo.data;

  // MarketTwo header offsets — matches backend-edge decoders.
  const mintPt = new PublicKey(data.slice(8 + 32 + 2 + 1 + 32, 8 + 32 + 2 + 1 + 64));
  const mintSy = new PublicKey(
    data.slice(8 + 32 + 2 + 1 + 64, 8 + 32 + 2 + 1 + 96)
  );
  const mintLp = new PublicKey(data.slice(171, 203));
  const marketEscrowPt = new PublicKey(data.slice(203, 235));
  const marketEscrowSy = new PublicKey(data.slice(235, 267));
  const tokenFeeTreasurySy = new PublicKey(data.slice(267, 299));
  const marketAlt = new PublicKey(data.slice(43, 75));

  const coreVaultPk = new PublicKey(data.slice(8 + 32 + 2 + 1 + 96, 8 + 32 + 2 + 1 + 128));
  const coreVaultInfo = await conn.getAccountInfo(coreVaultPk);
  if (!coreVaultInfo) return null;
  const syProgram = new PublicKey(coreVaultInfo.data.slice(43, 75));

  const [coreEventAuthority] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("__event_authority")],
    CLEARSTONE_CORE_PROGRAM_ID
  );

  // See the comment in roll.ts — prefer snapshot-supplied adapter keys
  // for non-generic SY adapters.
  const syMarket = vault.adapter
    ? new PublicKey(vault.adapter.syMarket)
    : PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("sy_market"), baseMintPk.toBuffer()],
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
    from: {
      market: marketPk,
      marketEscrowPt,
      marketEscrowSy,
      tokenFeeTreasurySy,
      marketAlt,
      mintPt,
      mintLp,
      vaultPtAta,
      vaultLpAta,
    },
    // Shared fields — same on both sides.
    syProgram,
    syMarket,
    syMint: mintSy,
    adapterBaseVault,
    vaultSyAta,
    coreEventAuthority,
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

export async function executeDelegatedRoll(
  conn: Connection,
  cfg: KeeperConfig,
  vault: CuratorVaultSnapshot,
  delegation: LiveDelegation,
  decision: Extract<DelegatedRollDecision, { reason: "ready" }>
): Promise<string | null> {
  const fromPk = new PublicKey(decision.fromMarket);
  const toPk = new PublicKey(decision.toMarket);

  // Two parallel account-derivation passes (from and to markets are
  // separate MarketTwo accounts).
  const [fromSide, toSide] = await Promise.all([
    deriveCrankAccountsFor(conn, vault, fromPk),
    deriveCrankAccountsFor(conn, vault, toPk),
  ]);
  if (!fromSide || !toSide) {
    throw new Error("failed to derive crank accounts (market account missing)");
  }

  const ix = fixedYield.delegation.buildCrankRollDelegated({
    keeper: cfg.curatorKeypair.publicKey,
    delegation: delegation.pda,
    vault: new PublicKey(vault.vault),
    baseMint: new PublicKey(vault.baseMint),
    baseEscrow: new PublicKey(vault.baseEscrow),
    syMarket: fromSide.syMarket,
    syMint: fromSide.syMint,
    adapterBaseVault: fromSide.adapterBaseVault,
    vaultSyAta: fromSide.vaultSyAta,
    fromMarket: fromSide.from.market,
    fromMarketEscrowPt: fromSide.from.marketEscrowPt,
    fromMarketEscrowSy: fromSide.from.marketEscrowSy,
    fromTokenFeeTreasurySy: fromSide.from.tokenFeeTreasurySy,
    fromMarketAlt: fromSide.from.marketAlt,
    fromMintPt: fromSide.from.mintPt,
    fromMintLp: fromSide.from.mintLp,
    fromVaultPtAta: fromSide.from.vaultPtAta,
    fromVaultLpAta: fromSide.from.vaultLpAta,
    toMarket: toSide.from.market,
    toMarketEscrowPt: toSide.from.marketEscrowPt,
    toMarketEscrowSy: toSide.from.marketEscrowSy,
    toTokenFeeTreasurySy: toSide.from.tokenFeeTreasurySy,
    toMarketAlt: toSide.from.marketAlt,
    toMintPt: toSide.from.mintPt,
    toMintLp: toSide.from.mintLp,
    toVaultPtAta: toSide.from.vaultPtAta,
    toVaultLpAta: toSide.from.vaultLpAta,
    coreEventAuthority: fromSide.coreEventAuthority,
    syProgram: fromSide.syProgram,
    fromIndex: decision.fromIndex,
    toIndex: decision.toIndex,
    minBaseOut: new BN(decision.minBaseOut.toString()),
  });

  // Pre-init the to-side vault ATAs if they don't exist yet. The
  // curator program dropped `init_if_needed` on these two accounts to
  // keep CrankRollDelegated's stack frame under the SBF cap (see
  // FOLLOWUPS :: CURATOR_CRANK_STACK_OVERFLOW). Keepers now own the
  // one-time rent cost per (vault, market) pair.
  const vaultPk = new PublicKey(vault.vault);
  const preIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      cfg.curatorKeypair.publicKey,
      toSide.from.vaultPtAta,
      vaultPk,
      toSide.from.mintPt,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      cfg.curatorKeypair.publicKey,
      toSide.from.vaultLpAta,
      vaultPk,
      toSide.from.mintLp,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  // crank_roll_delegated carries 33 accounts in one ix; without the
  // from/to market LUTs the compiled tx exceeds Solana's 1232-byte
  // packet cap and serialize() throws "encoding overruns Uint8Array".
  const [fromAlt, toAlt] = await Promise.all([
    loadLookupTable(conn, fromSide.from.marketAlt),
    loadLookupTable(conn, toSide.from.marketAlt),
  ]);

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: cfg.curatorKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }),
      ...preIxs,
      ix,
    ],
  }).compileToV0Message([fromAlt, toAlt]);
  const tx = new VersionedTransaction(msg);
  tx.sign([cfg.curatorKeypair]);

  if (cfg.dryRun) {
    return null;
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// Silence unused-import warning when the helper isn't exercised directly.
export type _KeeperKeypair = Keypair;
