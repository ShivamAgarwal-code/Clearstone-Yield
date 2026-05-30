/**
 * Audit Route — source-of-funds proof on regulator demand.
 *
 * GET /audit/report/:walletAddress returns the full compliance trail for a wallet:
 *   - KYC record (identity, approval status)
 *   - KYT record (risk score at time of approval)
 *   - Travel Rule transfers involving this wallet
 *   - On-chain whitelist entries with tx signatures
 */

import type { FastifyInstance } from "fastify";
import { getKycService, NotFoundError } from "../services/kyc.service.js";
import { getKytService } from "../services/kyt.service.js";
import { getTravelRuleService } from "../services/travel-rule.service.js";

function errorResponse(err: unknown): { statusCode: number; error: string } {
  if (err instanceof NotFoundError) {
    return { statusCode: err.statusCode, error: err.message };
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  return { statusCode: 500, error: msg };
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const kyc = getKycService();
  const kyt = getKytService();
  const travelRule = getTravelRuleService();

  // GET /audit/report/:walletAddress
  app.get<{ Params: { walletAddress: string } }>(
    "/audit/report/:walletAddress",
    async (req, reply) => {
      try {
        const { walletAddress } = req.params;

        const kycRecord = kyc.getStatus(walletAddress);
        const kytRecord = kyt.getRecord(walletAddress) ?? null;
        const travelRuleTransfers = travelRule.getByWallet(walletAddress);

        return reply.send({
          success: true,
          data: {
            kycRecord,
            kytRecord,
            travelRuleTransfers,
            onChainWhitelistEntries: kycRecord.whitelistResults ?? [],
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        const { statusCode, error } = errorResponse(err);
        return reply.status(statusCode).send({ success: false, error });
      }
    }
  );
}
