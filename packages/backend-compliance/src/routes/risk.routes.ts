import type { FastifyInstance } from "fastify";
import { getRiskControlService } from "../services/risk.service.js";

export async function riskRoutes(app: FastifyInstance): Promise<void> {
  const svc = getRiskControlService();

  // GET /risk/summary — current pool exposure metrics
  app.get("/risk/summary", async (_req, reply) => {
    return reply.send({ success: true, data: svc.summary() });
  });
}
