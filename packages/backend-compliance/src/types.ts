export type KycStatus = "pending" | "approved" | "rejected";
export type EntityType = "individual" | "company";

export interface KycRecord {
  walletAddress: string;
  entityType: EntityType;
  name: string;
  email: string;
  status: KycStatus;
  // Per-pool whitelist results, populated on approval.
  // One entry per mint in WRAPPED_MINT_ADDRESSES.
  whitelistResults?: Array<{ mintAddress: string; signature: string; whitelistEntryAddress: string }>;

  /**
   * Microsoft Entra B2C subject ID (`sub` claim) — immutable per-app user
   * identifier. Set when the user calls POST /auth/link-wallet with a valid
   * Entra Bearer token. Links the verified institutional identity to this
   * wallet address.
   */
  entraSubjectId?: string;

  createdAt: string;    // ISO timestamp
  updatedAt: string;
}

export interface SubmitKycBody {
  walletAddress: string;
  entityType: EntityType;
  name: string;
  email: string;
}

export interface ApproveRejectBody {
  walletAddress: string;
}

// ---------------------------------------------------------------------------
// KYT (Know Your Transaction)
// ---------------------------------------------------------------------------

export type KytRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface KytResult {
  walletAddress: string;
  riskLevel: KytRiskLevel;
  /** Flags from the screening provider, e.g. "SANCTIONS_MATCH", "MIXER" */
  flags: string[];
  screenedAt: string; // ISO timestamp
  /** External reference ID from real provider */
  providerRef?: string;
}

export type KytRecord = KytResult;

// ---------------------------------------------------------------------------
// Travel Rule (FATF Recommendation 16)
// ---------------------------------------------------------------------------

export interface TravelRuleParty {
  /** VASP DID or LEI */
  vaspDid: string;
  name: string;
  walletAddress: string;
}

export interface TravelRuleTransferBody {
  originator: TravelRuleParty;
  beneficiary: TravelRuleParty;
  /** USD-equivalent amount */
  amount: number;
  /** Asset symbol, e.g. "USDY" */
  asset: string;
  /** Solana tx signature if already broadcast */
  txSignature?: string;
}

export interface TravelRuleRecord extends TravelRuleTransferBody {
  transferId: string;
  createdAt: string;
  /** true if amount < $1,000 FATF threshold — no VASP message required */
  belowThreshold: boolean;
}

// ---------------------------------------------------------------------------
// Risk Controls
// ---------------------------------------------------------------------------

export interface RiskCheckResult {
  passed: boolean;
  /** Populated when passed === false */
  reason?: string;
  walletExposureUsd: number;
  poolExposureUsd: number;
}
