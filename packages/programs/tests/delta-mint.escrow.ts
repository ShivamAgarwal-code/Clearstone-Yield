/**
 * Delta-Mint — Escrow role + co-authority role regressions
 *
 * Covers the M-KYC-0 changes:
 *   - WhitelistRole::Escrow appended to the enum.
 *   - add_escrow / add_escrow_with_co_authority create Escrow-role entries.
 *   - add_liquidator_with_co_authority correctly stores Liquidator role
 *     (previously missing — forced governor.add_participant_via_pool(Liquidator)
 *     to fall back to the Holder path and write the wrong role).
 *   - mint_to rejects BOTH Escrow and Liquidator entries (fail-closed).
 *   - A plain Token-2022 transfer FROM a Holder INTO an Escrow ATA succeeds —
 *     the property clearstone_core's escrow_sy PDAs rely on.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import { expect } from "chai";
import type { DeltaMint } from "../target/types/delta_mint";

describe("delta-mint — escrow + co-authority regressions", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DeltaMint as Program<DeltaMint>;
  const authority = provider.wallet;

  // Fresh mint per describe block so we don't collide with delta-mint.ts state.
  const mintKeypair = Keypair.generate();

  // An arbitrary "PDA-shaped" pubkey used as an Escrow custody account owner.
  // In production this would be a clearstone_core escrow_sy PDA.
  const escrowOwner = Keypair.generate();

  // A KYC'd holder we can mint to + transfer from.
  const holder = Keypair.generate();

  // A co-authority keypair — stands in for a governor pool PDA so we can
  // exercise the *_with_co_authority paths without the full activate_wrapping
  // dance. Works because delta-mint's check is mint_config.co_authority ==
  // co_authority.key() — any signer will do as long as it matches.
  const coAuthority = Keypair.generate();

  // Two more wallets to exercise the co-auth paths.
  const escrowOwnerViaCoAuth = Keypair.generate();
  const liquidatorViaCoAuth = Keypair.generate();

  let mintConfigPda: PublicKey;
  let mintAuthorityPda: PublicKey;
  let holderWhitelistPda: PublicKey;
  let escrowWhitelistPda: PublicKey;
  let escrowCoAuthWhitelistPda: PublicKey;
  let liqCoAuthWhitelistPda: PublicKey;

  before(async () => {
    [mintConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [holderWhitelistPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        holder.publicKey.toBuffer(),
      ],
      program.programId
    );
    [escrowWhitelistPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        escrowOwner.publicKey.toBuffer(),
      ],
      program.programId
    );
    [escrowCoAuthWhitelistPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        escrowOwnerViaCoAuth.publicKey.toBuffer(),
      ],
      program.programId
    );
    [liqCoAuthWhitelistPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        liquidatorViaCoAuth.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Fund the co-authority so it can pay for its own whitelist ix fees if needed.
    const sig = await provider.connection.requestAirdrop(
      coAuthority.publicKey,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(sig);
  });

  it("initializes a fresh mint for this test suite", async () => {
    await program.methods
      .initializeMint(6)
      .accounts({
        authority: authority.publicKey,
        mint: mintKeypair.publicKey,
        mintConfig: mintConfigPda,
        mintAuthority: mintAuthorityPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([mintKeypair])
      .rpc();

    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.decimals).to.equal(6);
    expect(config.totalWhitelisted.toNumber()).to.equal(0);
  });

  it("add_escrow creates a whitelist entry with role = Escrow", async () => {
    await program.methods
      .addEscrow()
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        wallet: escrowOwner.publicKey,
        whitelistEntry: escrowWhitelistPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.whitelistEntry.fetch(
      escrowWhitelistPda
    );
    expect(entry.approved).to.be.true;
    expect(entry.wallet.toBase58()).to.equal(escrowOwner.publicKey.toBase58());
    // Anchor serializes enum variants as objects keyed by the lowercase variant name.
    expect(JSON.stringify(entry.role)).to.include("escrow");
    expect(JSON.stringify(entry.role)).to.not.include("holder");
    expect(JSON.stringify(entry.role)).to.not.include("liquidator");
  });

  it("mint_to against an Escrow-role entry is rejected (fail-closed)", async () => {
    // Create an ATA owned by escrowOwner so the destination is valid.
    const escrowAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      escrowOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createAtaIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      escrowAta,
      escrowOwner.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await provider.sendAndConfirm(new Transaction().add(createAtaIx));

    let threw = false;
    try {
      await program.methods
        .mintTo(new BN(1_000))
        .accounts({
          authority: authority.publicKey,
          mintConfig: mintConfigPda,
          mint: mintKeypair.publicKey,
          mintAuthority: mintAuthorityPda,
          whitelistEntry: escrowWhitelistPda,
          destination: escrowAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      // Same error the Liquidator path has hit since day 1 — the check is
      // `role == Holder` with `LiquidatorCannotMint`. Reusing it is
      // deliberate: it's a non-Holder reject, not a Liquidator-specific one.
      expect(err.toString()).to.match(/LiquidatorCannotMint|0x177[0-9a-fA-F]/);
    }
    expect(threw, "mint_to to Escrow entry must revert").to.be.true;
  });

  it("plain SPL transfer Holder → Escrow ATA succeeds (pass-through property)", async () => {
    // 1) Whitelist the holder + mint them tokens.
    await program.methods
      .addToWhitelist()
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        wallet: holder.publicKey,
        whitelistEntry: holderWhitelistPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const holderAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      holder.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createHolderAtaIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      holderAta,
      holder.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    await program.methods
      .mintTo(new BN(1_000_000))
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        mint: mintKeypair.publicKey,
        mintAuthority: mintAuthorityPda,
        whitelistEntry: holderWhitelistPda,
        destination: holderAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createHolderAtaIx])
      .rpc();

    // 2) Transfer from holder → escrowOwner's ATA. The escrow ATA already
    // exists from the previous test. Holder signs.
    const escrowAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      escrowOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Holder needs lamports to pay tx fees for signing.
    const airdropSig = await provider.connection.requestAirdrop(
      holder.publicKey,
      100_000_000
    );
    await provider.connection.confirmTransaction(airdropSig);

    const transferIx = createTransferCheckedInstruction(
      holderAta,
      mintKeypair.publicKey,
      escrowAta,
      holder.publicKey,
      500_000,
      6,
      [],
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(transferIx);
    tx.feePayer = holder.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(holder);
    const sig = await provider.connection.sendRawTransaction(tx.serialize());
    await provider.connection.confirmTransaction(sig);

    const escrowAcc = await getAccount(
      provider.connection,
      escrowAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(escrowAcc.amount)).to.equal(500_000);

    const holderAcc = await getAccount(
      provider.connection,
      holderAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(holderAcc.amount)).to.equal(500_000);
  });

  it("set_co_authority registers a co-authority signer", async () => {
    await program.methods
      .setCoAuthority(coAuthority.publicKey)
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.coAuthority.toBase58()).to.equal(
      coAuthority.publicKey.toBase58()
    );
  });

  it("add_escrow_with_co_authority stores role = Escrow (co-auth path)", async () => {
    await program.methods
      .addEscrowWithCoAuthority()
      .accounts({
        coAuthority: coAuthority.publicKey,
        payer: authority.publicKey,
        mintConfig: mintConfigPda,
        wallet: escrowOwnerViaCoAuth.publicKey,
        whitelistEntry: escrowCoAuthWhitelistPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([coAuthority])
      .rpc();

    const entry = await program.account.whitelistEntry.fetch(
      escrowCoAuthWhitelistPda
    );
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("escrow");
  });

  it("add_liquidator_with_co_authority stores role = Liquidator (the bug fix)", async () => {
    // Before this fix, add_participant_via_pool(Liquidator) fell through to
    // add_to_whitelist_with_co_authority, which hardcoded role = Holder.
    // Directly calling the new instruction must produce Liquidator.
    await program.methods
      .addLiquidatorWithCoAuthority()
      .accounts({
        coAuthority: coAuthority.publicKey,
        payer: authority.publicKey,
        mintConfig: mintConfigPda,
        wallet: liquidatorViaCoAuth.publicKey,
        whitelistEntry: liqCoAuthWhitelistPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([coAuthority])
      .rpc();

    const entry = await program.account.whitelistEntry.fetch(
      liqCoAuthWhitelistPda
    );
    expect(entry.approved).to.be.true;
    expect(JSON.stringify(entry.role)).to.include("liquidator");
    expect(JSON.stringify(entry.role)).to.not.include("holder");
  });

  it("mint_to against a co-auth Liquidator entry is also rejected", async () => {
    // Regression: even now that Liquidator-via-co-auth stores the correct role,
    // mint_to must still reject it. This is the whole point of the role check.
    const liqAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      liquidatorViaCoAuth.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const createAtaIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      liqAta,
      liquidatorViaCoAuth.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await provider.sendAndConfirm(new Transaction().add(createAtaIx));

    let threw = false;
    try {
      await program.methods
        .mintTo(new BN(1_000))
        .accounts({
          authority: authority.publicKey,
          mintConfig: mintConfigPda,
          mint: mintKeypair.publicKey,
          mintAuthority: mintAuthorityPda,
          whitelistEntry: liqCoAuthWhitelistPda,
          destination: liqAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      expect(err.toString()).to.match(/LiquidatorCannotMint|0x177[0-9a-fA-F]/);
    }
    expect(threw, "mint_to to Liquidator (co-auth) entry must revert").to.be
      .true;
  });

  it("total_whitelisted tracks all role variants", async () => {
    // Holder + Escrow (auth path) + Escrow (co-auth) + Liquidator (co-auth) = 4.
    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.totalWhitelisted.toNumber()).to.equal(4);
  });
});
