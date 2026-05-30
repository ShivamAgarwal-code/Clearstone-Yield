import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  KLEND_PROGRAM_ID,
  DISC,
} from "../common/constants.js";
import { obligationPda, userMetadataPda } from "../common/pda.js";

/**
 * Build `init_user_metadata` instruction.
 * Creates the user metadata PDA (required before creating obligations).
 *
 * @param owner  User wallet (signer + fee payer)
 */
export function initUserMetadata(
  owner: PublicKey,
): TransactionInstruction {
  const userMeta = userMetadataPda(owner);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },       // feePayer
      { pubkey: userMeta, isSigner: false, isWritable: true },    // userMetadata
      { pubkey: KLEND_PROGRAM_ID, isSigner: false, isWritable: false }, // referrerUserMetadata (optional → pass program ID)
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: DISC.initUserMetadata,
  });
}

/**
 * Build `init_obligation` instruction.
 * Creates a lending obligation for the user on a given market.
 *
 * @param owner   User wallet (signer + fee payer)
 * @param market  The lending market pubkey
 * @param seed    Obligation seed index (default 0, allows multiple obligations)
 */
export function initObligation(
  owner: PublicKey,
  market: PublicKey,
  seed = 0,
): TransactionInstruction {
  const oblig = obligationPda(market, owner, seed);
  const userMeta = userMetadataPda(owner);

  const data = Buffer.alloc(8 + 8 + 1);
  DISC.initObligation.copy(data, 0);
  data.writeBigUInt64LE(BigInt(0), 8); // tag
  data.writeUInt8(seed, 16);           // id

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: oblig, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: userMeta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}
