import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseConfig } from "../src/config/schema.js";
import { Store } from "../src/layer2/store.js";
import { History } from "../src/layer2/history.js";
import { MemoryService } from "../src/layer3/memory.js";
import { ContextBuilder } from "../src/layer3/context.js";
import { contextPreview } from "../src/admin/context-preview.js";
import {
  assembleSystem,
  assembleBackground,
} from "../src/layer3/prompt-assembly.js";
import {
  stateContext,
  stateContextSteps,
} from "../src/layer3/state-context.js";
import { promptMappingDefaults } from "../src/config/prompt-mapping.js";
import type { Runtime } from "../src/layer2/runtime.js";
import type { Event } from "../src/contracts/index.js";
import type { Intelligence } from "../src/shared/models.js";
import { client } from "../src/admin/ui-client.js";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hineni-flow-test-"));
  await fs.mkdir(path.join(root, "prompts"));
  await fs.mkdir(path.join(root, "skills", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(root, "persona.md"),
    "你有自己的性格。喜欢亲近，也能认真做事。",
  );
  await fs.writeFile(
    path.join(root, "prompts/system.md"),
    "运行于Hineni，使用真实工具，如实交付。",
  );
  await fs.writeFile(
    path.join(root, "skills/demo/SKILL.md"),
    "---\nname: demo\ndescription: 测试技能，先阅读再使用。\n---\n此正文不应自动加入Prompt。",
  );
  const cfg = parseConfig({
    channels: [{ id: "local", type: "webhook" }],
    agents: [
      {
        id: "main",
        name: "Main",
        defaultTarget: { channel: "local", conversation: "owner" },
      },
    ],
    memory: {
      associationProbability: 0,
      temporalNeighbors: 0,
      searchDescription: false,
    },
    context: { spark: true, sparkProbability: 1, trace: false },
    state: {
      thoughtContextProbability: 1,
      thoughtContextItems: 1,
      focusContextProbability: 1,
      focusMax: 1,
    },
  });
  const db = new Store(path.join(root, "runtime.sqlite"));
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const now = Date.now();
  await fs.writeFile(
    path.join(root, "memory.json"),
    JSON.stringify({
      memory: [
        {
          id: "noodle",
          occurred_at: new Date(now - 86400000).toISOString(),
          summary: "拉面店",
          details: "喜欢清汤",
          importance: 4,
          people: ["owner"],
          emotion: { labels: ["愉快"], intensity: 0.9 },
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(root, "state.json"),
    JSON.stringify({
      updated_at: new Date(now - 3600000).toISOString(),
      assessed_at: new Date(now - 3600000).toISOString(),
      mood: 90,
      emotions: { 愉快: 30, 安心: 0 },
      drives: { curiosity: 80 },
      cause: "旧感受",
      thoughts: [{ text: "想接着玩", at: new Date(now).toISOString() }],
      focus: ["旧关注"],
      focus_updated_at: new Date(now).toISOString(),
      activation: {},
    }),
  );
  const calls: string[] = [];
  const llm: Intelligence = {
    json: async (_s, _i, _a, p) => {
      calls.push(p ?? "query");
      if (p === "spark") return { spark: "想象一只纸碗偷偷长出耳朵。" };
      if (p === "query") return { queries: ["拉面经历"] };
      return { ids: ["noodle"] };
    },
    embed: async (texts) => {
      calls.push("embedding");
      return texts.map(() => [1, 0]);
    },
    summarize: async () => {
      throw Error("Preview must never summarize history");
    },
  };
  const memory = new MemoryService(root, "main", db, cfg, llm);
  await memory.sync(true);
  calls.length = 0;
  const runtime = {
    cfg,
    db,
    config: { root: () => root },
    agentRoot: () => root,
    memories: new Map([["main", memory]]),
  } as unknown as Runtime;
  const preserved = async () =>
    JSON.stringify({
      files: await Promise.all(
        ["memory.json", "state.json", ".runtime/search-index.json"].map((f) =>
          fs.readFile(path.join(root, f), "utf8"),
        ),
      ),
      kv: db.db.prepare("SELECT * FROM kv ORDER BY key").all(),
      events: db.db.prepare("SELECT COUNT(*) AS count FROM events").get(),
      runs: db.db.prepare("SELECT COUNT(*) AS count FROM runs").get(),
    });
  return { root, cfg, db, memory, llm, calls, runtime, preserved, now };
}

test("full third-layer preview exposes ordered prompts and never writes history, memory or state", async (t) => {
  const f = await fixture(t),
    before = await f.preserved();
  const all = f.db.all;
  f.db.all = () => {
    throw Error("History content must be omitted");
  };
  let p: Awaited<ReturnType<typeof contextPreview>>;
  try {
    p = await contextPreview(
      f.runtime,
      "main",
      "又想吃拉面了",
      "user",
      () => 0,
    );
  } finally {
    f.db.all = all;
  }
  assert.equal(await f.preserved(), before);
  assert.deepEqual(
    p!.layout.map((x) => x.role),
    ["system", "omitted", "system", "user"],
  );
  assert.equal(p!.stages[0].id, "input");
  assert.equal(p!.stages.at(-1)!.id, "final");
  assert.ok(p!.context.system.includes("[Operating rules]"));
  assert.ok(p!.context.system.includes("[Project]"));
  assert.ok(p!.context.system.includes("demo"));
  assert.ok(!p!.context.system.includes("此正文不应自动加入Prompt"));
  assert.ok(
    String(p!.context.messages.at(-1)!.content).includes("又想吃拉面了"),
  );
  assert.ok(
    p!.stages.find((s) => s.id === "state-mood")!.prompt.includes("心情"),
  );
  assert.ok(p!.stages.find((s) => s.id === "spark")!.prompt.includes("纸碗"));
  assert.ok(p!.calls.find((c) => c.purpose === "query")!.system);
  assert.deepEqual(new Set(f.calls), new Set(["query", "embedding", "spark"]));
  assert.equal(
    await fs.stat(path.join(f.root, ".runtime/traces")).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("preview final strings match actual ContextBuilder when history is empty", async (t) => {
  const f = await fixture(t),
    old = Date.now;
  Date.now = () => f.now;
  try {
    const preview = await contextPreview(
      f.runtime,
      "main",
      "又想吃拉面了",
      "user",
      () => 0,
    );
    const stored = f.db.append({
      protocol_version: 1,
      event_id: "actual",
      agent_id: "main",
      source: "local",
      type: "incoming_message",
      text: "又想吃拉面了",
      attachments: [],
      reply_target: f.cfg.agents[0].defaultTarget,
      sender: { id: "owner", name: "owner", kind: "user" },
      data: {},
    });
    const actual = await new ContextBuilder(
      f.db,
      f.cfg,
      f.cfg.agents[0],
      f.root,
      path.join(f.root, "prompts"),
      new History(f.db, f.cfg, f.llm),
      f.memory,
      f.llm,
      f.root,
    ).build([stored], "actual-run", new AbortController().signal);
    assert.equal(preview.context.system, actual.system);
    assert.deepEqual(preview.context.messages, actual.messages);
  } finally {
    Date.now = old;
  }
});

test("disabled probability branches are visible as skips; internal events keep their identity", async (t) => {
  const f = await fixture(t);
  f.cfg.memory.enabled = false;
  f.cfg.context.sparkProbability = 0;
  f.cfg.state.thoughtContextProbability = 0;
  f.cfg.state.focusContextProbability = 0;
  const before = await f.preserved(),
    p = await contextPreview(
      f.runtime,
      "main",
      "想分享点新东西",
      "random_chat",
      () => 0.8,
    );
  assert.equal(p.output.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(p.stages.find((s) => s.id === "state-thoughts")!.kind, "跳过");
  assert.equal(p.stages.find((s) => s.id === "state-focus")!.kind, "跳过");
  assert.equal(p.stages.find((s) => s.id === "spark")!.kind, "跳过");
  assert.ok(
    String(p.context.messages.at(-1)!.content).includes(
      "内部事件，并非用户发言",
    ),
  );
  assert.equal(await f.preserved(), before);
});

test("shared prompt assembly enforces budgets and matches state-section output", async (t) => {
  const f = await fixture(t),
    state = await f.memory.state(),
    mapping = promptMappingDefaults;
  f.cfg.context.stateTokens = 40;
  const projected = stateContextSteps(state, f.cfg, f.now, mapping, {
    thoughts: true,
    focus: true,
  });
  assert.equal(projected.prompt, stateContext(state, f.cfg, f.now, mapping));
  const stable = assembleSystem({
    cfg: f.cfg,
    agent: f.cfg.agents[0],
    root: f.root,
    base: "x ".repeat(20000),
    persona: "y ".repeat(20000),
    skills: [],
  });
  assert.ok(stable.rulesPersona.length < stable.rulesPersonaRaw.length);
  const dynamic = assembleBackground({
    cfg: f.cfg,
    target: f.cfg.agents[0].defaultTarget,
    memories: [],
    state,
    mapping,
    selection: { thoughts: true, focus: true },
    stateExpression: "解释",
    spark: "",
    system: stable.system,
    now: f.now,
  });
  assert.equal(dynamic.stateSteps.prompt, projected.prompt);
  assert.ok(dynamic.raw.includes("解释"));
  new Function(client);
  assert.ok(client.includes("function renderPromptFlow("));
  assert.ok(!client.includes("innerHTML"));
});
