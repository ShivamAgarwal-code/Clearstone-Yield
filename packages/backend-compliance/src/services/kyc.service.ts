/**
 * KYC Service — pure business logic, no Express/Fastify dependencies.
 *
 * This is the layer you replace when plugging in a real KYC provider
 * (Persona, Jumio, Sumsub). See PROVIDER_SWAP.md for details.
 *
 * Current implementation: manual approval flow (mock / admin-driven).
 * Production flow: webhook from provider → call approveWallet() internally.
 *
 * Approve flow:
 *   1. KYT screening  — blocks HIGH-risk wallets before any on-chain write
 *   2. Risk controls  — blocks sanctioned / capped wallets
 *   3. On-chain whitelist write
 */

import type { KycRecord, SubmitKycBody } from "../types.js";
import type { KycStore } from "../db/store.js";
import { createKycStore } from "../db/store.js";
import { getBlockchainService } from "./blockchain.service.js";
import { getKytService, type KytService } from "./kyt.service.js";
import { getRiskControlService, type RiskControlService } from "./risk.service.js";

// ---------------------------------------------------------------------------
// KYC Provider interface
// ---------------------------------------------------------------------------

/**
 * Implement this interface to swap in a real KYC provider.
 *
 * Example Persona webhook flow:
 *   1. POST /kyc/submit  → createInquiry(record) → returns inquiry ID
 *   2. User completes verification on Persona hosted flow
 *   3. Persona POSTs webhook to /kyc/webhook/persona
 *   4. Webhook handler calls provider.handleWebhook(payload)
 *   5. Provider resolves → calls kycService.approveWallet(walletAddress)
 */
export interface KycProvider {
  /** Called when a new KYC submission is received. */
  onSubmit(record: KycRecord): Promise<void>;
  /** Called when an admin manually approves (mock only, no-op in real providers). */
  onApprove(record: KycRecord): Promise<void>;
  /** Called when an admin manually rejects. */
  onReject(record: KycRecord): Promise<void>;
}

class MockKycProvider implements KycProvider {
  async onSubmit(record: KycRecord): Promise<void> {
    console.log(`[kyc:mock] New submission from ${record.walletAddress} (${record.entityType})`);
  }
  async onApprove(record: KycRecord): Promise<void> {
    console.log(`[kyc:mock] Approved ${record.walletAddress}`);
  }
  async onReject(record: KycRecord): Promise<void> {
    console.log(`[kyc:mock] Rejected ${record.walletAddress}`);
  }
}

// ---------------------------------------------------------------------------
// KYC Service
// ---------------------------------------------------------------------------

export class KycService {
  private readonly store: KycStore;
  private readonly blockchain = getBlockchainService();
  private readonly kyt: KytService;
  private readonly risk: RiskControlService;
  private provider: KycProvider;

  constructor(
    store?: KycStore,
    provider?: KycProvider,
    kyt?: KytService,
    risk?: RiskControlService
  ) {
    this.store = store ?? createKycStore();
    this.provider = provider ?? new MockKycProvider();
    this.kyt = kyt ?? getKytService();
    this.risk = risk ?? getRiskControlService();
  }

  setProvider(provider: KycProvider): void {
    this.provider = provider;
  }

  // -------------------------------------------------------------------------
  // Register from Entra — primary user-facing entry point
  // -------------------------------------------------------------------------

  /**
   * Primary onboarding path. Called after the user authenticates with Entra B2C.
   * Name and email are pulled directly from the verified JWT claims — the user
   * never fills out a form. Creates a KYC record with entraSubjectId already
   * set and status "pending" for compliance officer review.
   *
   * Idempotent: if the wallet is already registered with this sub, returns the
   * existing record unchanged.
   */
  async registerFromEntra(
    walletAddress: string,
    entraSubjectId: string,
    claims: { name?: string; given_name?: string; family_name?: string; emails?: string[]; email?: string }
  ): Promise<KycRecord> {
    if (!this.blockchain.validateAddress(walletAddress)) {
      throw new ValidationError("Invalid Solana wallet address");
    }

    // Idempotent — already registered with same sub, just return existing record
    const existingByWallet = this.store.findByWallet(walletAddress);
    if (existingByWallet?.entraSubjectId === entraSubjectId) {
      return existingByWallet;
    }

    // Same Entra identity trying to claim a different wallet
    const existingBySub = this.store.findByEntraSub(entraSubjectId);
    if (existingBySub && existingBySub.walletAddress !== walletAddress) {
      throw new ConflictError(
        `This Entra identity is already linked to wallet ${existingBySub.walletAddress}`
      );
    }

    // Wallet already registered but without an Entra sub — link it now
    if (existingByWallet && !existingByWallet.entraSubjectId) {
      return this.store.linkEntraSub(walletAddress, entraSubjectId)!;
    }

    // Wallet already registered with a different Entra identity
    if (existingByWallet) {
      throw new ConflictError(
        `Wallet ${walletAddress} is already linked to a different Entra identity`
      );
    }

    const name =
      claims.name ??
      ([claims.given_name, claims.family_name].filter(Boolean).join(" ") || "Unknown");
    const email =
      claims.emails?.[0] ?? (claims.email as string | undefined) ?? "";

    const record = this.store.create({
      walletAddress,
      entityType: "individual",
      name,
      email,
      status: "pending",
      entraSubjectId,
    });

    await this.provider.onSubmit(record);
    return record;
  }

  // -------------------------------------------------------------------------
  // Submit — admin / manual onboarding only
  // -------------------------------------------------------------------------

  async submitKyc(body: SubmitKycBody, entraSubjectId?: string): Promise<KycRecord> {
    if (!this.blockchain.validateAddress(body.walletAddress)) {
      throw new ValidationError("Invalid Solana wallet address");
    }

    const existing = this.store.findByWallet(body.walletAddress);
    if (existing) {
      throw new ConflictError(
        `KYC already submitted for ${body.walletAddress} (status: ${existing.status})`
      );
    }

    // Prevent one Entra identity from being linked to multiple wallets
    if (entraSubjectId) {
      const existingBySub = this.store.findByEntraSub(entraSubjectId);
      if (existingBySub) {
        throw new ConflictError(
          `This Entra identity is already linked to wallet ${existingBySub.walletAddress}`
        );
      }
    }

    if (!["individual", "company"].includes(body.entityType)) {
      throw new ValidationError('entityType must be "individual" or "company"');
    }

    if (!body.name?.trim()) throw new ValidationError("name is required");
    if (!body.email?.trim()) throw new ValidationError("email is required");
    if (!isValidEmail(body.email)) throw new ValidationError("Invalid email address");

    const record = this.store.create({
      walletAddress: body.walletAddress,
      entityType: body.entityType,
      name: body.name.trim(),
      email: body.email.trim().toLowerCase(),
      status: "pending",
      entraSubjectId,
    });

    await this.provider.onSubmit(record);
    return record;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  getStatus(walletAddress: string): KycRecord {
    const record = this.store.findByWallet(walletAddress);
    if (!record) throw new NotFoundError(`No KYC record for ${walletAddress}`);
    return record;
  }

  /** Returns null instead of throwing when no record exists. */
  getStatusOrNull(walletAddress: string): KycRecord | null {
    return this.store.findByWallet(walletAddress) ?? null;
  }

  findByEntraSub(entraSubjectId: string): KycRecord | null {
    return this.store.findByEntraSub(entraSubjectId) ?? null;
  }

  linkEntraSub(walletAddress: string, entraSubjectId: string): KycRecord | null {
    return this.store.linkEntraSub(walletAddress, entraSubjectId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Approve — KYT → Risk → on-chain whitelist
  // -------------------------------------------------------------------------

  async approveWallet(walletAddress: string): Promise<KycRecord> {
    const record = this.store.findByWallet(walletAddress);
    if (!record) throw new NotFoundError(`No KYC record for ${walletAddress}`);
    if (record.status === "approved") {
      throw new ConflictError(`${walletAddress} is already approved`);
    }

    // 1. KYT screening — blocks HIGH-risk wallets
    const kytResult = await this.kyt.screenWallet(walletAddress);
    if (kytResult.riskLevel === "HIGH") {
      throw new ComplianceError(
        `KYT: wallet flagged as HIGH risk — flags: ${kytResult.flags.join(", ") || "none"}`
      );
    }

    // 2. Risk controls — blacklist, per-wallet cap, pool cap
    const riskResult = await this.risk.checkWallet(walletAddress);
    if (!riskResult.passed) {
      throw new ComplianceError(`Risk: ${riskResult.reason}`);
    }

    // 3. On-chain whitelist write for every configured pool
    const whitelistResults = await this.blockchain.addToWhitelist(walletAddress);

    const updated = this.store.updateStatus(walletAddress, "approved", whitelistResults)!;
    await this.provider.onApprove(updated);

    // 4. Register wallet in risk tracker (deposit amount unknown at approval time)
    this.risk.recordDeposit(walletAddress, 0);

    const sigs = whitelistResults.map((r) => r.signature).join(", ");
    console.log(`[kyc] Approved ${walletAddress} | txs: ${sigs}`);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Reject
  // -------------------------------------------------------------------------

  async rejectWallet(walletAddress: string): Promise<KycRecord> {
    const record = this.store.findByWallet(walletAddress);
    if (!record) throw new NotFoundError(`No KYC record for ${walletAddress}`);
    if (record.status === "rejected") {
      throw new ConflictError(`${walletAddress} is already rejected`);
    }

    const updated = this.store.updateStatus(walletAddress, "rejected")!;
    await this.provider.onReject(updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Admin helpers
  // -------------------------------------------------------------------------

  listAll(): KycRecord[] {
    return this.store.findAll();
  }
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) { super(message); this.name = "NotFoundError"; }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = "ConflictError"; }
}

/** Thrown when a compliance check (KYT or risk controls) blocks an approval. */
export class ComplianceError extends Error {
  readonly statusCode = 403;
  constructor(message: string) { super(message); this.name = "ComplianceError"; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: KycService | undefined;

export function getKycService(): KycService {
  if (!_instance) _instance = new KycService();
  return _instance;
}
