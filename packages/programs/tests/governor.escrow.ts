/**
 * Governor — Escrow role routing + activated-pool Liquidator regression
 *
 * Runs on the local validator (no mainnet fork). Verifies:
 *   1. add_participant(Escrow) on a non-activated pool creates a whitelist entry
 *      with role = Escrow (routes through delta_cpi::add_escrow).
 *   2. After activate_wrapping + fix_co_authority, add_participant_via_pool(Escrow)
 *      creates a whitelist entry with role = Escrow (routes through
 *      delta_cpi::add_escrow_with_co_authority).
 *   3. add_participant_via_pool(Liquidator) now correctly stores role = Liquidator
 *      (regression — previously it fell through to the Holder path and stored
 *      role = Holder on activated pools).
 *   4. add_participant_via_pool(Holder) still works (no regression).
 *
 * The underlying-mint and oracle pubkeys are arbitrary here; the governor
 * only stores them. Nothing in these code paths reads the underlying mint
 * as a real token account.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import type { Governor } from "../target/types/governor";
import type { DeltaMint } from "../target/types/delta_mint";

describe("governor — escrow role + co-auth regressions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const governorProgram = anchor.workspace.Governor as Program<Governor>;
  const deltaMintProgram = anchor.workspace.DeltaMint as Program<DeltaMint>;

  // Arbitrary pubkeys — governor only stores these.
  const underlyingMint = Keypair.generate().publicKey;
  const borrowMint = Keypair.generate().publicKey;
  const underlyingOracle = Keypair.generate().publicKey;
  const borrowOracle = Keypair.generate().publicKey;

  // The wrapped mint IS actually created by the CPI into delta-mint, so this
  // must be a fresh Signer.
  const wrappedMintKeypair = Keypair.generate();

  // Participants we'll whitelist under various roles.
  const escrowPdaPre = Keypair.generate().publicKey; // pre-activation target
  const escrowPdaPost = Keypair.generate().publicKey; // post-activation target
  const holderPost = Keypair.generate().publicKey;
  const liquidatorPost = Keypair.generate().publicKey;

  // PDAs
  let poolConfigPda: PublicKey;
  let dmMintConfigPda: PublicKey;
  let dmMintAuthorityPda: PublicKey;
  let wlEscrowPre: PublicKey;
  let wlEscrowPost: PublicKey;
  let wlHolderPost: PublicKey;
  let wlLiquidatorPost: PublicKey;

  const deriveWhitelist = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), dmMintConfigPda.toBuffer(), wallet.toBuffer()],
      deltaMintProgram.programId
    )[0];

  before(() => {
    [poolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), underlyingMint.toBuffer()],
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

    wlEscrowPre = deriveWhitelist(escrowPdaPre);
    wlEscrowPost = deriveWhitelist(escrowPdaPost);
    wlHolderPost = deriveWhitelist(holderPost);
    wlLiquidatorPost = deriveWhitelist(liquidatorPost);
  });

  it("initializes a fresh pool (pool status: Initializing)", async () => {
    await governorProgram.methods
      .initializePool({
        underlyingOracle,
        borrowMint,
        borrowOracle,
        decimals: 6,
        ltvPct: 75,
        liquidationThresholdPct: 82,
        elevationGroup: 1,
      })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        underlyingMint,
        wrappedMint: wrappedMintKeypair.publicKey,
        dmMintConfig: dmMintConfigPda,
        dmMintAuthority: dmMintAuthorityPda,
        deltaMintProgram: deltaMintProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([wrappedMintKeypair])
      .rpc();

    const pool = await governorProgram.account.poolConfig.fetch(poolConfigPda);
    expect(pool.underlyingMint.toBase58()).to.equal(underlyingMint.toBase58());
    expect(JSON.stringify(pool.status)).to.include("initializing");
  });

  // -------------------------------------------------------------------------
  // Non-activated pool — add_participant (routes via delta-mint's *authority*
  // path, i.e. add_escrow / add_liquidator / add_to_whitelist).
  // -------------------------------------------------------------------------

  it("add_participant({ escrow: {} }) — non-activated pool → role = Escrow", async () => {
    await governorProgram.methods
      .addParticipant({ escrow: {} })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wallet: escrowPdaPre,
        whitelistEntry: wlEscrowPre,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await deltaMintProgram.account.whitelistEntry.fetch(
      wlEscrowPre
    );
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("escrow");
    expect(JSON.stringify(entry.role)).to.not.include("holder");
    expect(JSON.stringify(entry.role)).to.not.include("liquidator");
  });

  // -------------------------------------------------------------------------
  // Activate wrapping — moves delta-mint authority to the pool PDA so the
  // add_participant_via_pool path becomes the live one.
  // -------------------------------------------------------------------------

  it("activate_wrapping + fix_co_authority transfers auth to the pool PDA", async () => {
    await governorProgram.methods
      .activateWrapping()
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        dmMintConfig: dmMintConfigPda,
        deltaMintProgram: deltaMintProgram.programId,
      })
      .rpc();

    await governorProgram.methods
      .fixCoAuthority()
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        dmMintConfig: dmMintConfigPda,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await deltaMintProgram.account.mintConfig.fetch(
      dmMintConfigPda
    );
    expect(config.authority.toBase58()).to.equal(poolConfigPda.toBase58());
    expect(config.coAuthority.toBase58()).to.equal(poolConfigPda.toBase58());
  });

  // -------------------------------------------------------------------------
  // Activated pool — add_participant_via_pool (routes via delta-mint's
  // co-authority path, i.e. add_escrow_with_co_authority etc.).
  // -------------------------------------------------------------------------

  it("add_participant_via_pool({ escrow: {} }) → role = Escrow", async () => {
    await governorProgram.methods
      .addParticipantViaPool({ escrow: {} })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wallet: escrowPdaPost,
        whitelistEntry: wlEscrowPost,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await deltaMintProgram.account.whitelistEntry.fetch(
      wlEscrowPost
    );
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("escrow");
  });

  it("add_participant_via_pool({ liquidator: {} }) → role = Liquidator (bug fix)", async () => {
    // Pre-fix behavior: the Liquidator arm fell through to
    // delta_cpi::add_to_whitelist_with_co_authority which hardcoded role = Holder.
    // Post-fix: routes to delta_cpi::add_liquidator_with_co_authority.
    await governorProgram.methods
      .addParticipantViaPool({ liquidator: {} })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wallet: liquidatorPost,
        whitelistEntry: wlLiquidatorPost,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await deltaMintProgram.account.whitelistEntry.fetch(
      wlLiquidatorPost
    );
    expect(entry.approved).to.be.true;
    expect(
      JSON.stringify(entry.role),
      "role must be Liquidator, not Holder (bug fix)"
    ).to.include("liquidator");
    expect(JSON.stringify(entry.role)).to.not.include("holder");
  });

  it("add_participant_via_pool({ holder: {} }) → role = Holder (no regression)", async () => {
    await governorProgram.methods
      .addParticipantViaPool({ holder: {} })
      .accounts({
        authority: provider.wallet.publicKey,
        poolConfig: poolConfigPda,
        adminEntry: null,
        dmMintConfig: dmMintConfigPda,
        wallet: holderPost,
        whitelistEntry: wlHolderPost,
        deltaMintProgram: deltaMintProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await deltaMintProgram.account.whitelistEntry.fetch(
      wlHolderPost
    );
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("holder");
    expect(JSON.stringify(entry.role)).to.not.include("escrow");
    expect(JSON.stringify(entry.role)).to.not.include("liquidator");
  });
});
