import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import OpenAI from "openai";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConfigStore } from "../config/store.js";
import type { Runtime } from "../layer2/runtime.js";
import { atomicWrite } from "../shared/files.js";
import { AdminFiles } from "./files.js";
import { runFor, requests, toolFiles } from "./inspect.js";
import { History } from "../layer2/history.js";
import { agentConfig, parseConfig } from "../config/schema.js";
import { OpenAIModels } from "../shared/models.js";
import { configurationGuide, fieldGuide } from "../config/guide.js";
import { fieldLessons } from "../config/learning.js";
import { processingGuide } from "../config/processing-guide.js";
import { describeFile } from "./file-guide.js";
import { skillsList } from "../layer3/context.js";
export interface AdminLifecycle {
  restart(): Promise<void>;
  status(): unknown;
}
const pageNumber = (v: any, fallback: number, max = 10000000) =>
  Math.max(0, Math.min(max, Number(v) || fallback));
export async function controls(
  app: FastifyInstance,
  config: ConfigStore,
  runtime: Runtime,
  lifecycle?: AdminLifecycle,
) {
  const files = new AdminFiles(config);
  const historyViews = new Map<
    string,
    { key: string; view: ReturnType<History["inspect"]> }
  >();
  const agent = (id: string) => {
    if (!config.current.agents.some((a) => a.id === id))
      throw Error("Unknown agent");
    return id;
  };
  app.get("/v1/admin/guide", async () => ({
    sections: configurationGuide,
    fields: fieldGuide,
    lessons: fieldLessons,
    processes: Object.fromEntries(
      Object.keys(fieldGuide).map((k) => [k, processingGuide(k)]),
    ),
    locations: {
      root: config.root(),
      config: path.resolve(config.file),
      env: config.resolve(".env"),
      agents: config.resolve(config.current.agentsDir),
      data: config.resolve(config.current.dataDir),
    },
    defaults: parseConfig({
      channels: [{ id: "local", type: "webhook" }],
      agents: [
        {
          id: "main",
          name: "Hineni",
          defaultTarget: { channel: "local", conversation: "owner" },
        },
      ],
    }),
  }));
  app.get("/v1/telegram/chats", async () =>
    Object.fromEntries(
      runtime.cfg.channels
        .filter((c) => c.type === "telegram")
        .map((c) => [c.id, runtime.db.get(`telegram-chats:${c.id}`, [])]),
    ),
  );
  app.get<{
    Params: { agent: string };
    Querystring: { offset?: string; limit?: string };
  }>("/v1/agents/:agent/history-view", async (req) => {
    const id = agent(req.params.agent),
      a = runtime.cfg.agents.find((a) => a.id === id);
    if (!a) throw Error("Save and restart to initialize this agent");
    const effective = agentConfig(runtime.cfg, a);
    const seq = runtime.db.db
      .prepare("SELECT MAX(seq) AS seq FROM events WHERE agent_id=?")
      .get(id)?.seq;
    const key = JSON.stringify([
      seq,
      runtime.db.get(`history:${id}`, {}),
      runtime.db.get(`history-revision:${id}`, 0),
      effective.history,
    ]);
    let cached = historyViews.get(id);
    if (!cached || cached.key !== key) {
      cached = {
        key,
        view: new History(
          runtime.db,
          effective,
          new OpenAIModels(effective, runtime.environments.get(id)),
        ).inspect(id),
      };
      historyViews.set(id, cached);
    }
    const view = cached.view;
    const offset = pageNumber(req.query.offset, 0),
      limit = pageNumber(req.query.limit, 200000, 1000000);
    const target =
      runtime.db.recent(
        id,
        [
          "incoming_message",
          "internal_event",
          "attachment_ready",
          "attachment_failed",
        ],
        1,
      )[0]?.reply_target ?? a.defaultTarget;
    return {
      ...view,
      remaining: view.remaining.slice(offset, offset + limit),
      total: view.remaining.length,
      next_offset:
        offset + limit < view.remaining.length ? offset + limit : null,
      as_of: new Date().toISOString(),
      target,
      conversation_context: effective.state.gap
        ? runtime.db.gap(id, target)
        : null,
      gap_enabled: effective.state.gap,
      restart_required: config.current !== runtime.cfg,
    };
  });
  app.get<{
    Params: { agent: string };
    Querystring: { offset?: string; limit?: string };
  }>("/v1/agents/:agent/layer2-snapshot", async (req) => {
    const id = agent(req.params.agent);
    const runs = runtime.db.db
      .prepare(
        "SELECT id FROM runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 100",
      )
      .all(id);
    for (const run of runs) {
      const name = path.join(
        runtime.agentRoot(id),
        ".runtime",
        "traces",
        String(run.id) + ".json",
      );
      let data: any;
      try {
        data = JSON.parse(await fs.readFile(name, "utf8"));
      } catch (e: any) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const text =
        data.layer2?.history ??
        data.messages?.find((m: any) => typeof m.content === "string")
          ?.content ??
        "";
      const offset = pageNumber(req.query.offset, 0),
        limit = pageNumber(req.query.limit, 200000, 1000000);
      return {
        run_id: run.id,
        ...(data.layer2 ?? {}),
        history: text.slice(offset, offset + limit),
        total: text.length,
        next_offset: offset + limit < text.length ? offset + limit : null,
        legacy: !data.layer2,
      };
    }
    return { unavailable: true };
  });
  app.get("/v1/admin/lifecycle", async () => ({
    supported: !!lifecycle,
    ...((lifecycle?.status() as any) ?? {}),
  }));
  app.post("/v1/service/restart", async (_req, reply) => {
    if (!lifecycle)
      return reply
        .code(409)
        .send({ error: "Restart unavailable in this host" });
    await lifecycle.restart();
    return reply.code(202).send({ restarting: true });
  });
  app.delete<{ Params: { agent: string } }>(
    "/v1/agents/:agent/history",
    async (req) => {
      const id = agent(req.params.agent);
      if (!runtime.cfg.agents.some((a) => a.id === id))
        throw Error("Save and restart to initialize this agent");
      const body = z
        .discriminatedUnion("mode", [
          z.object({ mode: z.literal("all") }).strict(),
          z
            .object({
              mode: z.literal("selected"),
              event_ids: z.array(z.string().min(1)).min(1).max(500),
            })
            .strict(),
        ])
        .parse(req.body);
      return runtime.eraseHistory(
        id,
        body.mode === "all" ? "all" : body.event_ids,
      );
    },
  );
  app.delete<{ Params: { agent: string } }>(
    "/v1/agents/:agent/history-summary",
    async (req) => {
      const id = agent(req.params.agent);
      if (!runtime.cfg.agents.some((a) => a.id === id))
        throw Error("Save and restart to initialize this agent");
      return runtime.clearHistorySummary(id);
    },
  );
  app.get<{
    Params: { agent: string };
    Querystring: {
      before?: string;
      after?: string;
      limit?: string;
      type?: string;
    };
  }>("/v1/agents/:agent/timeline", async (req) => {
    const a = agent(req.params.agent),
      q = req.query;
    let sql = "SELECT * FROM events WHERE agent_id=?";
    const args: any[] = [a];
    if (q.before) {
      sql += " AND seq<?";
      args.push(Number(q.before));
    }
    if (q.after) {
      sql += " AND seq>?";
      args.push(Number(q.after));
    }
    if (q.type) {
      sql += " AND type=?";
      args.push(q.type);
    }
    sql += " ORDER BY seq DESC LIMIT ?";
    args.push(pageNumber(q.limit, 100, 500));
    const rows = runtime.db.db
      .prepare(sql)
      .all(...args)
      .map((r) => runtime.db.decode(r))
      .reverse();
    return {
      items: rows,
      history_revision: runtime.db.get("history-revision:" + a, 0),
      oldest: rows[0]?.seq ?? null,
      latest: rows.at(-1)?.seq ?? null,
    };
  });
  app.get<{ Params: { agent: string; run: string } }>(
    "/v1/agents/:agent/runs/:run",
    async (req) => {
      const a = agent(req.params.agent),
        r = req.params.run;
      return {
        run: runFor(runtime, a, r),
        events: runtime.db.runEvents(a, r),
        files: await toolFiles(runtime, files, a, r),
        requests: await requests(runtime, a, r),
      };
    },
  );
  app.delete<{ Params: { agent: string; run: string } }>(
    "/v1/agents/:agent/runs/:run/context",
    async (req) => {
      const a = agent(req.params.agent),
        r = req.params.run;
      runFor(runtime, a, r);
      if (runtime.status().active.some((x) => x.run_id === r))
        throw Object.assign(Error("这轮仍在运行，请结束后删除上下文快照。"), {
          statusCode: 409,
        });
      const body = z
        .discriminatedUnion("mode", [
          z.object({ mode: z.literal("all") }).strict(),
          z
            .object({
              mode: z.literal("selected"),
              request: z
                .string()
                .regex(/^\d+\.json$/)
                .nullable(),
            })
            .strict(),
        ])
        .parse(req.body);
      const names = await requests(runtime, a, r);
      if (
        body.mode === "selected" &&
        body.request !== null &&
        !names.includes(body.request)
      )
        throw Object.assign(Error("Unknown request"), { statusCode: 404 });
      const base = path.join(runtime.agentRoot(a), ".runtime");
      const paths =
        body.mode === "all"
          ? [
              ...names.map((n) => path.join(base, "requests", r, n)),
              path.join(base, "traces", r + ".json"),
            ]
          : [
              body.request === null
                ? path.join(base, "traces", r + ".json")
                : path.join(base, "requests", r, body.request),
            ];
      let deleted = 0;
      for (const p of paths) {
        await files.resolve(path.relative(config.root(), p));
        try {
          await fs.unlink(p);
          deleted++;
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      return { deleted_snapshots: deleted };
    },
  );
  app.get<{
    Params: { agent: string; run: string };
    Querystring: { request?: string; offset?: string; limit?: string };
  }>("/v1/agents/:agent/runs/:run/context", async (req) => {
    const a = agent(req.params.agent),
      r = req.params.run;
    const list = await requests(runtime, a, r);
    const chosen = req.query.request ?? list.at(-1);
    if (chosen && !list.includes(chosen)) throw Error("Unknown request");
    const relative = path.relative(
      config.root(),
      path.join(
        runtime.agentRoot(a),
        ".runtime",
        chosen ? "requests" : "traces",
        chosen ? r : r + ".json",
        ...(chosen ? [chosen] : []),
      ),
    );
    try {
      return {
        ...(await files.read(
          relative,
          pageNumber(req.query.offset, 0),
          pageNumber(req.query.limit, 200000, 1000000),
        )),
        request: chosen ?? null,
        requests: list,
      };
    } catch (e: any) {
      if (e.code === "ENOENT")
        return {
          content: "",
          total: 0,
          next_offset: null,
          requests: list,
          unavailable: true,
        };
      throw e;
    }
  });
  app.get<{ Querystring: { agent?: string } }>("/v1/admin/files", async (req) =>
    (
      await files.list(req.query.agent ? agent(req.query.agent) : undefined)
    ).map((f) => ({
      ...f,
      absolutePath: config.resolve(f.path),
      ...describeFile(f.path),
      ...(config.current.agents.some(
        (a) =>
          path.resolve(
            config.agentRoot(a.id),
            agentConfig(config.current, a).scheduler.script,
          ) === config.resolve(f.path),
      )
        ? { ...describeFile("agents/current/schedule.ts"), advanced: false }
        : {}),
    })),
  );
  app.get<{ Querystring: { path: string; offset?: string; limit?: string } }>(
    "/v1/admin/file",
    async (req) =>
      files.read(
        req.query.path,
        pageNumber(req.query.offset, 0),
        pageNumber(req.query.limit, 200000, 1000000),
      ),
  );
  app.put("/v1/admin/file", async (req) => {
    const b = z
      .object({
        path: z.string(),
        content: z.string().max(10000000),
        version: z.string().optional(),
      })
      .parse(req.body);
    return files.write(b.path, b.content, b.version);
  });
  app.get<{ Querystring: { path: string } }>(
    "/v1/admin/download",
    async (req, reply) => {
      const file = await files.resolve(req.query.path);
      reply
        .header("Content-Type", "application/octet-stream")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        );
      return fs.readFile(file);
    },
  );
  app.get<{ Params: { agent: string } }>(
    "/v1/agents/:agent/skills",
    async (req) => {
      const id = agent(req.params.agent),
        a = config.current.agents.find((a) => a.id === id)!;
      const own = path.join(config.agentRoot(id), "skills");
      return (await skillsList([own, ...a.skills])).map((s) => ({
        ...s,
        path: path.relative(config.root(), s.file),
        local: s.file.startsWith(own + path.sep),
      }));
    },
  );
  app.post<{ Params: { agent: string } }>(
    "/v1/agents/:agent/skills",
    async (req) => {
      const b = z
        .object({
          name: z.string(),
          files: z
            .array(
              z.object({ path: z.string(), content: z.string().max(2000000) }),
            )
            .min(1)
            .max(200),
        })
        .parse(req.body);
      return files.install(agent(req.params.agent), b.name, b.files);
    },
  );
  app.delete<{ Params: { agent: string; skill: string } }>(
    "/v1/agents/:agent/skills/:skill",
    async (req) => files.removeSkill(agent(req.params.agent), req.params.skill),
  );
  const credentialFile = (id?: string) =>
    id
      ? path.join(config.agentRoot(agent(id)), ".env")
      : config.resolve(".env");
  const readEnv = async (file: string) =>
    dotenv.parse(
      await fs.readFile(file).catch((e) => {
        if (e.code === "ENOENT") return Buffer.from("");
        throw e;
      }),
    );
  app.get<{ Querystring: { agent?: string } }>(
    "/v1/credentials",
    async (req) => {
      const id = req.query.agent;
      const env = await readEnv(credentialFile(id));
      const effective = id
        ? agentConfig(
            config.current,
            config.current.agents.find((a) => a.id === id)!,
          )
        : config.current;
      const active = id ? (runtime.environments.get(id) ?? {}) : process.env;
      const names = new Set([
        ...Object.keys(env),
        ...(id ? [] : [config.current.server.tokenEnv]),
        ...(Object.values(effective.models)
          .map((m) => m?.apiKeyEnv)
          .filter(Boolean) as string[]),
        ...(!id
          ? (config.current.channels
              .map((c) => c.tokenEnv)
              .filter(Boolean) as string[])
          : []),
      ]);
      return [...names].map((name) => ({
        name,
        configured: !!env[name],
        active: !!active[name],
        restart_required: env[name] !== undefined && env[name] !== active[name],
      }));
    },
  );
  app.put("/v1/credentials", async (req) => {
    const b = z
      .object({
        agent_id: z.string().optional(),
        name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
        value: z.string().max(20000),
      })
      .parse(req.body);
    if (b.name === config.current.server.tokenEnv && b.value.length < 24)
      throw Error("Management token needs at least 24 characters");
    if (/[\r\n]/.test(b.value)) throw Error("Credential must be one line");
    if (
      b.agent_id &&
      [
        config.current.server.tokenEnv,
        ...config.current.channels.flatMap((c) => [c.tokenEnv, c.secretEnv]),
      ].includes(b.name)
    )
      throw Error("Connection credentials belong to the root .env");
    const file = credentialFile(b.agent_id);
    let source = await fs.readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    const line = b.name + "=" + JSON.stringify(b.value);
    const re = new RegExp("^" + b.name + "=.*$", "m");
    source = re.test(source)
      ? source.replace(re, () => line)
      : source.trimEnd() + "\n" + line + "\n";
    await atomicWrite(file, source);
    return { saved: true, restart_required: true };
  });
  app.post("/v1/models/discover", async (req) => {
    const b = z
      .object({
        agent_id: z.string().optional(),
        baseUrl: z.string().url(),
        apiKeyEnv: z.string(),
        apiKey: z.string().max(20000).optional(),
      })
      .parse(req.body);
    const u = new URL(b.baseUrl);
    if (!["http:", "https:"].includes(u.protocol))
      throw Error("HTTP(S) required");
    const env = await readEnv(credentialFile(b.agent_id)),
      key =
        b.apiKey ||
        env[b.apiKeyEnv] ||
        (!b.agent_id ? process.env[b.apiKeyEnv] : undefined);
    if (!key) throw Error("Credential not configured");
    const client = new OpenAI({
      baseURL: b.baseUrl,
      apiKey: key,
      maxRetries: 0,
      timeout: 15000,
    });
    const result = await client.models.list();
    return {
      models: result.data
        .map((m) => ({ id: m.id, owned_by: m.owned_by }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  });
}
