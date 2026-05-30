import { describe, it, expect, beforeEach } from "vitest";
import { KycService, ValidationError, NotFoundError, ConflictError } from "../src/services/kyc.service.js";
import { createKycStore } from "../src/db/store.js";
import { setBlockchainService } from "../src/services/blockchain.service.js";
import type { BlockchainService } from "../src/services/blockchain.service.js";

// ---------------------------------------------------------------------------
// Mock blockchain service — no Solana RPC calls
// ---------------------------------------------------------------------------

const mockBlockchain: BlockchainService = {
  validateAddress: (addr) => addr.length >= 32 && addr.length <= 44,
  isWhitelisted: async () => false,
  addToWhitelist: async (addr) => [
    { mintAddress: "mockMintA", signature: `mocksig_${addr.slice(0, 8)}`, whitelistEntryAddress: `mockpda_${addr.slice(0, 8)}` },
    { mintAddress: "mockMintB", signature: `mocksig2_${addr.slice(0, 8)}`, whitelistEntryAddress: `mockpda2_${addr.slice(0, 8)}` },
  ],
  removeFromWhitelist: async (addr) => [`mockremovesig_${addr.slice(0, 8)}`],
};

const VALID_WALLET = "So11111111111111111111111111111111111111112";
const VALID_WALLET_2 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------------------------------------------------------------------------

describe("KycService", () => {
  let svc: KycService;

  beforeEach(() => {
    setBlockchainService(mockBlockchain);
    svc = new KycService(createKycStore());
  });

  describe("submitKyc", () => {
    it("creates a pending record", async () => {
      const record = await svc.submitKyc({
        walletAddress: VALID_WALLET,
        entityType: "individual",
        name: "Alice",
        email: "alice@example.com",
      });
      expect(record.status).toBe("pending");
      expect(record.walletAddress).toBe(VALID_WALLET);
    });

    it("rejects duplicate submissions", async () => {
      const body = { walletAddress: VALID_WALLET, entityType: "individual" as const, name: "Alice", email: "alice@example.com" };
      await svc.submitKyc(body);
      await expect(svc.submitKyc(body)).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects invalid wallet address", async () => {
      await expect(svc.submitKyc({
        walletAddress: "not-a-valid-address!!",
        entityType: "individual",
        name: "Bob",
        email: "bob@example.com",
      })).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects missing name", async () => {
      await expect(svc.submitKyc({
        walletAddress: VALID_WALLET,
        entityType: "individual",
        name: "",
        email: "test@example.com",
      })).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects invalid email", async () => {
      await expect(svc.submitKyc({
        walletAddress: VALID_WALLET,
        entityType: "individual",
        name: "Alice",
        email: "not-an-email",
      })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("getStatus", () => {
    it("returns the record after submission", async () => {
      await svc.submitKyc({ walletAddress: VALID_WALLET, entityType: "individual", name: "Alice", email: "a@b.com" });
      const record = svc.getStatus(VALID_WALLET);
      expect(record.status).toBe("pending");
    });

    it("throws NotFoundError for unknown wallet", () => {
      expect(() => svc.getStatus(VALID_WALLET)).toThrow(NotFoundError);
    });
  });

  describe("approveWallet", () => {
    it("transitions to approved and stores tx signature", async () => {
      await svc.submitKyc({ walletAddress: VALID_WALLET, entityType: "company", name: "Acme Corp", email: "kyc@acme.com" });
      const record = await svc.approveWallet(VALID_WALLET);
      expect(record.status).toBe("approved");
      expect(record.whitelistResults?.[0].signature).toMatch(/^mocksig_/);
    });

    it("throws ConflictError if already approved", async () => {
      await svc.submitKyc({ walletAddress: VALID_WALLET, entityType: "individual", name: "Alice", email: "a@b.com" });
      await svc.approveWallet(VALID_WALLET);
      await expect(svc.approveWallet(VALID_WALLET)).rejects.toBeInstanceOf(ConflictError);
    });

    it("throws NotFoundError for unknown wallet", async () => {
      await expect(svc.approveWallet(VALID_WALLET)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("rejectWallet", () => {
    it("transitions to rejected", async () => {
      await svc.submitKyc({ walletAddress: VALID_WALLET, entityType: "individual", name: "Alice", email: "a@b.com" });
      const record = await svc.rejectWallet(VALID_WALLET);
      expect(record.status).toBe("rejected");
    });

    it("throws ConflictError if already rejected", async () => {
      await svc.submitKyc({ walletAddress: VALID_WALLET, entityType: "individual", name: "Alice", email: "a@b.com" });
      await svc.rejectWallet(VALID_WALLET);
      await expect(svc.rejectWallet(VALID_WALLET)).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("listAll", () => {
    it("returns all records", async () => {
      await svc.submitKyc({ walletAddress: VALID_WALLET, entityType: "individual", name: "Alice", email: "a@b.com" });
      await svc.submitKyc({ walletAddress: VALID_WALLET_2, entityType: "company", name: "Acme", email: "kyc@acme.com" });
      expect(svc.listAll()).toHaveLength(2);
    });
  });

  describe("registerFromEntra", () => {
    const SUB = "entra-sub-abc123";
    const CLAIMS = {
      name: "Alice Smith",
      emails: ["alice@aminabank.com"],
    };

    it("creates a pending record with entraSubjectId linked", async () => {
      const record = await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      expect(record.status).toBe("pending");
      expect(record.walletAddress).toBe(VALID_WALLET);
      expect(record.entraSubjectId).toBe(SUB);
      expect(record.name).toBe("Alice Smith");
      expect(record.email).toBe("alice@aminabank.com");
    });

    it("is idempotent — returns existing record if same sub+wallet called again", async () => {
      const first = await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      const second = await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      expect(second.walletAddress).toBe(first.walletAddress);
      expect(second.entraSubjectId).toBe(first.entraSubjectId);
      expect(svc.listAll()).toHaveLength(1);
    });

    it("falls back to given_name + family_name when name claim is absent", async () => {
      const record = await svc.registerFromEntra(VALID_WALLET, SUB, {
        given_name: "Alice",
        family_name: "Smith",
        emails: ["alice@aminabank.com"],
      });
      expect(record.name).toBe("Alice Smith");
    });

    it("falls back to 'Unknown' when no name claims are present", async () => {
      const record = await svc.registerFromEntra(VALID_WALLET, SUB, {});
      expect(record.name).toBe("Unknown");
    });

    it("throws ConflictError when same sub tries to claim a different wallet", async () => {
      await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      await expect(
        svc.registerFromEntra(VALID_WALLET_2, SUB, CLAIMS)
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("throws ConflictError when wallet is already linked to a different sub", async () => {
      await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      await expect(
        svc.registerFromEntra(VALID_WALLET, "different-sub-456", CLAIMS)
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("links sub to existing wallet that has no entraSubjectId yet", async () => {
      await svc.submitKyc({
        walletAddress: VALID_WALLET,
        entityType: "individual",
        name: "Alice",
        email: "alice@aminabank.com",
      });
      const record = await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      expect(record.entraSubjectId).toBe(SUB);
    });

    it("throws ValidationError for invalid wallet address", async () => {
      await expect(
        svc.registerFromEntra("not-a-valid-wallet!!", SUB, CLAIMS)
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("findByEntraSub returns the record after registration", async () => {
      await svc.registerFromEntra(VALID_WALLET, SUB, CLAIMS);
      expect(svc.findByEntraSub(SUB)?.walletAddress).toBe(VALID_WALLET);
    });
  });
});
