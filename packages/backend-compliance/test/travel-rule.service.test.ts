import { describe, it, expect } from "vitest";
import { TravelRuleService, FATF_THRESHOLD_USD } from "../src/services/travel-rule.service.js";
import type { TravelRuleTransferBody } from "../src/types.js";

const originator = {
  vaspDid: "did:vasp:delta-finance",
  name: "Delta Finance",
  walletAddress: "So11111111111111111111111111111111111111112",
};
const beneficiary = {
  vaspDid: "did:vasp:acme-bank",
  name: "Acme Bank",
  walletAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

function makeTransfer(amount: number): TravelRuleTransferBody {
  return { originator, beneficiary, amount, asset: "USDY" };
}

describe("TravelRuleService", () => {
  it("marks transfer below threshold without calling provider", async () => {
    const svc = new TravelRuleService();
    const record = await svc.initiateTransfer(makeTransfer(FATF_THRESHOLD_USD - 1));
    expect(record.belowThreshold).toBe(true);
    expect(record.transferId).toMatch(/^BELOW-THRESHOLD-/);
  });

  it("sends VASP message for transfers at or above threshold", async () => {
    let called = false;
    const mockProvider = {
      createTransfer: async () => { called = true; return "MOCK-TR-123"; },
    };
    const svc = new TravelRuleService(mockProvider);
    const record = await svc.initiateTransfer(makeTransfer(FATF_THRESHOLD_USD));
    expect(record.belowThreshold).toBe(false);
    expect(called).toBe(true);
    expect(record.transferId).toBe("MOCK-TR-123");
  });

  it("retrieves transfers by originator wallet", async () => {
    const svc = new TravelRuleService();
    await svc.initiateTransfer(makeTransfer(500));
    await svc.initiateTransfer(makeTransfer(2000));
    const records = svc.getByWallet(originator.walletAddress);
    expect(records).toHaveLength(2);
  });

  it("retrieves transfers by beneficiary wallet", async () => {
    const svc = new TravelRuleService();
    await svc.initiateTransfer(makeTransfer(500));
    const records = svc.getByWallet(beneficiary.walletAddress);
    expect(records).toHaveLength(1);
  });
});
