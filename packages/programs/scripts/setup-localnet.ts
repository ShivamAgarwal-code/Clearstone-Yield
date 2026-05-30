/**
 * setup-localnet.ts — Full environment setup on local validator
 *
 * Expects: pnpm localnet running in another terminal
 * Creates: mints, governor pool, klend market, reserves, oracles, whitelist
 *
 * Usage: SOLANA_RPC_URL=http://localhost:8899 npx tsx scripts/setup-localnet.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createMint, mintTo, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "http://localhost:8899";

// Program IDs
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const DELTA_MINT = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");

// Mainnet Pyth oracles (cloned to localnet)
const PYTH_USDC_ORACLE = new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD");

function loadKeypair(): Keypair {
  const p = path.join(process.env.HOME || "~", ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function klendDisc(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8) as Buffer;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  // Airdrop SOL
  console.log("=== Localnet Setup ===\n");
  const bal = await conn.getBalance(authority.publicKey);
  if (bal < 10 * 1e9) {
    console.log("Airdropping 100 SOL...");
    const sig = await conn.requestAirdrop(authority.publicKey, 100 * 1e9);
    await conn.confirmTransaction(sig, "confirmed");
  }
  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Balance: ${((await conn.getBalance(authority.publicKey)) / 1e9).toFixed(2)} SOL\n`);

  // === Step 1: Create test mints ===
  console.log("--- Step 1: Create test mints ---");

  // USDC mint (SPL Token, 6 decimals)
  const usdcMint = await createMint(conn, authority, authority.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  console.log(`  USDC mint: ${usdcMint.toBase58()}`);

  // USDY mint (SPL Token, 6 decimals) — the underlying RWA
  const usdyMint = await createMint(conn, authority, authority.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  console.log(`  USDY mint: ${usdyMint.toBase58()}`);

  // Mint test USDC and USDY to authority
  const usdcAta = await getOrCreateAssociatedTokenAccount(conn, authority, usdcMint, authority.publicKey);
  await mintTo(conn, authority, usdcMint, usdcAta.address, authority, 1_000_000 * 1e6); // 1M USDC
  console.log(`  Minted 1M test USDC`);

  const usdyAta = await getOrCreateAssociatedTokenAccount(conn, authority, usdyMint, authority.publicKey);
  await mintTo(conn, authority, usdyMint, usdyAta.address, authority, 1_000_000 * 1e6); // 1M USDY
  console.log(`  Minted 1M test USDY\n`);

  // === Step 2: Create governor pool + cUSDY mint ===
  console.log("--- Step 2: Initialize governor pool ---");

  const govIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "governor.json"), "utf8"));
  const govProgram = new Program(govIdl, provider);

  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), usdyMint.toBuffer()],
    GOVERNOR
  );

  const wrappedMintKp = Keypair.generate();
  const [dmMintConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), wrappedMintKp.publicKey.toBuffer()],
    DELTA_MINT
  );
  const [dmMintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), wrappedMintKp.publicKey.toBuffer()],
    DELTA_MINT
  );

  try {
    const sig = await (govProgram.methods as any)
      .initializePool({
        underlyingOracle: PYTH_USDC_ORACLE, // placeholder — will use USDC oracle for both
        borrowMint: usdcMint,
        borrowOracle: PYTH_USDC_ORACLE,
        decimals: 6,
        ltvPct: 75,
        liquidationThresholdPct: 85,
        elevationGroup: 0,
      })
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        underlyingMint: usdyMint,
        wrappedMint: wrappedMintKp.publicKey,
        dmMintConfig,
        dmMintAuthority,
        deltaMintProgram: DELTA_MINT,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([wrappedMintKp])
      .rpc();
    console.log(`  Pool: ${poolConfig.toBase58()}`);
    console.log(`  cUSDY mint: ${wrappedMintKp.publicKey.toBase58()}`);
    console.log(`  Tx: ${sig.slice(0, 20)}...\n`);
  } catch (e: any) {
    console.log(`  Pool creation: ${e.message?.slice(0, 100)}\n`);
  }

  // === Step 3: Whitelist + mint cUSDY ===
  console.log("--- Step 3: Whitelist + mint cUSDY ---");

  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), authority.publicKey.toBuffer()],
    DELTA_MINT
  );

  try {
    await (govProgram.methods as any)
      .addParticipant({ holder: {} })
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        adminEntry: null,
        dmMintConfig,
        wallet: authority.publicKey,
        whitelistEntry,
        deltaMintProgram: DELTA_MINT,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  Whitelisted: ${authority.publicKey.toBase58()}`);
  } catch (e: any) {
    console.log(`  Whitelist: ${e.message?.slice(0, 80)}`);
  }

  // Create cUSDY ATA and mint
  const dUsdyAta = getAssociatedTokenAddressSync(
    wrappedMintKp.publicKey, authority.publicKey, false, TOKEN_2022_PROGRAM_ID
  );
  try {
    const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey, dUsdyAta, authority.publicKey, wrappedMintKp.publicKey, TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(conn, tx, [authority]);
  } catch {}

  try {
    await (govProgram.methods as any)
      .mintWrapped(new BN(100_000 * 1e6))
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        adminEntry: null,
        dmMintConfig,
        wrappedMint: wrappedMintKp.publicKey,
        dmMintAuthority,
        whitelistEntry,
        destination: dUsdyAta,
        deltaMintProgram: DELTA_MINT,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Minted 100,000 cUSDY\n`);
  } catch (e: any) {
    console.log(`  Mint: ${e.message?.slice(0, 80)}\n`);
  }

  // === Step 4: Create klend market + reserves ===
  console.log("--- Step 4: Create klend market ---");

  const KLEND_GLOBAL = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
  const marketKp = Keypair.generate();
  const marketSize = 4664;
  const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), marketKp.publicKey.toBuffer()], KLEND);

  // Create market account + InitLendingMarket
  const initMarketDisc = klendDisc("init_lending_market");
  const quoteCurrency = Buffer.alloc(32);
  Buffer.from("USD").copy(quoteCurrency);

  const marketRent = await conn.getMinimumBalanceForRentExemption(marketSize);
  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx1.add(SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: marketKp.publicKey,
    lamports: marketRent,
    space: marketSize,
    programId: KLEND,
  }));
  tx1.add({
    programId: KLEND,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: marketKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([initMarketDisc, quoteCurrency]),
  });

  try {
    await sendAndConfirmTransaction(conn, tx1, [authority, marketKp]);
    console.log(`  Market: ${marketKp.publicKey.toBase58()}`);
  } catch (e: any) {
    console.log(`  Market creation failed: ${e.message?.slice(0, 100)}`);
    return;
  }

  // Create USDC reserve
  console.log("  Creating USDC reserve...");
  const usdcReserveKp = Keypair.generate();
  const reserveSize = 8624;

  // PDAs for reserve
  const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), usdcReserveKp.publicKey.toBuffer()], KLEND);
  const [feeReceiver] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), usdcReserveKp.publicKey.toBuffer()], KLEND);
  const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), usdcReserveKp.publicKey.toBuffer()], KLEND);
  const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), usdcReserveKp.publicKey.toBuffer()], KLEND);

  // Need initial USDC deposit
  const seedAta = usdcAta.address;
  const resRent = await conn.getMinimumBalanceForRentExemption(reserveSize);

  const initReserveDisc = klendDisc("init_reserve");
  const tx2 = new Transaction();
  tx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
  tx2.add(SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: usdcReserveKp.publicKey,
    lamports: resRent,
    space: reserveSize,
    programId: KLEND,
  }));
  tx2.add({
    programId: KLEND,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: marketKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: usdcReserveKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: liqSupply, isSigner: false, isWritable: true },
      { pubkey: feeReceiver, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collSupply, isSigner: false, isWritable: true },
      { pubkey: seedAta, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(initReserveDisc),
  });

  try {
    await sendAndConfirmTransaction(conn, tx2, [authority, usdcReserveKp]);
    console.log(`  USDC reserve: ${usdcReserveKp.publicKey.toBase58()}`);
  } catch (e: any) {
    console.log(`  USDC reserve failed: ${e.logs?.slice(-3).join("\n    ") || e.message?.slice(0, 150)}`);
  }

  // Configure USDC reserve with Pyth oracle
  console.log("  Configuring USDC oracle...");
  const updateDisc = klendDisc("update_reserve_config");
  const oracleData = Buffer.alloc(1 + 4 + 32 + 1); // mode(1) + len(4) + pubkey(32) + skip(1)
  oracleData.writeUInt8(20, 0); // UpdatePythPrice
  oracleData.writeUInt32LE(32, 1);
  PYTH_USDC_ORACLE.toBuffer().copy(oracleData, 5);
  oracleData.writeUInt8(1, 37); // skip validation

  const txOracle = new Transaction();
  txOracle.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  txOracle.add({
    programId: KLEND,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: KLEND_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: marketKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: usdcReserveKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([updateDisc, oracleData]),
  });

  try {
    await sendAndConfirmTransaction(conn, txOracle, [authority]);
    console.log(`  Oracle set to Pyth USDC/USD`);
  } catch (e: any) {
    console.log(`  Oracle config failed: ${e.logs?.slice(-3).join("\n    ") || e.message?.slice(0, 100)}`);
  }

  // Test RefreshReserve
  console.log("\n--- Step 5: Test RefreshReserve ---");
  const refreshDisc = klendDisc("refresh_reserve");
  const txRefresh = new Transaction();
  txRefresh.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  txRefresh.add({
    programId: KLEND,
    keys: [
      { pubkey: usdcReserveKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: marketKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: PYTH_USDC_ORACLE, isSigner: false, isWritable: false },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(refreshDisc),
  });

  try {
    const sim = await conn.simulateTransaction(txRefresh, [authority]);
    if (sim.value.err) {
      console.log(`  FAILED:`, sim.value.logs?.slice(-3).join("\n    "));
    } else {
      console.log(`  RefreshReserve: SUCCESS!`);
    }
  } catch (e: any) {
    console.log(`  Sim failed: ${e.message?.slice(0, 100)}`);
  }

  // === Save config ===
  const config = {
    cluster: "localnet",
    rpc: RPC,
    authority: authority.publicKey.toBase58(),
    mints: {
      usdc: usdcMint.toBase58(),
      usdy: usdyMint.toBase58(),
      dUsdy: wrappedMintKp.publicKey.toBase58(),
    },
    pool: {
      poolConfig: poolConfig.toBase58(),
      dmMintConfig: dmMintConfig.toBase58(),
      dmMintAuthority: dmMintAuthority.toBase58(),
    },
    market: {
      lendingMarket: marketKp.publicKey.toBase58(),
      usdcReserve: usdcReserveKp.publicKey.toBase58(),
      usdcOracle: PYTH_USDC_ORACLE.toBase58(),
    },
  };

  const outDir = path.join(__dirname, "..", "configs", "localnet");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "deployment.json"), JSON.stringify(config, null, 2));
  console.log(`\n============================================`);
  console.log(`  Config saved to configs/localnet/deployment.json`);
  console.log(`============================================`);
}

main().catch(console.error);
