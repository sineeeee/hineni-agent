import { z } from "zod";
import { TargetSchema } from "../contracts/index.js";
const flag = (d = true) => z.boolean().default(d);
const n = (d: number, min = 0) => z.number().min(min).default(d);
const model = z
  .object({
    protocol: z.enum(["responses", "chat-completions"]).default("responses"),
    baseUrl: z.string().url().default("https://api.openai.com/v1"),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    name: z.string().default("gpt-4.1"),
    contextWindow: n(1_047_576, 100_000),
    maxOutput: n(8192, 1),
    reasoning: z
      .enum(["off", "minimal", "low", "medium", "high"])
      .default("off"),
    compat: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const ConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    dataDir: z.string().default("data"),
    agentsDir: z.string().default("agents"),
    server: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: n(8787, 1),
        adminPort: n(8788, 1),
        tokenEnv: z.string().default("HINENI_TOKEN"),
      })
      .strict()
      .default(() => ({
        host: "127.0.0.1",
        port: 8787,
        adminPort: 8788,
        tokenEnv: "HINENI_TOKEN",
      })),
    models: z
      .object({
        main: model.default(() => model.parse({})),
        fast: model.default(() =>
          model.parse({ name: "gpt-4.1-mini", maxOutput: 2000 }),
        ),
        embedding: model.default(() =>
          model.parse({ name: "text-embedding-3-small", maxOutput: 1 }),
        ),
        query: model.partial().optional(),
        maintenance: model.partial().optional(),
        emotion: model.partial().optional(),
        rerank: model.partial().optional(),
      })
      .strict()
      .default(() => ({
        main: model.parse({}),
        fast: model.parse({ name: "gpt-4.1-mini", maxOutput: 2000 }),
        embedding: model.parse({
          name: "text-embedding-3-small",
          maxOutput: 1,
        }),
      })),
    history: z
      .object({
        triggerTokens: n(600000, 1000),
        targetTokens: n(350000, 500),
        summaryTokens: n(12000, 100),
        toolTailTokens: n(200, 20),
        pollMs: n(500, 50),
      })
      .strict()
      .default(() => ({
        triggerTokens: 600000,
        targetTokens: 350000,
        summaryTokens: 12000,
        toolTailTokens: 200,
        pollMs: 500,
      })),
    context: z
      .object({
        layer3Tokens: n(32000, 1000),
        memoryTokens: n(20000, 200),
        stateTokens: n(1000, 100),
        safetyTokens: n(16384, 100),
        trace: flag(),
      })
      .strict()
      .default(() => ({
        layer3Tokens: 32000,
        memoryTokens: 20000,
        stateTokens: 1000,
        safetyTokens: 16384,
        trace: true,
      })),
    memory: z
      .object({
        enabled: flag(),
        queryRecentMessages: n(8, 1),
        queryInputTokens: n(2500, 100),
        queryTimeoutMs: n(2500, 100),
        queryCacheSeconds: n(60),
        recallTimeoutMs: n(1500, 100),
        rrfK: n(60, 1),
        vectorThreshold: n(0.18),
        diversityPenalty: n(0.15),
        summaryTokens: n(160, 20),
        temporalNeighbors: n(2),
        temporalWindowHours: n(24),
        associationTokens: n(250, 20),
        activationEnabled: flag(),
        activationMaxItems: n(12, 1),
        emotionHalfLifeDays: n(7, 1),
        descriptionTokens: n(120, 10),
        debounceSeconds: n(120),
        maintenanceTimeoutMs: n(60000, 1000),
        maintenanceAttempts: n(3, 1),
        maintenanceBatchItems: n(20, 1),
        toolsEnabled: flag(),
        toolPageTokens: n(3000, 100),
        toolReadTokens: n(4000, 100),
        toolPageItems: n(10, 1),
        reviewOverlap: n(4),
        smallDetailProbability: n(0.15),
        smallDetailMax: n(1),
        noveltyAttention: flag(),
        query: flag(),
        rerank: flag(),
        searchDescription: flag(),
        maxItems: n(12, 1),
        detailsItems: n(6),
        detailsTokens: n(2000, 20),
        candidates: n(40, 1),
        queryDirections: n(3, 1),
        baseHalfLifeDays: n(30, 1),
        importanceMultiplier: n(2),
        reinforcementGain: n(0.2),
        activationHalfLifeMinutes: n(30, 1),
        activationTtlHours: n(3, 1),
        associationProbability: z.number().min(0).max(1).default(0.2),
        associationCooldown: n(8),
        pollSeconds: n(300, 10),
        embeddingUpdate: z.enum(["daily", "debounced"]).default("daily"),
        sleepCron: z.string().default("0 3 * * *"),
        reviewEnabled: flag(),
        reviewBatchTokens: n(12000, 1000),
        maxReviewItems: n(8, 1),
        chunkTokens: n(800, 100),
        chunkOverlap: n(80),
        rankWeights: z
          .object({
            base: n(0.5),
            strength: n(0.15),
            importance: n(0.15),
            familiarity: n(0.05),
            emotion: n(0.05),
            activation: n(0.1),
          })
          .default(() => ({
            base: 0.5,
            strength: 0.15,
            importance: 0.15,
            familiarity: 0.05,
            emotion: 0.05,
            activation: 0.1,
          })),
      })
      .strict()
      .default(() => ({}) as any),
    state: z
      .object({
        enabled: flag(),
        emotionLabels: z
          .array(z.string())
          .default(["愉快", "安心", "好奇", "担忧", "失落", "烦躁"]),
        eventSensitivity: n(1),
        surpriseMax: n(1.5),
        repeatedStimulusMultiplier: n(0.5),
        reportChars: n(120, 10),
        thoughtContextItems: n(1),
        thoughtContextTokens: n(300, 20),
        thoughtHalfLifeHours: n(6, 1),
        focusMax: n(2),
        focusTtlHours: n(24, 1),
        baseline: n(70),
        moodHalfLifeHours: n(12, 1),
        emotionHalfLifeMinutes: n(90, 1),
        moodDeltaLimit: n(3),
        dimensionDeltaLimit: n(5),
        inputTokens: n(6000, 500),
        timeoutMs: n(10000, 100),
        thoughtsMax: n(3),
        thoughtTtlHours: n(24, 1),
        gap: flag(),
      })
      .strict()
      .default(() => ({}) as any),
    style: z
      .object({
        casualParts: n(3, 1),
        emotionExpression: n(0.35),
        restraint: n(0.6),
        catchphraseCooldown: n(5),
        memoryMentions: n(1),
        repeatMemoryCooldown: n(8),
        allowShortAck: flag(),
        casualChars: n(150, 10),
        casualSentences: n(3, 1),
        warmth: n(0.6),
        humor: n(0.3),
        directness: n(0.7),
      })
      .strict()
      .default(() => ({}) as any),
    runtime: z
      .object({
        mcpConnectTimeoutMs: n(30000, 100),
        shellMaxTimeoutMs: n(1800000, 1000),
        backend: z.literal("pi").default("pi"),
        maxRounds: n(50, 1),
        timeoutMs: n(300000, 1000),
        runTimeoutMs: n(3600000, 1000),
        toolTimeoutMs: n(120000, 1000),
        toolsEnabled: flag(),
        skillsEnabled: flag(),
        mcpEnabled: flag(),
        webEnabled: flag(),
        cancelGraceMs: n(5000, 100),
        maxToolChars: n(16000, 100),
      })
      .strict()
      .default(() => ({}) as any),
    delivery: z
      .object({
        typing: flag(),
        initialDelayMs: n(0),
        partIntervalMs: n(0),
        split: z
          .enum(["platform", "paragraph", "sentence"])
          .default("platform"),
        attempts: n(3, 1),
      })
      .strict()
      .default(() => ({}) as any),
    scheduler: z
      .object({
        enabled: flag(),
        script: z.string().default("schedule.ts"),
        timezone: z.string().default("Asia/Shanghai"),
        randomChat: flag(),
        randomMinMinutes: n(60, 1),
        randomMaxMinutes: n(180, 1),
        activeStart: n(8),
        activeEnd: n(22),
        dreamCron: z.string().default("0 4 * * 0"),
        dreamEnabled: flag(),
      })
      .strict()
      .default(() => ({}) as any),
    prompts: z.record(z.string(), z.string()).default({}),
    drives: z
      .record(
        z.string(),
        z.object({
          enabled: flag(),
          baseline: n(50),
          halfLifeHours: n(6, 0.1),
          sensitivity: n(1),
          min: n(0),
          max: n(100),
        }),
      )
      .default(() =>
        Object.fromEntries(
          Object.entries({
            curiosity: [55, 6],
            social: [40, 6],
            responsibility: [50, 12],
            introspection: [30, 12],
            missing: [20, 12],
            closeness: [20, 12],
            fatigue: [10, 3],
            stress: [10, 6],
            joy: [60, 6],
          }).map(([k, [baseline, halfLifeHours]]) => [
            k,
            {
              enabled: true,
              baseline,
              halfLifeHours,
              sensitivity: 1,
              min: 0,
              max: 100,
            },
          ]),
        ),
      ),
    channels: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.enum(["telegram", "webhook"]),
            enabled: flag(),
            tokenEnv: z.string().optional(),
            url: z.string().url().optional(),
            secretEnv: z.string().optional(),
            allowedChats: z.array(z.string()).default([]),
            maxFileBytes: n(20 * 1024 * 1024, 1),
          })
          .strict(),
      )
      .default([]),
    agents: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            name: z.string(),
            enabled: flag(),
            defaultTarget: TargetSchema,
            targets: z.record(z.string(), TargetSchema).default({}),
            routes: z.array(TargetSchema).default([]),
            skills: z.array(z.string()).default([]),
            main: model.partial().optional(),
            overrides: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1),
    mcp: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
            enabled: flag(),
            command: z.string().optional(),
            args: z.array(z.string()).default([]),
            url: z.string().url().optional(),
            env: z.record(z.string(), z.string()).default({}),
            headersEnv: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export type AgentConfig = Config["agents"][number];
export function parseConfig(raw: unknown): Config {
  // Parse twice to apply child defaults when an entire optional group was omitted.
  const c = ConfigSchema.parse(ConfigSchema.parse(raw));
  if (c.history.targetTokens >= c.history.triggerTokens)
    throw Error("history.targetTokens must be below triggerTokens");
  if (c.context.memoryTokens + c.context.stateTokens > c.context.layer3Tokens)
    throw Error("context budgets exceed layer3Tokens");
  if (c.server.port === c.server.adminPort)
    throw Error("API and admin ports must differ");
  for (const list of [c.agents, c.channels])
    if (new Set(list.map((x) => x.id)).size !== list.length)
      throw Error("duplicate id");
  if (c.scheduler.randomMaxMinutes < c.scheduler.randomMinMinutes)
    throw Error("invalid random interval");
  for (const server of c.mcp)
    if (server.enabled && Boolean(server.command) === Boolean(server.url))
      throw Error("MCP needs exactly one command or URL");
  for (const d of Object.values(c.drives))
    if (d.min > d.baseline || d.baseline > d.max)
      throw Error("Invalid drive bounds");
  if (
    c.history.summaryTokens +
      c.models.main.maxOutput +
      c.context.safetyTokens >=
    c.models.main.contextWindow
  )
    throw Error("旧摘要预算、模型输出和安全余量之和必须小于主模型上下文容量");
  if (c.memory.chunkOverlap >= c.memory.chunkTokens)
    throw Error("invalid memory chunk overlap");
  for (const a of c.agents)
    for (const t of [a.defaultTarget, ...a.routes, ...Object.values(a.targets)])
      if (!c.channels.some((ch) => ch.id === t.channel))
        throw Error(`unknown channel ${t.channel}`);
  for (const key of ["port", "adminPort"] as const)
    if (!Number.isInteger(c.server[key]) || c.server[key] > 65535)
      throw Error("Invalid server port");
  for (const m of [c.models.main, c.models.fast])
    if (m.maxOutput + c.context.safetyTokens >= m.contextWindow)
      throw Error("Output reserve exceeds model capacity");
  if (
    c.scheduler.activeStart >= 24 ||
    c.scheduler.activeEnd > 24 ||
    c.scheduler.activeStart >= c.scheduler.activeEnd
  )
    throw Error("Active hours must be within 0–24 and start before end");
  for (const a of c.agents)
    for (const k of Object.keys(a.overrides))
      if (
        ![
          "models",
          "history",
          "context",
          "memory",
          "state",
          "style",
          "runtime",
          "delivery",
          "prompts",
          "drives",
          "scheduler",
          "mcp",
        ].includes(k)
      )
        throw Error("Invalid agent override: " + k);
  return c;
}

export function agentConfig(config: Config, agent: AgentConfig): Config {
  const allowed = new Set([
    "models",
    "history",
    "context",
    "memory",
    "state",
    "style",
    "runtime",
    "delivery",
    "prompts",
    "drives",
    "scheduler",
    "mcp",
  ]);
  const merge = (a: any, b: any): any =>
    Object.fromEntries(
      Object.keys({ ...a, ...b }).map((k) => [
        k,
        b[k] === undefined
          ? a[k]
          : b[k] && typeof b[k] === "object" && !Array.isArray(b[k])
            ? merge(a[k] ?? {}, b[k])
            : b[k],
      ]),
    );
  for (const k of Object.keys(agent.overrides))
    if (!allowed.has(k)) throw Error("Invalid agent override: " + k);
  const merged = merge(config, agent.overrides);
  if (agent.main) merged.models.main = { ...merged.models.main, ...agent.main };
  return parseConfig(merged);
}
