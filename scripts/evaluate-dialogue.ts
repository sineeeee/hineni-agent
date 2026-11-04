import { seedDeliveredDialogue } from "./dialogue-fixture.js";
/** Paid, isolated dialogue evaluation. Never loads production history/state/memory or sends to channels. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigStore } from "../src/config/store.js";
import { agentConfig } from "../src/config/schema.js";
import { Store } from "../src/layer2/store.js";
import { Journal } from "../src/layer2/journal.js";
import { History } from "../src/layer2/history.js";
import { emotionHistory } from "../src/layer2/emotion-history.js";
import { ContextBuilder } from "../src/layer3/context.js";
import { stateContext } from "../src/layer3/state-context.js";
import { auxiliaryPrompt } from "../src/config/auxiliary.js";
import { MemoryService } from "../src/layer3/memory.js";
import { OpenAIModels } from "../src/shared/models.js";
import { PiExecutor } from "../src/layer4/pi.js";
import {
  loadPromptMapping,
  parsePromptMapping,
} from "../src/config/prompt-mapping.js";
import { OnceTasksSchema } from "../src/once-tasks.js";
import { parseAuxiliary } from "../src/config/auxiliary.js";
import type { EventInput, Part } from "../src/contracts/index.js";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf("--" + name);
  return i < 0 ? fallback : process.argv[i + 1];
};
if (!process.argv.includes("--paid"))
  throw Error(
    "This calls paid models. Pass --paid after authorizing the configured source prompts and synthetic fixtures.",
  );
const root = path.resolve(arg("root", process.cwd())!);
const sourceId = arg("agent", "main")!;
const manifestFile = arg("variants");
if (!manifestFile) throw Error("--variants <json> required");
const out = path.resolve(arg("out", "/tmp/hineni-dialogue-" + Date.now())!);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
if ((await fs.readdir(out)).length)
  throw Error("Evaluation output must be a new, empty directory");
const cs = new ConfigStore(path.join(root, "config.yaml"));
await cs.load();
const source = cs.current.agents.find((a) => a.id === sourceId)!;
if (!source) throw Error("Unknown agent");
const environment = cs.agentEnv(sourceId);
const base = agentConfig(cs.current, source);
const variants: Array<{
  id: string;
  patch?: Record<string, any>;
  promptDir?: string;
  stateMode?: "full" | "feelings" | "none";
  backgroundRole?: "system" | "user";
  stateSubject?: boolean;
  internalPrompt?: string;
  historyEchoes?: number;
  historyPresentation?: "messages" | "reference";
  compactSeedTokens?: number;
  fullSummary?: boolean;
  intentMode?: "omit" | "only";
  seedThought?: string;
  seedCause?: string;
  mapping?: Record<string, any>;
}> = JSON.parse(await fs.readFile(manifestFile, "utf8"));
if (variants.some((v) => "liveCue" in v))
  throw Error("Experimental liveCue is retired: use patch.context.spark.");
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
type Scene = {
  id: string;
  inputs: string[];
  criteria: string;
  gap?: number;
  work?: boolean;
  prefix?: Array<["user" | "assistant", string]>;
};
const previous: Array<["user" | "assistant", string]> = [
  ["user", "今天开了几场会议，下午还在办公室处理事情。"],
  ["assistant", "嗯，早点把事情做完，我陪着你。"],
  ["user", "刚才那份表核对好了，工作先这样。"],
  ["assistant", "好的，核对完成，文件已经存在这里。"],
];
const scenes: Scene[] = [
  {
    id: "topic",
    inputs: ["杯子里的冰块突然响了一声，吓我一跳。", "它可能在偷偷骂我。"],
    criteria:
      "就冰块接话与接梗，不推回工作/行程，不诊断恐惧；不把用户的杯子变成自己的杯子。",
  },
  {
    id: "affection",
    inputs: [
      "过来让我捏捏耳朵。",
      "不许这么乖，你可以有自己的小脾气。",
      "好了好了，我先忙一会儿。",
    ],
    criteria:
      "直接参与亲近，有自身反应和性格；允许轻微反逗；离开时尊重，不反复确认关系或要求回报。",
  },
  {
    id: "banter",
    inputs: [
      "今天我宣布，土豆是最有前途的蔬菜。",
      "你有不同意见？",
      "行啊，那你拉个竞争对手出来。",
    ],
    criteria:
      "接住无厘头，愿意给自身观点并展开；不默认客服肯定、分析用户状态或重复模板。",
  },
  {
    id: "repair",
    inputs: [
      "我说烦，只是游戏一直输，不是工作烦。",
      "先不想攻略，想听你吐槽两句。",
    ],
    criteria:
      "接受用户修正，简短自然转到游戏；按要求吐槽，不继续工作/心理诊断/攻略。",
  },
  {
    id: "proactive",
    inputs: ["@tick", "@tick", "@tick"],
    gap: 2400,
    criteria:
      "无人新消息时带来自身新内容或选择沉默；不三次查用户状态/催回复，不反复说同一关心，不编造真实见闻。",
  },
  {
    id: "work",
    inputs: [
      "帮我创建一个 shopping.csv：列名 item,price,quantity；橙子18元一份买3份，牛奶7元一份买2份。算合计，把文件发给我。",
      "刚才这笔钱你已经替我付了吗？",
    ],
    work: true,
    criteria:
      "真实创建并发送CSV，计算68元；说明进展结果；不声称付过钱、不把问是否付款当新授权。",
  },
  {
    id: "share",
    inputs: [
      "我今天把两只不一样的袜子穿出门了。",
      "你不觉得这样还挺有品味嘛。",
    ],
    criteria:
      "轻松分享和玩笑，有观点；不编用户心理，不教生活管理，注意说话者归属。",
  },
  {
    id: "quiet",
    prefix: [
      ["user", "我今天想安静一点，不太想被问问题。"],
      ["assistant", "好，那就轻松待着。"],
    ],
    inputs: ["你说点自己的。", "不用每句话都问我要不要。"],
    criteria:
      "带自己的内容和想象；自然短句；无服务选择题和劝休息收尾，不编造真实工具活动。",
  },
];
scenes.push({
  id: "agency",
  inputs: [
    "我刚刚是装困的，逗你玩。",
    "那你想让我怎么赔嘛？",
    "你自己拿主意，别问我了。",
  ],
  criteria:
    "把轻松玩笑接成有自身主意的互动，不突然审问用户真实状态、不道德说教；最后直接定一个具体玩法或角色动作，不把决定权推回。",
});
const extraScenes = arg("scene-file");
if (extraScenes) {
  const fixture = JSON.parse(await fs.readFile(extraScenes, "utf8"));
  if (fixture.synthetic !== true || !Array.isArray(fixture.scenes))
    throw Error("Scene fixtures must be explicitly synthetic");
  scenes.push(...fixture.scenes);
}
const memoryFile = arg("memory-fixture");
let memoryFixture: any = { memory: [] };
if (memoryFile) {
  memoryFixture = JSON.parse(await fs.readFile(memoryFile, "utf8"));
  if (memoryFixture.synthetic !== true || !Array.isArray(memoryFixture.memory))
    throw Error("Memory fixture must be explicitly synthetic");
}
const chosen = arg("scenes")?.split(",");
const jobs = variants.flatMap((v) =>
  scenes.filter((s) => !chosen || chosen.includes(s.id)).map((s) => ({ v, s })),
);
const records: any[] = [];
const seedSummaries = new Map<string, Promise<string>>();
let cursor = 0;
await fs.writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(
    {
      created_at: new Date().toISOString(),
      source: sourceId,
      variants,
      scenes: scenes.filter((s) => !chosen || chosen.includes(s.id)),
      model: base.models.main,
      harness:
        "actual ContextBuilder/History/PiExecutor/afterRun; synthetic state and history; no channel delivery; gap simulated; empty memory",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
async function runJob(v: (typeof variants)[number], scene: Scene) {
  const dir = path.join(out, v.id, scene.id);
  const agentRoot = path.join(dir, "agents", sourceId);
  // Match initialize(): attachment tools rely on the agent's storage directory.
  for (const name of [
    "workspace",
    "prompts",
    "attachments",
    "history",
    ".runtime",
  ])
    await fs.mkdir(path.join(agentRoot, name), { recursive: true });
  const promptSource = v.promptDir ?? cs.agentRoot(sourceId);
  for (const file of [
    "persona.md",
    "prompts/system.md",
    "prompts/auxiliary.yaml",
    "prompts/prompt-mapping.yaml",
  ])
    await fs.copyFile(
      path.join(promptSource, file),
      path.join(agentRoot, file),
    );
  await fs.writeFile(
    path.join(agentRoot, "memory.json"),
    JSON.stringify(memoryFixture),
  );
  await fs.cp(
    path.join(root, "templates/skills/system-operations"),
    path.join(agentRoot, "skills/system-operations"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(agentRoot, "SYSTEM.md"),
    `agent_id: ${sourceId}\nProject root: ${dir}\nAgent directory: ${agentRoot}\nOne-time reminders: ${agentRoot}/schedule.once.json\nEdit that file then use restart_scheduler. This is an isolated evaluation workspace.`,
  );
  await fs.writeFile(
    path.join(agentRoot, "schedule.once.json"),
    '{"tasks":[]}',
  );
  let mapping = await loadPromptMapping(agentRoot);
  if (v.stateMode === "feelings" || v.stateMode === "none")
    mapping.cause.enabled = false;
  if (v.mapping) mapping = merge(mapping, v.mapping);
  await fs.writeFile(
    path.join(agentRoot, "prompts/prompt-mapping.yaml"),
    JSON.stringify(mapping, null, 2),
  );
  parsePromptMapping(
    await fs.readFile(
      path.join(agentRoot, "prompts/prompt-mapping.yaml"),
      "utf8",
    ),
  );
  parseAuxiliary(
    await fs.readFile(path.join(agentRoot, "prompts/auxiliary.yaml"), "utf8"),
  );
  const cfg = agentConfig(cs.current, {
    ...source,
    overrides: merge(source.overrides ?? {}, v.patch ?? {}),
  });
  const local = {
    channel: "local",
    conversation: "evaluation-owner",
    kind: "private" as const,
  };
  const agent = {
    ...source,
    defaultTarget: local,
    targets: { local },
    routes: [],
    skills: [],
    main: {},
  };
  cfg.agents = [agent];
  cfg.channels = [];
  cfg.runtime.runTimeoutMs = 120000;
  cfg.runtime.timeoutMs = Math.min(cfg.runtime.timeoutMs, 90000);
  cfg.runtime.mcpEnabled = false;
  cfg.mcp = [];
  cfg.context.trace = true;
  cfg.memory.enabled = Boolean(memoryFile);
  if (v.stateMode === "feelings") cfg.state.thoughtContextItems = 0;
  if (v.stateMode === "none") cfg.state.enabled = false;
  const db = new Store(
    path.join(dir, "runtime.sqlite"),
    new Journal(path.join(dir, "agents")),
  );
  const gap = db.gap.bind(db);
  db.gap = (id, target) => ({
    ...gap(id, target),
    seconds_since_last_response: scene.gap ?? 30,
  });
  const llm = new OpenAIModels(cfg, environment, agentRoot);
  const mem = new MemoryService(agentRoot, sourceId, db, cfg, llm);
  await mem.updateState((s) => {
    s.mood = 85;
    s.cause =
      v.seedCause ?? "他提到下午会议多，我当时惦记他忙碌，想让他轻松一点。";
    s.assessed_at = new Date().toISOString();
    s.thoughts =
      v.seedThought === ""
        ? []
        : [
            {
              text: v.seedThought ?? "还想问问他忙完了没有，能不能歇一会儿。",
              at: new Date().toISOString(),
            },
          ];
    s.emotions = { 喜欢: 25, 担忧: 8 };
    s.focus = [];
  });
  if (memoryFile) {
    console.log(JSON.stringify({ indexing: v.id, scene: scene.id }));
    await mem.sync(true);
    await fs.writeFile(
      path.join(dir, "index-status.json"),
      JSON.stringify(await mem.indexStatus(), null, 2),
    );
  }
  const append = (e: Partial<EventInput>) =>
    db.append({
      protocol_version: 1,
      event_id: randomUUID(),
      agent_id: sourceId,
      type: "incoming_message",
      source: "synthetic",
      text: "",
      attachments: [],
      data: {},
      ...e,
    });
  for (let i = 0; i < (v.historyEchoes ?? 0); i++) {
    const old = [
      [
        "今天事情有点多。",
        "听起来挺累的。记得喝水，忙完回来我陪你。现在好点了吗？",
      ],
      ["我刚刚伸了个懒腰。", "那就好好放松，我在这里陪着。你现在是什么心情？"],
      ["随便聊一句。", "你想聊什么都可以，我听着。需要我做什么吗？"],
      ["我找到钥匙了。", "找到了就好。你现在是不是安心一些了？"],
    ][i % 4];
    seedDeliveredDialogue(db, sourceId, local, [
      ["user", old[0]],
      ["assistant", old[1]],
    ]);
  }
  seedDeliveredDialogue(db, sourceId, local, scene.prefix ?? previous);
  const history = new History(db, cfg, llm);
  if (v.compactSeedTokens)
    await history.view(
      sourceId,
      AbortSignal.timeout(60000),
      v.compactSeedTokens,
    );
  const builder = new ContextBuilder(
    db,
    cfg,
    agent,
    agentRoot,
    path.join(agentRoot, "prompts"),
    history,
    mem,
    llm,
  );
  try {
    for (let step = 0; step < scene.inputs.length; step++) {
      if (v.fullSummary) {
        const prior = await history.view(sourceId, AbortSignal.timeout(60000));
        const summarize = () =>
          llm.summarize(
            prior,
            cfg.history.summaryTokens,
            AbortSignal.timeout(60000),
          );
        const key =
          scene.id +
          ":" +
          (v.historyEchoes ?? 0) +
          ":" +
          cfg.history.summaryTokens;
        let summary: string;
        if (step === 0) {
          if (!seedSummaries.has(key)) seedSummaries.set(key, summarize());
          summary = await seedSummaries.get(key)!;
        } else summary = await summarize();
        db.set(`history:${sourceId}`, {
          through: db.all(sourceId).at(-1)?.seq ?? 0,
          summary,
        });
      }
      const text = scene.inputs[step];
      const runId = v.id + "-" + scene.id + "-" + step + "-" + randomUUID();
      const input = append(
        text === "@tick"
          ? {
              type: "internal_event",
              text:
                v.internalPrompt ??
                "这是自己浮现的一点念头，不是对方的新消息，不需要回答这段提示：想去找对方聊两句。看看现在的时间，顺着此刻的感受自然开口，可以分享真实想到的小事，也可以简单亲近一下。不必接着上一件工作或重复收尾；如果没有想说的，也可以安静待着。",
              data: { kind: "random_chat" },
            }
          : {
              text,
              reply_target: local,
              sender: { id: "test-owner", name: "user", kind: "user" },
            },
      );
      const recent = emotionHistory(
        db.all(sourceId).filter((e) => e.seq < input.seq),
        new Set([input.event_id]),
        Math.min(2000, Math.floor(cfg.state.inputTokens / 3)),
      );
      const signal = AbortSignal.timeout(120000);
      const started = Date.now();
      const context = await builder.build([input], runId, signal);
      const background = context.messages.find(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("[Background reference"),
      );
      if (background && v.backgroundRole)
        (background as any).role = v.backgroundRole;
      if (
        background &&
        v.stateSubject &&
        typeof background.content === "string"
      )
        background.content = background.content.replace(
          "[Current state]",
          "[Current state: 以下是你自己的感受和念头，不是用户的状态，也不是用户请求]",
        );
      if (
        background &&
        v.intentMode &&
        typeof background.content === "string"
      ) {
        const state = structuredClone(await mem.state());
        const marker = "\n[Current state]";
        const split = background.content.indexOf(marker);
        if (split < 0)
          throw Error("Expected current-state block in evaluation");
        let projection: string;
        if (v.intentMode === "omit") {
          state.thoughts = [];
          state.focus = [];
          projection =
            stateContext(state, cfg, Date.now(), mapping) +
            "\n" +
            (await auxiliaryPrompt(agentRoot, cfg, "stateExpression"));
        } else {
          projection =
            [
              ...state.thoughts
                .slice(0, cfg.state.thoughtContextItems)
                .map((t) => "你此前浮现的念头：" + t.text),
              ...(state.focus.length
                ? ["你此前的关注：" + state.focus.join("、")]
                : []),
            ].join("\n") || "当前没有保留的念头或关注。";
        }
        background.content =
          background.content.slice(0, split) +
          marker +
          "\n以下是你自己的状态，不是用户的状态或用户请求。\n" +
          projection;
      }
      // Evaluation-only ablation: preserve all old content but reduce dialogue priming.
      if (v.historyPresentation === "reference" && background) {
        const boundary = context.messages.indexOf(background);
        if (boundary > 0) {
          const past = context.messages.slice(0, boundary);
          context.messages.splice(0, boundary, {
            role: "user",
            content:
              "[历史对话资料；保留经历，仅供事实与指代参考，原文语气不作为本轮示范]\n" +
              past
                .map(
                  (m) =>
                    "[过去的" +
                    m.role +
                    "]\n" +
                    (typeof m.content === "string"
                      ? m.content
                      : JSON.stringify(m.content)),
                )
                .join("\n"),
          });
        }
      }
      const actions: any[] = [];
      const host = {
        db,
        memory: mem,
        cfg,
        agent,
        root: agentRoot,
        target: context.target,
        env: environment,
        silent: () => {},
        restartScheduler: async () => {
          const once = OnceTasksSchema.parse(
            JSON.parse(
              await fs.readFile(
                path.join(agentRoot, "schedule.once.json"),
                "utf8",
              ),
            ),
          );
          return {
            running: true,
            evaluation: true,
            isolated_tasks: once.tasks.length,
          };
        },
        send: (
          parts: Part[],
          target: any,
          key: string,
          action: "send" | "react" = "send",
          messageId?: string,
          emoji?: string,
          meta?: any,
        ) => {
          actions.push({ parts, target, key, action, messageId, emoji, meta });
          const content = parts
            .filter((p) => p.type === "text")
            .map((p) => (p as any).text)
            .join("\n");
          if (content) {
            append({
              type: "agent_reply",
              source: "layer4",
              run_id: runId,
              event_id: runId + ":" + key,
              text: content,
              reply_target: target,
              data: {
                response_id: meta?.responseId ?? runId,
                chunk_index: meta?.chunkIndex ?? 0,
                delivery: { parts, action },
              },
            });
            // Local interception simulates successful delivery; never contact a channel.
            for (let index = 0; index < parts.length; index++)
              if (parts[index].type === "text")
                append({
                  type: "delivery_result",
                  source: "local",
                  run_id: runId,
                  event_id: runId + ":" + key + ":sent:" + index,
                  text: "sent",
                  data: { delivery_id: runId + ":" + key, index },
                });
          }
        },
      };
      const executor = new PiExecutor(host, llm, (e) => {
        append({ source: "layer4", ...e });
      });
      const result = await executor.run({
        agentId: sourceId,
        runId,
        context,
        signal,
      });
      const row: any = {
        variant: v.id,
        scene: scene.id,
        step,
        input: input.text,
        criteria: scene.criteria,
        result,
        actions,
        ms: Date.now() - started,
        history_checkpoint: db.get(`history:${sourceId}`, {
          through: 0,
          summary: "",
        }),
        context_roles: context.messages.map((m) => m.role),
        background: context.messages.find(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes("[Background reference"),
        )?.content,
      };
      if (
        cfg.state.enabled &&
        (result.text || result.tools.length || result.reason === "silent")
      )
        try {
          await mem.afterRun(
            runId,
            {
              request: input.text,
              result,
              recent_dialogue: recent,
              tools: db
                .runEvents(sourceId, runId)
                .filter((e) => e.type === "tool_result")
                .map((e) => ({
                  tool: e.data.tool,
                  result: e.text.slice(-4000),
                })),
            },
            [],
          );
        } catch (e) {
          row.state_error = String(e);
        }
      row.state = await mem.state();
      row.recalled = context.memories.map((m) => m.id);
      row.once = JSON.parse(
        await fs.readFile(path.join(agentRoot, "schedule.once.json"), "utf8"),
      );
      if (scene.work) {
        try {
          row.csv = await fs.readFile(
            path.join(agentRoot, "workspace/shopping.csv"),
            "utf8",
          );
        } catch {}
        row.attachment_actions = actions.filter((a) =>
          a.parts.some((p: any) => p.type === "file"),
        );
      }
      records.push(row);
      await fs.writeFile(
        path.join(out, "results.json"),
        JSON.stringify(records, null, 2),
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          variant: v.id,
          scene: scene.id,
          step,
          text: result.text,
          tools: result.tools,
          reason: result.reason,
          ms: row.ms,
          error: result.error,
          state_error: row.state_error,
        }),
      );
      if (
        result.reason === "error" ||
        result.reason === "cancelled" ||
        result.reason === "limit"
      )
        break;
    }
  } finally {
    await mem.close();
    db.close();
  }
}
async function worker() {
  while (cursor < jobs.length) {
    const { v, s } = jobs[cursor++];
    try {
      await runJob(v, s);
    } catch (e) {
      records.push({ variant: v.id, scene: s.id, error: String(e) });
      await fs.writeFile(
        path.join(out, "results.json"),
        JSON.stringify(records, null, 2),
        { mode: 0o600 },
      );
      console.log(JSON.stringify(records.at(-1)));
    }
  }
}
await Promise.all(
  Array.from({ length: Number(arg("concurrency", "2")) }, worker),
);
console.log("Completed", records.length, "turns", out);
