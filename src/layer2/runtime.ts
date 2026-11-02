import path from "node:path";
import fs from "node:fs/promises";
import {
  agentConfig,
  type Config,
  type AgentConfig,
} from "../config/schema.js";
import type {
  EventInput,
  Event,
  Executor,
  RunResult,
  ContextBundle,
  Part,
  Target,
} from "../contracts/index.js";
import { EventSchema, triggerTypes } from "../contracts/index.js";
import { ConfigStore } from "../config/store.js";
import { Store } from "./store.js";
import { History } from "./history.js";
import { MemoryService } from "../layer3/memory.js";
import { ContextBuilder } from "../layer3/context.js";
import { OpenAIModels, type Intelligence } from "../shared/models.js";
import { PiExecutor } from "../layer4/pi.js";
import type { ToolHost } from "../layer4/tools.js";
import { ChannelRegistry } from "../layer1/channels.js";
import { Outbox } from "./outbox.js";
import { id, errorText } from "../shared/files.js";
export type ExecutorFactory = (
  host: ToolHost,
  llm: Intelligence,
  record: (e: any) => void,
) => Executor;
export class Runtime {
  readonly cfg: Config;
  readonly registry: ChannelRegistry;
  readonly outbox: Outbox;
  readonly memories = new Map<string, MemoryService>();
  readonly environments = new Map<string, NodeJS.ProcessEnv>();
  private pollAt = new Map<string, number>();
  private maintenanceAt = new Map<string, number>();
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; runId: string }
  >();
  private timer?: NodeJS.Timeout;
  private maintenance?: NodeJS.Timeout;
  private maintenanceBusy = false;
  private stopping = false;
  private background = new Set<Promise<unknown>>();
  private moodChains = new Map<string, Promise<unknown>>();
  constructor(
    public config: ConfigStore,
    public db: Store,
    private restartScheduler: (id?: string) => Promise<void>,
    private llm: Intelligence = new OpenAIModels(config.current),
    private factory: ExecutorFactory = (h, l, r) => new PiExecutor(h, l, r),
  ) {
    this.cfg = config.current;
    for (const a of this.cfg.agents) {
      this.environments.set(a.id, config.agentEnv(a.id));
      db.addSecrets(config.agentEnv(a.id));
    }
    this.registry = new ChannelRegistry(
      this.cfg,
      db,
      (a) => this.agentRoot(a),
      (e) => this.ingress(e),
    );
    this.outbox = new Outbox(db, this.cfg, this.registry, (e) =>
      this.ingress(e),
    );
    for (const a of this.cfg.agents)
      this.memories.set(
        a.id,
        new MemoryService(
          this.agentRoot(a.id),
          a.id,
          db,
          agentConfig(this.cfg, a),
          llm instanceof OpenAIModels
            ? new OpenAIModels(agentConfig(this.cfg, a), config.agentEnv(a.id))
            : llm,
        ),
      );
  }
  agentRoot(id: string) {
    return path.resolve(this.config.root(), this.cfg.agentsDir, id);
  }
  ingress(raw: unknown) {
    if (this.stopping) throw Error("Service is shutting down");
    const e = EventSchema.parse(raw),
      a = this.cfg.agents.find((a) => a.id === e.agent_id && a.enabled);
    if (!a) throw Error("Unknown or disabled agent");
    if (
      e.reply_target &&
      !this.cfg.channels.some((c) => c.id === e.reply_target!.channel)
    )
      throw Error("Unknown channel");
    for (const ref of e.attachments)
      if (!this.db.getAttachment(e.agent_id, ref))
        throw Error("Unknown attachment");
    if (
      e.type === "incoming_message" &&
      e.source_message_id &&
      e.reply_target &&
      this.db.isEcho(e.agent_id, e.source_message_id, e.reply_target)
    ) {
      e.type = "delivery_result";
      e.data = { ...e.data, echo: true };
    }
    if (this.db.getEvent(e.agent_id, e.event_id))
      return this.db.getEvent(e.agent_id, e.event_id)!;
    const incoming = this.db.append(e);
    if (triggerTypes.has(e.type)) {
      this.active.get(a.id)?.controller.abort(new Error("New event"));
      this.db.purgeUnsent(a.id, e.reply_target ?? a.defaultTarget);
    }
    return incoming;
  }
  async start() {
    this.db.rebuild(this.cfg.agents.map((a) => a.id));
    this.db.recover();
    this.outbox.recover();
    await this.registry.start();
    this.outbox.start();
    this.timer = setInterval(() => this.tick(), 50);
    this.maintenance = setInterval(() => void this.maintain(), 1000);
    this.tick();
    void this.maintain();
  }
  tick() {
    if (this.stopping) return;
    for (const a of this.cfg.agents.filter((a) => a.enabled)) {
      if (Date.now() < (this.pollAt.get(a.id) ?? 0)) continue;
      this.pollAt.set(
        a.id,
        Date.now() + agentConfig(this.cfg, a).history.pollMs,
      );
      const batch = this.db.pending(a.id);
      if (!batch.length) continue;
      const running = this.active.get(a.id);
      if (running) {
        running.controller.abort(new Error("New event"));
        continue;
      }
      const runId = id(),
        controller = new AbortController();
      this.db.claim(a.id, batch, runId);
      const promise = this.execute(a, batch, runId, controller.signal)
        .catch((e) => this.db.log("error", "runtime", errorText(e)))
        .finally(() => {
          this.active.delete(a.id);
          if (!this.stopping) this.tick();
        });
      this.active.set(a.id, { controller, promise, runId });
    }
  }
  private async execute(
    a: AgentConfig,
    batch: Event[],
    runId: string,
    signal: AbortSignal,
  ) {
    const cfg = agentConfig(this.cfg, a),
      llm =
        this.llm instanceof OpenAIModels
          ? new OpenAIModels(cfg, this.environments.get(a.id))
          : this.llm;
    const signalWithTimeout = AbortSignal.any([
      signal,
      AbortSignal.timeout(cfg.runtime.runTimeoutMs),
    ]);
    let context: ContextBundle | undefined,
      result: RunResult | undefined,
      executed = false;
    const memory = this.memories.get(a.id)!;
    const history = new History(this.db, cfg, llm);
    let chunk = 0;
    const record = (e: any) =>
      this.db.append({
        protocol_version: 1,
        agent_id: a.id,
        source: "layer4",
        attachments: [],
        data: {},
        ...e,
      });
    try {
      context = await new ContextBuilder(
        this.db,
        cfg,
        a,
        this.agentRoot(a.id),
        path.join(this.agentRoot(a.id), "prompts"),
        history,
        memory,
      ).build(batch, runId, signalWithTimeout);
      signalWithTimeout.throwIfAborted();
      const host: ToolHost = {
        db: this.db,
        memory,
        cfg,
        agent: a,
        root: this.agentRoot(a.id),
        target: context.target,
        restartScheduler: () => this.restartScheduler(a.id),
        env: this.environments.get(a.id),
        silent: () => {},
        send: (
          parts: Part[],
          target: Target,
          key: string,
          action = "send",
          messageId?: string,
          emoji?: string,
          meta?: { responseId: string; chunkIndex: number },
        ) => {
          if (signalWithTimeout.aborted) return;
          this.outbox.queue({
            id: `${runId}:out:${key}`,
            agent_id: a.id,
            run_id: runId,
            response_id: meta?.responseId ?? `${runId}:tool:${key}`,
            chunk_index: meta?.chunkIndex ?? chunk++,
            target,
            action,
            parts,
            message_id: messageId,
            emoji,
          });
        },
      };
      executed = true;
      result = await this.factory(host, llm, record).run({
        agentId: a.id,
        runId,
        context,
        signal: signalWithTimeout,
      });
    } catch (e) {
      result = {
        reason: signalWithTimeout.aborted ? "cancelled" : "error",
        text: "",
        tools: [],
        memoryIds: [],
        error: errorText(e),
      };
    } finally {
      result ??= {
        reason: "error",
        text: "",
        tools: [],
        memoryIds: [],
        error: "No result",
      };
      // Do not persist a second copy of replies already removed from the outbox/history.
      const retainedText = this.db.retainedReplyText(a.id, runId);
      if (signalWithTimeout.aborted) this.db.pruneRunSnapshots(a.id, runId);
      this.db.finish(runId, result.reason, result.error);
      record({
        event_id: runId + ":done",
        type: "run_finished",
        run_id: runId,
        text: JSON.stringify({ ...result, text: retainedText }),
        data: {
          reason: result.reason,
          trigger_ids: batch.map((e) => e.event_id),
        },
      });
      if (result.reason === "error")
        this.outbox.queue({
          id: runId + ":error",
          agent_id: a.id,
          run_id: runId,
          response_id: runId + ":error",
          chunk_index: 0,
          target:
            context?.target ?? batch.at(-1)?.reply_target ?? a.defaultTarget,
          action: "send",
          parts: [
            {
              type: "text",
              text: "这次执行没有完成。请查看控制台的执行记录和日志；已有结果已保留。",
            },
          ],
        });
      if (result.error)
        this.db.log("error", "run", result.error, {
          agent: a.id,
          run_id: runId,
        });
      // Mood follows the fourth-layer run lifecycle, independently of delivery acknowledgement.
      if (
        executed &&
        context &&
        (result.text || result.tools.length || result.reason === "silent")
      ) {
        const captured = context,
          finished = result;
        const job = (this.moodChains.get(a.id) ?? Promise.resolve())
          .then(async () => {
            const items = await memory.items();
            await memory.afterRun(
              runId,
              {
                request: captured.inputText,
                result: finished,
                tools: this.db
                  .runEvents(a.id, runId)
                  .filter((e) => e.type === "tool_result")
                  .map((e) => ({
                    tool: e.data.tool,
                    result: e.text.slice(-4000),
                  })),
              },
              items.filter((m) => finished.memoryIds.includes(m.id)),
            );
          })
          .catch((e) =>
            this.db.log("warn", "mood", errorText(e), { run_id: runId }),
          );
        this.moodChains.set(a.id, job);
        this.background.add(job);
        void job.finally(() => this.background.delete(job));
      }
    }
  }
  async maintain() {
    if (this.maintenanceBusy || this.stopping) return;
    this.maintenanceBusy = true;
    try {
      for (const a of this.cfg.agents.filter((a) => a.enabled)) {
        const cfg = agentConfig(this.cfg, a);
        if (
          !cfg.memory.enabled ||
          Date.now() < (this.maintenanceAt.get(a.id) ?? 0)
        )
          continue;
        this.maintenanceAt.set(
          a.id,
          Date.now() + cfg.memory.pollSeconds * 1000,
        );
        await this.memories.get(a.id)!.updateState(() => {});
        await this.memories
          .get(a.id)!
          .sync(
            cfg.memory.embeddingUpdate === "debounced" &&
              Date.now() -
                (await fs.stat(path.join(this.agentRoot(a.id), "memory.json")))
                  .mtimeMs >=
                cfg.memory.debounceSeconds * 1000,
          );
      }
    } catch (e) {
      this.db.log("warn", "maintenance", errorText(e));
    } finally {
      this.maintenanceBusy = false;
    }
  }
  cancel(agent: string) {
    this.active.get(agent)?.controller.abort(new Error("User cancellation"));
    return { cancelled: !!this.active.get(agent) };
  }
  eraseHistory(agent: string, selected: string[] | "all") {
    if (this.active.has(agent) || this.outbox.isSending(agent))
      throw Object.assign(
        Error("当前 agent 正在执行或发送；先停止并等它结束，再删除记录。"),
        { statusCode: 409 },
      );
    return this.db.eraseEvents(agent, selected);
  }
  clearHistorySummary(agent: string) {
    if (this.active.has(agent))
      throw Object.assign(
        Error("当前 agent 正在执行；请等它结束后再清空摘要。"),
        {
          statusCode: 409,
        },
      );
    this.db.clearSummary(agent);
    return { cleared: true };
  }
  status() {
    const agentModels = Object.fromEntries(
      this.cfg.agents.map((a) => {
        const cfg = agentConfig(this.cfg, a),
          env = this.environments.get(a.id) ?? {};
        return [
          a.id,
          Object.fromEntries(
            Object.entries(cfg.models).map(([k, m]) => [
              k,
              {
                name: m?.name ?? cfg.models.fast.name,
                configured: !!env[m?.apiKeyEnv ?? cfg.models.fast.apiKeyEnv],
              },
            ]),
          ),
        ];
      }),
    );
    return {
      active: [...this.active].map(([agent, x]) => ({
        agent,
        run_id: x.runId,
      })),
      channels: this.registry.status,
      models: agentModels[this.cfg.agents[0].id],
      agent_models: agentModels,
    };
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.maintenance);
    const indexing = [...this.memories.values()].map((memory) =>
      memory.close(),
    );
    for (const x of this.active.values())
      x.controller.abort(new Error("Shutdown"));
    await Promise.allSettled([...this.active.values()].map((x) => x.promise));
    await this.outbox.stop();
    await this.registry.stop();
    await Promise.allSettled(this.background);
    await Promise.allSettled(indexing);
    while (this.maintenanceBusy) await new Promise((r) => setTimeout(r, 50));
  }
}
