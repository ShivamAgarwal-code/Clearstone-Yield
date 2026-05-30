/**
 * Risk Control Service — enforces fund-level controls on top of KYT.
 *
 * Three independent guards (all run, first failure wins):
 *   1. OFAC/sanctions blacklist — immediate 403, no amount needed
 *   2. Per-wallet deposit cap   — configurable via DEPOSIT_CAP_USD
 *   3. Total pool exposure cap  — configurable via POOL_CAP_USD
 *
 * In production replace the in-memory exposure tracker with a DB query
 * that sums historical deposits per wallet / across the pool.
 */

import type { RiskCheckResult } from "../types.js";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface RiskControlService {
  checkWallet(walletAddress: string, amountUsd?: number): Promise<RiskCheckResult>;
  summary(): { poolExposureUsd: number; walletCount: number; cappedWallets: string[] };
  recordDeposit(walletAddress: string, amountUsd: number): void;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

class InMemoryRiskControlService implements RiskControlService {
  private readonly walletExposure = new Map<string, number>();
  private poolExposureUsd = 0;

  async checkWallet(
    walletAddress: string,
    amountUsd = 0
  ): Promise<RiskCheckResult> {
    const walletExposureUsd = this.walletExposure.get(walletAddress) ?? 0;

    // Guard 1: OFAC / sanctions blacklist
    // Production: download SDN list from https://ofac.treasury.gov and cache it.
    if (config.ofacMockList.includes(walletAddress)) {
      return {
        passed: false,
        reason: "Wallet is on the OFAC sanctions list",
        walletExposureUsd,
        poolExposureUsd: this.poolExposureUsd,
      };
    }

    // Guard 2: per-wallet cap
    if (walletExposureUsd + amountUsd > config.depositCapUsd) {
      return {
        passed: false,
        reason: `Wallet exposure would exceed per-wallet cap of $${config.depositCapUsd.toLocaleString()}`,
        walletExposureUsd,
        poolExposureUsd: this.poolExposureUsd,
      };
    }

    // Guard 3: pool cap
    if (this.poolExposureUsd + amountUsd > config.poolCapUsd) {
      return {
        passed: false,
        reason: `Pool exposure would exceed pool cap of $${config.poolCapUsd.toLocaleString()}`,
        walletExposureUsd,
        poolExposureUsd: this.poolExposureUsd,
      };
    }

    return {
      passed: true,
      walletExposureUsd,
      poolExposureUsd: this.poolExposureUsd,
    };
  }

  recordDeposit(walletAddress: string, amountUsd: number): void {
    const current = this.walletExposure.get(walletAddress) ?? 0;
    this.walletExposure.set(walletAddress, current + amountUsd);
    this.poolExposureUsd += amountUsd;
  }

  summary(): { poolExposureUsd: number; walletCount: number; cappedWallets: string[] } {
    const cappedWallets = Array.from(this.walletExposure.entries())
      .filter(([, v]) => v >= config.depositCapUsd)
      .map(([k]) => k);

    return {
      poolExposureUsd: this.poolExposureUsd,
      walletCount: this.walletExposure.size,
      cappedWallets,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: RiskControlService | undefined;

export function getRiskControlService(): RiskControlService {
  if (!_instance) _instance = new InMemoryRiskControlService();
  return _instance;
}

export function setRiskControlService(svc: RiskControlService): void {
  _instance = svc;
}
