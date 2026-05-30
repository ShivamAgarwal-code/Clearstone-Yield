/**
 * KYT (Know Your Transaction) Service — wallet risk screening.
 *
 * Runs before every KYC approval. HIGH-risk wallets are blocked from
 * being whitelisted on-chain.
 *
 * Mock implementation: deterministic rules, zero external calls.
 *
 * Real provider swap: Chainalysis KYT, Elliptic Wallet Screening, or TRM Labs
 * all expose a synchronous GET /v2/entities/:address endpoint returning a risk
 * score. The KytProvider interface maps 1:1 to those calls — implement
 * screenWallet() as a single fetch and return the normalized KytResult.
 */

import type { KytRecord, KytResult, KytRiskLevel } from "../types.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface KytProvider {
  screenWallet(address: string): Promise<KytResult>;
}

// ---------------------------------------------------------------------------
// Mock implementation
// ---------------------------------------------------------------------------

class MockKytProvider implements KytProvider {
  async screenWallet(address: string): Promise<KytResult> {
    const flags: string[] = [];
    let riskLevel: KytRiskLevel = "LOW";

    if (config.ofacMockList.includes(address) || address.startsWith("bad")) {
      riskLevel = "HIGH";
      flags.push("SANCTIONS_MATCH");
    } else if (parseInt(address.slice(-1), 36) % 3 === 0) {
      riskLevel = "MEDIUM";
      flags.push("UNUSUAL_PATTERN");
    }

    return {
      walletAddress: address,
      riskLevel,
      flags,
      screenedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// KYT Service
// ---------------------------------------------------------------------------

export class KytService {
  private provider: KytProvider;
  private readonly records = new Map<string, KytRecord>();

  constructor(provider?: KytProvider) {
    this.provider = provider ?? new MockKytProvider();
  }

  setProvider(p: KytProvider): void {
    this.provider = p;
  }

  async screenWallet(address: string): Promise<KytResult> {
    const result = await this.provider.screenWallet(address);
    this.records.set(address, result);
    console.log(`[kyt] ${address} → ${result.riskLevel}${result.flags.length ? " [" + result.flags.join(", ") + "]" : ""}`);
    return result;
  }

  getRecord(address: string): KytRecord | undefined {
    return this.records.get(address);
  }

  getAllRecords(): KytRecord[] {
    return Array.from(this.records.values());
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: KytService | undefined;

export function getKytService(): KytService {
  if (!_instance) _instance = new KytService();
  return _instance;
}

export function setKytService(svc: KytService): void {
  _instance = svc;
}
