/**
 * Travel Rule Service — FATF Recommendation 16 compliance.
 *
 * Collects originator/beneficiary VASP information for transfers at or above
 * the $1,000 USD threshold and forwards them to the configured VASP network.
 *
 * Below-threshold transfers are recorded locally but no VASP message is sent.
 *
 * Real provider swap: TRISA (gRPC), Notabene (REST), or Sygna Bridge (REST)
 * all accept a JSON payload structurally identical to TravelRuleTransferBody.
 * Implement createTransfer() as a single authenticated POST /transfers call.
 */

import type {
  TravelRuleRecord,
  TravelRuleTransferBody,
} from "../types.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface TravelRuleProvider {
  /** Submit a Travel Rule message. Returns the provider's transfer ID. */
  createTransfer(data: TravelRuleTransferBody): Promise<string>;
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

class MockTravelRuleProvider implements TravelRuleProvider {
  async createTransfer(data: TravelRuleTransferBody): Promise<string> {
    const id = `MOCK-TR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    console.log(
      `[travel-rule:mock] ${id} | ${data.originator.name} (${data.originator.vaspDid}) → ` +
      `${data.beneficiary.name} (${data.beneficiary.vaspDid}) | $${data.amount} ${data.asset}`
    );
    return id;
  }
}

// ---------------------------------------------------------------------------
// Travel Rule Service
// ---------------------------------------------------------------------------

export const FATF_THRESHOLD_USD = 1_000;

export class TravelRuleService {
  private provider: TravelRuleProvider;
  private readonly records = new Map<string, TravelRuleRecord>();

  constructor(provider?: TravelRuleProvider) {
    this.provider = provider ?? new MockTravelRuleProvider();
  }

  setProvider(p: TravelRuleProvider): void {
    this.provider = p;
  }

  async initiateTransfer(data: TravelRuleTransferBody): Promise<TravelRuleRecord> {
    const belowThreshold = data.amount < FATF_THRESHOLD_USD;

    // Only send VASP message for transfers at or above the threshold
    const transferId = belowThreshold
      ? `BELOW-THRESHOLD-${Date.now()}`
      : await this.provider.createTransfer(data);

    const record: TravelRuleRecord = {
      ...data,
      transferId,
      createdAt: new Date().toISOString(),
      belowThreshold,
    };

    this.records.set(transferId, record);
    return record;
  }

  getByWallet(walletAddress: string): TravelRuleRecord[] {
    return Array.from(this.records.values()).filter(
      (r) =>
        r.originator.walletAddress === walletAddress ||
        r.beneficiary.walletAddress === walletAddress
    );
  }

  getAll(): TravelRuleRecord[] {
    return Array.from(this.records.values());
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: TravelRuleService | undefined;

export function getTravelRuleService(): TravelRuleService {
  if (!_instance) _instance = new TravelRuleService();
  return _instance;
}

export function setTravelRuleService(svc: TravelRuleService): void {
  _instance = svc;
}
