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
      feelingRecall: false,
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

test("dual recall separates text, merges IDs once, excludes state from feeling query and previews without writes", async (t) => {
  const f = await fixture(t);
  f.cfg.memory.feelingRecall = true;
  f.cfg.memory.query = false;
  f.cfg.memory.rerank = false;
  f.cfg.memory.temporalNeighbors = 0;
  f.cfg.memory.associationProbability = 0;
  f.cfg.memory.maxItems = 5;
  const raw = {
    memory: f.items.map((m) => ({
      ...m,
      emotion:
        m.id === "neighbor"
          ? { labels: ["被理解"], feeling: "终于有人听懂那份等待" }
          : { labels: [], feeling: "" },
    })),
  };
  await fs.writeFile(path.join(f.root, "memory.json"), JSON.stringify(raw));
  const calls: any[] = [];
  const llm: Intelligence = {
    json: async (prompt, input) => {
      calls.push({ prompt, input });
      return { feeling_query: "被理解" };
    },
    embed: async () => {
      throw Error("offline: lexical fallback");
    },
    summarize: async () => "",
  };
  const memory = new MemoryService(f.root, "main", f.db, f.cfg, llm);
  await memory.sync(false);
  const before = await f.preserved();
  const trial = await memory.simulateRecall("拉面");
  assert.deepEqual(
    new Set(trial.output.map((m: any) => m.id)),
    new Set(["anchor", "neighbor"]),
  );
  assert.equal(
    new Set(trial.output.map((m: any) => m.id)).size,
    trial.output.length,
  );
  assert.equal(trial.query.feeling, "被理解");
  assert.deepEqual(Object.keys(calls[0].input).sort(), ["route", "text"]);
  assert.equal(calls[0].input.text, "拉面");
  assert.equal(await f.preserved(), before);
  const index = await memory.index();
  assert.ok(!index.neighbor.text.includes("被理解"));
  assert.equal(index.neighbor.feelingText, "被理解\n终于有人听懂那份等待");
  assert.deepEqual(
    trial.search.entries.find((x: any) => x.id === "neighbor").matched_routes,
    ["feeling"],
  );
  const broken = new MemoryService(f.root, "main", f.db, f.cfg, {
    ...llm,
    json: async () => {
      throw Error("unavailable");
    },
  });
  const fallback = await broken.simulateRecall("拉面");
  assert.deepEqual(
    fallback.output.map((m: any) => m.id),
    ["anchor"],
  );
});

test("dual index invalidates only changed content and preserves lifetime factors", () => {
  const item = {
    id: "one",
    summary: "fact",
    details: "detail",
    people: ["owner"],
    emotion: { labels: ["joy"], feeling: "warm" },
  };
  const index: Record<string, any> = {};
  synchronizeMemoryIndex([item], index, "model", Date.now());
  Object.assign(index.one, {
    vectors: [[1, 0]],
    feelingVectors: [[0, 1]],
    description: "fact description",
    strength: 0.7,
    familiarity: 4,
  });
  synchronizeMemoryIndex(
    [{ ...item, emotion: { labels: ["joy"], feeling: "closer" } }],
    index,
    "model",
    Date.now(),
  );
  assert.deepEqual(index.one.vectors, [[1, 0]]);
  assert.deepEqual(index.one.feelingVectors, []);
  assert.equal(index.one.familiarity, 4);
  assert.equal(index.one.strength, 0.7);
  index.one.feelingVectors = [[0, 1]];
  synchronizeMemoryIndex(
    [
      {
        ...item,
        details: "changed",
        emotion: { labels: ["joy"], feeling: "closer" },
      },
    ],
    index,
    "model",
    Date.now(),
  );
  assert.deepEqual(index.one.vectors, []);
  assert.deepEqual(index.one.feelingVectors, [[0, 1]]);
  synchronizeMemoryIndex([], index, "model", Date.now());
  assert.deepEqual(index, {});
});

test("feeling index maintenance survives fact-model failure and retries only missing side", async (t) => {
  const f = await fixture(t);
  f.cfg.memory.feelingRecall = true;
  await fs.writeFile(
    path.join(f.root, "memory.json"),
    JSON.stringify({
      memory: [
        {
          ...f.items[0],
          details: "new fact content",
          emotion: { labels: ["安心"], feeling: "有人陪着" },
        },
      ],
    }),
  );
  let fail = true;
  const inputs: string[] = [];
  const llm: Intelligence = {
    json: async (_p, input) => {
      assert.ok(!("emotion" in (input as any).memory));
      if (fail) throw Error("fact description unavailable");
      return { search_text: "拉面" };
    },
    embed: async (texts) => {
      inputs.push(...texts);
      return texts.map(() => [1, 0]);
    },
    summarize: async () => "",
  };
  const m = new MemoryService(f.root, "main", f.db, f.cfg, llm);
  await m.sync(true);
  let row = (await m.index()).anchor;
  assert.equal(row.vectors.length, 0);
  assert.equal(row.feelingVectors.length, 1);
  assert.equal((await m.indexStatus()).ready, 0);
  fail = false;
  await m.sync(true);
  row = (await m.index()).anchor;
  assert.equal(row.vectors.length, 1);
  assert.equal((await m.indexStatus()).ready, 1);
  assert.equal(inputs.filter((x) => x.includes("有人陪着")).length, 1);
});

test("memory CRUD persists JSON first, invalidates one side, rejects stale editors and deletes both indexes", async (t) => {
  const f = await fixture(t);
  let view = await f.memory.inspectMemories();
  const created = await f.memory.changeMemory("create", view.version, {
    occurred_at: "2026-11-05",
    summary: "新增一条",
    details: "事实",
    people: [],
    emotion: { labels: ["温暖"], feeling: "感受" },
    importance: 3,
  });
  const disk = JSON.parse(
    await fs.readFile(path.join(f.root, "memory.json"), "utf8"),
  );
  assert.equal(disk.memory.at(-1).id, created.id);
  let ix = await f.memory.index();
  assert.ok(ix[created.id!]);
  assert.deepEqual(ix[created.id!].vectors, []);
  await assert.rejects(
    () => f.memory.changeMemory("delete", view.version, undefined, created.id),
    /刷新/,
  );
  ix[created.id!].vectors = [[1, 0]];
  ix[created.id!].feelingVectors = [[0, 1]];
  f.db.set("index:main", ix);
  view = await f.memory.inspectMemories();
  const old = view.rows.find((x) => x.id === created.id)!.memory;
  await f.memory.changeMemory(
    "update",
    view.version,
    { ...old, emotion: { labels: ["温暖"], feeling: "改变感受" } },
    created.id,
  );
  ix = await f.memory.index();
  assert.deepEqual(ix[created.id!].vectors, [[1, 0]]);
  assert.deepEqual(ix[created.id!].feelingVectors, []);
  view = await f.memory.inspectMemories();
  await f.memory.updateState((s) => {
    s.activation[created.id!] = Date.now();
  });
  await f.memory.changeMemory("delete", view.version, undefined, created.id);
  assert.ok(!(await f.memory.index())[created.id!]);
  assert.ok(
    !JSON.parse(
      await fs.readFile(
        path.join(f.root, ".runtime/search-index.json"),
        "utf8",
      ),
    )[created.id!],
  );
  assert.ok(
    !JSON.parse(
      await fs.readFile(path.join(f.root, "memory.json"), "utf8"),
    ).memory.some((x: any) => x.id === created.id),
  );
  assert.ok(!(await f.memory.state()).activation[created.id!]);
  assert.equal((await f.memory.items()).length, f.items.length);
});

test("explicit rebuild of one memory side preserves other vectors and familiarity", async (t) => {
  const f = await fixture(t);
  f.cfg.memory.searchDescription = false;
  f.cfg.memory.feelingRecall = true;
  await fs.writeFile(
    path.join(f.root, "memory.json"),
    JSON.stringify({
      memory: [
        { ...f.items[0], emotion: { labels: ["开心"], feeling: "舒心" } },
      ],
    }),
  );
  const calls: string[] = [];
  const m = new MemoryService(f.root, "main", f.db, f.cfg, {
    json: async () => ({}),
    embed: async (texts) => {
      calls.push(...texts);
      return texts.map(() => [0.5, 0.5]);
    },
    summarize: async () => "",
  });
  await m.sync(true);
  const ix = await m.index();
  ix.anchor.familiarity = 7;
  ix.anchor.vectors = [[1, 0]];
  f.db.set("index:main", ix);
  calls.length = 0;
  await m.sync(true, { side: "feeling", ids: ["anchor"], force: true });
  assert.ok(calls.length === 1 && calls[0].includes("舒心"));
  assert.deepEqual((await m.index()).anchor.vectors, [[1, 0]]);
  assert.equal((await m.index()).anchor.familiarity, 7);
  calls.length = 0;
  await m.sync(true, { side: "fact", ids: ["anchor"], force: true });
  assert.ok(calls.length === 1 && !calls[0].includes("舒心"));
});

test("balanced retrieval allocates half the slots and borrows only when a route is short", async () => {
  const { balancedMemories } = await import("../src/layer3/memory-ranking.js");
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    score: 100 - i,
    fact: i < 8,
    feeling: i >= 8,
  }));
  const pick = balancedMemories(
    rows,
    8,
    0.5,
    (x) => x.fact,
    (x) => x.feeling,
  );
  assert.equal(pick.filter((x) => x.route === "fact").length, 4);
  assert.equal(pick.filter((x) => x.route === "feeling").length, 4);
  const overlap = balancedMemories(
    rows.map((x) => ({ ...x, feeling: true })),
    8,
    0.5,
    (x) => x.fact,
    (x) => x.feeling,
  );
  assert.equal(new Set(overlap.map((x) => x.value.id)).size, 8);
  const short = balancedMemories(
    rows.filter((x) => x.id < 9),
    8,
    0.5,
    (x) => x.fact,
    (x) => x.feeling,
  );
  assert.equal(short.length, 8);
  assert.equal(short.filter((x) => x.route === "feeling").length, 1);
});

test("memory page renders CRUD controls and saves through the scoped HTTP routes", async (t) => {
  const f = await fixture(t),
    app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((e, _q, r) =>
    r.code((e as any).statusCode ?? 400).send({ error: String(e) }),
  );
  memoryRoutes(app, {
    memories: new Map([["main", f.memory]]),
  } as unknown as Runtime);
  const { memoryClient } = await import("../src/admin/memory-client.js");
  let nodes: any[] = [];
  const notices: string[] = [];
  const el = (tag: string, attrs: any = {}, ...children: any[]) => {
    const n = {
      tag,
      ...attrs,
      children: children.flat(),
      append(...xs: any[]) {
        this.children.push(...xs);
      },
    };
    nodes.push(n);
    return n;
  };
  const btn = (text: string, onclick: () => unknown) =>
    el("button", { text, onclick });
  const api = async (url: string, method = "GET", body?: unknown) => {
    const res = await app.inject({
      url,
      method: method as any,
      ...(body ? { payload: body } : {}),
    });
    const data = res.json();
    if (res.statusCode >= 400) throw Error(data.error);
    return data;
  };
  let render: () => Promise<unknown>;
  render = new Function(
    "el",
    "panel",
    "btn",
    "api",
    "replaceContent",
    "notify",
    "show",
    "confirm",
    "jsonViewer",
    "time",
    "agentId",
    "view",
    "startVectorize",
    memoryClient + ";return renderMemory;",
  )(
    el,
    (title: string, ...xs: any[]) => el("section", { title }, ...xs),
    btn,
    api,
    (n: any, ...xs: any[]) => {
      n.children = xs;
    },
    (s: string) => notices.push(s),
    async () => {
      nodes = [];
      return render();
    },
    () => true,
    () => el("pre"),
    (x: string) => x,
    "main",
    "memory",
    () => {},
  );
  await render();
  assert.ok(nodes.some((n) => n.text === "重建事实侧"));
  assert.ok(nodes.some((n) => n.text === "重建感受侧"));
  await nodes.find((n) => n.text === "新增记忆").onclick();
  const input = nodes.find((n) => n["aria-label"] === "记忆条目 JSON");
  assert.equal(input.wrap, "off");
  const entry = JSON.parse(input.value);
  entry.summary = "UI CRUD test";
  entry.details = "new fact";
  input.value = JSON.stringify(entry);
  await nodes.find((n) => n.text === "只保存").onclick();
  assert.ok(notices.some((s) => s.includes("记忆已保存")));
  await nodes.find((n) => n.text === "UI CRUD test").onclick();
  await nodes.find((n) => n.text === "编辑此条").onclick();
  const edit = nodes.find((n) => n["aria-label"] === "记忆条目 JSON");
  const changed = JSON.parse(edit.value);
  changed.summary = "UI edited";
  edit.value = JSON.stringify(changed);
  await nodes.find((n) => n.text === "只保存").onclick();
  await nodes.find((n) => n.text === "UI edited").onclick();
  await nodes.find((n) => n.text === "删除此条").onclick();
  assert.equal((await f.memory.items()).length, f.items.length);
  const res = await app.inject({
    method: "POST",
    url: "/v1/agents/other/memory/entries",
    payload: { version: "x", entry: {} },
  });
  assert.equal(res.statusCode, 400);
});

test("deleting while vector generation is in flight cannot resurrect the memory", async (t) => {
  const f = await fixture(t);
  f.cfg.memory.searchDescription = false;
  await fs.writeFile(
    path.join(f.root, "memory.json"),
    JSON.stringify({
      memory: [{ ...f.items[0], details: "changed for rebuild" }],
    }),
  );
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (started = r));
  const memory = new MemoryService(f.root, "main", f.db, f.cfg, {
    json: async () => ({}),
    summarize: async () => "",
    embed: async (texts) => {
      started();
      await waiting;
      return texts.map(() => [1, 0]);
    },
  });
  const work = memory.sync(true);
  await began;
  const snap = await memory.inspectMemories();
  await memory.changeMemory("delete", snap.version, undefined, "anchor");
  release();
  await work;
  assert.deepEqual(await memory.items(), []);
  assert.deepEqual(await memory.index(), {});
});
