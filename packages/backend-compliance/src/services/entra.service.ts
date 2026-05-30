/**
 * Microsoft Entra B2C — token validation service.
 *
 * Validates Bearer tokens issued by an Entra B2C user flow and extracts
 * the immutable subject ID (`sub` claim) used to anchor KYC identity.
 *
 * Flow:
 *   1. User authenticates via Entra B2C (Authorization Code + PKCE in frontend)
 *   2. Frontend receives an ID token / access token (JWT)
 *   3. Frontend calls POST /auth/link-wallet with Authorization: Bearer <token>
 *   4. This service validates the token against Entra's public JWKS endpoint
 *   5. Returns the `sub` claim — an immutable, per-app user identifier
 *
 * Supports two Entra flavors (auto-detected via ENTRA_FLAVOR env var):
 *
 *   b2c  (classic Azure AD B2C, default):
 *     JWKS:   https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/{policy}/discovery/v2.0/keys
 *     Issuer: https://{tenant}.b2clogin.com/{tenantId}/v2.0/
 *
 *   external  (new Entra External ID / CIAM, for tenants created after May 2025):
 *     JWKS:   https://{tenant}.ciamlogin.com/{tenantId}/discovery/v2.0/keys
 *     Issuer: https://{tenantId}.ciamlogin.com/{tenantId}/v2.0/
 */

import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTPayload } from "jose";
import { config } from "../config.js";

export interface EntraTokenClaims extends JWTPayload {
  /** Immutable per-app user identifier — use this as the KYC anchor. */
  sub: string;
  /** Object ID — stable across apps within the same tenant. */
  oid?: string;
  /** Email address (if included in token claims). */
  emails?: string[];
  /** Display name. */
  name?: string;
  /** Given name. */
  given_name?: string;
  /** Surname. */
  family_name?: string;
  /**
   * App roles assigned in Azure portal → App registrations → App roles.
   * e.g. ["VaultAdmin"] for compliance officers.
   */
  roles?: string[];
}

export class EntraService {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor() {
    const { tenantName, tenantId, clientId, policy, flavor } = config.entra;

    let jwksUri: string;
    if (flavor === "external") {
      // Entra External ID (CIAM) — created after May 2025
      jwksUri = `https://${tenantName}.ciamlogin.com/${tenantId}/discovery/v2.0/keys`;
      this.issuer = `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0/`;
    } else {
      // Classic Azure AD B2C — policy name is part of the JWKS URL
      jwksUri = `https://${tenantName}.b2clogin.com/${tenantName}.onmicrosoft.com/${policy}/discovery/v2.0/keys`;
      this.issuer = `https://${tenantName}.b2clogin.com/${tenantId}/v2.0/`;
    }

    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    this.audience = clientId;

    console.log(`[entra] flavor: ${flavor ?? "b2c"}`);
    console.log(`[entra] JWKS: ${jwksUri}`);
    console.log(`[entra] Issuer: ${this.issuer}`);
  }

  /**
   * Validate a raw Bearer token and return the verified claims.
   * Throws if the token is invalid, expired, or from the wrong issuer/audience.
   *
   * When ENTRA_MOCK=true: skips signature verification and decodes the token
   * as-is. If the token is not a valid JWT, returns hardcoded mock claims.
   * Never use mock mode in production.
   */
  async validateToken(rawToken: string): Promise<EntraTokenClaims> {
    if (config.entraMock) {
      try {
        const payload = decodeJwt(rawToken);
        if (!payload.sub) throw new Error("no sub");
        console.warn("[entra:mock] Skipping signature verification — ENTRA_MOCK=true");
        return payload as EntraTokenClaims;
      } catch {
        // Token is not a real JWT — return hardcoded mock claims for local dev
        console.warn("[entra:mock] Invalid JWT, returning mock claims");
        return {
          sub: "mock-sub-local-dev",
          oid: "mock-oid-local-dev",
          name: "Mock Compliance Officer",
          emails: ["compliance@mock.local"],
          roles: ["VaultAdmin"],
          iss: "mock",
          aud: "mock",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
      }
    }

    const { payload } = await jwtVerify(rawToken, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
    });

    if (!payload.sub) {
      throw new Error("Token missing sub claim");
    }

    return payload as EntraTokenClaims;
  }

  /**
   * Extract email from the token claims.
   * Entra B2C stores emails in an array (`emails` claim), not a scalar.
   */
  static extractEmail(claims: EntraTokenClaims): string | undefined {
    return claims.emails?.[0] ?? (claims.email as string | undefined);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: EntraService | undefined;

export function getEntraService(): EntraService {
  if (!_instance) _instance = new EntraService();
  return _instance;
}
