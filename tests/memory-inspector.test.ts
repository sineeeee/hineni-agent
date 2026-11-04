import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { parseConfig } from "../src/config/schema.js";
import { Store } from "../src/layer2/store.js";
import { MemoryService } from "../src/layer3/memory.js";
import {
  memoryFactors,
  synchronizeMemoryIndex,
} from "../src/layer3/memory-ranking.js";
import { memoryRoutes } from "../src/admin/memory.js";
import type { Runtime } from "../src/layer2/runtime.js";
import type { Intelligence } from "../src/shared/models.js";
import { client } from "../src/admin/ui-client.js";

const target = { channel: "local", conversation: "owner" };
async function fixture(t: any) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "hineni-memory-inspect-"),
  );
  const cfg = parseConfig({
    channels: [{ id: "local", type: "webhook" }],
    agents: [{ id: "main", name: "Main", defaultTarget: target }],
    memory: {
      maxItems: 2,
      temporalNeighbors: 1,
      associationProbability: 1,
      detailsItems: 1,
      baseHalfLifeDays: 61,
    },
  });
  const db = new Store(path.join(root, "runtime.sqlite"));
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const now = Date.now(),
    date = (days: number) => new Date(now - days * 86400000).toISOString();
  const items = [
    {
      id: "anchor",
      occurred_at: date(1),
      summary: "拉面",
      details: "真实细节",
      people: ["owner"],
      emotion: ["愉快"],
      importance: 4,
      type: "event",
    },
    {
      id: "neighbor",
      occurred_at: date(1 - 1 / 24),
      summary: "散步",
      details: "附近的事",
      people: [],
      emotion: [],
      importance: 1,
      type: "event",
    },
    {
      id: "association",
      occurred_at: date(10),
      summary: "公园",
      details: "",
      people: ["owner"],
      emotion: [],
      importance: 1,
      type: "event",
    },
    {
      id: "second",
      occurred_at: date(8),
      summary: "牛排",
      details: "",
      people: [],
      emotion: [],
      importance: 2,
      type: "event",
    },
    {
      id: "unrelated",
      occurred_at: date(20),
      summary: "地图",
      details: "",
      people: [],
      emotion: [],
      importance: 5,
      type: "event",
    },
  ];
  await fs.writeFile(
    path.join(root, "memory.json"),
    JSON.stringify({ memory: items }),
  );
  const state = {
    updated_at: new Date(now).toISOString(),
    mood: 76,
    emotions: { 愉快: 60 },
    drives: {},
    cause: "",
    thoughts: [],
    focus: [],
    activation: { anchor: now - 20 * 60000 },
  };
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state));
  const calls: string[] = [];
  const llm: Intelligence = {
    json: async (_p, _i, _s, purpose) => {
      calls.push(purpose!);
      return purpose === "query"
        ? { queries: ["拉面"] }
        : { ids: ["anchor", "second"] };
    },
    embed: async (texts) => {
      calls.push("embedding");
      return texts.map(() => [1, 0]);
    },
    summarize: async () => "",
  };
  const memory = new MemoryService(root, "main", db, cfg, llm);
  const index: Record<string, any> = {};
  synchronizeMemoryIndex(
    await memory.items(),
    index,
    cfg.models.embedding.baseUrl + "|" + cfg.models.embedding.name,
    now,
  );
  for (const m of items) {
    index[m.id].vectors = [
      [
        m.id === "anchor" || m.id === "second" ? 1 : 0,
        m.id === "anchor" || m.id === "second" ? 0 : 1,
      ],
    ];
    index[m.id].description = "检索描述";
  }
  index.anchor.strength = 0.8;
  index.anchor.familiarity = 2;
  db.set("index:main", index);
  db.set("recallRound:main", 3);
  db.set("associations:main", {});
  await fs.mkdir(path.join(root, ".runtime"));
  await fs.writeFile(
    path.join(root, ".runtime/search-index.json"),
    JSON.stringify(index),
  );
  const preserved = async () =>
    JSON.stringify({
      files: await Promise.all(
        ["memory.json", "state.json", ".runtime/search-index.json"].map((f) =>
          fs.readFile(path.join(root, f), "utf8"),
        ),
      ),
      kv: db.db.prepare("SELECT * FROM kv ORDER BY key").all(),
    });
  return { root, cfg, db, items, state, memory, calls, preserved };
}

test("memory factors distinguish stored state, decayed state and configured contributions", () => {
  const cfg = parseConfig({
    channels: [{ id: "local", type: "webhook" }],
    agents: [{ id: "main", name: "Main", defaultTarget: target }],
    memory: { baseHalfLifeDays: 61 },
  });
  const now = Date.now(),
    m = {
      id: "a",
      importance: 4,
      occurred_at: new Date(now).toISOString(),
      emotion: ["愉快"],
    };
  const state = { activation: { a: now - 50 * 60000 }, emotions: { 愉快: 60 } };
  const f = memoryFactors(
    m,
    {
      strength: 0.8,
      strengthAt: new Date(now - 152.5 * 86400000).toISOString(),
      familiarity: 5,
    },
    state,
    cfg.memory,
    now,
  );
  assert.equal(f.halfLifeDays, 152.5);
  assert.equal(f.strength, 0.4);
  assert.equal(f.importance, 0.75);
  assert.equal(f.emotion, 0.6);
  assert.deepEqual(f.matchedEmotions, ["愉快"]);
  assert.ok(
    Math.abs(
      f.multiplier - Object.values(f.contributions).reduce((a, b) => a + b, 0),
    ) < 1e-12,
  );
  const explicit = memoryFactors(
    m,
    { strength: 0.01, strengthAt: new Date(0).toISOString(), familiarity: 0 },
    state,
    cfg.memory,
    now,
    true,
  );
  assert.equal(explicit.strength, 1);
  assert.equal(
    memoryFactors(
      { ...m, emotion: ["开心"] },
      { strength: 1, strengthAt: new Date(now).toISOString(), familiarity: 0 },
      state,
      cfg.memory,
      now,
    ).emotion,
    0,
  );
});

test("inspect and real recall preview expose all stages without mutating memory or counters", async (t) => {
  const f = await fixture(t),
    before = await f.preserved();
  const inspected = await f.memory.inspectMemories();
  assert.equal(inspected.rows.length, 5);
  assert.equal(inspected.index_source, "database");
  assert.equal(f.calls.length, 0);
  assert.equal(inspected.rows[0].stored_index!.vectors, undefined);
  assert.equal(inspected.rows[0].stored_index!.vector_count, 1);
  assert.deepEqual(
    (await f.memory.inspectMemories("anchor")).rows[0].stored_index!.vectors,
    [[1, 0]],
  );
  await assert.rejects(f.memory.inspectMemories("not-this-agent"));
  const result = await f.memory.simulateRecall("拉面");
  assert.deepEqual(
    result.output.map((m: any) => m.id),
    ["anchor", "neighbor", "association"],
  );
  assert.deepEqual(
    result.recall.expanded_ids.map((m: any) => m.reason),
    ["relevant", "temporal", "association"],
  );
  assert.equal(result.search.entries.length, 5);
  assert.ok(result.query.expanded.includes("拉面\n拉面"));
  assert.deepEqual(f.calls, ["query", "embedding", "rerank"]);
  assert.equal(await f.preserved(), before);
  const explicit = await f.memory.simulateRecall("拉面", "search");
  assert.deepEqual(
    explicit.output.map((m: any) => m.id),
    ["anchor", "second"],
  );
  assert.equal(
    explicit.search.entries.find((m: any) => m.id === "anchor").factors
      .strength,
    1,
  );
  assert.equal(await f.preserved(), before);
  // Simulator does not populate the real service's query cache.
  const queryCalls = f.calls.filter((x) => x === "query").length;
  await f.memory.recall("拉面");
  assert.equal(f.calls.filter((x) => x === "query").length, queryCalls + 1);
});

test("stale and invalid source inspection is read-only, rather than rebuilding the live index", async (t) => {
  const f = await fixture(t);
  f.items[0].details = "修改后的内容";
  await fs.writeFile(
    path.join(f.root, "memory.json"),
    JSON.stringify({ memory: f.items }),
  );
  const before = await f.preserved(),
    result = await f.memory.inspectMemories();
  assert.equal(result.rows[0].index_current, false);
  assert.equal(
    result.rows[0].stored_index!.text.includes("修改后的内容"),
    false,
  );
  await f.memory.simulateRecall("拉面");
  assert.equal(await f.preserved(), before);
  await fs.writeFile(path.join(f.root, "memory.json"), "{");
  await assert.rejects(f.memory.inspectMemories());
  assert.equal(
    await fs.readFile(path.join(f.root, "memory.json"), "utf8"),
    "{",
  );
});

test("memory inspection routes validate inputs, scope agents, and serve browser navigation", async (t) => {
  const f = await fixture(t),
    app = Fastify();
  app.setErrorHandler((error, _req, reply) =>
    reply.code(400).send({ error: String(error) }),
  );
  memoryRoutes(app, {
    memories: new Map([["main", f.memory]]),
  } as unknown as Runtime);
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ url: "/v1/agents/main/memory/inspect" })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: "/v1/agents/other/memory/inspect" })).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/agents/main/memory/simulate",
        payload: { query: "", extra: true },
      })
    ).statusCode,
    400,
  );
  const response = await app.inject({
    method: "POST",
    url: "/v1/agents/main/memory/simulate",
    payload: { query: "拉面" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().agent_id, "main");
  assert.ok(client.includes("memory:renderMemory"));
  new Function(client);
});
