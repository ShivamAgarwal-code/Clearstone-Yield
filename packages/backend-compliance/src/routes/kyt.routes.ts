import type { FastifyInstance } from "fastify";
import { getKytService } from "../services/kyt.service.js";
import { ValidationError } from "../services/kyc.service.js";

function errorResponse(err: unknown): { statusCode: number; error: string } {
  if (err instanceof ValidationError) {
    return { statusCode: err.statusCode, error: err.message };
  }
  const msg = err instanceof Error ? err.message : "Internal server error";
  return { statusCode: 500, error: msg };
}

export async function kytRoutes(app: FastifyInstance): Promise<void> {
  const svc = getKytService();

  // GET /kyt/score/:walletAddress — fresh risk screen
  app.get<{ Params: { walletAddress: string } }>(
    "/kyt/score/:walletAddress",
    async (req, reply) => {
      try {
        const result = await svc.screenWallet(req.params.walletAddress);
        return reply.send({ success: true, data: result });
      } catch (err) {
        const { statusCode, error } = errorResponse(err);
        return reply.status(statusCode).send({ success: false, error });
      }
    }
  );
}
