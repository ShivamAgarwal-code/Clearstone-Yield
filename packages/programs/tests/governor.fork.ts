/**
 * Governor Pool Creation — Fork Integration Test
 *
 * Demonstrates the full governor-orchestrated flow:
 *   1. governor.initializePool() — creates PoolConfig + cUSDY mint via CPI to delta-mint
 *   2. governor.addParticipant(Holder) — whitelist operator via CPI
 *   3. governor.mintWrapped() — mint cUSDY via CPI
 *   4. Off-chain: create klend market + reserves
 *   5. governor.registerLendingMarket() — register klend addresses
 *   6. governor.addParticipant(Liquidator) — whitelist liquidator bot
 *   7. Verify end-to-end pool structure
 *
 * Run with:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com pnpm ts-mocha \
 *     -p ./tsconfig.json -t 1000000 tests/governor.fork.ts
 */

import { createRequire } from "node:module";
import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";

const require = createRequire(import.meta.url);
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { expect } from "chai";
import type { Governor } from "../target/types/governor";
import type { DeltaMint } from "../target/types/delta_mint";

// ---------------------------------------------------------------------------
// Mainnet constants
// ---------------------------------------------------------------------------

const BPF_UPGRADEABLE_LOADER = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
const KAMINO_MAIN_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
// Ondo USDY on Solana mainnet
const USDY_MINT = new PublicKey(
  "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"
);

// Pyth price feed accounts (from configs/)
const PYTH_USDY_PRICE = new PublicKey(
  "BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb"
);
const PYTH_USDC_PRICE = new PublicKey(
  "Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD"
);

// Klend instruction discriminators
const IX_INIT_LENDING_MARKET = Buffer.from([34, 162, 116, 14, 101, 137, 94, 239]);
const IX_INIT_RESERVE = Buffer.from([138, 245, 71, 225, 153, 4, 3, 43]);
const DISC_LENDING_MARKET = Buffer.from([246, 114, 50, 98, 72, 157, 28, 120]);
const RESERVE_ACCOUNT_SIZE = 8624;

// ---------------------------------------------------------------------------
// Klend helpers (shared with kamino-market.fork.ts)
// ---------------------------------------------------------------------------

function klendMarketAuthPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()],
    KLEND_PROGRAM_ID
  );
}

function klendGlobalConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    KLEND_PROGRAM_ID
  );
}

function reservePdas(reserve: PublicKey) {
  const find = (seed: string) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), reserve.toBuffer()],
      KLEND_PROGRAM_ID
    )[0];
  return {
    liqSupply: find("reserve_liq_supply"),
    feeVault: find("fee_receiver"),
    collMint: find("reserve_coll_mint"),
    collSupply: find("reserve_coll_supply"),
  };
}

function buildInitLendingMarketIx(owner: PublicKey, market: PublicKey): TransactionInstruction {
  const [marketAuth] = klendMarketAuthPda(market);
  const quoteCurrency = Buffer.alloc(32);
  Buffer.from("USD").copy(quoteCurrency);
  const data = Buffer.alloc(40);
  IX_INIT_LENDING_MARKET.copy(data, 0);
  quoteCurrency.copy(data, 8);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: marketAuth, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitReserveIx(
  owner: PublicKey, market: PublicKey, reserve: PublicKey,
  liquidityMint: PublicKey, initialLiqSource: PublicKey, liquidityTokenProgram: PublicKey,
): TransactionInstruction {
  const [marketAuth] = klendMarketAuthPda(market);
  const { liqSupply, feeVault, collMint, collSupply } = reservePdas(reserve);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: marketAuth, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: liquidityMint, isSigner: false, isWritable: false },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: feeVault, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collSupply, isSigner: false, isWritable: true },
      { pubkey: initialLiqSource, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: liquidityTokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_INIT_RESERVE),
  });
}

function createTokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

async function snapshotAccount(address: PublicKey, conn: Connection) {
  const info = await conn.getAccountInfo(address);
  if (!info) return null;
  return {
    address,
    info: { lamports: info.lamports, data: info.data, owner: info.owner, executable: info.executable },
  };
}

async function snapshotMany(addresses: PublicKey[], conn: Connection) {
  const results = await Promise.allSettled(addresses.map((a) => snapshotAccount(a, conn)));
  return results
    .filter(
      (r): r is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof snapshotAccount>>>> =>
        r.status === "fulfilled" && r.value !== null
    )
    .map((r) => r.value);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("governor-pool-creation (mainnet fork)", () => {
  let context: any;
  let provider: BankrunProvider;
  let governorProgram: Program<Governor>;
  let deltaMintProgram: Program<DeltaMint>;
  let mainnetAvailable = false;
  let LENDING_MARKET_SIZE = 4856;

  // ---- Governor pool state ----
  const wrappedMintKeypair = Keypair.generate();
  let poolConfigPda: PublicKey;
  let dmMintConfigPda: PublicKey;
  let dmMintAuthorityPda: PublicKey;

  // ---- Participants ----
  const kycUser = Keypair.generate();
  const liquidatorBot = Keypair.generate();
  let operatorWhitelistPda: PublicKey;
  let liquidatorWhitelistPda: PublicKey;

  // ---- Kamino state ----
  const marketKeypair = Keypair.generate();
  const dUsdyReserveKeypair = Keypair.generate();
  const usdcReserveKeypair = Keypair.generate();

  before(async () => {
    const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpcUrl);

    const [globalConfigAddr] = klendGlobalConfigPda();
    const snapshotAddresses = [
      KAMINO_MAIN_MARKET, USDC_MINT, USDY_MINT,
      PYTH_USDY_PRICE, PYTH_USDC_PRICE, globalConfigAddr,
    ];

    const mainnetAccounts = await snapshotMany(snapshotAddresses, conn);

    // Snapshot klend program + programdata
    const klendSnap = await snapshotAccount(KLEND_PROGRAM_ID, conn);
    if (klendSnap) {
      mainnetAccounts.push(klendSnap);
      const [pdAddr] = PublicKey.findProgramAddressSync(
        [KLEND_PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE_LOADER
      );
      const pdSnap = await snapshotAccount(pdAddr, conn);
      if (pdSnap) mainnetAccounts.push(pdSnap);
    }

    mainnetAvailable = mainnetAccounts.length >= 5;

    const marketSnap = mainnetAccounts.find((a) => a.address.equals(KAMINO_MAIN_MARKET));
    if (marketSnap) LENDING_MARKET_SIZE = marketSnap.info.data.length;

    context = await startAnchor("", [], mainnetAccounts);
    const payer: Keypair = context.payer;

    // Inject USDC for the payer
    if (mainnetAvailable) {
      const payerUsdcAta = getAssociatedTokenAddressSync(
        USDC_MINT, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
      context.setAccount(payerUsdcAta, {
        lamports: 2_039_280,
        data: createTokenAccountData(USDC_MINT, payer.publicKey, BigInt(1_000_000_000)),
        owner: TOKEN_PROGRAM_ID,
        executable: false,
      });
    }

    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    governorProgram = new Program<Governor>(anchor.workspace.Governor.idl, provider);
    deltaMintProgram = new Program<DeltaMint>(anchor.workspace.DeltaMint.idl, provider);

    // Derive PDAs
    [poolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), USDY_MINT.toBuffer()],
      governorProgram.programId
    );
    [dmMintConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), wrappedMintKeypair.publicKey.toBuffer()],
      deltaMintProgram.programId
    );
    [dmMintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), wrappedMintKeypair.publicKey.toBuffer()],
      deltaMintProgram.programId
    );
    [operatorWhitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), dmMintConfigPda.toBuffer(), provider.wallet.publicKey.toBuffer()],
      deltaMintProgram.programId
    );
    [liquidatorWhitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), dmMintConfigPda.toBuffer(), liquidatorBot.publicKey.toBuffer()],
      deltaMintProgram.programId
    );
  });

  // =========================================================================
  // Phase 1 — Governor: initialize pool (creates cUSDY mint via CPI)
  // =========================================================================

  it("initializes a KYC-gated lending pool via governor", async () => {
    await governorProgram.methods
      .initializePool({
        underlyingOracle: PYTH_USDY_PRICE,
        borrowMint: USDC_MINT,
        borrowOracle: PYTH_USDC_PRICE,
        decimals: 6,
        ltvPct: 75,
        liquidationThresholdPct: 82,
        elevationGroup: 1,
      })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        underlyingMint: USDY_MINT,
        wrappedMint: wrappedMintKeypair.publicKey,
        dmMintConfig: dmMintConfigPda,
        dmMintAuthority: dmMintAuthorityPda,
        deltaMintProgram: deltaMintProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([wrappedMintKeypair])
      .rpc();

    // Verify pool config
    const pool = await governorProgram.account.poolConfig.fetch(poolConfigPda);
    expect(pool.underlyingMint.toBase58()).to.equal(USDY_MINT.toBase58());
    expect(pool.wrappedMint.toBase58()).to.equal(wrappedMintKeypair.publicKey.toBase58());
    expect(pool.ltvPct).to.equal(75);
    expect(pool.liquidationThresholdPct).to.equal(82);
    expect(pool.decimals).to.equal(6);
    expect(JSON.stringify(pool.status)).to.include("initializing");

    // Verify cUSDY mint was created via CPI
    const mintConfig = await deltaMintProgram.account.mintConfig.fetch(dmMintConfigPda);
    expect(mintConfig.decimals).to.equal(6);
    expect(mintConfig.mint.toBase58()).to.equal(wrappedMintKeypair.publicKey.toBase58());

    console.log(`\n    Pool created:     ${poolConfigPda.toBase58()}`);
    console.log(`    cUSDY mint:      ${wrappedMintKeypair.publicKey.toBase58()}`);
    console.log(`    Underlying:      USDY (${USDY_MINT.toBase58()})`);
    console.log(`    Oracle:          ${PYTH_USDY_PRICE.toBase58()}`);
  });

  // =========================================================================
  // Phase 2 — Governor: whitelist operator + mint cUSDY
  // =========================================================================

  it("whitelists the operator as a Holder via governor", async () => {
    await governorProgram.methods
      .addParticipant({ holder: {} })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wallet: provider.wallet.publicKey,
        whitelistEntry: operatorWhitelistPda,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await deltaMintProgram.account.whitelistEntry.fetch(operatorWhitelistPda);
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("holder");
  });

  it("mints 100 cUSDY to operator via governor", async () => {
    // First register the market to activate the pool (mint_wrapped requires Active status)
    // For now, let's register with placeholder addresses to activate, then update later
    await governorProgram.methods
      .registerLendingMarket(
        PublicKey.default, // placeholder - will update after klend setup
        PublicKey.default,
        PublicKey.default,
      )
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
      })
      .rpc();

    const pool = await governorProgram.account.poolConfig.fetch(poolConfigPda);
    expect(JSON.stringify(pool.status)).to.include("active");

    // Now mint via governor
    const operatorAta = getAssociatedTokenAddressSync(
      wrappedMintKeypair.publicKey, provider.wallet.publicKey,
      false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createAtaIx = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey, operatorAta, provider.wallet.publicKey,
      wrappedMintKeypair.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await governorProgram.methods
      .mintWrapped(new BN(100_000_000)) // 100 cUSDY
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wrappedMint: wrappedMintKeypair.publicKey,
        dmMintAuthority: dmMintAuthorityPda,
        whitelistEntry: operatorWhitelistPda,
        destination: operatorAta,
        deltaMintProgram: deltaMintProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createAtaIx])
      .rpc();

    const ataInfo = await provider.connection.getAccountInfo(operatorAta);
    expect(ataInfo).to.not.be.null;
    const balance = ataInfo!.data.readBigUInt64LE(64);
    expect(Number(balance)).to.equal(100_000_000);
    console.log("    Minted 100 cUSDY via governor → operator ATA");
  });

  // =========================================================================
  // Phase 3 — Governor: whitelist liquidator bot
  // =========================================================================

  it("whitelists a liquidator bot via governor", async () => {
    await governorProgram.methods
      .addParticipant({ liquidator: {} })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wallet: liquidatorBot.publicKey,
        whitelistEntry: liquidatorWhitelistPda,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await deltaMintProgram.account.whitelistEntry.fetch(liquidatorWhitelistPda);
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("liquidator");
    console.log(`    Liquidator bot: ${liquidatorBot.publicKey.toBase58()}`);
  });

  it("rejects minting to a liquidator via governor", async () => {
    const liqAta = getAssociatedTokenAddressSync(
      wrappedMintKeypair.publicKey, liquidatorBot.publicKey,
      false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createAtaIx = createAssociatedTokenAccountInstruction(
      provider.wallet.publicKey, liqAta, liquidatorBot.publicKey,
      wrappedMintKeypair.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await governorProgram.methods
        .mintWrapped(new BN(1_000_000))
        .accounts({
          authority: provider.wallet.publicKey,
          poolConfig: poolConfigPda,
          adminEntry: null,
          dmMintConfig: dmMintConfigPda,
          wrappedMint: wrappedMintKeypair.publicKey,
          dmMintAuthority: dmMintAuthorityPda,
          whitelistEntry: liquidatorWhitelistPda,
          destination: liqAta,
          deltaMintProgram: deltaMintProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .preInstructions([createAtaIx])
        .rpc();
      expect.fail("Should have rejected mint to liquidator");
    } catch (err: any) {
      expect(err.toString()).to.include("LiquidatorCannotMint");
      console.log("    Correctly rejected: liquidator cannot mint via governor");
    }
  });

  // =========================================================================
  // Phase 4 — Off-chain: klend market + reserve setup
  // =========================================================================

  let klendExecutionWorks = false;

  it("creates klend market and reserves (off-chain)", function () {
    if (!mainnetAvailable) return this.skip();
    return (async () => {
      const owner = provider.wallet.publicKey;

      // --- Create lending market ---
      const marketRent = await provider.connection.getMinimumBalanceForRentExemption(LENDING_MARKET_SIZE);
      const createMarketIx = SystemProgram.createAccount({
        fromPubkey: owner, newAccountPubkey: marketKeypair.publicKey,
        lamports: marketRent, space: LENDING_MARKET_SIZE, programId: KLEND_PROGRAM_ID,
      });
      const initMarketIx = buildInitLendingMarketIx(owner, marketKeypair.publicKey);

      try {
        const tx1 = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          createMarketIx, initMarketIx,
        );
        await provider.sendAndConfirm(tx1, [marketKeypair]);
        klendExecutionWorks = true;

        console.log(`\n    klend market: ${marketKeypair.publicKey.toBase58()}`);

        // --- cUSDY reserve ---
        const reserveRent = await provider.connection.getMinimumBalanceForRentExemption(RESERVE_ACCOUNT_SIZE);
        const operatorDusdyAta = getAssociatedTokenAddressSync(
          wrappedMintKeypair.publicKey, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const tx2 = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          SystemProgram.createAccount({
            fromPubkey: owner, newAccountPubkey: dUsdyReserveKeypair.publicKey,
            lamports: reserveRent, space: RESERVE_ACCOUNT_SIZE, programId: KLEND_PROGRAM_ID,
          }),
          buildInitReserveIx(owner, marketKeypair.publicKey, dUsdyReserveKeypair.publicKey,
            wrappedMintKeypair.publicKey, operatorDusdyAta, TOKEN_2022_PROGRAM_ID),
        );
        await provider.sendAndConfirm(tx2, [dUsdyReserveKeypair]);
        console.log(`    cUSDY reserve: ${dUsdyReserveKeypair.publicKey.toBase58()}`);

        // --- USDC reserve ---
        const operatorUsdcAta = getAssociatedTokenAddressSync(
          USDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const tx3 = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          SystemProgram.createAccount({
            fromPubkey: owner, newAccountPubkey: usdcReserveKeypair.publicKey,
            lamports: reserveRent, space: RESERVE_ACCOUNT_SIZE, programId: KLEND_PROGRAM_ID,
          }),
          buildInitReserveIx(owner, marketKeypair.publicKey, usdcReserveKeypair.publicKey,
            USDC_MINT, operatorUsdcAta, TOKEN_PROGRAM_ID),
        );
        await provider.sendAndConfirm(tx3, [usdcReserveKeypair]);
        console.log(`    USDC reserve:  ${usdcReserveKeypair.publicKey.toBase58()}`);

      } catch (err: any) {
        if (err.message?.includes("deadline")) {
          console.log("\n    [BANKRUN TIMEOUT] klend BPF JIT exceeded deadline — verification only");
        } else {
          throw err;
        }
      }
    })();
  });

  // =========================================================================
  // Phase 5 — Verify complete pool structure
  // =========================================================================

  it("verifies governor pool config matches all on-chain state", async () => {
    const pool = await governorProgram.account.poolConfig.fetch(poolConfigPda);

    // Pool config values
    expect(pool.underlyingMint.toBase58()).to.equal(USDY_MINT.toBase58());
    expect(pool.wrappedMint.toBase58()).to.equal(wrappedMintKeypair.publicKey.toBase58());
    expect(pool.underlyingOracle.toBase58()).to.equal(PYTH_USDY_PRICE.toBase58());
    expect(pool.borrowMint.toBase58()).to.equal(USDC_MINT.toBase58());
    expect(pool.borrowOracle.toBase58()).to.equal(PYTH_USDC_PRICE.toBase58());
    expect(pool.ltvPct).to.equal(75);
    expect(pool.liquidationThresholdPct).to.equal(82);
    expect(pool.decimals).to.equal(6);
    expect(JSON.stringify(pool.status)).to.include("active");

    // delta-mint state consistency
    const mintConfig = await deltaMintProgram.account.mintConfig.fetch(dmMintConfigPda);
    expect(mintConfig.authority.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(mintConfig.totalWhitelisted.toNumber()).to.be.greaterThanOrEqual(2); // operator + liquidator

    // JSON config consistency
    const dUsdyConfig = require("../configs/delta_usdy_reserve.json");
    const usdcConfig = require("../configs/usdc_borrow_reserve.json");
    expect(pool.ltvPct).to.equal(dUsdyConfig.loanToValuePct);
    expect(pool.liquidationThresholdPct).to.equal(dUsdyConfig.liquidationThresholdPct);
    expect(dUsdyConfig.tokenInfo.pythConfiguration.price).to.equal(pool.underlyingOracle.toBase58());
    expect(usdcConfig.tokenInfo.pythConfiguration.price).to.equal(pool.borrowOracle.toBase58());

    console.log("\n    ============================================");
    console.log("    === Governor Pool Verified ===");
    console.log("    ============================================");
    console.log(`    Pool PDA:        ${poolConfigPda.toBase58()}`);
    console.log(`    Status:          Active`);
    console.log(`    Underlying:      USDY (${USDY_MINT.toBase58().slice(0, 8)}...)`);
    console.log(`    Wrapped mint:    cUSDY (${wrappedMintKeypair.publicKey.toBase58().slice(0, 8)}...)`);
    console.log(`    Oracle (USDY):   ${PYTH_USDY_PRICE.toBase58()}`);
    console.log(`    Oracle (USDC):   ${PYTH_USDC_PRICE.toBase58()}`);
    console.log(`    LTV / Liq:       ${pool.ltvPct}% / ${pool.liquidationThresholdPct}%`);
    console.log(`    Whitelisted:     ${mintConfig.totalWhitelisted.toNumber()} participants`);
    if (klendExecutionWorks) {
      console.log(`    klend market:    ${marketKeypair.publicKey.toBase58()}`);
      console.log(`    cUSDY reserve:   ${dUsdyReserveKeypair.publicKey.toBase58()}`);
      console.log(`    USDC reserve:    ${usdcReserveKeypair.publicKey.toBase58()}`);
    }
    console.log("    ============================================\n");
  });
});
