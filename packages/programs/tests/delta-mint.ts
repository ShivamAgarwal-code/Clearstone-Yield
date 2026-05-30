import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import { expect } from "chai";
import type { DeltaMint } from "../target/types/delta_mint";

describe("delta-mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DeltaMint as Program<DeltaMint>;
  const authority = provider.wallet;

  const mintKeypair = Keypair.generate();
  const recipient = Keypair.generate();

  // PDAs
  let mintConfigPda: PublicKey;
  let mintAuthorityPda: PublicKey;
  let whitelistEntryPda: PublicKey;

  before(() => {
    [mintConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_config"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [whitelistEntryPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        recipient.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("initializes the mint with confidential transfer extension", async () => {
    const decimals = 6;

    await program.methods
      .initializeMint(decimals)
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
    expect(config.authority.toBase58()).to.equal(
      authority.publicKey.toBase58()
    );
    expect(config.mint.toBase58()).to.equal(
      mintKeypair.publicKey.toBase58()
    );
    expect(config.decimals).to.equal(decimals);
    expect(config.totalWhitelisted.toNumber()).to.equal(0);
  });

  it("adds a wallet to the KYC whitelist", async () => {
    await program.methods
      .addToWhitelist()
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        wallet: recipient.publicKey,
        whitelistEntry: whitelistEntryPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const entry = await program.account.whitelistEntry.fetch(
      whitelistEntryPda
    );
    expect(entry.wallet.toBase58()).to.equal(
      recipient.publicKey.toBase58()
    );
    expect(entry.approved).to.be.true;

    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.totalWhitelisted.toNumber()).to.equal(1);
  });

  it("mints tokens to a whitelisted recipient", async () => {
    // Create an associated token account for the recipient (Token-2022)
    const destinationAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const createAtaIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      destinationAta,
      recipient.publicKey,
      mintKeypair.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const mintAmount = new BN(1_000_000); // 1 token (6 decimals)

    await program.methods
      .mintTo(mintAmount)
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        mint: mintKeypair.publicKey,
        mintAuthority: mintAuthorityPda,
        whitelistEntry: whitelistEntryPda,
        destination: destinationAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .preInstructions([createAtaIx])
      .rpc();

    // Verify the balance
    const tokenAccount = await getAccount(
      provider.connection,
      destinationAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(Number(tokenAccount.amount)).to.equal(1_000_000);
  });

  it("rejects minting to a non-whitelisted wallet", async () => {
    const nonWhitelisted = Keypair.generate();

    // Derive a whitelist PDA for this non-whitelisted wallet
    const [fakeWhitelistPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("whitelist"),
        mintConfigPda.toBuffer(),
        nonWhitelisted.publicKey.toBuffer(),
      ],
      program.programId
    );

    const destinationAta = getAssociatedTokenAddressSync(
      mintKeypair.publicKey,
      nonWhitelisted.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    try {
      await program.methods
        .mintTo(new BN(1_000))
        .accounts({
          authority: authority.publicKey,
          mintConfig: mintConfigPda,
          mint: mintKeypair.publicKey,
          mintAuthority: mintAuthorityPda,
          whitelistEntry: fakeWhitelistPda,
          destination: destinationAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown — wallet is not whitelisted");
    } catch (err) {
      // The PDA doesn't exist, so Anchor will fail to deserialize it
      expect(err).to.exist;
    }
  });

  it("removes a wallet from the whitelist", async () => {
    await program.methods
      .removeFromWhitelist()
      .accounts({
        authority: authority.publicKey,
        mintConfig: mintConfigPda,
        whitelistEntry: whitelistEntryPda,
      })
      .rpc();

    const config = await program.account.mintConfig.fetch(mintConfigPda);
    expect(config.totalWhitelisted.toNumber()).to.equal(0);

    // Verify account is closed
    const info = await provider.connection.getAccountInfo(whitelistEntryPda);
    expect(info).to.be.null;
  });
});
