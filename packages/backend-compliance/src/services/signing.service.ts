/**
 * Signing Service — abstracts transaction signing so the admin key
 * can be a local keypair (dev/hackathon) or Fireblocks MPC (production).
 *
 * To enable Fireblocks:
 *   1. Set FIREBLOCKS_API_KEY, FIREBLOCKS_VAULT_ACCOUNT_ID, FIREBLOCKS_SIGNER_PUBLIC_KEY
 *   2. The factory below will automatically return FireblocksSigner
 */

import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SigningService {
  /** The public key that appears as signer/feePayer in instructions. */
  publicKey(): PublicKey;
  /** Signs the transaction and returns it ready for serialization. */
  sign(tx: Transaction): Promise<Transaction>;
}

// ---------------------------------------------------------------------------
// LocalKeypairSigner — current default
// ---------------------------------------------------------------------------

class LocalKeypairSigner implements SigningService {
  private readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async sign(tx: Transaction): Promise<Transaction> {
    tx.sign(this.keypair);
    return tx;
  }
}

// ---------------------------------------------------------------------------
// FireblocksSigner — stub showing the full production API shape
// ---------------------------------------------------------------------------

class FireblocksSigner implements SigningService {
  private readonly _publicKey: PublicKey;
  private readonly apiKey: string;
  private readonly vaultAccountId: string;

  constructor(apiKey: string, vaultAccountId: string, signerPublicKey: string) {
    this.apiKey = apiKey;
    this.vaultAccountId = vaultAccountId;
    this._publicKey = new PublicKey(signerPublicKey);
  }

  publicKey(): PublicKey {
    return this._publicKey;
  }

  async sign(tx: Transaction): Promise<Transaction> {
    // Production implementation:
    //
    // 1. Serialize the transaction message to base64
    //    const msg = tx.serializeMessage().toString("base64");
    //
    // 2. Submit RAW signing request to Fireblocks
    //    POST https://api.fireblocks.io/v1/transactions
    //    {
    //      "operation": "RAW",
    //      "assetId": "SOL",
    //      "source": { "type": "VAULT_ACCOUNT", "id": this.vaultAccountId },
    //      "extraParameters": {
    //        "rawMessageData": { "messages": [{ "content": msg }] }
    //      }
    //    }
    //
    // 3. Poll GET /v1/transactions/:id until status === "COMPLETED"
    //
    // 4. Extract signature from response.signedMessages[0].signature.fullSig
    //    tx.addSignature(this._publicKey, Buffer.from(fullSig, "hex"));
    //
    // 5. Return signed tx

    throw new Error(
      "FireblocksSigner: set FIREBLOCKS_API_KEY, FIREBLOCKS_VAULT_ACCOUNT_ID, " +
      "and FIREBLOCKS_SIGNER_PUBLIC_KEY to enable Fireblocks signing."
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: SigningService | undefined;

export function getSigningService(): SigningService {
  if (!_instance) {
    if (config.fireblocksApiKey && config.fireblocksSignerPublicKey) {
      _instance = new FireblocksSigner(
        config.fireblocksApiKey,
        config.fireblocksVaultAccountId,
        config.fireblocksSignerPublicKey
      );
    } else {
      _instance = new LocalKeypairSigner(config.adminKeypair);
    }
  }
  return _instance;
}

export function setSigningService(svc: SigningService): void {
  _instance = svc;
}
