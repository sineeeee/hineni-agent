import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Runtime } from "../layer2/runtime.js";

export function memoryRoutes(app: FastifyInstance, runtime: Runtime) {
  const active = new Set<string>();
  const memory = (id: string) => {
    const service = runtime.memories.get(id);
    if (!service)
      throw Error(
        "Unknown or inactive agent; save and restart to initialize it",
      );
    return service;
  };
  app.get<{ Params: { agent: string }; Querystring: { id?: string } }>(
    "/v1/agents/:agent/memory/inspect",
    (req) => memory(req.params.agent).inspectMemories(req.query.id),
  );
  app.post<{ Params: { agent: string } }>(
    "/v1/agents/:agent/memory/simulate",
    async (req, reply) => {
      const body = z
        .object({
          query: z.string().trim().min(1).max(20000),
          mode: z.enum(["recall", "search"]).default("recall"),
        })
        .strict()
        .parse(req.body);
      const service = memory(req.params.agent);
      if (active.has(req.params.agent))
        return reply
          .code(409)
          .send({ error: "该agent已有一次召回试算，请等待完成。" });
      active.add(req.params.agent);
      try {
        return await service.simulateRecall(body.query, body.mode);
      } finally {
        active.delete(req.params.agent);
      }
    },
  );
}
