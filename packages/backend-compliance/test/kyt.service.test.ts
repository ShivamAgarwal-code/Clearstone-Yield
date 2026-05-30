import { describe, it, expect, beforeEach } from "vitest";
import { KytService } from "../src/services/kyt.service.js";
import { setRiskControlService } from "../src/services/risk.service.js";
import { setBlockchainService } from "../src/services/blockchain.service.js";
import { KycService, ComplianceError } from "../src/services/kyc.service.js";
import { createKycStore } from "../src/db/store.js";
import type { BlockchainService } from "../src/services/blockchain.service.js";
import type { RiskControlService } from "../src/services/risk.service.js";
import type { RiskCheckResult } from "../src/types.js";

const VALID_WALLET = "So11111111111111111111111111111111111111112";

const mockBlockchain: BlockchainService = {
  validateAddress: (addr) => addr.length >= 32 && addr.length <= 44,
  isWhitelisted: async () => false,
  addToWhitelist: async (addr) => [
    { mintAddress: "mockMint", signature: `sig_${addr.slice(0, 6)}`, whitelistEntryAddress: `pda_${addr.slice(0, 6)}` },
  ],
  removeFromWhitelist: async () => ["mockSig"],
};

const passingRisk: RiskControlService = {
  checkWallet: async () => ({ passed: true, walletExposureUsd: 0, poolExposureUsd: 0 }),
  summary: () => ({ poolExposureUsd: 0, walletCount: 0, cappedWallets: [] }),
  recordDeposit: () => {},
};

describe("KytService", () => {
  it("returns LOW for a normal address", async () => {
    const svc = new KytService();
    const result = await svc.screenWallet(VALID_WALLET);
    expect(result.riskLevel).toBe("LOW");
    expect(result.flags).toHaveLength(0);
  });

  it("returns HIGH for an address starting with 'bad'", async () => {
    const svc = new KytService();
    const result = await svc.screenWallet("bad1111111111111111111111111111111111111111");
    expect(result.riskLevel).toBe("HIGH");
    expect(result.flags).toContain("SANCTIONS_MATCH");
  });

  it("stores result for later retrieval", async () => {
    const svc = new KytService();
    await svc.screenWallet(VALID_WALLET);
    expect(svc.getRecord(VALID_WALLET)).toBeDefined();
    expect(svc.getRecord(VALID_WALLET)?.walletAddress).toBe(VALID_WALLET);
  });
});

describe("KycService — ComplianceError on HIGH-risk wallet", () => {
  beforeEach(() => {
    setBlockchainService(mockBlockchain);
    setRiskControlService(passingRisk);
  });

  it("blocks approval when KYT returns HIGH", async () => {
    const highRiskKyt = new KytService();
    const svc = new KycService(createKycStore(), undefined, highRiskKyt, passingRisk);

    await svc.submitKyc({
      walletAddress: "bad1111111111111111111111111111111111111111",
      entityType: "individual",
      name: "Eve",
      email: "eve@example.com",
    });

    await expect(
      svc.approveWallet("bad1111111111111111111111111111111111111111")
    ).rejects.toBeInstanceOf(ComplianceError);
  });

  it("allows approval when KYT returns LOW", async () => {
    const lowRiskKyt = new KytService();
    const svc = new KycService(createKycStore(), undefined, lowRiskKyt, passingRisk);

    await svc.submitKyc({
      walletAddress: VALID_WALLET,
      entityType: "individual",
      name: "Alice",
      email: "alice@example.com",
    });

    const record = await svc.approveWallet(VALID_WALLET);
    expect(record.status).toBe("approved");
  });
});
