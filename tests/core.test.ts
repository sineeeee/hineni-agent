import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import YAML from "yaml";
import { initialize } from "../src/init.js";
import { ConfigStore } from "../src/config/store.js";
import { parseConfig, agentConfig } from "../src/config/schema.js";
import { Journal } from "../src/layer2/journal.js";
import { Store } from "../src/layer2/store.js";
import { Runtime, type ExecutorFactory } from "../src/layer2/runtime.js";
import { History } from "../src/layer2/history.js";
import { MemoryService } from "../src/layer3/memory.js";
import { ContextBuilder } from "../src/layer3/context.js";
import { Chunker } from "../src/layer4/chunker.js";
import { PiExecutor } from "../src/layer4/pi.js";
import { appTools, type ToolHost } from "../src/layer4/tools.js";
import { ChannelRegistry, SendFailure } from "../src/layer1/channels.js";
import { Outbox } from "../src/layer2/outbox.js";
import { Scheduler } from "../src/scheduler.js";
import { servers } from "../src/admin/server.js";
import type {
  EventInput,
  Delivery,
  RunResult,
} from "../src/contracts/index.js";
import type { Intelligence } from "../src/shared/models.js";
const llm: Intelligence = {
  json: async () => ({ queries: [], ids: [], memory_mentions: [] }),
  embed: async (texts) => texts.map(() => [1, 0, 0]),
  summarize: async () => "Older history safely summarized.",
};
const event = (id = "one"): EventInput => ({
  protocol_version: 1,
  event_id: id,
  agent_id: "main",
  type: "incoming_message",
  source: "local",
  text: "你好",
  reply_target: { channel: "local", conversation: "owner" },
  attachments: [],
  data: {},
});
const complete = (text = ""): RunResult => ({
  reason: "complete",
  text,
  tools: [],
  memoryIds: [],
});
async function wait(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function fixture(t: any) {
  const cleanup: Array<() => Promise<unknown>> = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hineni-test-"));
  for (const dir of ["templates", "prompts", "scripts"])
    await fs.cp(path.resolve(dir), path.join(root, dir), { recursive: true });
  await initialize(root);
  const config = new ConfigStore(path.join(root, "config.yaml"));
  await config.load();
  await config.save({
    ...config.current,
    models: {
      ...config.current.models,
      main: { ...config.current.models.main, protocol: "chat-completions" },
      fast: { ...config.current.models.fast, protocol: "chat-completions" },
    },
    channels: [{ id: "local", type: "webhook" }],
    memory: {
      ...config.current.memory,
      query: false,
      rerank: false,
      associationProbability: 0,
    },
    state: { ...config.current.state, enabled: false },
    scheduler: { ...config.current.scheduler, enabled: false },
    history: { ...config.current.history, pollMs: 50 },
  });
  const db = new Store(
    path.join(root, "data/runtime.sqlite"),
    new Journal(path.join(root, "agents")),
  );
  t.after(async () => {
    for (const fn of cleanup) await fn();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, config, db, cleanup };
}

test("defaults, invalid budgets and per-agent overrides", () => {
  const c = parseConfig({
    channels: [{ id: "x", type: "webhook" }],
    agents: [
      {
        id: "a",
        name: "A",
        defaultTarget: { channel: "x", conversation: "u" },
      },
    ],
  });
  assert.equal(c.memory.maxItems, 12);
  assert.equal(c.state.enabled, true);
  assert.equal(c.drives.fatigue.halfLifeHours, 3);
  assert.throws(() =>
    parseConfig({ ...c, history: { ...c.history, targetTokens: 999999 } }),
  );
  assert.throws(() => parseConfig({ ...c, mcp: [{ name: "bad" }] }));
  assert.equal(
    agentConfig(c, { ...c.agents[0], overrides: { style: { warmth: 0.9 } } })
      .style.warmth,
    0.9,
  );
});
test("raw journal is immediately readable, duplicate events have one line, rebuilt index does not replay", async (t) => {
  const f = await fixture(t);
  f.db.append(event());
  f.db.append(event());
  const dir = path.join(f.root, "agents/main/history");
  const file = (await fs.readdir(dir)).find((x) => x.endsWith(".jsonl"))!;
  const lines = (await fs.readFile(path.join(dir, file), "utf8"))
    .trim()
    .split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, "你好");
  const db = new Store(
    path.join(f.root, "second.sqlite"),
    new Journal(path.join(f.root, "agents")),
  );
  db.rebuild(["main"]);
  assert.equal(db.all("main").length, 1);
  assert.equal(db.pending("main").length, 0);
  db.close();
});
test("chunker preserves order, drops unfinished text on cancel, keeps fenced code", () => {
  const out: string[] = [];
  const c = new Chunker((s) => out.push(s));
  c.push("好的。现在");
  assert.deepEqual(out, ["好的。"]);
  c.push("运行。");
  c.push("```js\nx();\n```");
  assert.equal(out.length, 2);
  c.flush();
  assert.equal(out[2], "```js\nx();\n```");
  c.push("还没完成");
  c.discard();
  c.flush();
  assert.equal(out.length, 3);
});
test("history compacts only at capacity and keeps raw originals", async (t) => {
  const f = await fixture(t);
  const cfg = parseConfig({
    ...f.config.current,
    history: {
      ...f.config.current.history,
      triggerTokens: 1500,
      targetTokens: 800,
      summaryTokens: 100,
    },
  });
  let summaries = 0;
  const intelligence = {
    ...llm,
    summarize: async () => {
      summaries++;
      return "summary";
    },
  };
  for (let i = 0; i < 8; i++)
    f.db.append({ ...event("e" + i), text: "较早的经历 ".repeat(100) });
  const h = new History(f.db, cfg, intelligence);
  const view = await h.view("main");
  assert.match(view, /summary/);
  const count = summaries;
  await h.view("main");
  assert.equal(summaries, count);
  assert.equal(f.db.all("main").length, 8);
});
test("same poll batches input; new input cancels old run; tool events do not recurse", async (t) => {
  const f = await fixture(t);
  let starts = 0,
    oldStopped = false;
  const calls: string[] = [];
  const factory: ExecutorFactory = (host, _l, record) => ({
    run: async (req) => {
      starts++;
      calls.push(JSON.stringify(req.context.messages));
      if (starts === 1) {
        host.send(
          [{ type: "text", text: "已看到。" }],
          req.context.target,
          "ack",
        );
        record({
          event_id: "tool",
          type: "tool_result",
          run_id: req.runId,
          text: "partial result",
        });
        await new Promise<void>((r) =>
          req.signal.addEventListener("abort", () => r(), { once: true }),
        );
        oldStopped = true;
        return { ...complete(), reason: "cancelled" };
      }
      host.send(
        [{ type: "text", text: "接着处理。" }],
        req.context.target,
        "final",
      );
      return complete();
    },
  });
  const rt = new Runtime(f.config, f.db, async () => {}, llm, factory);
  await rt.start();
  await rt.outbox.stop(); // Keep outputs unhanded until the interruption under test.
  f.cleanup.push(() => rt.stop());
  rt.ingress(event("a"));
  rt.ingress({ ...event("b"), text: "第二句话" });
  rt.tick();
  await wait(() => starts === 1);
  rt.ingress({ ...event("c"), text: "新的要求" });
  rt.tick();
  await wait(() => starts === 2);
  await wait(() => rt.status().active.length === 0);
  assert.equal(oldStopped, true);
  assert.match(calls[0], /第二句话/);
  assert.match(calls[1], /partial result/);
  assert.equal(starts, 2);
  assert.equal(
    f.db.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()!.n,
    1,
  );
  assert.ok(!calls[1].includes("已看到。"));
});
test("outbox is serial, sent text remains after cancel and uncertain delivery requires explicit retry", async (t) => {
  const f = await fixture(t);
  const registry = new ChannelRegistry(
    f.config.current,
    f.db,
    (a) => f.config.agentRoot(a),
    () => {},
  );
  const sends: string[] = [];
  registry.channels.set("local", {
    id: "local",
    send: async (_d, p) => {
      sends.push(p?.type === "text" ? p.text : "");
      if (sends.length === 2) throw new SendFailure("connection dropped", true);
      return { message_id: "42" };
    },
  });
  const out = new Outbox(f.db, f.config.current, registry, () => {});
  const d: Delivery = {
    id: "d",
    agent_id: "main",
    run_id: "r",
    response_id: "r:msg:0",
    chunk_index: 0,
    target: event().reply_target!,
    action: "send",
    parts: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
  };
  out.queue(d);
  out.queue(d);
  await out.tick();
  assert.deepEqual(sends, ["one", "two"]);
  const row: any = f.db.db.prepare("SELECT * FROM deliveries").get();
  assert.equal(row.status, "uncertain");
  assert.equal(row.part_index, 1);
  await out.tick();
  assert.equal(sends.length, 2);
  assert.equal(
    f.db.all("main").filter((e) => e.type === "agent_reply").length,
    1,
  );
});
test("memory query degrades to lexical, full read paginates, actual mention reinforces only candidates", async (t) => {
  const f = await fixture(t);
  const cfg = parseConfig({
    ...f.config.current,
    state: { ...f.config.current.state, enabled: true },
  });
  const mem = {
    memory: [
      {
        id: "m1",
        occurred_at: "2020-01-01",
        summary: "小猫的名字是豆豆",
        details: "豆豆很喜欢睡觉。".repeat(1000),
        importance: 4,
      },
      {
        id: "m2",
        occurred_at: "2024-01-01",
        summary: "去海边旅行",
        details: "大海",
        importance: 3,
      },
    ],
  };
  await fs.writeFile(
    path.join(f.root, "agents/main/memory.json"),
    JSON.stringify(mem),
  );
  let emotionCalls = 0;
  const brain = {
    ...llm,
    embed: async () => {
      throw Error("offline");
    },
    json: async () => {
      emotionCalls++;
      return {
        mood: 100,
        emotions: { 愉快: 100 },
        memory_mentions: ["m1", "unknown"],
        thoughts: [],
      };
    },
  };
  const m = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    cfg,
    brain,
  );
  assert.equal((await m.search("豆豆", true))[0].id, "m1");
  await m.afterRun("r", { text: "豆豆" }, await m.items());
  await m.afterRun("r", { text: "豆豆" }, await m.items());
  assert.equal(emotionCalls, 1);
  const state = await m.state();
  assert.ok(state.mood <= 73 && state.mood > 72);
  assert.ok(state.activation.m1);
  assert.equal((await m.index()).m1.familiarity, 1);
  const tool = appTools({
    db: f.db,
    memory: m,
    cfg,
    agent: cfg.agents[0],
    root: f.config.agentRoot("main"),
    target: event().reply_target!,
    send: () => {},
    silent: () => {},
    restartScheduler: async () => {},
  }).find((x) => x.name === "memory_read")!;
  const p = JSON.parse(
    (await tool.execute("t", { id: "m1" })).content[0].type === "text"
      ? ((await tool.execute("t", { id: "m1" })).content[0] as any).text
      : "{}",
  );
  assert.ok(p.next_offset);
  const next = await tool.execute("t2", {
    id: "m1",
    version: p.version,
    offset: p.next_offset,
  });
  assert.ok(next.content.length);
});
test("HTTP API authentication, validation, attachment isolation, configuration revision", async (t) => {
  const f = await fixture(t);
  process.env.HINENI_TOKEN = "test-token-long-enough-for-authentication";
  const rt = new Runtime(f.config, f.db, async () => {}, llm);
  const sched = new Scheduler(f.config, f.db),
    s = await servers(f.config, rt, sched);
  f.cleanup.push(() => s.close());
  const auth = { authorization: "Bearer " + process.env.HINENI_TOKEN! };
  assert.equal((await s.api.inject({ url: "/v1/status" })).statusCode, 401);
  assert.equal((await s.admin.inject({ url: "/" })).statusCode, 200);
  assert.equal(
    (
      await s.api.inject({
        method: "POST",
        url: "/v1/events",
        headers: auth,
        payload: { ...event(), type: "tool_result" },
      })
    ).statusCode,
    400,
  );
  const upload = await s.api.inject({
    method: "POST",
    url: "/v1/agents/main/attachments",
    headers: auth,
    payload: {
      name: "hello.txt",
      mime: "text/plain",
      data_base64: Buffer.from("hello").toString("base64"),
    },
  });
  assert.equal(upload.statusCode, 201);
  const e = await s.api.inject({
    method: "POST",
    url: "/v1/events",
    headers: auth,
    payload: { ...event(), attachments: [upload.json().id] },
  });
  assert.equal(e.statusCode, 202);
  const bad = await s.api.inject({
    method: "PUT",
    url: "/v1/config",
    headers: auth,
    payload: { revision: 0, config: f.config.current },
  });
  assert.equal(bad.statusCode, 400);
  const schema = await s.api.inject({
    url: "/v1/config/schema",
    headers: auth,
  });
  assert.equal(schema.statusCode, 200);
});
test("stable attachment copies survive removal of generated source", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.config.agentRoot("main"), "workspace/out.txt");
  await fs.writeFile(source, "saved");
  let queued: any;
  const cfg = f.config.current;
  const tool = appTools({
    db: f.db,
    memory: new MemoryService(
      f.config.agentRoot("main"),
      "main",
      f.db,
      cfg,
      llm,
    ),
    cfg,
    agent: cfg.agents[0],
    root: f.config.agentRoot("main"),
    target: event().reply_target!,
    send: (p) => (queued = p),
    silent: () => {},
    restartScheduler: async () => {},
  }).find((t) => t.name === "send_attachment")!;
  await tool.execute("t", { path: source, kind: "file" });
  await fs.unlink(source);
  const a = f.db.getAttachment("main", queued[0].attachment_id)!;
  assert.equal(await fs.readFile(a.path, "utf8"), "saved");
});

// Exercises the real Pi SDK, OpenAI wire conversion, official file tool and callbacks.
test("real Pi: OpenAI SSE -> text -> write tool -> final text; fresh next run has no prior session", async (t) => {
  const f = await fixture(t);
  let requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const payload = JSON.parse(raw);
    requests.push(payload);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: any, finish: any = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "mock",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock",
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          "\n\n",
      );
    emit({ role: "assistant" });
    if (requests.length === 1) {
      emit({ content: "好的。" });
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call_write",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({
                path: "result.txt",
                content: "real tool output",
              }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else {
      emit({ content: "完成了。" });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as any).port;
  process.env.TEST_MODEL_KEY = "fake-test-key";
  const cfg = parseConfig({
    ...f.config.current,
    models: {
      ...f.config.current.models,
      main: {
        ...f.config.current.models.main,
        name: "mock",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: "TEST_MODEL_KEY",
      },
    },
  });
  const sent: any[] = [];
  const host: ToolHost = {
    db: f.db,
    memory: new MemoryService(
      f.config.agentRoot("main"),
      "main",
      f.db,
      cfg,
      llm,
    ),
    cfg,
    agent: cfg.agents[0],
    root: f.config.agentRoot("main"),
    target: event().reply_target!,
    send: (parts, target, key, action, msg, emoji, meta) =>
      sent.push({ parts, meta }),
    silent: () => {},
    restartScheduler: async () => {},
  };
  const exec = new PiExecutor(host, llm, (e) =>
    f.db.append({
      protocol_version: 1,
      agent_id: "main",
      source: "layer4",
      attachments: [],
      data: {},
      ...e,
    }),
  );
  const context = {
    system: "Test identity only.",
    messages: [{ role: "user" as const, content: "Write the file." }],
    memories: [],
    target: event().reply_target!,
    inputText: "Write the file.",
  };
  const result = await exec.run({
    agentId: "main",
    runId: "run-real",
    context,
    signal: new AbortController().signal,
  });
  assert.equal(result.reason, "complete", result.error ?? "");
  assert.equal(
    await fs.readFile(path.join(host.root, "workspace/result.txt"), "utf8"),
    "real tool output",
  );
  assert.deepEqual(
    sent.map((s) => s.parts[0].text),
    ["好的。", "完成了。"],
  );
  assert.notEqual(sent[0].meta.responseId, sent[1].meta.responseId);
  assert.equal(
    f.db.all("main").filter((e) => e.type === "tool_result").length,
    1,
  );
  assert.ok(requests[1].messages.some((m: any) => m.role === "tool"));
  const captured = JSON.parse(
    await fs.readFile(
      path.join(host.root, ".runtime/requests/run-real/1.json"),
      "utf8",
    ),
  );
  assert.ok(
    captured.context.messages.some(
      (m: any) =>
        m.role === "system" &&
        JSON.stringify(m).includes("Test identity only."),
    ),
  );
  assert.ok(
    captured.context.messages.some((m: any) => m.role === "toolResult"),
  );
  assert.ok(
    captured.context.messages.some(
      (m: any) => m.role === "system" && JSON.stringify(m).includes("write"),
    ),
  );

  await exec.run({
    agentId: "main",
    runId: "new-run",
    context: {
      ...context,
      messages: [{ role: "user", content: "New supplied context only" }],
    },
    signal: new AbortController().signal,
  });
  assert.ok(!JSON.stringify(requests[2]).includes("Write the file."));
  assert.ok(JSON.stringify(requests[0]).includes("Test identity only."));
});

test("MCP stdio: discover and execute a real server tool", async (t) => {
  const { mcpTools } = await import("../src/layer4/mcp.js");
  const f = await fixture(t);
  const cfg = parseConfig({
    ...f.config.current,
    mcp: [
      {
        name: "test",
        command: process.execPath,
        args: [path.resolve("tests/fixtures/mcp-server.mjs")],
      },
    ],
  });
  const mcp = await mcpTools(cfg, new AbortController().signal);
  f.cleanup.push(() => mcp.close());
  assert.equal(mcp.tools[0].name, "mcp_test_echo");
  const value = await mcp.tools[0].execute("call", { text: "你好" });
  assert.equal((value.content[0] as any).text, "echo:你好");
});

test("mood follows run completion even if there is no delivered message", async (t) => {
  const f = await fixture(t);
  await f.config.save({
    ...f.config.current,
    state: { ...f.config.current.state, enabled: true },
  });
  let calls = 0;
  const brain = {
    ...llm,
    json: async () => {
      calls++;
      return { mood: 2, memory_mentions: [] };
    },
  };
  const rt = new Runtime(
    f.config,
    f.db,
    async () => {},
    brain,
    () => ({ run: async () => ({ ...complete(), reason: "silent" }) }),
  );
  await rt.start();
  f.cleanup.push(() => rt.stop());
  rt.ingress(event());
  rt.tick();
  await wait(() => calls === 1);
  await wait(
    () => !!f.db.db.prepare("SELECT id FROM runs WHERE status='silent'").get(),
  );
  await wait(
    () =>
      !!f.db.get(
        `moodDone:${String(f.db.db.prepare("SELECT id FROM runs WHERE status='silent'").get()!.id)}`,
        false,
      ),
  );
  const s = await rt.memories.get("main")!.state();
  assert.ok(s.mood > 71);
  assert.equal(
    f.db.db.prepare("SELECT count(*) AS n FROM deliveries").get()!.n,
    0,
  );
});

test("vector enrichment never blocks lexical recall behind an API request", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.config.agentRoot("main"), "memory.json"),
    JSON.stringify({
      memory: [
        {
          id: "m",
          occurred_at: "2026-01-01",
          summary: "苹果",
          details: "红苹果",
        },
      ],
    }),
  );
  let release: () => void = () => {},
    started = false;
  const brain = {
    ...llm,
    json: async () => {
      started = true;
      await new Promise<void>((r) => (release = r));
      return { search_text: "苹果" };
    },
  };
  const m = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    f.config.current,
    brain,
  );
  const job = m.sync(true);
  await wait(() => started);
  const read = await m.search("苹果", true);
  assert.equal(read[0].id, "m");
  release();
  await job;
  assert.equal((await m.index()).m.vectors.length, 1);
});

test("interrupted journal tail is preserved separately and next append remains valid", async (t) => {
  const f = await fixture(t);
  f.db.append(event("a"));
  const dir = path.join(f.config.agentRoot("main"), "history"),
    file = (await fs.readdir(dir)).find((n) => n.endsWith(".jsonl"))!;
  await fs.appendFile(path.join(dir, file), '{"partial":');
  f.db.append(event("b"));
  const lines = (await fs.readFile(path.join(dir, file), "utf8"))
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).event_id, "b");
  assert.ok((await fs.readdir(dir)).some((n) => n.includes(".torn-")));
});

test("agent memory, journal and target lookup remain separate", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "agents/other"), { recursive: true });
  await fs.writeFile(
    path.join(f.root, "agents/other/memory.json"),
    JSON.stringify({
      memory: [
        {
          id: "private",
          occurred_at: "2026-01-01",
          summary: "另一位知道的秘密",
          details: "only other",
        },
      ],
    }),
  );
  f.db.append({
    ...event("same-id"),
    agent_id: "other",
    text: "other history",
  });
  f.db.append(event("same-id"));
  const m = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    f.config.current,
    llm,
  );
  assert.equal((await m.search("秘密", true)).length, 0);
  assert.equal(f.db.all("main").length, 1);
  assert.equal(f.db.all("main")[0].text, "你好");
});

test("ready attachment uses original target, image appears once and trace excludes base64", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.config.agentRoot("main"), "attachments/image.png");
  await fs.writeFile(file, Buffer.from("test-image"));
  f.db.attachment({
    id: "pic",
    agent_id: "main",
    path: file,
    name: "image.png",
    mime: "image/png",
    status: "ready",
  });
  const a = f.db.append({ ...event("a"), attachments: ["pic"] });
  const b = f.db.append({
    ...event("b"),
    type: "attachment_ready",
    parent_event_id: "a",
    attachments: ["pic"],
  });
  const memory = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    f.config.current,
    llm,
  );
  const build = new ContextBuilder(
    f.db,
    f.config.current,
    f.config.current.agents[0],
    f.config.agentRoot("main"),
    path.join(f.root, "prompts"),
    new History(f.db, f.config.current, llm),
    memory,
  );
  const context = await build.build(
    [a, b],
    "image-run",
    new AbortController().signal,
  );
  assert.equal(context.target.conversation, "owner");
  const images = context.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((c) => c.type === "image") : [],
  );
  assert.equal(images.length, 1);
  const trace = await fs.readFile(
    path.join(f.config.agentRoot("main"), ".runtime/traces/image-run.json"),
    "utf8",
  );
  assert.ok(!trace.includes(Buffer.from("test-image").toString("base64")));
  const savedTrace = JSON.parse(trace);
  assert.equal(savedTrace.layer2.target.conversation, "owner");
  assert.deepEqual(savedTrace.layer2.trigger_ids, [a.event_id, b.event_id]);
  assert.equal(typeof savedTrace.layer2.history, "string");
  const { buildStylePrompt } = await import("../src/config/style-prompt.js");
  assert.ok(
    savedTrace.system.includes(
      "[Style]\n" + buildStylePrompt(f.config.current.style),
    ),
  );
});

test("outbox retries a definite failure without repeating acknowledged parts", async (t) => {
  const f = await fixture(t),
    registry = new ChannelRegistry(
      f.config.current,
      f.db,
      (a) => f.config.agentRoot(a),
      () => {},
    );
  let second = 0;
  const sent: string[] = [];
  registry.channels.set("local", {
    id: "local",
    send: async (_d, p) => {
      const text = p?.type === "text" ? p.text : "";
      if (text === "two" && second++ === 0)
        throw new SendFailure("rate limited", false);
      sent.push(text);
      return { message_id: text };
    },
  });
  const out = new Outbox(f.db, f.config.current, registry, () => {});
  out.queue({
    id: "retry",
    agent_id: "main",
    run_id: "r",
    response_id: "msg",
    chunk_index: 0,
    target: event().reply_target!,
    action: "send",
    parts: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
  });
  await out.tick();
  f.db.db.exec("UPDATE deliveries SET next_at=0");
  await out.tick();
  assert.deepEqual(sent, ["one", "two"]);
  assert.equal(
    f.db.db.prepare("SELECT status FROM deliveries").get()!.status,
    "sent",
  );
});

test("private co-location does not share experiences; explicit group messages do", async (t) => {
  const f = await fixture(t);
  const cfg = parseConfig({
    ...f.config.current,
    agents: [
      ...f.config.current.agents,
      {
        id: "second",
        name: "Second",
        defaultTarget: event().reply_target!,
        routes: [{ ...event().reply_target!, kind: "group" }],
      },
    ],
  });
  const seen: EventInput[] = [];
  const registry = new ChannelRegistry(
    cfg,
    f.db,
    (a) => path.join(f.root, "agents", a),
    (e) => seen.push(e),
  );
  await registry.start();
  f.cleanup.push(() => registry.stop());
  const out = new Outbox(f.db, cfg, registry, (e) => seen.push(e));
  const send = (id: string, kind: "private" | "group") =>
    out.queue({
      id,
      agent_id: "main",
      run_id: "r",
      response_id: id,
      chunk_index: 0,
      target: { ...event().reply_target!, kind },
      action: "send",
      parts: [{ type: "text", text: "hello" }],
    });
  send("private", "private");
  await out.tick();
  assert.equal(seen.length, 0);
  send("group", "group");
  await out.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agent_id, "second");
});

test("configuration save cannot relocate a live runtime, concurrent revision writes conflict", async (t) => {
  const f = await fixture(t);
  const rt = new Runtime(f.config, f.db, async () => {}, llm);
  const original = rt.agentRoot("main"),
    revision = f.config.revision;
  const saves = await Promise.allSettled([
    f.config.save({ ...f.config.current, agentsDir: "new-agents" }, revision),
    f.config.save({ ...f.config.current, agentsDir: "another" }, revision),
  ]);
  assert.equal(saves.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal(rt.agentRoot("main"), original);
});

test("Pi can end silently and cancel streamed partial output", async (t) => {
  const f = await fixture(t);
  let started: () => void = () => {};
  let streaming = false;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta: any, finish: any = null) =>
      res.write(
        "data: " +
          JSON.stringify({
            id: "s",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock",
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          "\n\n",
      );
    emit({ role: "assistant" });
    if (streaming) {
      emit({ content: "还没说完" });
      started();
    } else {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "silent",
            type: "function",
            function: { name: "finish_without_reply", arguments: "{}" },
          },
        ],
      });
      emit({}, "tool_calls");
      res.end("data: [DONE]\n\n");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const cfg = parseConfig({
    ...f.config.current,
    models: {
      ...f.config.current.models,
      main: {
        ...f.config.current.models.main,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        apiKeyEnv: "TEST_MODEL_KEY",
      },
    },
  });
  process.env.TEST_MODEL_KEY = "test";
  const sent: any[] = [];
  const host: ToolHost = {
    cfg,
    db: f.db,
    agent: cfg.agents[0],
    root: f.config.agentRoot("main"),
    memory: new MemoryService(
      f.config.agentRoot("main"),
      "main",
      f.db,
      cfg,
      llm,
    ),
    target: event().reply_target!,
    send: (p) => sent.push(p),
    silent: () => {},
    restartScheduler: async () => {},
  };
  const executor = new PiExecutor(host, llm, (e) =>
    f.db.append({
      protocol_version: 1,
      agent_id: "main",
      source: "layer4",
      attachments: [],
      data: {},
      ...e,
    }),
  );
  const context = {
    system: "test",
    messages: [{ role: "user" as const, content: "test" }],
    target: event().reply_target!,
    memories: [],
    inputText: "test",
  };
  assert.equal(
    (
      await executor.run({
        agentId: "main",
        runId: "silent",
        context,
        signal: new AbortController().signal,
      })
    ).reason,
    "silent",
  );
  assert.equal(sent.length, 0);
  streaming = true;
  const controller = new AbortController(),
    begun = new Promise<void>((r) => (started = r));
  const job = executor.run({
    agentId: "main",
    runId: "abort",
    context,
    signal: controller.signal,
  });
  await begun;
  controller.abort();
  assert.equal((await job).reason, "cancelled");
  assert.equal(sent.length, 0);
});

test("official Pi tools support shell, content search and file edits in workspace", async (t) => {
  const f = await fixture(t);
  const { createCodingTools, createGrepTool, createFindTool } =
    await import("@earendil-works/pi-coding-agent");
  const cwd = path.join(f.config.agentRoot("main"), "workspace");
  const tools = createCodingTools(cwd);
  await tools
    .find((x) => x.name === "write")!
    .execute("write", { path: "note.txt", content: "alpha beta\n" });
  const grep = await createGrepTool(cwd).execute("grep", {
    pattern: "alpha",
    path: ".",
  });
  assert.match(JSON.stringify(grep), /alpha/);
  const find = await createFindTool(cwd).execute("find", {
    pattern: "*.txt",
    path: ".",
  });
  assert.match(JSON.stringify(find), /note.txt/);
  await tools
    .find((x) => x.name === "edit")!
    .execute("edit", {
      path: "note.txt",
      edits: [{ oldText: "alpha", newText: "gamma" }],
    });
  const bash = await tools
    .find((x) => x.name === "bash")!
    .execute("bash", { command: "cat note.txt", timeout: 5 });
  assert.match(JSON.stringify(bash), /gamma beta/);
});

test("admin console: recent timeline, tool records, request snapshots and agent boundary", async (t) => {
  const f = await fixture(t);
  process.env.HINENI_TOKEN = "test-admin-console-token-123456789";
  const runtime = new Runtime(f.config, f.db, async () => {}, llm);
  const server = await servers(
    f.config,
    runtime,
    new Scheduler(f.config, f.db),
  );
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  for (let n = 0; n < 510; n++) f.db.append(event("history-" + n));
  const recent = await server.api.inject({
    url: "/v1/agents/main/timeline?limit=10",
    headers,
  });
  assert.equal(recent.json().items.length, 10);
  assert.equal(recent.json().items.at(-1).event_id, "history-509");
  const trigger = f.db.append(event("tool-trigger"));
  f.db.claim("main", [trigger], "inspect-run");
  f.db.append({
    ...event("call"),
    type: "tool_call",
    run_id: "inspect-run",
    text: '{"tool":"bash","args":{"command":"echo hi"}}',
  });
  f.db.append({
    ...event("result"),
    type: "tool_result",
    run_id: "inspect-run",
    text: "hi",
  });
  const dir = path.join(f.root, "agents/main/.runtime/requests/inspect-run");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "0.json"),
    JSON.stringify({ context: { systemPrompt: "own context", messages: [] } }),
  );
  const detail = await server.api.inject({
    url: "/v1/agents/main/runs/inspect-run",
    headers,
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(
    detail.json().events.filter((e: any) => e.type.startsWith("tool_")).length,
    2,
  );
  const context = await server.api.inject({
    url: "/v1/agents/main/runs/inspect-run/context",
    headers,
  });
  assert.match(context.json().content, /own context/);
  assert.equal(
    (
      await server.api.inject({
        url: "/v1/agents/other/runs/inspect-run/context",
        headers,
      })
    ).statusCode,
    400,
  );
});

test("admin file editor: traversal and links blocked, conflicts detected, archived Skills stay removed", async (t) => {
  const f = await fixture(t);
  const { AdminFiles } = await import("../src/admin/files.js");
  const files = new AdminFiles(f.config);
  await assert.rejects(files.read("../outside"));
  await assert.rejects(files.read(".env"));
  const secret = path.join(f.root, "secret.txt");
  await fs.writeFile(secret, "private");
  await fs.symlink(secret, path.join(f.root, "agents/main/workspace/link.txt"));
  await assert.rejects(files.read("agents/main/workspace/link.txt"));
  const current = await files.read("agents/main/persona.md");
  await files.write(current.path, "updated", current.version);
  await assert.rejects(files.write(current.path, "stale", current.version));
  const updated = await files.read(current.path);
  const writes = await Promise.allSettled([
    files.write(current.path, "writer one", updated.version),
    files.write(current.path, "writer two", updated.version),
  ]);
  assert.equal(writes.filter((x) => x.status === "fulfilled").length, 1);
  await assert.rejects(
    files.install("main", "bad", [
      { path: "SKILL.md", content: "ok" },
      { path: "../escape", content: "bad" },
    ]),
  );
  await files.install("main", "sample", [
    { path: "SKILL.md", content: "---\nname: sample\ndescription: test\n---" },
    { path: "scripts/helper.py", content: "print(1)" },
  ]);
  assert.match(
    (await files.read("agents/main/skills/sample/scripts/helper.py")).content,
    /print/,
  );
  await files.removeSkill("main", "personal-memory");
  await initialize(f.root);
  await assert.rejects(
    fs.access(path.join(f.root, "agents/main/skills/personal-memory/SKILL.md")),
  );
  await assert.rejects(files.write("agents/main/history/x.jsonl", "bad"));
});

test("admin credentials never echo values; model discovery uses configured endpoint; restart delegates", async (t) => {
  const f = await fixture(t);
  process.env.HINENI_TOKEN = "test-admin-console-token-123456789";
  let restarted = 0;
  const runtime = new Runtime(f.config, f.db, async () => {}, llm);
  const server = await servers(
    f.config,
    runtime,
    new Scheduler(f.config, f.db),
    {
      restart: async () => {
        restarted++;
      },
      status: () => ({ restarting: false }),
    },
  );
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  const secret = "fake-new-model-key-23456789";
  const saved = await server.api.inject({
    method: "PUT",
    url: "/v1/credentials",
    headers,
    payload: { name: "MODEL_TEST_KEY", value: secret },
  });
  assert.equal(saved.statusCode, 200);
  assert.ok(!saved.body.includes(secret));
  const credentials = await server.api.inject({
    url: "/v1/credentials",
    headers,
  });
  assert.ok(!credentials.body.includes(secret));
  assert.ok(
    credentials
      .json()
      .some((v: any) => v.name === "MODEL_TEST_KEY" && v.configured),
  );
  let expectedSecret = secret;
  const provider = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + expectedSecret);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: "model-test", object: "model", owned_by: "test" }],
        object: "list",
      }),
    );
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => new Promise<void>((r) => provider.close(() => r())));
  const found = await server.api.inject({
    method: "POST",
    url: "/v1/models/discover",
    headers,
    payload: {
      baseUrl: "http://127.0.0.1:" + (provider.address() as any).port + "/v1",
      apiKeyEnv: "MODEL_TEST_KEY",
    },
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().models[0].id, "model-test");
  expectedSecret = "temporary-list-key-only";
  const temporary = await server.api.inject({
    method: "POST",
    url: "/v1/models/discover",
    headers,
    payload: {
      baseUrl: "http://127.0.0.1:" + (provider.address() as any).port + "/v1",
      apiKeyEnv: "MODEL_TEST_KEY",
      apiKey: expectedSecret,
    },
  });
  assert.equal(temporary.statusCode, 200);
  assert.ok(!temporary.body.includes(expectedSecret));
  assert.ok(
    !(await fs.readFile(path.join(f.root, ".env"), "utf8")).includes(
      expectedSecret,
    ),
  );

  assert.equal(
    (
      await server.api.inject({
        method: "POST",
        url: "/v1/service/restart",
        headers,
        payload: {},
      })
    ).statusCode,
    202,
  );
  assert.equal(restarted, 1);
});

test("managed restart reloads saved configuration without losing history", async (t) => {
  const f = await fixture(t);
  const freePort = async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as any).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  };
  const port = await freePort(),
    adminPort = await freePort();
  await f.config.save({
    ...f.config.current,
    server: { ...f.config.current.server, port, adminPort },
  });
  const { startManaged } = await import("../src/application.js");
  f.db.append(event("restart-history"));
  const service = await startManaged(f.root);
  f.cleanup.unshift(() => service.close());
  const app = service.app;
  const cfg = cloneForTest(app.runtime.cfg);
  cfg.style.casualSentences = 2;
  await app.config.save(cfg);
  await service.lifecycle.restart();
  await wait(() => service.app !== app, 10000);
  assert.equal(service.app.runtime.cfg.style.casualSentences, 2);
  assert.equal(
    service.app.runtime.db.getEvent("main", "restart-history")?.text,
    "你好",
  );
  assert.equal((service.lifecycle.status() as any).last_restart_error, null);
});
function cloneForTest<T>(value: T): T {
  return structuredClone(value);
}

test("history inspection is read-only; handoff snapshots preserve their original gap and agent boundary", async (t) => {
  const f = await fixture(t);
  const runtime = new Runtime(f.config, f.db, async () => {}, llm);
  const server = await servers(
    f.config,
    runtime,
    new Scheduler(f.config, f.db),
  );
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  const old = f.db.append({ ...event("preview-old"), text: "旧经历" });
  f.db.set("history:main", { through: old.seq, summary: "已存在的摘要" });
  f.db.append({ ...event("preview-new"), text: "保留这段原文" });
  f.db.append({
    ...event("preview-tool"),
    type: "tool_result",
    text: "工具结果".repeat(1000),
  });
  f.db.append({
    ...event("preview-delivery"),
    type: "delivery_result",
    text: "不进入压缩视图",
  });
  const before = f.db.get("history:main", {});
  const r = await server.api.inject({
    url: "/v1/agents/main/history-view?limit=80",
    headers,
  });
  assert.equal(r.statusCode, 200);
  const view = r.json();
  assert.equal(view.summary, "已存在的摘要");
  assert.equal(view.remaining_events, 2);
  assert.ok(view.total > 80);
  assert.equal(view.next_offset, 80);
  assert.equal(view.remaining.length, 80);
  assert.deepEqual(f.db.get("history:main", {}), before);
  f.db.append({ ...event("inspection-new-arrival"), text: "新到的消息" });
  const refreshed = (
    await server.api.inject({ url: "/v1/agents/main/history-view", headers })
  ).json();
  assert.equal(refreshed.remaining_events, 3);
  assert.ok(refreshed.remaining.includes("新到的消息"));

  const run = "handoff-view";
  f.db.db
    .prepare("INSERT INTO runs(id,agent_id,status,started_at) VALUES(?,?,?,?)")
    .run(run, "main", "complete", new Date().toISOString());
  const gap = { seconds_since_last_response: 123, last_response_id: "fixed" };
  await fs.mkdir(path.join(f.config.agentRoot("main"), ".runtime", "traces"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(f.config.agentRoot("main"), ".runtime", "traces", run + ".json"),
    JSON.stringify({
      layer2: {
        history: "真正交接的历史",
        conversation_context: gap,
        target: { channel: "local", conversation: "owner" },
        trigger_ids: ["preview-new"],
        through: old.seq,
      },
    }),
  );
  const snap = (
    await server.api.inject({ url: "/v1/agents/main/layer2-snapshot", headers })
  ).json();
  assert.equal(snap.history, "真正交接的历史");
  assert.deepEqual(snap.conversation_context, gap);
  assert.equal(snap.legacy, false);
  assert.equal(
    (
      await server.api.inject({
        url: "/v1/agents/unknown/history-view",
        headers,
      })
    ).statusCode,
    400,
  );
});

test("configuration guide covers executable fields and file catalog separates Skills from documents", async (t) => {
  const { fieldHelp } = await import("../src/config/help.js");
  const { fieldGuide, guideKey } = await import("../src/config/guide.js");
  const { describeFile } = await import("../src/admin/file-guide.js");
  for (const [group, fields] of Object.entries(fieldHelp))
    if (!["models", "paths"].includes(group))
      for (const key of Object.keys(fields))
        assert.ok(fieldGuide[group + "." + key], group + "." + key);
  assert.equal(
    guideKey("agents.1.overrides.models.emotion.name"),
    "model.name",
  );
  assert.equal(
    guideKey("agents.1.routes.0.conversation"),
    "target.conversation",
  );
  assert.equal(
    describeFile("agents/main/skills/personal-memory/SKILL.md").category,
    "skills",
  );
  assert.equal(describeFile("docs/config.schema.json").advanced, true);
  assert.equal(describeFile("agents/main/persona.md").category, "agent");
  const f = await fixture(t);
  const runtime = new Runtime(f.config, f.db, async () => {}, llm);
  const server = await servers(
    f.config,
    runtime,
    new Scheduler(f.config, f.db),
  );
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  const guide = (
    await server.api.inject({ url: "/v1/admin/guide", headers })
  ).json();
  assert.equal(guide.defaults.style.casualSentences, 3);
  assert.equal(guide.locations.config, path.resolve(f.config.file));
  assert.ok(
    guide.lessons["state.moodHalfLifeHours"].effect.includes("12 小时"),
  );
  assert.ok(
    guide.processes["state.moodHalfLifeHours"].steps.some((x: string) =>
      x.includes("2^("),
    ),
  );
  assert.match(guide.fields["target.conversation"], /chat ID/i);
  const list = (
    await server.api.inject({ url: "/v1/admin/files?agent=main", headers })
  ).json();
  assert.ok(
    list.some(
      (x: any) => x.path.endsWith("persona.md") && x.effect.includes("下一轮"),
    ),
  );
  const context = await import("../src/admin/ui-client.js");
  assert.match(context.client, /存储：config.yaml/);
});

test("configuration explanations cover every field and preserve executable style text", async () => {
  const { fieldGuide } = await import("../src/config/guide.js");
  const { fieldLessons } = await import("../src/config/learning.js");
  const { processingGuide } = await import("../src/config/processing-guide.js");
  const { buildStylePrompt } = await import("../src/config/style-prompt.js");
  const { describeFile } = await import("../src/admin/file-guide.js");
  for (const key of Object.keys(fieldGuide)) {
    const lesson = fieldLessons[key];
    assert.ok(
      lesson?.title && lesson.meaning && lesson.effect && lesson.when,
      key,
    );
    const process = processingGuide(key);
    assert.ok(process.steps.length >= 2 && process.code.length, key);
  }
  const cfg = parseConfig({
    channels: [{ id: "local", type: "webhook" }],
    agents: [
      {
        id: "main",
        name: "test",
        defaultTarget: { channel: "local", conversation: "owner" },
      },
    ],
  });
  const style = {
    ...cfg.style,
    casualSentences: 1,
    casualChars: 80,
    warmth: 0.2,
    humor: 0.6,
    directness: 0.8,
  };
  const result = buildStylePrompt(style);
  assert.match(result, /日常优先1句、约80字；复杂交付按需展开/);
  assert.match(result, /亲和倾向: 较少/);
  assert.match(result, /幽默倾向: 适中/);
  assert.match(result, /直接表达倾向: 较强/);
  const memory = describeFile("agents/main/memory.json");
  assert.ok(memory.steps.some((x) => x.includes(".runtime/search-index.json")));
  assert.ok(memory.fields.importance.includes("1–5"));
  const { client } = await import("../src/admin/ui-client.js");
  new Function(client);
  assert.ok(!client.includes("暂存、保存、生效是三件事"));
  assert.ok(!client.includes("saveGuide()"));
  assert.ok(client.includes("class:'action-help'"));
});

test("streamed list numbering stays attached to its item", () => {
  const emitted: string[] = [];
  const c = new Chunker((text) => emitted.push(text));
  c.push("步骤如下：\n");
  for (const delta of [
    "1.",
    " ",
    "第一项。",
    "\n2.",
    "\n",
    "第二项。",
    "\n3)",
    " ",
    "第三项。",
  ])
    c.push(delta);
  c.flush();
  assert.deepEqual(emitted, [
    "步骤如下：",
    "1. 第一项。",
    "2.\n第二项。",
    "3) 第三项。",
  ]);
  assert.ok(emitted.every((text) => !/^\d+[.)、]$/.test(text)));
});

test("interruption physically removes unhanded replies only in the same agent and conversation", async (t) => {
  const f = await fixture(t);
  const registry = new ChannelRegistry(
    f.config.current,
    f.db,
    (a) => f.config.agentRoot(a),
    () => {},
  );
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  registry.channels.set("local", {
    id: "local",
    send: async (_d, p) => {
      entered = true;
      await gate;
      sent.push(p?.type === "text" ? p.text : "");
      return { message_id: String(sent.length) };
    },
  });
  const out = new Outbox(f.db, f.config.current, registry, () => {});
  const delivery = (
    id: string,
    text: string,
    extra: Partial<Delivery> = {},
  ): Delivery => ({
    id,
    agent_id: "main",
    run_id: "run-old",
    response_id: "response-old",
    chunk_index: 0,
    action: "send",
    target: event().reply_target!,
    parts: [{ type: "text", text }],
    ...extra,
  });
  out.queue(
    delivery("started", "ALREADY_HANDED", {
      parts: [
        { type: "text", text: "ALREADY_HANDED" },
        { type: "text", text: "SECOND_PART_OF_STARTED" },
      ],
    }),
  );
  out.queue(delivery("unhanded-unique-id", "SECRET_UNSENT_BODY"));
  out.queue(
    delivery("different-chat", "OTHER_CHAT", {
      run_id: "run-other",
      target: { channel: "local", conversation: "elsewhere" },
    }),
  );
  out.queue(
    delivery("different-thread", "OTHER_THREAD", {
      run_id: "run-thread",
      target: { channel: "local", conversation: "owner", thread: "2" },
    }),
  );
  out.queue(
    delivery("different-agent", "OTHER_AGENT", {
      agent_id: "other",
      run_id: "run-other-agent",
    }),
  );
  f.db.append({
    ...event("tool-remains"),
    type: "tool_result",
    run_id: "run-old",
    text: "Actual tool work",
  });
  f.db.append({
    ...event("old-finished"),
    type: "run_finished",
    run_id: "run-old",
    text: JSON.stringify(complete("ALREADY_HANDED\nSECRET_UNSENT_BODY")),
  });
  const dropped = f.db.getEvent("main", "unhanded-unique-id")!;
  f.db.set("history:main", {
    through: dropped.seq,
    summary: "SECRET_UNSENT_BODY",
  });
  const rtDir = path.join(f.root, "agents/main/.runtime");
  await fs.mkdir(path.join(rtDir, "requests/run-old"), { recursive: true });
  await fs.mkdir(path.join(rtDir, "requests/run-new"), { recursive: true });
  await fs.writeFile(
    path.join(rtDir, "requests/run-old/0.json"),
    JSON.stringify({ text: "SECRET_UNSENT_BODY" }),
  );
  await fs.writeFile(
    path.join(rtDir, "requests/run-new/0.json"),
    JSON.stringify({ history: "event=unhanded-unique-id SECRET_UNSENT_BODY" }),
  );
  const sending = out.tick();
  await wait(() => entered);
  f.db.purgeUnsent("main", event().reply_target!);
  assert.equal(f.db.getEvent("main", "unhanded-unique-id"), undefined);
  assert.equal(
    f.db.db
      .prepare("SELECT id FROM deliveries WHERE id=?")
      .get("unhanded-unique-id"),
    undefined,
  );
  for (const id of [
    "started",
    "different-chat",
    "different-thread",
    "tool-remains",
  ])
    assert.ok(f.db.getEvent("main", id));
  assert.ok(f.db.getEvent("other", "different-agent"));
  assert.equal(f.db.get("history:main", null), null);
  assert.equal(f.db.get("history-revision:main", 0), 1);
  assert.ok(
    !f.db.getEvent("main", "old-finished")!.text.includes("SECRET_UNSENT_BODY"),
  );
  assert.ok(
    !JSON.stringify([
      ...new Journal(path.join(f.root, "agents")).read("main"),
    ]).includes("SECRET_UNSENT_BODY"),
  );
  await assert.rejects(fs.access(path.join(rtDir, "requests/run-old/0.json")));
  await assert.rejects(fs.access(path.join(rtDir, "requests/run-new/0.json")));
  release();
  await sending;
  assert.deepEqual(sent, ["ALREADY_HANDED", "SECOND_PART_OF_STARTED"]);
  assert.equal(
    (
      f.db.db
        .prepare("SELECT status FROM deliveries WHERE id='started'")
        .get() as any
    ).status,
    "sent",
  );
  f.db.rebuild(["main"]);
  out.recover();
  assert.equal(f.db.getEvent("main", "unhanded-unique-id"), undefined);
  assert.equal(
    f.db.db
      .prepare("SELECT id FROM deliveries WHERE id=?")
      .get("unhanded-unique-id"),
    undefined,
  );
});

test("new ingress cancels generation immediately, removes queued text, and duplicates do not cancel newer replies", async (t) => {
  const f = await fixture(t);
  let starts = 0,
    aborted = false;
  const contexts: string[] = [];
  const factory: ExecutorFactory = (host, _llm, record) => ({
    run: async (req) => {
      contexts.push(JSON.stringify(req.context.messages));
      starts++;
      if (starts === 1) {
        host.send(
          [{ type: "text", text: "SHOULD_NEVER_BE_SEEN" }],
          req.context.target,
          "first",
        );
        record({
          event_id: "work-done",
          type: "tool_result",
          run_id: req.runId,
          text: "TOOL_RESULT_KEPT",
        });
        await new Promise<void>((resolve) =>
          req.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        host.send(
          [{ type: "text", text: "LATE_TEXT" }],
          req.context.target,
          "late",
        );
        return { ...complete("SHOULD_NEVER_BE_SEEN"), reason: "cancelled" };
      }
      host.send(
        [{ type: "text", text: "NEW_REPLY" }],
        req.context.target,
        "new",
      );
      return complete("NEW_REPLY");
    },
  });
  const rt = new Runtime(f.config, f.db, async () => {}, llm, factory);
  f.cleanup.push(() => rt.stop());
  rt.ingress(event("first-input"));
  rt.tick();
  await wait(() => starts === 1);
  rt.ingress(event("interrupting-input"));
  assert.equal(aborted, true);
  await wait(() => {
    rt.tick();
    return starts === 2;
  });
  await wait(() => rt.status().active.length === 0);
  assert.ok(!contexts[1].includes("SHOULD_NEVER_BE_SEEN"));
  assert.ok(contexts[1].includes("TOOL_RESULT_KEPT"));
  rt.ingress(event("interrupting-input"));
  assert.ok(f.db.all("main").some((e) => e.text === "NEW_REPLY"));
  const stored = JSON.stringify(f.db.all("main"));
  assert.ok(!stored.includes("SHOULD_NEVER_BE_SEEN"));
  assert.ok(!stored.includes("LATE_TEXT"));
  const raw = JSON.stringify([
    ...new Journal(path.join(f.root, "agents")).read("main"),
  ]);
  assert.ok(!raw.includes("SHOULD_NEVER_BE_SEEN"));
});

test("handoff survives failure and manual retry; unfinished deletion resumes before rebuild", async (t) => {
  const f = await fixture(t);
  const registry = new ChannelRegistry(
    f.config.current,
    f.db,
    (a) => f.config.agentRoot(a),
    () => {},
  );
  registry.channels.set("local", {
    id: "local",
    send: async () => {
      throw new SendFailure("definite failure");
    },
  });
  const out = new Outbox(f.db, f.config.current, registry, () => {});
  const d: Delivery = {
    id: "retry-me",
    agent_id: "main",
    run_id: "r",
    response_id: "r:0",
    chunk_index: 0,
    target: event().reply_target!,
    action: "send",
    parts: [{ type: "text", text: "HANDED_ONCE" }],
  };
  out.queue(d);
  await out.tick();
  f.db.deliveryUpdate(d.id, "queued", 0, 0);
  f.db.purgeUnsent("main", d.target);
  assert.ok(f.db.getEvent("main", d.id));
  out.queue({
    ...d,
    id: "remove-after-crash",
    parts: [{ type: "text", text: "CRASH_PENDING" }],
  });
  f.db.set("prune-outbox:main", {
    agent: "main",
    ids: ["remove-after-crash"],
    runs: ["r"],
  });
  const journal = new Journal(path.join(f.root, "agents"));
  journal.prune("main", new Set(["remove-after-crash"]), new Map());
  const recovered = new Store(
    path.join(f.root, "data/runtime.sqlite"),
    journal,
  );
  try {
    recovered.rebuild(["main"]);
    assert.equal(recovered.getEvent("main", "remove-after-crash"), undefined);
    assert.equal(recovered.get("prune-outbox:main", null), null);
    assert.ok(recovered.getEvent("main", d.id));
  } finally {
    recovered.close();
  }
});

test("invalid memory edits retain the existing index across process restart", async (t) => {
  const f = await fixture(t);
  const root = path.join(f.root, "agents/main");
  await fs.writeFile(
    path.join(root, "memory.json"),
    JSON.stringify({
      memory: [
        { id: "keep", occurred_at: "2026-01-01", summary: "保留这条记忆" },
      ],
    }),
  );
  const memory = new MemoryService(root, "main", f.db, f.config.current, llm);
  await memory.sync(false);
  const before = f.db.get("index:main", {});
  await fs.writeFile(path.join(root, "memory.json"), "{");
  const restarted = new MemoryService(
    root,
    "main",
    f.db,
    f.config.current,
    llm,
  );
  await restarted.sync(false);
  assert.deepEqual(f.db.get("index:main", {}), before);
});

test("invalid token chunk budgets fail instead of entering a non-progressing loop", async () => {
  const { chunks } = await import("../src/shared/tokens.js");
  assert.throws(() => chunks("text", -1, 0));
  assert.throws(() => chunks("text", 4, 4));
});

test("emergency compaction removes the oversized original", async (t) => {
  const f = await fixture(t);
  let body: any;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const cfg = structuredClone(f.config.current);
  cfg.models.main = {
    ...cfg.models.main,
    baseUrl: "http://127.0.0.1:" + (server.address() as any).port + "/v1",
    contextWindow: 100000,
  };
  cfg.runtime.toolsEnabled = false;
  cfg.runtime.mcpEnabled = false;
  cfg.mcp = [
    {
      name: "unreachable",
      enabled: true,
      command: "/missing-test-command",
      args: [],
      env: {},
    },
  ];
  const a = cfg.agents[0],
    root = path.join(f.root, "agents/main");
  const host: ToolHost = {
    db: f.db,
    cfg,
    agent: a,
    root,
    target: a.defaultTarget,
    memory: new MemoryService(root, a.id, f.db, cfg, llm),
    send: () => {},
    silent: () => {},
    restartScheduler: async () => {},
    env: { OPENAI_API_KEY: "test-key" },
  };
  const result = await new PiExecutor(host, llm, () => {}).run({
    agentId: a.id,
    runId: "compaction-check",
    signal: new AbortController().signal,
    context: {
      system: "System rules",
      messages: [
        {
          role: "user",
          content: "oversized original " + "long ".repeat(110000),
        },
      ],
      memories: [],
      target: a.defaultTarget,
      inputText: "current trigger",
    },
  });
  assert.equal(result.reason, "complete");
  assert.ok(body);
  assert.ok(JSON.stringify(body).length < 20000);
  assert.ok(!JSON.stringify(body).includes("oversized original"));
});

test("selected deletion removes only chosen second-layer records and preserves context files", async (t) => {
  const f = await fixture(t);
  const root = f.config.agentRoot("main");
  const file = path.join(root, "attachments", "first");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "private attachment");
  await fs.writeFile(file + ".json", "{}");
  f.db.attachment({
    id: "first",
    agent_id: "main",
    path: file,
    name: "first",
    mime: "text/plain",
    status: "ready",
  });
  f.db.append({
    ...event("remove-me"),
    text: "unique deleted history text 123",
    attachments: ["first"],
  });
  f.db.append({ ...event("keep-me"), text: "unrelated retained message" });
  f.db.set("history:main", { through: 1, summary: "independent summary" });
  const related = path.join(root, ".runtime", "traces", "related.json");
  const unrelated = path.join(root, ".runtime", "traces", "unrelated.json");
  await fs.mkdir(path.dirname(related), { recursive: true });
  await fs.writeFile(
    related,
    JSON.stringify({ history: "remove-me unique deleted history text 123" }),
  );
  await fs.writeFile(
    unrelated,
    JSON.stringify({ history: "keep-me unrelated retained message" }),
  );
  const request = path.join(root, ".runtime", "requests", "test-run", "0.json");
  await fs.mkdir(path.dirname(request), { recursive: true });
  await fs.writeFile(request, JSON.stringify({ history: "remove-me" }));
  const result = f.db.eraseEvents("main", ["remove-me"]);
  assert.equal(result.deleted_events, 1);
  assert.deepEqual(
    f.db.all("main").map((e) => e.event_id),
    ["keep-me"],
  );
  assert.deepEqual(
    [...new Journal(path.join(f.root, "agents")).read("main")].map(
      (e) => e.event_id,
    ),
    ["keep-me"],
  );
  assert.equal(
    f.db.get("history:main", { through: 0, summary: "" }).summary,
    "independent summary",
  );
  assert.equal(f.db.getAttachment("main", "first"), undefined);
  await assert.rejects(fs.stat(file));
  assert.ok((await fs.stat(related)).isFile());
  assert.ok((await fs.stat(unrelated)).isFile());
  assert.ok((await fs.stat(request)).isFile());
  assert.equal(f.db.get("history-revision:main", 0), 1);
  f.db.clearSummary("main");
  assert.deepEqual(f.db.get("history:main", {}), {});
  assert.equal(f.db.get("history-revision:main", 0), 2);
});

test("deleting a reply removes its queued send and rewrites the retained run result", async (t) => {
  const f = await fixture(t);
  const trigger = f.db.append(event("trigger"));
  f.db.claim("main", [trigger], "run-one");
  const delivery = (id: string): Delivery => ({
    id,
    agent_id: "main",
    run_id: "run-one",
    response_id: "response",
    chunk_index: 0,
    target: event().reply_target!,
    action: "send",
    parts: [{ type: "text", text: id }],
  });
  const first = delivery("first-reply"),
    second = delivery("second-reply");
  f.db.append({
    ...event(first.id),
    type: "agent_reply",
    run_id: "run-one",
    text: "delete this reply",
    data: { delivery: first },
  });
  f.db.append({
    ...event(second.id),
    type: "agent_reply",
    run_id: "run-one",
    text: "keep this reply",
    data: { delivery: second },
  });
  f.db.enqueue(first);
  f.db.enqueue(second);
  f.db.append({
    ...event("done"),
    type: "run_finished",
    run_id: "run-one",
    text: JSON.stringify({
      reason: "complete",
      text: "delete this reply\nkeep this reply",
    }),
  });
  f.db.eraseEvents("main", [first.id]);
  assert.equal(
    f.db.db.prepare("SELECT id FROM deliveries WHERE id=?").get(first.id),
    undefined,
  );
  assert.ok(
    f.db.db.prepare("SELECT id FROM deliveries WHERE id=?").get(second.id),
  );
  assert.equal(
    JSON.parse(f.db.getEvent("main", "done")!.text).text,
    "keep this reply",
  );
  assert.equal(f.db.getEvent("main", "trigger")?.event_id, "trigger");
  assert.equal(
    [...new Journal(path.join(f.root, "agents")).read("main")].find(
      (e) => e.event_id === "done",
    )?.text,
    JSON.stringify({ reason: "complete", text: "keep this reply" }),
  );
});

test("all-history deletion is scoped to one agent and recovery cannot restore it", async (t) => {
  const f = await fixture(t);
  const extra = { ...event("other-event"), agent_id: "other" };
  f.db.append(extra);
  const mainEvent = f.db.append(event("main-event"));
  f.db.claim("main", [mainEvent], "all-run");
  f.db.set("history:main", { through: 1, summary: "separate summary" });
  const persona = path.join(f.config.agentRoot("main"), "persona.md");
  const before = await fs.readFile(persona, "utf8");
  const trace = path.join(
    f.config.agentRoot("main"),
    ".runtime/traces/all-run.json",
  );
  await fs.mkdir(path.dirname(trace), { recursive: true });
  await fs.writeFile(trace, JSON.stringify({ history: "main-event" }));
  const request = path.join(
    f.config.agentRoot("main"),
    ".runtime/requests/all-run/0.json",
  );
  await fs.mkdir(path.dirname(request), { recursive: true });
  await fs.writeFile(request, JSON.stringify({ history: "main-event" }));
  f.db.eraseEvents("main", "all");
  assert.equal(f.db.all("main").length, 0);
  assert.equal(
    [...new Journal(path.join(f.root, "agents")).read("main")].length,
    0,
  );
  assert.equal(f.db.all("other").length, 1);
  assert.equal(
    f.db.get("history:main", { through: 0, summary: "" }).summary,
    "separate summary",
  );
  assert.ok((await fs.stat(trace)).isFile());
  assert.ok((await fs.stat(request)).isFile());
  assert.equal(
    f.db.db.prepare("SELECT id FROM runs WHERE agent_id=?").get("main"),
    undefined,
  );
  assert.equal(await fs.readFile(persona, "utf8"), before);
  f.db.rebuild(["main", "other"]);
  assert.equal(f.db.all("main").length, 0);
});

test("history deletion API rejects invalid scopes and keeps summary separate", async (t) => {
  const f = await fixture(t);
  process.env.HINENI_TOKEN = "test-token-long-enough-for-authentication";
  const runtime = new Runtime(f.config, f.db, async () => {}, llm);
  const scheduler = new Scheduler(f.config, f.db);
  const server = await servers(f.config, runtime, scheduler);
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  f.db.append(event("api-delete"));
  f.db.set("history:main", { through: 1, summary: "keep summary" });
  const url = "/v1/agents/main/history";
  (runtime as any).active.set("main", {
    controller: new AbortController(),
    promise: Promise.resolve(),
    runId: "busy",
  });
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url,
        headers,
        payload: { mode: "all" },
      })
    ).statusCode,
    409,
  );
  (runtime as any).active.delete("main");
  (runtime.outbox as any).sendingAgent = "main";
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url,
        headers,
        payload: { mode: "all" },
      })
    ).statusCode,
    409,
  );
  (runtime.outbox as any).sendingAgent = null;
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url,
        payload: { mode: "all" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url,
        headers,
        payload: { mode: "selected", event_ids: ["missing"] },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url,
        headers,
        payload: { mode: "all", event_ids: ["api-delete"] },
      })
    ).statusCode,
    400,
  );
  const result = await server.api.inject({
    method: "DELETE",
    url,
    headers,
    payload: { mode: "selected", event_ids: ["api-delete"] },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().deleted_events, 1);
  assert.equal(
    f.db.get("history:main", { through: 0, summary: "" }).summary,
    "keep summary",
  );
  const summary = await server.api.inject({
    method: "DELETE",
    url: "/v1/agents/main/history-summary",
    headers,
    payload: {},
  });
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(f.db.get("history:main", {}), {});
});

test("an interrupted deletion resumes before journal recovery", async (t) => {
  const f = await fixture(t);
  f.db.append(event("crash-delete"));
  const original = (f.db as any).journal.prune;
  (f.db as any).journal.prune = () => {
    throw Error("simulated interruption");
  };
  assert.throws(
    () => f.db.eraseEvents("main", ["crash-delete"]),
    /simulated interruption/,
  );
  (f.db as any).journal.prune = original;
  const oldTrace = path.join(
    f.config.agentRoot("main"),
    ".runtime/traces/old-intent.json",
  );
  await fs.mkdir(path.dirname(oldTrace), { recursive: true });
  await fs.writeFile(oldTrace, JSON.stringify({ history: "crash-delete" }));
  const pending = f.db.get("erase-events:main", { files: [] as string[] });
  f.db.set("erase-events:main", { ...pending, files: [oldTrace] });
  const reopened = new Store(
    path.join(f.root, "data/runtime.sqlite"),
    new Journal(path.join(f.root, "agents")),
  );
  reopened.rebuild(["main"]);
  assert.equal(reopened.all("main").length, 0);
  assert.equal(
    [...new Journal(path.join(f.root, "agents")).read("main")].length,
    0,
  );
  assert.equal(reopened.get("erase-events:main", null), null);
  assert.ok((await fs.stat(oldTrace)).isFile());
  reopened.close();
});

test("Responses Pi: reasoning + tools, callbacks, fresh session", async (t) => {
  const f = await fixture(t);
  let requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const payload = JSON.parse(raw);
    requests.push(payload);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    assert.equal(req.url, "/v1/responses");
    assert.equal(payload.store, false);
    assert.equal(payload.reasoning.effort, "low");
    assert.equal(payload.previous_response_id, undefined);
    assert.ok(
      payload.tools.some(
        (x: any) => x.type === "function" && x.name === "write",
      ),
    );
    const emit = (type: string, data: any) =>
      res.write(
        "event: " +
          type +
          "\n" +
          "data: " +
          JSON.stringify({ type, ...data }) +
          "\n\n",
      );
    const text = requests.length === 1 ? "好的。" : "完成了。";
    const message = {
      type: "message",
      id: "msg_" + requests.length,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    emit("response.output_item.added", {
      output_index: 0,
      item: { ...message, content: [] },
    });
    emit("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    emit("response.output_item.done", { output_index: 0, item: message });
    const output: any[] = [message];
    if (requests.length === 1) {
      const item = {
        type: "function_call",
        id: "fc_write",
        call_id: "call_write",
        name: "write",
        arguments: JSON.stringify({
          path: "result.txt",
          content: "real tool output",
        }),
        status: "completed",
      };
      emit("response.output_item.added", {
        output_index: 1,
        item: { ...item, arguments: "" },
      });
      emit("response.function_call_arguments.delta", {
        output_index: 1,
        delta: item.arguments,
      });
      emit("response.output_item.done", { output_index: 1, item });
      output.push(item);
    }
    emit("response.completed", {
      response: {
        id: "resp_" + requests.length,
        status: "completed",
        output,
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as any).port;
  process.env.TEST_MODEL_KEY = "fake-test-key";
  const cfg = parseConfig({
    ...f.config.current,
    models: {
      ...f.config.current.models,
      main: {
        ...f.config.current.models.main,
        name: "gpt-6-luna",
        protocol: "responses",
        reasoning: "low",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: "TEST_MODEL_KEY",
      },
    },
  });
  const sent: any[] = [];
  const host: ToolHost = {
    db: f.db,
    memory: new MemoryService(
      f.config.agentRoot("main"),
      "main",
      f.db,
      cfg,
      llm,
    ),
    cfg,
    agent: cfg.agents[0],
    root: f.config.agentRoot("main"),
    target: event().reply_target!,
    send: (parts, target, key, action, msg, emoji, meta) =>
      sent.push({ parts, meta }),
    silent: () => {},
    restartScheduler: async () => {},
  };
  const exec = new PiExecutor(host, llm, (e) =>
    f.db.append({
      protocol_version: 1,
      agent_id: "main",
      source: "layer4",
      attachments: [],
      data: {},
      ...e,
    }),
  );
  const context = {
    system: "Test identity only.",
    messages: [{ role: "user" as const, content: "Write the file." }],
    memories: [],
    target: event().reply_target!,
    inputText: "Write the file.",
  };
  const result = await exec.run({
    agentId: "main",
    runId: "run-real",
    context,
    signal: new AbortController().signal,
  });
  assert.equal(result.reason, "complete", result.error ?? "");
  assert.equal(
    await fs.readFile(path.join(host.root, "workspace/result.txt"), "utf8"),
    "real tool output",
  );
  assert.deepEqual(
    sent.map((s) => s.parts[0].text),
    ["好的。", "完成了。"],
  );
  assert.notEqual(sent[0].meta.responseId, sent[1].meta.responseId);
  assert.equal(
    f.db.all("main").filter((e) => e.type === "tool_result").length,
    1,
  );
  assert.ok(
    requests[1].input.some((m: any) => m.type === "function_call_output"),
  );
  const captured = JSON.parse(
    await fs.readFile(
      path.join(host.root, ".runtime/requests/run-real/1.json"),
      "utf8",
    ),
  );
  assert.ok(
    captured.context.messages.some(
      (m: any) =>
        m.role === "system" &&
        JSON.stringify(m).includes("Test identity only."),
    ),
  );
  assert.ok(
    captured.context.messages.some((m: any) => m.role === "toolResult"),
  );
  assert.ok(
    captured.context.messages.some(
      (m: any) => m.role === "system" && JSON.stringify(m).includes("write"),
    ),
  );

  await exec.run({
    agentId: "main",
    runId: "new-run",
    context: {
      ...context,
      messages: [{ role: "user", content: "New supplied context only" }],
    },
    signal: new AbortController().signal,
  });
  assert.ok(!JSON.stringify(requests[2]).includes("Write the file."));
  assert.ok(JSON.stringify(requests[0]).includes("Test identity only."));
});

test("context deletion selects snapshots independently of history and summary", async (t) => {
  const f = await fixture(t);
  process.env.HINENI_TOKEN = "test-token-long-enough-for-authentication";
  const runtime = new Runtime(f.config, f.db, async () => {}, llm);
  const server = await servers(
    f.config,
    runtime,
    new Scheduler(f.config, f.db),
  );
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  f.db.append(event("retained"));
  f.db.claim("main", [], "context-delete");
  f.db.finish("context-delete", "complete");
  f.db.set("history:main", { through: 1, summary: "keep" });
  const base = path.join(f.config.agentRoot("main"), ".runtime");
  const paths = [
    "requests/context-delete/0.json",
    "requests/context-delete/1.json",
    "traces/context-delete.json",
  ];
  for (const p of paths) {
    await fs.mkdir(path.dirname(path.join(base, p)), { recursive: true });
    await fs.writeFile(path.join(base, p), "{}");
  }
  const url = "/v1/agents/main/runs/context-delete/context";
  const remove = (payload: any) =>
    server.api.inject({ method: "DELETE", url, headers, payload });
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url,
        payload: { mode: "all" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await remove({ mode: "selected", request: "../0.json" })).statusCode,
    400,
  );
  assert.equal(
    (await remove({ mode: "selected", request: "999.json" })).statusCode,
    404,
  );
  (runtime as any).active.set("main", {
    controller: new AbortController(),
    promise: Promise.resolve(),
    runId: "context-delete",
  });
  assert.equal((await remove({ mode: "all" })).statusCode, 409);
  (runtime as any).active.delete("main");
  assert.equal(
    (await remove({ mode: "selected", request: "0.json" })).json()
      .deleted_snapshots,
    1,
  );
  await assert.rejects(fs.stat(path.join(base, paths[0])));
  assert.ok((await fs.stat(path.join(base, paths[1]))).isFile());
  assert.ok((await fs.stat(path.join(base, paths[2]))).isFile());
  assert.deepEqual(
    (await server.api.inject({ url, headers })).json().requests,
    ["1.json"],
  );
  assert.equal((await remove({ mode: "all" })).json().deleted_snapshots, 2);
  assert.equal(
    (await server.api.inject({ url, headers })).json().unavailable,
    true,
  );
  assert.equal(f.db.all("main").length, 1);
  assert.equal(f.db.get("history:main", { summary: "" }).summary, "keep");
  assert.ok(
    f.db.db.prepare("SELECT id FROM runs WHERE id=?").get("context-delete"),
  );
});

test("auxiliary JSON and compaction use selected protocol; Responses rejects incomplete output", async (t) => {
  const { OpenAIModels } = await import("../src/shared/models.js");
  const seen: any[] = [];
  let incomplete = false;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (body.text?.format?.type === "json_object") assert.match(JSON.stringify(body.input), /json/i);
    seen.push({ url: req.url, body });
    const text =
      body.text || body.response_format ? '{"queries":["test"]}' : "summary";
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/responses"
          ? {
              id: "resp_test",
              object: "response",
              status: incomplete ? "incomplete" : "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text, annotations: [] }],
                },
              ],
            }
          : {
              choices: [{ message: { content: text }, finish_reason: "stop" }],
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  for (const protocol of ["responses", "chat-completions"] as const) {
    const model = {
      protocol,
      name: "mock",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    };
    const cfg = parseConfig({
      agents: [{ id: "main", name: "Main", defaultTarget: {channel: "local", conversation: "owner"} }],
      channels: [{id: "local", type: "webhook"}],
      models: { main: model, fast: model },
    });
    const llm = new OpenAIModels(cfg, { OPENAI_API_KEY: "fake" });
    assert.deepEqual(await llm.json("query", {}), { queries: ["test"] });
    assert.equal(await llm.summarize("old text", 1000), "summary");
    for (const request of seen.slice(-2)) {
      assert.equal(
        request.url,
        protocol === "responses" ? "/v1/responses" : "/v1/chat/completions",
      );
      if (protocol === "responses") {
        assert.equal(request.body.store, false);
        assert.equal(request.body.previous_response_id, undefined);
      }
    }
    if (protocol === "responses") {
      incomplete = true;
      await assert.rejects(llm.json("query", {}), /Incomplete/);
      await assert.rejects(llm.summarize("old", 1000), /incomplete/);
      incomplete = false;
    }
  }
});
