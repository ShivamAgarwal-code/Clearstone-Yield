/**
 * Tests for EntraService — mock mode only (no live Azure tenant needed).
 *
 * Real JWKS validation is not tested here because it requires a live Entra
 * tenant. Integration tests against a real tenant should be run manually
 * during setup. These tests verify the mock bypass and claim extraction logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EntraService } from "../src/services/entra.service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal unsigned JWT with the given payload (mock mode only). */
function buildMockJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntraService (mock mode)", () => {
  let originalMock: string | undefined;

  beforeEach(() => {
    originalMock = process.env.ENTRA_MOCK;
    process.env.ENTRA_MOCK = "true";
    // Reset module singleton between tests
    vi.resetModules();
  });

  afterEach(() => {
    if (originalMock === undefined) {
      delete process.env.ENTRA_MOCK;
    } else {
      process.env.ENTRA_MOCK = originalMock;
    }
  });

  it("decodes a valid unsigned JWT without signature verification in mock mode", async () => {
    const payload = {
      sub: "user-sub-123",
      oid: "oid-456",
      name: "Alice Smith",
      emails: ["alice@aminabank.com"],
      iss: "mock-issuer",
      aud: "mock-audience",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const svc = new EntraService();
    const claims = await svc.validateToken(buildMockJwt(payload));

    expect(claims.sub).toBe("user-sub-123");
    expect(claims.name).toBe("Alice Smith");
    expect(claims.emails).toEqual(["alice@aminabank.com"]);
  });

  it("returns hardcoded mock claims when token is not a valid JWT", async () => {
    const svc = new EntraService();
    const claims = await svc.validateToken("not-a-jwt");

    expect(claims.sub).toBe("mock-sub-local-dev");
    expect(claims.roles).toContain("VaultAdmin");
    expect(claims.emails).toEqual(["compliance@mock.local"]);
  });

  it("returns hardcoded mock claims for an empty string token", async () => {
    const svc = new EntraService();
    const claims = await svc.validateToken("");

    expect(claims.sub).toBe("mock-sub-local-dev");
  });

  describe("extractEmail", () => {
    it("returns the first email from the emails array", () => {
      expect(
        EntraService.extractEmail({ sub: "x", iss: "", aud: "", iat: 0, exp: 0, emails: ["a@b.com", "c@d.com"] })
      ).toBe("a@b.com");
    });

    it("falls back to email scalar claim if emails array is absent", () => {
      expect(
        EntraService.extractEmail({ sub: "x", iss: "", aud: "", iat: 0, exp: 0, email: "scalar@b.com" } as any)
      ).toBe("scalar@b.com");
    });

    it("returns undefined when no email claims are present", () => {
      expect(
        EntraService.extractEmail({ sub: "x", iss: "", aud: "", iat: 0, exp: 0 })
      ).toBeUndefined();
    });
  });
});
