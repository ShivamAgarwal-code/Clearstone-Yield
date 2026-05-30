/**
 * create-wrapped-token.ts — Create a d-token (KYC-wrapped) for any SPL token.
 *
 * This script:
 *   1. Creates a test SPL token (or uses an existing one)
 *   2. Creates a governor pool for it → produces a d-token with whitelist mechanics
 *   3. Whitelists the authority wallet
 *   4. Mints test tokens and wraps them into d-tokens
 *   5. Creates a PriceUpdateV2 oracle for the d-token
 *   6. Optionally creates a klend reserve for the d-token
 *
 * Usage:
 *   npx tsx scripts/create-wrapped-token.ts [--name NAME] [--symbol SYM] [--price PRICE] [--mint EXISTING_MINT]
 *
 * Examples:
 *   npx tsx scripts/create-wrapped-token.ts --name "Test USDY" --symbol tUSDY --price 1.08
 *   npx tsx scripts/create-wrapped-token.ts --mint So11111111111111111111111111111111111111112 --name "Wrapped SOL" --symbol cSOL --price 150
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createMint, mintTo, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");
const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

function loadKeypair(): Keypair {
  const p = process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function parseArgs() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) {
      args[process.argv[i].slice(2)] = process.argv[i + 1] || "";
      i++;
    }
  }
  return {
    name: args.name || "Test USDY",
    symbol: args.symbol || "tUSDY",
    price: parseFloat(args.price || "1.08"),
    existingMint: args.mint ? new PublicKey(args.mint) : null,
    decimals: parseInt(args.decimals || "6"),
    mintAmount: parseInt(args.amount || "100000"),
  };
}

const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");

function buildPriceUpdateV2(authority: PublicKey, price: number, slot: number): Buffer {
  const buf = Buffer.alloc(133);
  let off = 0;
  PRICE_UPDATE_V2_DISC.copy(buf, off); off += 8;
  authority.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(1, off); off += 1;
  off += 32; // feed_id (zeros)
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeInt32LE(-8, off); off += 4;
  const ts = BigInt(Math.floor(Date.now() / 1000));
  buf.writeBigInt64LE(ts, off); off += 8;
  buf.writeBigInt64LE(ts - 1n, off); off += 8;
  buf.writeBigInt64LE(BigInt(Math.round(price * 1e8)), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeBigUInt64LE(BigInt(slot), off);
  return buf;
}

async function main() {
  const opts = parseArgs();
  const conn = new Connection(RPC_URL, "confirmed");
  const auth = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(auth), { commitment: "confirmed" });

  console.log("============================================");
  console.log(`  Create Wrapped Token: ${opts.symbol}`);
  console.log("============================================");
  console.log(`  Name:     ${opts.name}`);
  console.log(`  Symbol:   ${opts.symbol}`);
  console.log(`  Price:    $${opts.price}`);
  console.log(`  Decimals: ${opts.decimals}`);
  console.log(`  Authority: ${auth.publicKey.toBase58()}`);
  console.log(`  Balance:   ${((await conn.getBalance(auth.publicKey)) / 1e9).toFixed(4)} SOL`);
  console.log("============================================\n");

  // Step 1: Create or use existing underlying token
  let underlyingMint: PublicKey;
  if (opts.existingMint) {
    underlyingMint = opts.existingMint;
    console.log(`Using existing mint: ${underlyingMint.toBase58()}`);
  } else {
    console.log(`Creating ${opts.name} mint...`);
    underlyingMint = await createMint(conn, auth, auth.publicKey, null, opts.decimals);
    console.log(`  Mint: ${underlyingMint.toBase58()}`);
  }

  // Step 2: Check if pool already exists
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), underlyingMint.toBuffer()],
    GOVERNOR
  );
  const poolInfo = await conn.getAccountInfo(poolPda);

  let wrappedMint: PublicKey;
  let dmMintConfig: PublicKey;

  if (poolInfo) {
    console.log(`\nPool already exists: ${poolPda.toBase58()}`);
    // Read wrapped mint from pool data (offset 8 + 5*32 = 168, 32 bytes)
    wrappedMint = new PublicKey(poolInfo.data.subarray(168, 200));
    dmMintConfig = new PublicKey(poolInfo.data.subarray(200, 232));
    console.log(`  Wrapped mint: ${wrappedMint.toBase58()}`);
  } else {
    console.log(`\nCreating governor pool...`);
    const govIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "governor.json"), "utf8"));
    const govProgram = new Program(govIdl, provider);

    const wrappedMintKp = Keypair.generate();
    wrappedMint = wrappedMintKp.publicKey;

    const [dmConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), wrappedMint.toBuffer()],
      DELTA_MINT
    );
    dmMintConfig = dmConfig;

    const [dmAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), wrappedMint.toBuffer()],
      DELTA_MINT
    );

    // Create a PriceUpdateV2 oracle for the underlying
    const oracleKp = Keypair.generate();
    const slot = await conn.getSlot();
    const oracleRent = await conn.getMinimumBalanceForRentExemption(133);
    const oracleData = buildPriceUpdateV2(auth.publicKey, opts.price, slot);

    // Create oracle account
    const txOracle = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: auth.publicKey,
        newAccountPubkey: oracleKp.publicKey,
        lamports: oracleRent,
        space: 133,
        programId: MOCK_ORACLE,
      }));
    await sendAndConfirmTransaction(conn, txOracle, [auth, oracleKp]);

    // Write oracle data
    const writeDisc = crypto.createHash("sha256").update("global:write_raw").digest().subarray(0, 8);
    const writeArgs = Buffer.alloc(4 + 4 + oracleData.length);
    writeArgs.writeUInt32LE(0, 0);
    writeArgs.writeUInt32LE(oracleData.length, 4);
    oracleData.copy(writeArgs, 8);

    const txWrite = new Transaction().add({
      programId: MOCK_ORACLE,
      keys: [
        { pubkey: auth.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracleKp.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([writeDisc, writeArgs]),
    });
    await sendAndConfirmTransaction(conn, txWrite, [auth]);
    console.log(`  Oracle created: ${oracleKp.publicKey.toBase58()} ($${opts.price})`);

    // Create USDC oracle (for borrow side — reuse existing if available)
    let usdcOracle: PublicKey;
    try {
      const feeds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs/devnet/pyth-receiver-feeds.json"), "utf8"));
      usdcOracle = new PublicKey(feeds.USDC);
    } catch {
      usdcOracle = oracleKp.publicKey; // fallback: use same oracle
    }

    // Initialize pool via governor
    const sig = await (govProgram.methods as any)
      .initializePool({
        underlyingOracle: oracleKp.publicKey,
        borrowMint: PublicKey.default, // will be set later
        borrowOracle: usdcOracle,
        decimals: opts.decimals,
        ltvPct: 75,
        liquidationThresholdPct: 85,
        elevationGroup: 0,
      })
      .accounts({
        authority: auth.publicKey,
        poolConfig: poolPda,
        underlyingMint,
        wrappedMint: wrappedMintKp.publicKey,
        dmMintConfig: dmConfig,
        dmMintAuthority: dmAuthority,
        deltaMintProgram: DELTA_MINT,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([wrappedMintKp])
      .rpc();

    console.log(`  Pool created: ${poolPda.toBase58()}`);
    console.log(`  d${opts.symbol} mint: ${wrappedMint.toBase58()}`);
    console.log(`  Tx: ${sig.slice(0, 30)}...`);

    // Create vault (ATA for underlying token, owned by pool PDA)
    console.log(`  Creating vault...`);
    const vaultAta = await getOrCreateAssociatedTokenAccount(
      conn, auth, underlyingMint, poolPda, true // allowOwnerOffCurve for PDA
    );
    console.log(`  Vault: ${vaultAta.address.toBase58()}`);

    // Register lending market
    try {
      const marketConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs/devnet/working-reserves.json"), "utf8"));
      await (govProgram.methods as any)
        .registerLendingMarket(
          new PublicKey(marketConfig.market || "45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98"),
          PublicKey.default, // collateral reserve TBD
          PublicKey.default, // borrow reserve TBD
        )
        .accounts({ authority: auth.publicKey, poolConfig: poolPda })
        .rpc();
      console.log(`  Lending market registered`);
    } catch {
      console.log(`  Lending market registration skipped (pool may need separate setup)`);
    }

    // Save oracle
    const oracleConfig = { address: oracleKp.publicKey.toBase58(), price: opts.price };
    fs.writeFileSync(
      path.join(__dirname, "..", `configs/devnet/${opts.symbol.toLowerCase()}-oracle.json`),
      JSON.stringify(oracleConfig, null, 2)
    );
  }

  // Step 3: Whitelist authority
  console.log(`\nWhitelisting authority...`);
  const govIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "governor.json"), "utf8"));
  const govProgram = new Program(govIdl, provider);

  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), auth.publicKey.toBuffer()],
    DELTA_MINT
  );
  const wlInfo = await conn.getAccountInfo(whitelistEntry);
  if (wlInfo) {
    console.log(`  Already whitelisted`);
  } else {
    try {
      await (govProgram.methods as any)
        .addParticipant({ holder: {} })
        .accounts({
          authority: auth.publicKey,
          poolConfig: poolPda,
          adminEntry: null,
          dmMintConfig,
          wallet: auth.publicKey,
          whitelistEntry,
          deltaMintProgram: DELTA_MINT,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  Whitelisted!`);
    } catch (e: any) {
      console.log(`  Whitelist failed: ${e.message?.slice(0, 80)}`);
    }
  }

  // Step 4: Activate wrapping (transfer delta-mint authority to pool PDA)
  console.log(`\nActivating wrap flow...`);
  try {
    await (govProgram.methods as any)
      .activateWrapping()
      .accounts({
        authority: auth.publicKey,
        poolConfig: poolPda,
        dmMintConfig,
        deltaMintProgram: DELTA_MINT,
      })
      .rpc();
    console.log(`  Wrapping activated! Pool PDA is now the delta-mint authority.`);
  } catch (e: any) {
    console.log(`  Activate failed: ${e.message?.slice(0, 80)}`);
    console.log(`  (May already be activated or authority mismatch)`);
  }

  // Step 5: Mint test underlying tokens
  if (!opts.existingMint) {
    console.log(`\nMinting ${opts.mintAmount} ${opts.name}...`);
    const ata = await getOrCreateAssociatedTokenAccount(conn, auth, underlyingMint, auth.publicKey);
    await mintTo(conn, auth, underlyingMint, ata.address, auth, opts.mintAmount * 10 ** opts.decimals);
    console.log(`  Minted to: ${ata.address.toBase58()}`);
  }

  // Step 5: Wrap underlying → d-tokens (backed 1:1)
  console.log(`\nWrapping ${opts.mintAmount} ${opts.name} → d${opts.symbol}...`);
  const [dmAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), wrappedMint.toBuffer()],
    DELTA_MINT
  );
  const dTokenAta = getAssociatedTokenAddressSync(wrappedMint, auth.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const underlyingAta = getAssociatedTokenAddressSync(underlyingMint, auth.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(underlyingMint, poolPda, true);

  try {
    // Create d-token ATA if needed
    const ataInfo = await conn.getAccountInfo(dTokenAta);
    if (!ataInfo) {
      const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(auth.publicKey, dTokenAta, auth.publicKey, wrappedMint, TOKEN_2022_PROGRAM_ID)
      );
      await sendAndConfirmTransaction(conn, tx, [auth]);
    }

    // Ensure vault ATA exists
    await getOrCreateAssociatedTokenAccount(conn, auth, underlyingMint, poolPda, true);

    const wrapAmount = new BN(opts.mintAmount * 10 ** opts.decimals);
    await (govProgram.methods as any)
      .wrap(wrapAmount)
      .accounts({
        user: auth.publicKey,
        poolConfig: poolPda,
        underlyingMint,
        userUnderlyingAta: underlyingAta,
        vault: vaultAta,
        dmMintConfig,
        wrappedMint,
        dmMintAuthority: dmAuthority,
        whitelistEntry,
        userWrappedAta: dTokenAta,
        deltaMintProgram: DELTA_MINT,
        underlyingTokenProgram: TOKEN_PROGRAM_ID,
        wrappedTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    console.log(`  Wrapped ${opts.mintAmount} ${opts.name} → d${opts.symbol} (1:1 backed)`);
  } catch (e: any) {
    console.log(`  Wrap failed: ${e.message?.slice(0, 120)}`);
    console.log(`  (This is expected for existing pools — authority may not be transferred)`);
    // Fallback: try legacy mint_wrapped for old pools
    try {
      const mintAmount = new BN(opts.mintAmount * 10 ** opts.decimals);
      await (govProgram.methods as any)
        .mintWrapped(mintAmount)
        .accounts({
          authority: auth.publicKey,
          poolConfig: poolPda,
          adminEntry: null,
          dmMintConfig,
          wrappedMint,
          dmMintAuthority: dmAuthority,
          whitelistEntry,
          destination: dTokenAta,
          deltaMintProgram: DELTA_MINT,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      console.log(`  Fallback: minted ${opts.mintAmount} d${opts.symbol} (unbacked — legacy mode)`);
    } catch (e2: any) {
      console.log(`  Legacy mint also failed: ${e2.message?.slice(0, 80)}`);
    }
  }

  // Save config
  const tokenConfig = {
    name: opts.name,
    symbol: opts.symbol,
    decimals: opts.decimals,
    price: opts.price,
    underlyingMint: underlyingMint.toBase58(),
    wrappedMint: wrappedMint.toBase58(),
    pool: poolPda.toBase58(),
    dmMintConfig: dmMintConfig.toBase58(),
    createdAt: new Date().toISOString(),
  };
  const outPath = path.join(__dirname, "..", `configs/devnet/${opts.symbol.toLowerCase()}-token.json`);
  fs.writeFileSync(outPath, JSON.stringify(tokenConfig, null, 2));

  console.log("\n============================================");
  console.log(`  d${opts.symbol} Token Ready`);
  console.log("============================================");
  console.log(`  Underlying: ${underlyingMint.toBase58()}`);
  console.log(`  d${opts.symbol}:     ${wrappedMint.toBase58()}`);
  console.log(`  Pool:       ${poolPda.toBase58()}`);
  console.log(`  Config:     ${outPath}`);
  console.log("============================================");
}

main().catch(console.error);
