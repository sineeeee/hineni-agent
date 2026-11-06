import Fastify from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ConfigSchema, agentConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import type { Runtime } from "../layer2/runtime.js";
import type { Scheduler } from "../scheduler.js";
import { id, jsonWrite, atomicWrite, errorText } from "../shared/files.js";
import { icons, manifest } from "./icons.js";
import { page } from "./ui.js";
import { style } from "./ui-style.js";
import { client } from "./ui-client.js";
import { runCatalog } from "./inspect.js";
import { controls, type AdminLifecycle } from "./control.js";
export async function servers(
  config: ConfigStore,
  runtime: Runtime,
  scheduler: Scheduler,
  lifecycle?: AdminLifecycle,
) {
  const cfg = runtime.cfg,
    token = process.env[cfg.server.tokenEnv];
  if (!token || token.length < 24)
    throw Error(
      `Set ${cfg.server.tokenEnv} to a random token of at least 24 characters`,
    );
  const make = (admin: boolean) => {
    const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
    app.addHook("onRequest", async (req, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY");
      if (
        admin &&
        [
          "/",
          "/admin.css",
          "/admin.js",
          "/manifest.webmanifest",
          ...Object.keys(icons),
        ].includes(req.url.split("?")[0])
      )
        return;
      const actual = Buffer.from(
          req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        ),
        expected = Buffer.from(token);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        return reply.code(401).send({ error: "Authentication required" });
    });
    app.setErrorHandler((e, req, reply) => {
      const message = errorText(e);
      runtime.db.log("warn", "api", message, {
        method: req.method,
        path: req.url.split("?")[0],
      });
      reply
        .code(e instanceof z.ZodError ? 400 : ((e as any).statusCode ?? 400))
        .send({ error: message });
    });
    const agent = (agentId: string) => {
      if (!runtime.cfg.agents.some((a) => a.id === agentId))
        throw Error("Unknown agent");
      return agentId;
    };
    app.get("/v1/status", async () => ({
      ...runtime.status(),
      scheduler: scheduler.status(),
      config_revision: config.revision,
      restart_required: config.current !== runtime.cfg,
    }));
    app.post("/v1/events", async (req, reply) => {
      const b = req.body as any;
      if (!["incoming_message", "internal_event"].includes(b?.type))
        throw Error(
          "External events must be incoming_message or internal_event",
        );
      const e = runtime.ingress(b);
      return reply.code(202).send({ event_id: e.event_id, seq: e.seq });
    });
    app.get<{
      Params: { agent: string };
      Querystring: { after?: string; limit?: string };
    }>("/v1/agents/:agent/events", async (req) =>
      runtime.db.events(
        agent(req.params.agent),
        Math.max(0, Number(req.query.after) || 0),
        Math.min(500, Math.max(1, Number(req.query.limit) || 100)),
      ),
    );
    app.post<{ Params: { agent: string } }>(
      "/v1/agents/:agent/cancel",
      async (req) => runtime.cancel(agent(req.params.agent)),
    );
    app.get<{ Params: { agent: string } }>(
      "/v1/agents/:agent/state",
      async (req) => runtime.memories.get(agent(req.params.agent))!.state(),
    );
    app.post<{ Params: { agent: string } }>(
      "/v1/agents/:agent/memory/search",
      async (req) => {
        const b = z
          .object({
            query: z.string(),
            limit: z.number().int().min(1).max(50).default(12),
          })
          .parse(req.body);
        return runtime.memories
          .get(agent(req.params.agent))!
          .search(b.query, true, b.limit);
      },
    );
    app.post<{ Params: { agent: string } }>(
      "/v1/agents/:agent/memory/reindex",
      async (req, reply) => {
        const memory = runtime.memories.get(agent(req.params.agent))!;
        const body = z
          .object({
            background: z.boolean().default(false),
            side: z.enum(["both", "fact", "feeling"]).optional(),
            ids: z.array(z.string().min(1)).min(1).max(10000).optional(),
            force: z.boolean().default(false),
          })
          .strict()
          .parse(req.body ?? {});
        if ((body.force || body.side || body.ids) && memory.indexingBusy())
          throw Object.assign(Error("索引维护正在运行，请等待完成。"), {
            statusCode: 409,
          });
        if (body.background) {
          if (body.force || body.side || body.ids) memory.requestIndexing(body);
          else memory.startIndexing();
          return reply.code(202).send(await memory.indexStatus());
        }
        const items = await memory.sync(true, body);
        return { items: items.length, ...(await memory.indexStatus()) };
      },
    );
    app.get<{ Params: { agent: string } }>(
      "/v1/agents/:agent/memory/index-status",
      async (req) =>
        runtime.memories.get(agent(req.params.agent))!.indexStatus(),
    );
    app.post<{ Params: { agent: string } }>(
      "/v1/agents/:agent/attachments",
      async (req, reply) => {
        const a = agent(req.params.agent);
        const b = z
          .object({
            name: z.string().max(200),
            mime: z.string().max(100),
            data_base64: z.string().max(28_000_000),
          })
          .strict()
          .parse(req.body);
        const bytes = Buffer.from(b.data_base64, "base64");
        if (bytes.length > 20 * 1024 * 1024)
          throw Error("Attachment limit 20 MiB");
        const ref = id(),
          file = path.join(runtime.agentRoot(a), "attachments", ref);
        await atomicWrite(file, bytes);
        const attachment = {
          id: ref,
          agent_id: a,
          path: file,
          name: path.basename(b.name),
          mime: b.mime,
          status: "ready" as const,
        };
        await jsonWrite(file + ".json", attachment);
        runtime.db.attachment(attachment);
        return reply.code(201).send(attachment);
      },
    );
    app.get<{ Params: { agent: string; id: string } }>(
      "/v1/agents/:agent/attachments/:id",
      async (req, reply) => {
        const a = runtime.db.getAttachment(
          agent(req.params.agent),
          req.params.id,
        );
        if (!a || a.status !== "ready")
          return reply.code(404).send({ error: "Not ready" });
        reply
          .header("Content-Type", "application/octet-stream")
          .header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
          );
        return await fs.readFile(a.path);
      },
    );
    app.get("/v1/logs", async () => runtime.db.logs(200));
    app.get<{ Querystring: { agent?: string; scope?: string } }>(
      "/v1/runs",
      async (req) =>
        req.query.agent
          ? runCatalog(runtime, agent(req.query.agent), req.query.scope)
          : runtime.db.db
              .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 100")
              .all(),
    );
    app.get("/v1/deliveries", async () =>
      runtime.db.db
        .prepare("SELECT * FROM deliveries ORDER BY seq DESC LIMIT 100")
        .all()
        .map((x: any) => ({ ...x, payload: JSON.parse(x.payload) })),
    );
    app.post<{ Params: { id: string } }>(
      "/v1/deliveries/:id/retry",
      async (req) => {
        const row: any = runtime.db.db
          .prepare("SELECT * FROM deliveries WHERE id=?")
          .get(req.params.id);
        if (!row || !["failed", "uncertain"].includes(row.status))
          throw Error("Only failed/uncertain deliveries can be retried");
        runtime.db.deliveryUpdate(row.id, "queued", row.part_index, 0);
        return { queued: true };
      },
    );
    app.post("/v1/scheduler/restart", async (req) => {
      const b = z
        .object({ agent_id: z.string().optional() })
        .parse(req.body ?? {});
      await scheduler.restart(b.agent_id);
      return scheduler.status();
    });
    app.get("/v1/config", async () => {
      await config.refreshFromDisk();
      return { revision: config.revision, config: config.current };
    });
    app.get("/v1/config/schema", async () => z.toJSONSchema(ConfigSchema));
    app.put("/v1/config", async (req) => {
      const b = req.body as any;
      if (b.revision !== config.revision)
        throw Error("配置版本已变化，请先暂存草稿，再重新读取并核对。");
      await config.save(b.config, b.revision);
      runtime.db.log("info", "config", "Configuration saved and read back", {
        revision: config.revision,
        agents: config.current.agents.map((a) => a.id),
      });
      return {
        revision: config.revision,
        config: config.current,
        restart_required: true,
      };
    });
    app.get("/v1/files", async () => [
      "prompts/system.md",
      ...runtime.cfg.agents.map(
        (a) =>
          `${runtime.cfg.agentsDir}/${a.id}/${agentConfig(runtime.cfg, a).scheduler.script}`,
      ),
      ...runtime.cfg.agents.flatMap((a) => [
        `${runtime.cfg.agentsDir}/${a.id}/persona.md`,
        `${runtime.cfg.agentsDir}/${a.id}/memory.json`,
        `${runtime.cfg.agentsDir}/${a.id}/SYSTEM.md`,
      ]),
    ]);
    const allowed = () =>
      new Set([
        "prompts/system.md",
        ...runtime.cfg.agents.map(
          (a) =>
            `${runtime.cfg.agentsDir}/${a.id}/${agentConfig(runtime.cfg, a).scheduler.script}`,
        ),
        ...runtime.cfg.agents.flatMap((a) => [
          `${runtime.cfg.agentsDir}/${a.id}/persona.md`,
          `${runtime.cfg.agentsDir}/${a.id}/memory.json`,
          `${runtime.cfg.agentsDir}/${a.id}/SYSTEM.md`,
        ]),
      ]);
    app.get<{ Querystring: { path: string } }>("/v1/file", async (req) => {
      if (!allowed().has(req.query.path))
        throw Error("File is not editable here");
      return {
        content: await fs.readFile(config.resolve(req.query.path), "utf8"),
      };
    });
    app.put("/v1/file", async (req) => {
      const b = z
        .object({ path: z.string(), content: z.string().max(10_000_000) })
        .parse(req.body);
      if (!allowed().has(b.path)) throw Error("File is not editable here");
      if (b.path.endsWith("memory.json")) {
        const data = JSON.parse(b.content);
        if (!Array.isArray(data.memory)) throw Error("memory array required");
      }
      await atomicWrite(config.resolve(b.path), b.content);
      return { saved: true };
    });
    void controls(app, config, runtime, lifecycle);
    if (admin) {
      for (const [url, data] of Object.entries(icons))
        app.get(url, async (_req, reply) =>
          reply.type("image/png").send(Buffer.from(data, "base64")),
        );
      app.get("/manifest.webmanifest", async (_req, reply) =>
        reply.type("application/manifest+json").send(manifest),
      );
      app.get("/", async (_req, reply) => reply.type("text/html").send(page));
      app.get("/admin.css", async (_req, reply) =>
        reply.type("text/css").send(style),
      );
      app.get("/admin.js", async (_req, reply) =>
        reply.type("application/javascript").send(client),
      );
    }
    return app;
  };
  const api = make(false),
    admin = make(true);
  return {
    api,
    admin,
    listen: async () => {
      await api.listen({ host: cfg.server.host, port: cfg.server.port });
      try {
        await admin.listen({
          host: cfg.server.host,
          port: cfg.server.adminPort,
        });
      } catch (e) {
        await api.close();
        throw e;
      }
    },
    close: async () => {
      await Promise.all([api.close(), admin.close()]);
    },
  };
}
