/**
 * Authentication routes — Microsoft Entra B2C identity linking.
 *
 * POST /auth/link-wallet
 *   Links a verified Entra B2C identity (sub claim) to a Solana wallet address.
 *   The caller must present a valid Entra Bearer token.
 *
 *   After linking, the wallet's KYC record carries the `entraSubjectId`, proving
 *   that the wallet owner has been authenticated by the bank's institutional IDP
 *   (Microsoft Entra B2C per Amina's requirements).
 *
 * GET /auth/identity/:walletAddress
 *   Returns the Entra identity linked to a wallet (admin / audit use).
 *
 * GET /auth/me
 *   Returns the KYC record for the authenticated Entra user (self-service).
 */

import type { FastifyInstance } from "fastify";
import { requireEntraAuth } from "../middleware/entra-auth.js";
import { getKycService, NotFoundError } from "../services/kyc.service.js";

interface LinkWalletBody {
  walletAddress: string;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const kycSvc = getKycService();

  // -------------------------------------------------------------------------
  // POST /auth/link-wallet
  // Primary user onboarding endpoint. User only provides their wallet address —
  // name, email, and identity are pulled directly from the verified Entra token.
  //
  // Requires: Authorization: Bearer <entra_token>
  // Body:     { walletAddress: string }
  // -------------------------------------------------------------------------
  app.post<{ Body: LinkWalletBody }>(
    "/auth/link-wallet",
    { preHandler: requireEntraAuth },
    async (req, reply) => {
      const claims = req.entraUser!;
      const { walletAddress } = req.body;

      if (!walletAddress?.trim()) {
        return reply.status(400).send({ success: false, error: "walletAddress is required" });
      }

      try {
        const record = await kycSvc.registerFromEntra(walletAddress, claims.sub, claims);
        return reply.status(200).send({
          success: true,
          data: {
            walletAddress: record.walletAddress,
            entraSubjectId: record.entraSubjectId,
            kycStatus: record.status,
            message: record.status === "approved"
              ? "Already approved. Wallet is whitelisted."
              : "Registered. Pending compliance review.",
          },
        });
      } catch (err) {
        const status = (err as any).statusCode ?? 500;
        const message = err instanceof Error ? err.message : "Internal server error";
        return reply.status(status).send({ success: false, error: message });
      }
    }
  );

  // -------------------------------------------------------------------------
  // GET /auth/me
  // Requires: Authorization: Bearer <entra_token>
  // Returns the KYC record for the authenticated Entra user.
  // -------------------------------------------------------------------------
  app.get(
    "/auth/me",
    { preHandler: requireEntraAuth },
    async (req, reply) => {
      const claims = req.entraUser!;
      const record = kycSvc.findByEntraSub(claims.sub);

      if (!record) {
        return reply.status(404).send({
          success: false,
          error: "No wallet linked to this Entra identity. Call POST /auth/link-wallet first.",
        });
      }

      return reply.send({ success: true, data: record });
    }
  );

  // -------------------------------------------------------------------------
  // GET /auth/identity/:walletAddress  (admin / audit)
  // Returns Entra identity info for a given wallet address.
  // -------------------------------------------------------------------------
  app.get<{ Params: { walletAddress: string } }>(
    "/auth/identity/:walletAddress",
    async (req, reply) => {
      try {
        const record = kycSvc.getStatus(req.params.walletAddress);
        return reply.send({
          success: true,
          data: {
            walletAddress: record.walletAddress,
            entraSubjectId: record.entraSubjectId ?? null,
            entraLinked: !!record.entraSubjectId,
            kycStatus: record.status,
          },
        });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply.status(404).send({ success: false, error: (err as Error).message });
        }
        return reply.status(500).send({ success: false, error: "Internal server error" });
      }
    }
  );
}
