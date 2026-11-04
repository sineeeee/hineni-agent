import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Runtime } from "../layer2/runtime.js";
import type { ConfigStore } from "../config/store.js";
import { AdminFiles } from "./files.js";
import { artifactRunIds } from "./inspect.js";
const selection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      run_ids: z
        .array(z.string().regex(/^[a-zA-Z0-9:_-]+$/))
        .min(1)
        .max(500),
    })
    .strict(),
]);
export function cleanupRoutes(
  app: FastifyInstance,
  config: ConfigStore,
  runtime: Runtime,
) {
  const files = new AdminFiles(config);
  for (const scope of ["execution", "context"] as const) {
    app.delete<{ Params: { agent: string } }>(
      `/v1/agents/:agent/${scope}-records`,
      async (req) => {
        const agent = req.params.agent;
        if (!runtime.cfg.agents.some((a) => a.id === agent))
          throw Error("Unknown agent");
        if (
          runtime.status().active.some((a) => a.agent === agent) ||
          runtime.outbox.isSending(agent)
        )
          throw Object.assign(
            Error("当前 agent 正在执行或发送，请结束后清理。"),
            { statusCode: 409 },
          );
        const body = selection.parse(req.body);
        const dbRuns = (
          runtime.db.db
            .prepare("SELECT id FROM runs WHERE agent_id=?")
            .all(agent) as Array<{ id: string }>
        ).map((r) => r.id);
        const inventory = artifactRunIds(
          runtime,
          agent,
          scope === "execution" ? "tools" : "context",
        );
        const ids =
          body.mode === "all"
            ? scope === "context"
              ? inventory
              : [...new Set([...dbRuns, ...inventory])]
            : [...new Set(body.run_ids)];
        if (body.mode === "selected")
          for (const id of ids) {
            if (!dbRuns.includes(id) && !inventory.includes(id))
              throw Object.assign(Error("Unknown record; refresh first"), {
                statusCode: 404,
              });
          }
        const root = runtime.agentRoot(agent);
        const paths = ids.flatMap((id) =>
          scope === "context"
            ? [
                path.join(root, ".runtime/requests", id),
                path.join(root, ".runtime/traces", id + ".json"),
              ]
            : [path.join(root, "history/tools", id)],
        );
        // Validate every path before removing anything; reject links and traversal.
        for (const p of paths)
          await files.resolve(path.relative(config.root(), p));
        let deletedEvents = 0;
        if (scope === "execution") {
          const events = ids
            .flatMap((id) => runtime.db.runEvents(agent, id))
            .filter((e) =>
              ["tool_call", "tool_result", "run_finished"].includes(e.type),
            );
          // Store's selected limit is an API guard; chunked storage deletes use the same durable erase path.
          for (let i = 0; i < events.length; i += 500)
            deletedEvents += runtime.eraseHistory(
              agent,
              events.slice(i, i + 500).map((e) => e.event_id),
            ).deleted_events;
        }
        let deletedFiles = 0;
        for (const p of paths) {
          try {
            await fs.lstat(p);
            await fs.rm(p, { recursive: true, force: true });
            deletedFiles++;
          } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
          }
        }
        if (scope === "execution") {
          for (const id of ids)
            runtime.db.db
              .prepare("DELETE FROM runs WHERE agent_id=? AND id=?")
              .run(agent, id);
          runtime.db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        }
        return {
          deleted_runs: ids.length,
          deleted_events: deletedEvents,
          deleted_paths: deletedFiles,
        };
      },
    );
  }
  app.get("/v1/logs/storage", async () => ({
    database: config.resolve(path.join(runtime.cfg.dataDir, "runtime.sqlite")),
    table: "logs",
    ...runtime.db.db
      .prepare(
        "SELECT count(*) AS count,min(at) AS oldest,max(at) AS newest FROM logs",
      )
      .get(),
    stdout: "标准输出由启动方式决定；不包含在此清理中。",
  }));
  app.delete("/v1/logs", async (req) => {
    const body = z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("all") }).strict(),
        z
          .object({
            mode: z.literal("before"),
            before: z.iso.datetime({ offset: true }),
          })
          .strict(),
      ])
      .parse(req.body);
    const r =
      body.mode === "all"
        ? runtime.db.db.prepare("DELETE FROM logs").run()
        : runtime.db.db
            .prepare("DELETE FROM logs WHERE at < ?")
            .run(new Date(body.before).toISOString());
    runtime.db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { deleted_logs: Number(r.changes) };
  });
}
