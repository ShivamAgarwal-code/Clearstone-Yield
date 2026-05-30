import type { FastifyInstance } from "fastify";
import { getTravelRuleService } from "../services/travel-rule.service.js";
import { ValidationError } from "../services/kyc.service.js";
import type { TravelRuleTransferBody } from "../types.js";

function errorResponse(err: unknown): { statusCode: number; error: string } {
  if (err instanceof ValidationError) {
    return { statusCode: err.statusCode, error: err.message };
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  return { statusCode: 500, error: msg };
}

function validateBody(body: TravelRuleTransferBody): string | null {
  if (!body.originator?.vaspDid?.trim()) return "originator.vaspDid is required";
  if (!body.originator?.name?.trim()) return "originator.name is required";
  if (!body.originator?.walletAddress?.trim()) return "originator.walletAddress is required";
  if (!body.beneficiary?.vaspDid?.trim()) return "beneficiary.vaspDid is required";
  if (!body.beneficiary?.name?.trim()) return "beneficiary.name is required";
  if (!body.beneficiary?.walletAddress?.trim()) return "beneficiary.walletAddress is required";
  if (typeof body.amount !== "number" || body.amount <= 0) return "amount must be a positive number";
  if (!body.asset?.trim()) return "asset is required";
  return null;
}

export async function travelRuleRoutes(app: FastifyInstance): Promise<void> {
  const svc = getTravelRuleService();

  // POST /travel-rule/transfer — initiate Travel Rule message
  app.post<{ Body: TravelRuleTransferBody }>(
    "/travel-rule/transfer",
    async (req, reply) => {
      try {
        const validationError = validateBody(req.body);
        if (validationError) {
          return reply.status(400).send({ success: false, error: validationError });
        }
        const record = await svc.initiateTransfer(req.body);
        return reply.status(201).send({ success: true, data: record });
      } catch (err) {
        const { statusCode, error } = errorResponse(err);
        return reply.status(statusCode).send({ success: false, error });
      }
    }
  );
}
