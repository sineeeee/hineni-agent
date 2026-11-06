import { stateContext } from "../src/layer3/state-context.js";
import { parsePromptMapping } from "../src/config/prompt-mapping.js";
import { tokens } from "../src/shared/tokens.js";
import { OpenAIModels } from "../src/shared/models.js";
import { createTurnSpark, sparkContext } from "../src/layer3/spark.js";
import { modelCompat } from "../src/layer4/model-compat.js";
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
test("chunker keeps streamed closing quotes with their sentence", () => {
  const out: string[] = [];
  const c = new Chunker((s) => out.push(s));
  c.push("他说：“过来。");
  assert.deepEqual(out, []);
  c.push("”");
  assert.deepEqual(out, []);
  c.push("然后笑了。");
  assert.deepEqual(out, ["他说：“过来。”"]);
  c.flush();
  assert.deepEqual(out, ["他说：“过来。”", "然后笑了。"]);
  c.push("（就这样！");
  c.push("）下一句");
  assert.equal(out.at(-1), "（就这样！）");
  c.discard();
  c.push("最后一句。");
  c.flush();
  assert.equal(out.at(-1), "最后一句。");
});
test("chunker attaches punctuation and expressions across every streamed split", () => {
  for (const text of [
    "好呀！！ᢉ𐭩 下一句。",
    "收到。\n•ﻌ•\n继续。",
    "抱抱……Ი︵𐑼 好啦。",
    "Done! 👩‍💻 Next.",
    "好呀！(≧▽≦) 再见。",
    "他说：“好呀！！” 😊 下一句。",
  ])
    for (let split = 0; split <= text.length; split++) {
      const out: string[] = [],
        c = new Chunker((s) => out.push(s));
      c.push(text.slice(0, split));
      c.push(text.slice(split));
      c.flush();
      assert.equal(out.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
      assert.ok(
        out.every((x) => !/^[！!？?。”😊ᢉ•Ი]/u.test(x)),
        JSON.stringify({ text, split, out }),
      );
    }
  const out: string[] = [],
    c = new Chunker((s) => out.push(s));
  for (const char of "好呀！！ᢉ𐭩 下一句。") c.push(char);
  c.flush();
  assert.deepEqual(out, ["好呀！！ᢉ𐭩", "下一句。"]);
  const waiting: string[] = [],
    d = new Chunker((s) => waiting.push(s));
  d.push("好的。ᢉ");
  d.discard();
  d.flush();
  assert.deepEqual(waiting, []);
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
test("routine compaction failure retains history and retries next turn; hard limit and abort still fail", async (t) => {
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
  for (let i = 0; i < 8; i++)
    f.db.append({ ...event("retry" + i), text: "较早的经历 ".repeat(100) });
  f.db.set("history:main", { through: 0, summary: "已有摘要" });
  let fail = true,
    calls = 0;
  const h = new History(f.db, cfg, {
    ...llm,
    summarize: async () => {
      calls++;
      if (fail) throw Error("provider incomplete");
      return "新摘要";
    },
  });
  const view = await h.view("main");
  assert.match(view, /已有摘要/);
  assert.match(view, /较早的经历/);
  assert.equal(f.db.get("history:main", { through: 0 }).through, 0);
  assert.equal(f.db.all("main").length, 8);
  await assert.rejects(h.view("main", undefined, 800), /provider incomplete/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.view("main", controller.signal), /abort/i);
  fail = false;
  assert.match(await h.view("main"), /新摘要/);
  assert.ok(f.db.get("history:main", { through: 0 }).through > 0);
  const count = calls;
  await h.view("main");
  assert.equal(calls, count);
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
    llm,
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
  assert.match(result, /一般不超过1句、80字、3段/);
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
    assert.equal(payload.input[0].role, "system");
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
        compat: modelCompat({ baseUrl: "https://api.deepseek.com" }),
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
    messages: [
      { role: "user" as const, content: "Earlier question" },
      { role: "assistant" as const, content: "Earlier answer" },
      { role: "system" as const, content: "Runtime reference only." },
      { role: "user" as const, content: "Write the file." },
    ],
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
  for (const payload of requests) {
    const backgroundIndex = payload.input.findIndex((x: any) =>
      JSON.stringify(x.content ?? "").includes("Runtime reference only."),
    );
    assert.ok(
      backgroundIndex > 0,
      JSON.stringify(
        payload.input.map((x: any) => ({ role: x.role, type: x.type })),
      ),
    );
    assert.equal(payload.input[backgroundIndex].role, "system");
    assert.equal(payload.input[backgroundIndex - 1].role, "assistant");
    assert.equal(payload.input[backgroundIndex + 1].role, "user");
  }
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
  const orphan = path.join(base, "requests", "orphan-one");
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, "0.json"), "{}");
  const cleared = await server.api.inject({
    method: "DELETE",
    url: "/v1/agents/main/runs/orphan-one/context",
    headers,
    payload: { mode: "selected", request: "0.json" },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  const contexts = (
    await server.api.inject({
      url: "/v1/runs?agent=main&scope=context",
      headers,
    })
  ).json();
  assert.equal(
    contexts.some((r: any) => r.id === "orphan-one"),
    false,
  );
});

test("auxiliary JSON and compaction use selected protocol; Responses rejects incomplete output", async (t) => {
  const { OpenAIModels } = await import("../src/shared/models.js");
  const seen: any[] = [];
  let incomplete = false;
  let invalidSummary = false;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (body.text?.format?.type === "json_object")
      assert.match(
        JSON.stringify(body.input) + String(body.instructions ?? ""),
        /json/i,
      );
    seen.push({ url: req.url, body });
    const material =
      req.url === "/v1/responses" ? body.input : body.messages?.at(-1)?.content;
    const isSummary =
      typeof material === "string" &&
      material.includes("conversation_to_summarize");
    const text = isSummary
      ? invalidSummary
        ? '{"reply":"继续聊天"}'
        : '{"summary":"summary"}'
      : '{"queries":["test"]}';
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
      agents: [
        {
          id: "main",
          name: "Main",
          defaultTarget: { channel: "local", conversation: "owner" },
        },
      ],
      channels: [{ id: "local", type: "webhook" }],
      models: {
        main: { ...model, reasoning: "high" },
        summary: { ...model, reasoning: "off" },
        fast: { ...model, reasoning: "low" },
        emotion: { reasoning: "minimal" },
      },
    });
    assert.deepEqual(cfg.models.emotion, { reasoning: "minimal" });
    const llm = new OpenAIModels(cfg, { OPENAI_API_KEY: "fake" });
    assert.equal(llm.model("emotion").baseUrl, model.baseUrl);
    assert.deepEqual(await llm.json("query", {}), { queries: ["test"] });
    assert.equal(await llm.summarize("old text", 1000), "summary");
    const summaryBody = seen.at(-1).body;
    assert.equal(
      protocol === "responses"
        ? summaryBody.max_output_tokens
        : summaryBody.max_completion_tokens,
      cfg.models.main.maxOutput,
    );
    assert.equal(
      JSON.parse(
        protocol === "responses"
          ? summaryBody.input
          : summaryBody.messages.at(-1).content,
      ).conversation_to_summarize,
      "old text",
    );
    assert.equal(
      protocol === "responses"
        ? summaryBody.text.format.type
        : summaryBody.response_format.type,
      "json_object",
    );
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
    const effort = (request: any) =>
      protocol === "responses"
        ? request.body.reasoning?.effort
        : request.body.reasoning_effort;
    assert.equal(effort(seen.at(-2)), "low");
    assert.equal(effort(seen.at(-1)), undefined);
    await llm.json("emotion", {}, undefined, "emotion");
    assert.equal(effort(seen.at(-1)), "minimal");
    cfg.models.fast.reasoning = "off";
    cfg.models.main.reasoning = "off";
    await llm.json("query", {});
    await llm.summarize("text", 1000);
    assert.equal(effort(seen.at(-2)), undefined);
    assert.equal(effort(seen.at(-1)), undefined);
    invalidSummary = true;
    await assert.rejects(
      llm.summarize("user: continue the old conversation", 1000),
      /Invalid history summary/,
    );
    invalidSummary = false;
    if (protocol === "responses") {
      incomplete = true;
      await assert.rejects(llm.json("query", {}), /Incomplete/);
      await assert.rejects(llm.summarize("old", 1000), /incomplete/);
      incomplete = false;
    }
  }
});

test("context preserves dialogue roles, current trigger once last, and hides operational state", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.state.enabled = true;
  const old = f.db.append({ ...event("old-summary"), text: "old summarized" });
  f.db.set("history:main", { through: old.seq, summary: "older summary" });
  f.db.append({ ...event("previous-user"), text: "previous question" });
  f.db.append({
    ...event("previous-assistant"),
    type: "agent_reply",
    text: "previous answer",
    data: { delivery: { parts: [{ type: "text", text: "previous answer" }] } },
  });
  f.db.append({
    ...event("previous-answer-sent"),
    type: "delivery_result",
    text: "sent",
    data: { delivery_id: "previous-assistant", index: 0 },
  });
  f.db.append({
    ...event("previous-tool"),
    type: "tool_result",
    text: "tool evidence",
  });
  const current = f.db.append({
    ...event("latest-trigger"),
    text: "current question",
  });
  const memory = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    cfg,
    llm,
  );
  await memory.updateState((s) => {
    s.activation = { "internal-only-id": Date.now() };
    s.cause = "happy cause";
    s.focus_updated_at = new Date().toISOString();
  });
  const context = await new ContextBuilder(
    f.db,
    cfg,
    cfg.agents[0],
    f.config.agentRoot("main"),
    path.join(f.root, "prompts"),
    new History(f.db, cfg, llm),
    memory,
    llm,
  ).build([current], "ordered-context", new AbortController().signal);
  assert.match(
    String(context.messages.at(-2)?.content),
    /Background reference/,
  );
  assert.equal(context.messages.at(-2)?.role, "system");
  assert.match(String(context.messages.at(-2)?.content), /你自己的感受/);
  assert.match(String(context.messages.at(-2)?.content), /happy cause/);
  assert.doesNotMatch(
    String(context.messages.at(-2)?.content),
    /activation|internal-only-id|focus_updated_at|last_response_id/,
  );
  assert.match(String(context.messages[0].content), /older summary/);
  assert.equal(
    context.messages.find((m) => String(m.content).includes("previous answer"))
      ?.role,
    "assistant",
  );
  assert.match(
    String(
      context.messages.find((m) => String(m.content).includes("tool evidence"))
        ?.content,
    ),
    /Historical tool observation/,
  );
  assert.match(String(context.messages.at(-1)?.content), /current question/);
  assert.equal(
    JSON.stringify(context.messages).split("current question").length - 1,
    1,
  );
  assert.ok((await memory.state()).activation["internal-only-id"]);
});

test("query expansion preserves original input even when generated queries are empty", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.memory.query = true;
  cfg.memory.rerank = false;
  await fs.writeFile(
    path.join(f.config.agentRoot("main"), "memory.json"),
    JSON.stringify({
      memory: [
        {
          id: "m",
          occurred_at: "2026-01-01",
          summary: "旅行",
          details: "海边",
          importance: 3,
        },
      ],
    }),
  );
  let queries: string[] = [],
    seen: string[] = [];
  const memory = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    cfg,
    {
      ...llm,
      json: async () => ({ queries }),
      embed: async (texts) => {
        seen = texts;
        return [[1, 0]];
      },
    },
  );
  assert.deepEqual(await memory.recall("现在几点"), []);
  assert.deepEqual(seen, ["现在几点\n"]);
  queries = ["海边旅行"];
  await memory.recall("最新话题，附带很长的旧话题");
  assert.deepEqual(seen, ["最新话题，附带很长的旧话题\n海边旅行"]);
});

test("background vectorization reports partial failure, avoids duplicate work and retries missing items", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.memory.searchDescription = false;
  await fs.writeFile(
    path.join(f.config.agentRoot("main"), "memory.json"),
    JSON.stringify({
      memory: [
        { id: "one", occurred_at: "2026-01-01", summary: "one", importance: 3 },
        { id: "two", occurred_at: "2026-01-02", summary: "two", importance: 3 },
      ],
    }),
  );
  let release!: () => void,
    calls = 0,
    fail = true;
  const gate = new Promise<void>((r) => (release = r));
  const memory = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    cfg,
    {
      ...llm,
      embed: async (texts) => {
        calls++;
        await gate;
        if (texts[0].includes("two") && fail) throw Error("test failure");
        return texts.map(() => [1, 0]);
      },
    },
  );
  memory.startIndexing();
  memory.startIndexing();
  await wait(() => calls === 1);
  assert.equal((await memory.indexStatus()).status, "running");
  assert.equal((await memory.indexStatus()).ready, 0);
  release();
  await wait(() => calls === 2);
  await wait(() => !(memory as any).indexingTask);
  let s = await memory.indexStatus();
  assert.equal(s.status, "failed");
  assert.equal(s.ready, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.pending, 1);
  fail = false;
  memory.startIndexing();
  await wait(() => !(memory as any).indexingTask);
  s = await memory.indexStatus();
  assert.equal(s.status, "completed");
  assert.equal(s.ready, 2);
  assert.equal(calls, 3);
  memory.startIndexing();
  await wait(() => !(memory as any).indexingTask);
  assert.equal(calls, 3);
});

test("model history removes log headers, merges response chunks and preserves boundaries", async (t) => {
  const f = await fixture(t);
  const history = new History(f.db, f.config.current, llm);
  const first = f.db.append({
    ...event("private-first"),
    text: "你好",
    occurred_at: "2026-11-02T01:00:00Z",
  });
  for (const [id, text] of [
    ["chunk-1", "好的"],
    ["chunk-2", "我来看看"],
  ])
    f.db.append({
      ...event(id),
      type: "agent_reply",
      text,
      run_id: "run-1",
      data: { response_id: "response-1" },
      occurred_at: "2026-11-02T01:01:00Z",
    });
  f.db.append({
    ...event("tool-between"),
    type: "tool_result",
    text: "read result",
    occurred_at: "2026-11-02T01:01:01Z",
  });
  f.db.append({
    ...event("chunk-3"),
    type: "agent_reply",
    text: "看完了",
    run_id: "run-1",
    data: { response_id: "response-1" },
    occurred_at: "2026-11-02T01:01:02Z",
  });
  const latest = f.db.append({
    ...event("group-input"),
    text: "明天继续",
    reply_target: { channel: "telegram", conversation: "group", kind: "group" },
    sender: { id: "person-1", name: "小明", kind: "user" },
    reply_to_message_id: "42",
    occurred_at: "2026-11-03T01:00:00Z",
  });
  const messages = history.messages("main", [latest]);
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: "好的\n我来看看",
  });
  assert.equal(messages[3].content, "看完了");
  assert.match(String(messages[4].content), /2026-11-03 09:00/);
  assert.match(String(messages[4].content), /位置：telegram:group/);
  assert.match(String(messages[4].content), /发言人：小明/);
  assert.match(String(messages[4].content), /回复消息：42/);
  const serialized = JSON.stringify(messages);
  assert.doesNotMatch(
    serialized,
    /event=|platform_message=|source=|target=|private-first|response-1/,
  );
  assert.equal(serialized.split("明天继续").length - 1, 1);
  assert.match(history.render(first), /event=private-first/);
  assert.equal(f.db.all("main").length, 6);
  const view = await history.view("main");
  assert.doesNotMatch(view, /event=|platform_message=/);
  assert.match(view, /assistant: 好的/);
});

test("auxiliary files reload per call, overrides win, emotion scales and unknown names are explicit", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  const { auxiliaryPrompt, parseAuxiliary } =
    await import("../src/config/auxiliary.js");
  const file = path.join(f.config.agentRoot("main"), "prompts/auxiliary.yaml");
  assert.match(
    await auxiliaryPrompt(f.config.agentRoot("main"), cfg, "emotion"),
    /0–100/,
  );
  await fs.writeFile(file, "query: first\n");
  assert.equal(
    await auxiliaryPrompt(f.config.agentRoot("main"), cfg, "query"),
    "first",
  );
  await fs.writeFile(file, "query: second\n");
  assert.equal(
    await auxiliaryPrompt(f.config.agentRoot("main"), cfg, "query"),
    "second",
  );
  cfg.prompts.query = "override";
  assert.equal(
    await auxiliaryPrompt(f.config.agentRoot("main"), cfg, "query"),
    "override",
  );
  assert.throws(() => parseAuxiliary("typo: nope"));
  cfg.state.enabled = true;
  cfg.state.eventSensitivity = 2;
  cfg.state.moodDeltaLimit = 3;
  cfg.state.dimensionDeltaLimit = 5;
  let sent: any;
  const memory = new MemoryService(
    f.config.agentRoot("main"),
    "main",
    f.db,
    cfg,
    {
      ...llm,
      json: async (system, input) => {
        sent = { system, input };
        return {
          mood: 4,
          emotions: { 担忧: 4, 担心: 9 },
          drives: { closeness: 2 },
        };
      },
    },
  );
  await memory.afterRun(
    "emotion-test",
    { request: "做噩梦了", result: { text: "安慰" } },
    [],
  );
  const state = await memory.state();
  assert.match(sent.system, /不要自行乘/);
  assert.deepEqual(sent.input.policy.emotionLabels, cfg.state.emotionLabels);
  assert.ok(sent.input.policy.drives.closeness);
  assert.equal(sent.input.state.activation, undefined);
  assert.equal(sent.input.state.conversation_context, undefined);
  assert.ok(state.assessed_at);
  assert.ok(Math.abs(state.mood - (cfg.state.baseline + 3)) < 0.1);
  assert.ok(Math.abs(state.emotions.担忧 - 5) < 0.1);
  assert.equal(state.emotions.担心, undefined);
  const log = f.db.db
    .prepare(
      "SELECT data FROM logs WHERE component='mood' ORDER BY seq DESC LIMIT 1",
    )
    .get() as any;
  assert.match(JSON.stringify(log), /emotions.担心/);
});

test("one-time deadlines are absolute, disabled and past tasks skip, long waits rearm and cancellation stops", async () => {
  const { OnceTasksSchema, armOnceTasks, onceEventId } =
    await import("../src/once-tasks.js");
  const task = {
    id: "reminder",
    enabled: true,
    at: "2030-01-02T08:00:00+08:00",
    text: "提醒",
  };
  assert.throws(() =>
    OnceTasksSchema.parse({ tasks: [{ ...task, at: "2030-01-02T08:00:00" }] }),
  );
  assert.throws(() => OnceTasksSchema.parse({ tasks: [task, task] }));
  assert.equal(
    onceEventId("main", task),
    onceEventId("main", { ...task, at: "2030-01-02T00:00:00Z" }),
  );
  assert.notEqual(onceEventId("main", task), onceEventId("other", task));
  let now = Date.parse(task.at) - 3e9,
    seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>(),
    emitted: string[] = [];
  const clock = {
    now: () => now,
    set: (fn: () => void, ms: number) => {
      timers.set(++seq, { fn, ms });
      return seq;
    },
    clear: (id: number) => {
      timers.delete(id);
    },
  };
  const stop = armOnceTasks(
    [
      task,
      { ...task, id: "disabled", enabled: false },
      { ...task, id: "past", at: "2020-01-01T00:00:00Z" },
    ],
    async (t) => {
      emitted.push(t.id);
    },
    (e) => {
      throw e;
    },
    clock,
  );
  assert.equal(timers.size, 1);
  assert.equal(timers.get(1)!.ms, 2 ** 31 - 1);
  {
    const fn = timers.get(1)!.fn;
    timers.delete(1);
    fn();
  }
  assert.equal(emitted.length, 0);
  assert.equal(seq, 2);
  now = Date.parse(task.at);
  {
    const fn = timers.get(2)!.fn;
    timers.delete(2);
    fn();
  }
  await Promise.resolve();
  assert.deepEqual(emitted, ["reminder"]);
  stop();
  assert.equal(timers.size, 0);
  armOnceTasks(
    [task],
    async () => {
      throw Error("must skip past deadline");
    },
    () => {},
    clock,
  );
  assert.equal(timers.size, 0);
});

test("one-time scheduler posts normal events; invalid edits keep live schedule; restart skips past task", async (t) => {
  const f = await fixture(t);
  const accepted: any[] = [];
  const listener = http.createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    accepted.push({ url: req.url, body: JSON.parse(text) });
    res.end("{}");
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  f.cleanup.push(
    () => new Promise<void>((resolve) => listener.close(() => resolve())),
  );
  await fs.symlink(
    path.resolve("node_modules"),
    path.join(f.root, "node_modules"),
    "dir",
  );
  const port = (listener.address() as any).port;
  f.config.current.server.port = port;
  f.config.current.scheduler.enabled = true;
  await f.config.save(f.config.current);
  await fs.writeFile(
    path.join(f.config.agentRoot("main"), "schedule.ts"),
    "setInterval(()=>{}, 1000);",
  );
  const file = path.join(f.config.agentRoot("main"), "schedule.once.json");
  const task = {
    id: "wake",
    at: new Date(Date.now() + 1200).toISOString(),
    text: "提醒",
    enabled: true,
  };
  await fs.writeFile(file, JSON.stringify({ tasks: [task] }));
  const scheduler = new Scheduler(f.config, f.db);
  f.cleanup.push(() => scheduler.stop());
  await scheduler.start();
  await fs.writeFile(file, '{"tasks":[{"oops":1}]}');
  await assert.rejects(scheduler.restart("main"));
  assert.equal(scheduler.status().agents.main.running, true);
  await wait(() => accepted.length === 1);
  assert.equal(accepted[0].url, "/v1/events");
  assert.equal(accepted[0].body.type, "internal_event");
  assert.equal(accepted[0].body.agent_id, "main");
  assert.equal(accepted[0].body.data.kind, "once");
  await fs.writeFile(file, JSON.stringify({ tasks: [task] }));
  await scheduler.restart("main");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(accepted.length, 1);
});

test("existing installs gain auxiliary and once files without overwriting personal changes; admin validates both", async (t) => {
  const f = await fixture(t),
    root = f.config.agentRoot("main");
  const { AdminFiles } = await import("../src/admin/files.js");
  const { auxiliaryDefaults, parseAuxiliary } =
    await import("../src/config/auxiliary.js");
  assert.deepEqual(
    parseAuxiliary(await fs.readFile("prompts/auxiliary.yaml", "utf8")),
    auxiliaryDefaults,
  );
  await fs.unlink(path.join(root, "prompts/auxiliary.yaml"));
  await fs.unlink(path.join(root, "schedule.once.json"));
  await initialize(f.root);
  assert.match(
    await fs.readFile(path.join(root, "prompts/auxiliary.yaml"), "utf8"),
    /stateExpression/,
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(root, "schedule.once.json"), "utf8"),
    ),
    { tasks: [] },
  );
  const files = new AdminFiles(f.config),
    name = "agents/main/prompts/auxiliary.yaml";
  let file = await files.read(name);
  await assert.rejects(files.write(name, "emotion: []", file.version));
  file = await files.write(name, "emotion: 自定义判断规则\n", file.version);
  await initialize(f.root);
  assert.equal((await files.read(name)).content, "emotion: 自定义判断规则\n");
  const tasks = await files.read("agents/main/schedule.once.json");
  await assert.rejects(
    files.write(
      tasks.path,
      '{"tasks":[{"id":"bad","at":"no timezone","text":"x"}]}',
      tasks.version,
    ),
  );
  assert.deepEqual(JSON.parse((await files.read(tasks.path)).content), {
    tasks: [],
  });
});

test("natural state keeps numeric bookkeeping private and handles time/mood boundaries", async (t) => {
  const { stateContext, gapContext } =
    await import("../src/layer3/state-context.js");
  const { localMoment } = await import("../src/shared/time-context.js");
  const cfg = (await fixture(t)).config.current;
  cfg.state.enabled = true;
  cfg.scheduler.timezone = "Asia/Shanghai";
  const now = Date.parse("2026-11-03T02:34:00Z");
  const state = {
    updated_at: new Date(now).toISOString(),
    assessed_at: "2026-11-03T02:03:00Z",
    mood: 80,
    emotions: { 愉快: 3, 担忧: 72, 安心: 45, 旧名字: 100 },
    drives: {
      closeness: cfg.drives.closeness.baseline + 10,
      curiosity: cfg.drives.curiosity.baseline,
    },
    cause: "之前工作遇到阻碍",
    thoughts: [],
    focus: [],
    activation: { "private-id": now },
    conversation_context: { seconds_since_last_response: 1847 },
  };
  const prompt = stateContext(state, cfg, now);
  assert.match(prompt, /上午/);
  assert.match(prompt, /约 30 分钟/);
  assert.match(prompt, /不必重复上一段收尾/);
  assert.match(prompt, /明朗/);
  assert.match(prompt, /担忧非常明显，安心比较明显/);
  assert.match(prompt, /想亲近对方比平常更强/);
  assert.match(prompt, /早些时候.*10:03/);
  assert.doesNotMatch(
    prompt,
    /private-id|activation|80 \/ 100|旧名字|愉快|好奇比/,
  );
  for (const [n, text] of [
    [59, "刚刚"],
    [60, "约 1 分钟"],
    [899, "接着当前话题"],
    [900, "停了一会儿"],
    [7199, "停了一会儿"],
    [7200, "已有一段间隔"],
    [86400, "约 1 天"],
  ] as const)
    assert.ok(gapContext(n).includes(text));
  assert.match(gapContext(NaN), /没有/);
  assert.match(localMoment(now, "UTC"), /凌晨/);
  cfg.state.enabled = false;
  assert.doesNotMatch(stateContext(state, cfg, now), /心情底色|担忧|感受缘由/);
  cfg.state.gap = false;
  assert.doesNotMatch(stateContext(state, cfg, now), /距离上次/);
});

test("internal greetings carry their own time, preserve historical identity and use normal messages", async (t) => {
  const f = await fixture(t);
  f.config.current.scheduler.timezone = "Asia/Shanghai";
  const h = new History(f.db, f.config.current, llm);
  const e = f.db.append({
    ...event("natural-greeting"),
    type: "internal_event",
    source: "scheduler",
    occurred_at: "2026-11-03T02:34:00Z",
    text: "想找对方聊两句",
    data: { kind: "random_chat" },
  });
  const text = h.modelText(e);
  assert.match(text, /10:34.*上午/);
  assert.match(text, /不是要回复的消息/);
  const messages = h.messages("main", [e]);
  assert.equal(messages.at(-1)?.role, "user");
  assert.match(String(messages.at(-1)?.content), /想找对方聊两句/);
  assert.match(
    h.modelText({ ...e, data: { kind: "memory_review" } }),
    /内部事件/,
  );
  assert.doesNotMatch(
    h.modelText({ ...e, data: { kind: "memory_review" } }),
    /主动联系的契机/,
  );
});

test("prompt mapping validates bands, merges fields, reloads per agent and preserves defaults", async (t) => {
  const f = await fixture(t),
    root = f.config.agentRoot("main");
  const { parsePromptMapping, loadPromptMapping, promptMappingDefaults } =
    await import("../src/config/prompt-mapping.js");
  const { AdminFiles } = await import("../src/admin/files.js");
  const files = new AdminFiles(f.config),
    name = "agents/main/prompts/prompt-mapping.yaml";
  assert.deepEqual(
    parsePromptMapping(
      await fs.readFile("prompts/prompt-mapping.yaml", "utf8"),
    ),
    promptMappingDefaults,
  );
  assert.deepEqual(await loadPromptMapping(root), promptMappingDefaults);
  const rootTemplate = await files.read("prompts/prompt-mapping.yaml");
  await assert.rejects(
    files.write(rootTemplate.path, "gap: {bands: []}", rootTemplate.version),
  );

  for (const bad of [
    "typo: true",
    "gap: {bands: [{min: 10, text: x}]}",
    "mood: {bands: [{min: 0, text: x}, {min: 0, text: y}]}",
    "emotions: {maxItems: -1}",
    'text: {now: "{unknown}"}',
    "[]",
  ])
    assert.throws(() => parsePromptMapping(bad));
  let original = await files.read(name);
  await assert.rejects(files.write(name, "gap: {bands: []}", original.version));
  assert.equal((await files.read(name)).content, original.content);
  await files.write(
    name,
    'emotions: {maxItems: 0}\nmood: {template: "此刻：{label}"}\n',
    original.version,
  );
  assert.equal((await loadPromptMapping(root)).emotions.maxItems, 0);
  assert.equal((await loadPromptMapping(root)).mood.template, "此刻：{label}");
  assert.deepEqual(
    (await loadPromptMapping(root)).mood.bands,
    promptMappingDefaults.mood.bands,
  );
  await initialize(f.root);
  assert.equal((await loadPromptMapping(root)).emotions.maxItems, 0);
  assert.deepEqual(
    await loadPromptMapping(path.join(f.root, "missing-agent")),
    promptMappingDefaults,
  );
  await fs.unlink(path.join(root, "prompts/prompt-mapping.yaml"));
  await initialize(f.root);
  assert.deepEqual(await loadPromptMapping(root), promptMappingDefaults);
});

test("context reads edited mapping on next build without restart or mutating scores", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current,
    root = f.config.agentRoot("main");
  cfg.state.enabled = true;
  const memory = new MemoryService(root, "main", f.db, cfg, llm);
  await memory.updateState((s) => {
    s.mood = cfg.state.baseline;
    s.emotions = { 担忧: 80 };
  });
  const builder = new ContextBuilder(
    f.db,
    cfg,
    cfg.agents[0],
    root,
    path.join(root, "prompts"),
    new History(f.db, cfg, llm),
    memory,
    llm,
  );
  const e = f.db.append(event("mapping-context"));
  const initial = await builder.build(
    [e],
    "map-before",
    new AbortController().signal,
  );
  assert.match(String(initial.messages[0].content), /担忧非常明显/);
  await fs.writeFile(
    path.join(root, "prompts/prompt-mapping.yaml"),
    'emotions: {maxItems: 0}\nmood: {template: "独立映射：{label}"}\n',
  );
  const next = await builder.build(
    [e],
    "map-after",
    new AbortController().signal,
  );
  assert.match(String(next.messages[0].content), /独立映射/);
  assert.doesNotMatch(String(next.messages[0].content), /担忧非常明显/);
  assert.ok((await memory.state()).emotions.担忧 > 79);
  await fs.writeFile(
    path.join(root, "prompts/prompt-mapping.yaml"),
    "mood: {bands: []}",
  );
  await assert.rejects(
    builder.build([e], "map-invalid", new AbortController().signal),
    /Invalid prompts\/prompt-mapping.yaml/,
  );
});

test("dynamic background stays after stable history, before the whole fresh batch, including compaction", async (t) => {
  const f = await fixture(t),
    history = new History(f.db, f.config.current, llm);
  const old = f.db.append({ ...event("stable-old"), text: "old input" });
  f.db.append({
    ...event("stable-reply"),
    type: "agent_reply",
    text: "old reply",
  });
  const first = f.db.append({ ...event("batch-first"), text: "fresh one" });
  const second = f.db.append({ ...event("batch-second"), text: "fresh two" });
  const bg = { role: "user" as const, content: "dynamic state A" };
  const before = history.messages("main", [first, second], bg);
  const after = history.messages("main", [first, second], {
    ...bg,
    content: "dynamic state B",
  });
  assert.deepEqual(before.slice(0, -3), after.slice(0, -3));
  assert.equal(before.at(-3)?.content, bg.content);
  assert.match(String(before.at(-2)?.content), /fresh one/);
  assert.match(String(before.at(-1)?.content), /fresh two/);
  assert.equal(JSON.stringify(before).split("fresh one").length - 1, 1);
  f.db.set("history:main", { through: old.seq, summary: "old summary" });
  const compacted = history.messages("main", [first, second], bg);
  assert.match(String(compacted[0].content), /old summary/);
  assert.equal(compacted.at(-3)?.content, bg.content);
  assert.equal(history.messages("main", [], bg).at(-1)?.content, bg.content);
});

test("autonomous history keeps routing metadata out of assistant speech and preserves raw records", async (t) => {
  const f = await fixture(t);
  const history = new History(f.db, f.config.current, llm);
  const target = {
    channel: "telegram",
    conversation: "test-owner",
    kind: "private" as const,
  };
  f.db.append({
    ...event("route-user"),
    reply_target: target,
    text: "hello",
    occurred_at: "2026-11-03T01:00:00Z",
  });
  f.db.append({
    ...event("route-timer"),
    type: "internal_event",
    reply_target: undefined,
    text: "new opportunity",
    data: { kind: "random_chat" },
    occurred_at: "2026-11-03T01:10:00Z",
  });
  const original = f.db.append({
    ...event("route-reply"),
    type: "agent_reply",
    reply_target: target,
    text: "[位置：telegram:test-owner]\nnew thought",
    occurred_at: "2026-11-03T01:11:00Z",
  });
  f.db.append({
    ...event("route-other"),
    type: "agent_reply",
    reply_target: { ...target, conversation: "another" },
    text: "other place",
    occurred_at: "2026-11-03T03:11:00Z",
  });
  const messages = history.messages("main", []);
  assert.deepEqual(
    messages.filter((m) => m.role === "assistant").map((m) => m.content),
    ["new thought", "other place"],
  );
  assert.equal(
    messages.filter((m) =>
      String(m.content).includes("位置：telegram:test-owner"),
    ).length,
    1,
  );
  assert.ok(
    messages.some(
      (m) =>
        m.role === "user" &&
        String(m.content).includes("位置：telegram:another"),
    ),
  );
  assert.equal(
    f.db.all("main").find((e) => e.event_id === original.event_id)?.text,
    original.text,
  );
  const ordinary = {
    ...original,
    text: "我看到文件里的 [位置：telegram:test-owner]，这是内容。",
  };
  assert.equal(history.modelText(ordinary), ordinary.text);
});

test("recall query identifies only real incoming messages as previous user inputs", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current,
    root = f.config.agentRoot("main");
  f.db.append({ ...event("real-user"), text: "user fact" });
  f.db.append({
    ...event("old-timer"),
    type: "internal_event",
    text: "old internal idea",
  });
  const current = f.db.append({
    ...event("new-timer"),
    type: "internal_event",
    text: "new internal idea",
  });
  const memory = new MemoryService(root, "main", f.db, cfg, llm);
  let query = "";
  memory.recall = async (text) => {
    query = text;
    return [];
  };
  await new ContextBuilder(
    f.db,
    cfg,
    cfg.agents[0],
    root,
    path.join(root, "prompts"),
    new History(f.db, cfg, llm),
    memory,
    llm,
  ).build([current], "query-provenance", new AbortController().signal);
  assert.match(query, /user fact/);
  assert.match(query, /new internal idea/);
  assert.doesNotMatch(query, /old internal idea/);
});

test("DeepSeek transport preserves system identity without changing other providers or overrides", () => {
  assert.deepEqual(
    modelCompat({
      baseUrl: "https://api.deepseek.com/v1",
      compat: { supportsStrictMode: false },
    }),
    {
      supportsDeveloperRole: false,
      supportsMidConvoSystemMessages: true,
      supportsStrictMode: false,
    },
  );
  assert.deepEqual(modelCompat({ baseUrl: "https://api.openai.com/v1" }), {});
  assert.deepEqual(
    modelCompat({ baseUrl: "https://api.deepseek.com.example.org" }),
    {},
  );
  assert.deepEqual(
    modelCompat({ baseUrl: "https://example.org/deepseek" }),
    {},
  );
  assert.deepEqual(
    modelCompat({
      baseUrl: "https://api.deepseek.com",
      compat: { supportsDeveloperRole: true },
    }),
    { supportsDeveloperRole: true, supportsMidConvoSystemMessages: true },
  );
});

test("unanswered human inputs move after background until an actual text delivery", async (t) => {
  const f = await fixture(t),
    h = new History(f.db, f.config.current, llm);
  const a = f.db.append({ ...event("u-a"), text: "first human input" });
  f.db.append({
    ...event("tool-between"),
    type: "tool_result",
    text: "tool only",
  });
  const b = f.db.append({ ...event("u-b"), text: "second human input" });
  assert.deepEqual(
    h.unansweredBatch("main", [b]).map((e) => e.event_id),
    [a.event_id, b.event_id],
  );
  const pending = f.db.append({
    ...event("pending-text"),
    type: "agent_reply",
    text: "not yet delivered",
    data: { delivery: { parts: [{ type: "text", text: "reply" }] } },
  });
  const c = f.db.append({ ...event("u-c"), text: "third human input" });
  assert.equal(h.unansweredBatch("main", [c]).length, 3);
  f.db.append({
    ...event("reaction"),
    type: "outbound_action",
    data: { delivery: { parts: [], action: "react" } },
  });
  f.db.append({
    ...event("reaction-success"),
    type: "delivery_result",
    text: "sent",
    data: { delivery_id: "reaction", index: 0 },
  });
  const d = f.db.append({ ...event("u-d"), text: "fourth human input" });
  assert.equal(h.unansweredBatch("main", [d]).length, 4);
  f.db.append({
    ...event("text-success"),
    type: "delivery_result",
    text: "sent",
    data: { delivery_id: pending.event_id, index: 0 },
  });
  const e = f.db.append({ ...event("u-e"), text: "fifth human input" });
  assert.deepEqual(
    h.unansweredBatch("main", [e]).map((x) => x.event_id),
    [e.event_id],
  );
  const f1 = f.db.append({ ...event("u-f"), text: "sixth human input" });
  const batch = h.unansweredBatch("main", [f1]);
  const bg = { role: "system" as const, content: "memory and feelings" };
  const messages = h.messages("main", batch, bg);
  const index = messages.findIndex((m) => m.content === bg.content);
  assert.match(String(messages[index + 1].content), /fifth human input/);
  assert.match(String(messages[index + 2].content), /sixth human input/);
  assert.equal(
    JSON.stringify(messages).split("fifth human input").length - 1,
    1,
  );
  const timer = f.db.append({ ...event("timer-only"), type: "internal_event" });
  assert.deepEqual(h.unansweredBatch("main", [timer]), [timer]);
});

test("compaction checkpoint cannot skip an excluded unanswered input", async (t) => {
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
  for (let i = 0; i < 10; i++)
    f.db.append({
      ...event("old-prefix-" + i),
      text: "older information ".repeat(300),
    });
  const input = f.db.append({
    ...event("protected-unanswered"),
    text: "please remember my complete request",
  });
  for (let i = 0; i < 10; i++)
    f.db.append({
      ...event("later-tool-" + i),
      type: "tool_result",
      text: "large tool result ".repeat(150),
    });
  const h = new History(f.db, cfg, llm);
  await h.view("main", undefined, undefined, new Set([input.event_id]));
  assert.ok(f.db.get("history:main", { through: 0 }).through < input.seq);
  const replay = h.messages("main", [input], {
    role: "system",
    content: "background",
  });
  assert.equal(JSON.stringify(replay).split(input.text).length - 1, 1);
  assert.equal(f.db.getEvent("main", input.event_id)?.text, input.text);
});

test("execution/context bulk cleanup and age-based logs remain independent and agent scoped", async (t) => {
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
  const root = f.config.agentRoot("main");
  for (const id of ["cleanup-one", "cleanup-two"]) {
    f.db.claim("main", [], id);
    f.db.finish(id, "complete");
    f.db.append({ ...event("chat-" + id), run_id: id, text: "retained chat" });
    const tool = path.join(root, "history/tools", id, "result.json");
    await fs.mkdir(path.dirname(tool), { recursive: true });
    await fs.writeFile(tool, "tool secret");
    await fs.writeFile(tool.replace(/\.json$/, ".stdout"), "terminal bytes");
    f.db.append({
      ...event("call-" + id),
      run_id: id,
      type: "tool_call",
      text: "tool input",
    });
    f.db.append({
      ...event("result-" + id),
      run_id: id,
      type: "tool_result",
      text: "tool output",
      data: { result_file: tool },
    });
    f.db.append({
      ...event("finished-" + id),
      run_id: id,
      type: "run_finished",
      text: JSON.stringify({ text: "retained chat" }),
    });
    for (const file of [
      `.runtime/requests/${id}/0.json`,
      `.runtime/traces/${id}.json`,
    ]) {
      const p = path.join(root, file);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, "{}");
    }
  }
  f.db.claim("other", [], "other-run");
  f.db.finish("other-run", "complete");
  f.db.set("history:main", { through: 0, summary: "retained summary" });
  const remove = (scope: string, payload: any) =>
    server.api.inject({
      method: "DELETE",
      url: `/v1/agents/main/${scope}-records`,
      headers,
      payload,
    });
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url: "/v1/agents/main/execution-records",
        payload: { mode: "all" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await remove("execution", { mode: "selected", run_ids: ["../outside"] }))
      .statusCode,
    400,
  );
  assert.equal(
    (await remove("execution", { mode: "selected", run_ids: ["other-run"] }))
      .statusCode,
    404,
  );
  (runtime as any).active.set("main", {
    runId: "active",
    controller: new AbortController(),
    promise: Promise.resolve(),
  });
  assert.equal((await remove("context", { mode: "all" })).statusCode, 409);
  (runtime as any).active.delete("main");
  let result = await remove("execution", {
    mode: "selected",
    run_ids: ["cleanup-one"],
  });
  assert.equal(result.statusCode, 200, result.body);
  await assert.rejects(fs.stat(path.join(root, "history/tools/cleanup-one")));
  assert.ok(
    await fs.stat(path.join(root, ".runtime/requests/cleanup-one/0.json")),
  );
  const read = await server.api.inject({
    url: "/v1/agents/main/runs/cleanup-one/context",
    headers,
  });
  assert.equal(read.statusCode, 200, read.body);
  const catalog = (
    await server.api.inject({
      url: "/v1/runs?agent=main&scope=context",
      headers,
    })
  ).json();
  assert.ok(catalog.some((r: any) => r.id === "cleanup-one"));
  assert.equal((await remove("execution", { mode: "all" })).statusCode, 200);
  assert.equal(
    (await remove("context", { mode: "selected", run_ids: ["cleanup-one"] }))
      .statusCode,
    200,
  );
  assert.ok(
    await fs.stat(path.join(root, ".runtime/requests/cleanup-two/0.json")),
  );
  assert.equal((await remove("context", { mode: "all" })).statusCode, 200);
  assert.equal(
    (
      await server.api.inject({
        url: "/v1/runs?agent=main&scope=context",
        headers,
      })
    ).json().length,
    0,
  );
  assert.ok(
    f.db.db.prepare("SELECT id FROM runs WHERE agent_id='other'").get(),
  );
  assert.equal(
    f.db.all("main").filter((e) => e.type === "incoming_message").length,
    2,
  );
  assert.equal(
    f.db.get("history:main", { summary: "" }).summary,
    "retained summary",
  );
  f.db.db
    .prepare(
      "INSERT INTO logs(at,level,component,message,data) VALUES(?,?,?,?,?)",
    )
    .run("2020-01-01T00:00:00.000Z", "info", "test", "old", "{}");
  f.db.db
    .prepare(
      "INSERT INTO logs(at,level,component,message,data) VALUES(?,?,?,?,?)",
    )
    .run("2099-01-01T00:00:00.000Z", "info", "test", "new", "{}");
  result = await server.api.inject({
    method: "DELETE",
    url: "/v1/logs",
    headers,
    payload: { mode: "before", before: "2026-01-01T00:00:00Z" },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(
    f.db.logs(100).some((r: any) => r.message === "old"),
    false,
  );
  assert.equal(
    f.db.logs(100).some((r: any) => r.message === "new"),
    true,
  );
  assert.equal(
    (await server.api.inject({ url: "/v1/logs/storage", headers })).json()
      .table,
    "logs",
  );
  assert.equal(
    (
      await server.api.inject({
        method: "DELETE",
        url: "/v1/logs",
        headers,
        payload: { mode: "all" },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.db.logs(100).length, 0);
});

test("turn spark only sees persona/current batch, preserves full history, and never becomes state", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.context.spark = true;
  const old = f.db.append({
    ...event("spark-old"),
    text: "old conversation remains available",
  });
  const previousReply = f.db.append({
    ...event("spark-old-reply"),
    type: "agent_reply",
    text: "previous response",
    run_id: "spark-old-run",
    data: {
      delivery: { parts: [{ type: "text", text: "previous response" }] },
    },
  });
  f.db.append({
    ...event("spark-old-sent"),
    type: "delivery_result",
    text: "sent",
    run_id: "spark-old-run",
    data: { delivery_id: previousReply.event_id, index: 0 },
  });
  const current = f.db.append({
    ...event("spark-new"),
    text: "new playful input",
  });
  let seen: any, purpose: unknown;
  const model = {
    ...llm,
    json: async (
      _s: string,
      input: unknown,
      _signal?: AbortSignal,
      p?: string,
    ) => {
      seen = input;
      purpose = p;
      return { spark: "a small imagined paper ship" };
    },
  };
  const ar = f.config.agentRoot("main");
  const memory = new MemoryService(ar, "main", f.db, cfg, model);
  const context = await new ContextBuilder(
    f.db,
    cfg,
    cfg.agents[0],
    ar,
    path.join(ar, "prompts"),
    new History(f.db, cfg, model),
    memory,
    model,
  ).build([current], "spark-context", new AbortController().signal);
  assert.equal(purpose, "spark");
  assert.equal(seen.current_input, "new playful input");
  assert.doesNotMatch(
    JSON.stringify(seen),
    /old conversation|Current state|当前时间/,
  );
  assert.match(
    JSON.stringify(context.messages),
    /old conversation remains available/,
  );
  assert.match(JSON.stringify(context.messages), /a small imagined paper ship/);
  assert.match(
    String(context.messages.at(-2)?.content),
    /不是记忆、用户请求、现实经历或已执行的行为/,
  );
  assert.match(String(context.messages.at(-1)?.content), /new playful input/);
  assert.ok(old.seq < current.seq);
  assert.doesNotMatch(
    await fs.readFile(path.join(ar, "state.json"), "utf8"),
    /paper ship/,
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(ar, "memory.json"), "utf8"),
    /paper ship/,
  );
});

test("turn spark disabled/empty/invalid/error paths remain optional", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current,
    ar = f.config.agentRoot("main");
  const current = f.db.append(event("spark-paths"));
  let calls = 0,
    issues = 0,
    value: unknown = { spark: "" },
    fail = false;
  const model = {
    ...llm,
    json: async () => {
      calls++;
      if (fail) throw Error("offline");
      return value;
    },
  };
  const opts = {
    root: ar,
    cfg,
    llm: model,
    persona: "role",
    batch: [current],
    signal: new AbortController().signal,
    onIssue: () => {
      issues++;
    },
  };
  assert.equal(await createTurnSpark(opts), "");
  assert.equal(calls, 0);
  cfg.context.spark = true;
  assert.equal(
    await createTurnSpark({ ...opts, batch: [{ ...current, text: "" }] }),
    "",
  );
  assert.equal(calls, 0);
  assert.equal(await createTurnSpark(opts), "");
  assert.equal(sparkContext(""), "");
  value = { spark: ["not a string"] };
  assert.equal(await createTurnSpark(opts), "");
  fail = true;
  assert.equal(await createTurnSpark(opts), "");
  assert.equal(issues, 2);
});

test("turn spark timeout falls back but caller cancellation propagates", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.context.spark = true;
  cfg.context.sparkTimeoutMs = 20;
  const model = {
    ...llm,
    json: async (_s: string, _i: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        const hold = setTimeout(
          () => reject(Error("test should have cancelled")),
          500,
        );
        signal!.addEventListener(
          "abort",
          () => {
            clearTimeout(hold);
            reject(signal!.reason);
          },
          { once: true },
        );
      }),
  };
  const opts = {
    root: f.config.agentRoot("main"),
    cfg,
    llm: model,
    persona: "role",
    batch: [f.db.append(event("spark-cancel"))],
    signal: new AbortController().signal,
  };
  assert.equal(await createTurnSpark(opts), "");
  cfg.context.sparkTimeoutMs = 1000;
  const control = new AbortController();
  setTimeout(() => control.abort(Error("new user input")), 10);
  await assert.rejects(
    createTurnSpark({ ...opts, signal: control.signal }),
    /new user input/,
  );
});

test("turn spark budgets and model inheritance stay independent from retrieval", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.context.spark = true;
  cfg.context.sparkInputTokens = 400;
  cfg.context.sparkTokens = 20;
  cfg.models.fast.name = "fast-source";
  cfg.models.spark = { maxOutput: 700 };
  const modelConfig = new OpenAIModels(cfg, {}).model("spark");
  assert.equal(modelConfig.name, "fast-source");
  assert.equal(modelConfig.maxOutput, 700);
  assert.equal(cfg.models.query, undefined);
  let seen: any;
  const model = {
    ...llm,
    json: async (_s: string, input: unknown) => {
      seen = input;
      return { spark: "imagined detail ".repeat(200) };
    },
  };
  const spark = await createTurnSpark({
    root: f.config.agentRoot("main"),
    cfg,
    llm: model,
    persona: "role identity ".repeat(2000),
    batch: [
      f.db.append({
        ...event("spark-budget"),
        text: "old text ".repeat(500) + "latest input",
      }),
    ],
    signal: new AbortController().signal,
  });
  assert.ok(seen.current_input.endsWith("latest input"));
  assert.ok(tokens(JSON.stringify(seen)) <= cfg.context.sparkInputTokens);
  assert.ok(tokens(spark) <= cfg.context.sparkTokens);
});

test("runtime injects a disposable spark without creating recursive trigger events", async (t) => {
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.context.spark = true;
  let sparkCalls = 0,
    seen: any;
  const model = {
    ...llm,
    json: async (...args: Parameters<typeof llm.json>) => {
      if ((args as any[])[3] === "spark") {
        sparkCalls++;
        return { spark: "runtime-only imagined seed" };
      }
      return llm.json(...args);
    },
  };
  const rt = new Runtime(
    f.config,
    f.db,
    async () => {},
    model,
    () => ({
      run: async (request) => {
        seen = request.context;
        return complete("done");
      },
    }),
  );
  f.cleanup.push(() => rt.stop());
  await rt.start();
  rt.ingress({ ...event("spark-runtime-input"), text: "let us play" });
  await rt.tick();
  await wait(() => !!seen && rt.status().active.length === 0);
  assert.equal(sparkCalls, 1);
  assert.match(JSON.stringify(seen.messages), /runtime-only imagined seed/);
  assert.equal(
    f.db.all("main").filter((e) => e.type === "incoming_message").length,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(f.db.all("main")),
    /runtime-only imagined seed/,
  );
});

test("context probabilities use exact boundaries and skip spark API calls", async (t) => {
  const { chance } = await import("../src/shared/probability.js");
  let draws = 0;
  const random = () => {
    draws++;
    return 0.55;
  };
  assert.equal(chance(0, random), false);
  assert.equal(chance(1, random), true);
  assert.equal(draws, 0);
  assert.equal(
    chance(0.55, () => 0.549),
    true,
  );
  assert.equal(chance(0.55, random), false);
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.context.spark = true;
  cfg.context.sparkProbability = 0.55;
  let calls = 0;
  const opts = {
    root: f.config.agentRoot("main"),
    cfg,
    persona: "role",
    batch: [f.db.append(event("prob-spark"))],
    llm: {
      ...llm,
      json: async () => {
        calls++;
        return { spark: "imagined" };
      },
    },
    signal: new AbortController().signal,
  };
  assert.equal(await createTurnSpark({ ...opts, random: () => 0.55 }), "");
  assert.equal(calls, 0);
  assert.equal(
    await createTurnSpark({ ...opts, random: () => 0.54 }),
    "imagined",
  );
  assert.equal(calls, 1);
  assert.throws(() => parseConfig({ context: { sparkProbability: 55 } }));
});

test("thought/focus draws only affect rendering and respect zero counts", async (t) => {
  const { selectStateContext } = await import("../src/layer3/state-context.js");
  const f = await fixture(t),
    cfg = f.config.current;
  cfg.state.enabled = true;
  cfg.state.thoughtContextItems = 1;
  cfg.state.focusMax = 1;
  cfg.state.thoughtContextProbability = 0.15;
  cfg.state.focusContextProbability = 0.2;
  const ar = f.config.agentRoot("main"),
    memory = new MemoryService(ar, "main", f.db, cfg, llm);
  const state = await memory.state();
  state.thoughts = [{ text: "saved thought", at: new Date().toISOString() }];
  state.focus = ["saved focus"];
  const before = JSON.stringify(state);
  const a = selectStateContext(state, cfg, () => 0.1);
  assert.deepEqual(a, { thoughts: true, focus: true });
  const b = selectStateContext(state, cfg, () => 0.18);
  assert.deepEqual(b, { thoughts: false, focus: true });
  const c = selectStateContext(state, cfg, () => 0.9);
  assert.deepEqual(c, { thoughts: false, focus: false });
  assert.match(
    stateContext(state, cfg, Date.now(), undefined, a),
    /saved thought/,
  );
  assert.doesNotMatch(
    stateContext(state, cfg, Date.now(), undefined, c),
    /saved thought|saved focus/,
  );
  assert.equal(JSON.stringify(state), before);
  cfg.state.thoughtContextItems = 0;
  cfg.state.focusMax = 0;
  assert.deepEqual(
    selectStateContext(state, cfg, () => 0),
    { thoughts: false, focus: false },
  );
});

test("spark wrapping is configurable and legacy mapping files inherit it", () => {
  const mapping = parsePromptMapping("text:\n  spark: '偶然想到：{text}'\n");
  assert.match(sparkContext("a new idea", mapping), /偶然想到：a new idea/);
  assert.match(sparkContext("a new idea", mapping), /不是记忆、用户请求/);
  assert.ok(parsePromptMapping("{}").text.spark.includes("{text}"));
  assert.throws(() => parsePromptMapping("text:\n  spark: '{invalid}'\n"));
});

test("manual history compaction bypasses threshold, reports results and protects cancellation", async (t) => {
  const f = await fixture(t);
  await f.config.save({
    ...f.config.current,
    history: {
      ...f.config.current.history,
      triggerTokens: 20000,
      targetTokens: 1000,
      summaryTokens: 700,
    },
  });
  let release!: () => void;
  let fail = false;
  let seenBudget = 0;
  const model: Intelligence = {
    ...llm,
    summarize: async (_text, budget) => {
      seenBudget = budget;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (fail) throw Error("summary service unavailable");
      return "用户喜欢读书；保留这一项已确认事实。";
    },
  };
  const rt = new Runtime(f.config, f.db, async () => {}, model);
  f.cleanup.push(() => rt.stop());
  process.env.HINENI_TOKEN = "test-manual-compact-token-123456789";
  const server = await servers(f.config, rt, new Scheduler(f.config, f.db));
  f.cleanup.push(() => server.close());
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  const post = () =>
    server.api.inject({
      method: "POST",
      url: "/v1/agents/main/history-compact",
      headers,
      payload: {},
    });
  // No prior history: succeeds without a paid request.
  assert.equal((await post()).statusCode, 202);
  await wait(() => rt.historyCompaction("main")?.status === "skipped");
  for (let n = 0; n < 12; n++)
    f.db.append({
      ...event("compact-" + n),
      type: "agent_reply",
      text: "具体共同经历与已确认事实。".repeat(18),
    });
  const history = new History(
    f.db,
    agentConfig(rt.cfg, rt.cfg.agents[0]),
    model,
  );
  assert.ok(history.inspect("main").estimated_tokens < 20000);
  const count = f.db.all("main").length;
  assert.equal((await post()).statusCode, 202);
  assert.equal(rt.historyCompaction("main")?.status, "running");
  assert.equal((await post()).statusCode, 409);
  assert.throws(() => rt.clearHistorySummary("main"), /正在执行/);
  assert.throws(() => rt.eraseHistory("main", "all"), /正在执行/);
  release();
  await wait(() => rt.historyCompaction("main")?.status === "completed");
  assert.equal(seenBudget, 700);
  assert.equal(f.db.all("main").length, count); // No synthetic chat or inference.
  const first = rt.historyCompaction("main")!;
  assert.ok(first.after_tokens! < first.before_tokens);
  assert.equal(first.completed_batches, 1);
  assert.match(first.summary!, /读书/);
  const view = (
    await server.api.inject({ url: "/v1/agents/main/history-view", headers })
  ).json();
  assert.equal(view.compaction.status, "completed");
  const checkpoint = f.db.get("history:main", null);
  f.db.append({
    ...event("compact-new-history"),
    type: "agent_reply",
    text: "新的历史资料。".repeat(200),
  });
  fail = true;
  await post();
  release();
  await wait(() => rt.historyCompaction("main")?.status === "failed");
  assert.deepEqual(f.db.get("history:main", null), checkpoint);
  assert.match(rt.historyCompaction("main")!.error!, /unavailable/);
  fail = false;
  await post();
  // Even a model ignoring AbortSignal must not overwrite the checkpoint after cancellation.
  rt.ingress(event("new-user-during-compaction"));
  // Hold the next conversational tick; this test isolates the cancellation checkpoint.
  rt.tick = () => {};
  release();
  await wait(() => rt.historyCompaction("main")?.status === "cancelled");
  assert.deepEqual(f.db.get("history:main", null), checkpoint);
  assert.equal(f.db.pending("main").length, 1);
  assert.equal((await post()).statusCode, 409);
  assert.equal(
    (
      await server.api.inject({
        method: "POST",
        url: "/v1/agents/unknown/history-compact",
        headers,
        payload: {},
      })
    ).statusCode,
    400,
  );
});

test("summary repairs oversized and invalid output without changing normal model reasoning", async (t) => {
  const seen: any[] = [];
  let outputs: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    seen.push(JSON.parse(raw));
    const text = outputs.shift() ?? '{"summary":"short"}';
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/responses"
          ? {
              id: "resp_summary",
              object: "response",
              status: "completed",
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
    const cfg = parseConfig({
      agents: [
        {
          id: "main",
          name: "Main",
          defaultTarget: { channel: "local", conversation: "owner" },
        },
      ],
      channels: [{ id: "local", type: "webhook" }],
      models: {
        main: {
          name: "deepseek-flash",
          protocol,
          reasoning: "high",
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        },
      },
    });
    cfg.models.summary = { ...cfg.models.main, reasoning: "off" };
    const originalSummary = { ...cfg.models.summary };
    const llm = new OpenAIModels(cfg, { OPENAI_API_KEY: "fake" });
    const bodyInput = (b: any) =>
      JSON.parse(
        protocol === "responses" ? b.input : b.messages.at(-1).content,
      );
    outputs = [
      JSON.stringify({ summary: "事实。".repeat(200) }),
      '{"summary":"用户取消了任务；不再等待执行。"}',
    ];
    const start = seen.length;
    assert.equal(
      await llm.summarize("用户取消任务", 100),
      "用户取消了任务；不再等待执行。",
    );
    assert.equal(seen.length - start, 2);
    assert.ok(bodyInput(seen.at(-1)).measured_tokens > 100);
    assert.equal(bodyInput(seen.at(-1)).draft_summary, "事实。".repeat(200));
    assert.equal(
      protocol === "responses"
        ? seen.at(-1).reasoning.effort
        : seen.at(-1).reasoning_effort,
      "none",
    );
    assert.equal(cfg.models.main.reasoning, "high");
    cfg.models.summary = {
      ...cfg.models.summary,
      name: "deepseek-summary",
      reasoning: "low",
      maxOutput: 3456,
      apiKeyEnv: "SUMMARY_KEY",
      baseUrl: cfg.models.main.baseUrl,
    };
    const separate = new OpenAIModels(cfg, { SUMMARY_KEY: "summary-only" });
    assert.equal(await separate.summarize("摘要资料", 100), "short");
    assert.equal(seen.at(-1).model, "deepseek-summary");
    assert.equal(
      protocol === "responses"
        ? seen.at(-1).reasoning.effort
        : seen.at(-1).reasoning_effort,
      "low",
    );
    assert.equal(
      protocol === "responses"
        ? seen.at(-1).max_output_tokens
        : seen.at(-1).max_completion_tokens,
      3456,
    );
    cfg.models.summary = originalSummary;

    outputs = ["not json", '{"summary":"有效摘要"}'];
    assert.equal(await llm.summarize("原文", 100), "有效摘要");
    assert.equal(bodyInput(seen.at(-1)).conversation_to_summarize, "原文");
    outputs = Array(3).fill(JSON.stringify({ summary: "事实。".repeat(200) }));
    const beforeFailure = seen.length;
    await assert.rejects(
      llm.summarize("原文", 100),
      /exceeds its retained token budget/,
    );
    assert.equal(seen.length - beforeFailure, 3);
    const abort = new AbortController();
    abort.abort();
    const beforeAbort = seen.length;
    await assert.rejects(llm.summarize("原文", 100, abort.signal));
    assert.equal(seen.length, beforeAbort);
  }
});

test("summary configuration survives disk reload and stays independent of main and fast", async (t) => {
  const f = await fixture(t);
  const { agentConfig, summaryModelConfig } =
    await import("../src/config/schema.js");
  let cfg = structuredClone(f.config.current);
  cfg.models.main.reasoning = "high";
  cfg.models.summary.name = "summary-default";
  cfg.models.summary.baseUrl = "https://summary.invalid/v1";
  cfg.agents[0].overrides.models = {
    main: { name: "agent-chat", baseUrl: "https://agent.invalid/v1" },
    summary: { maxOutput: 4096 },
  };
  await f.config.save(cfg);
  await f.config.load();
  let selected = summaryModelConfig(
    agentConfig(f.config.current, f.config.current.agents[0]),
  );
  assert.equal(selected.name, "summary-default");
  assert.equal(selected.baseUrl, "https://summary.invalid/v1");
  assert.equal(selected.reasoning, "off");
  assert.equal(selected.maxOutput, 4096);
  cfg = structuredClone(f.config.current);
  (cfg.agents[0].overrides.models as any).summary = {
    name: "summary-only",
    reasoning: "low",
    protocol: "chat-completions",
    apiKeyEnv: "SUMMARY_KEY",
  };
  await f.config.save(cfg);
  await f.config.load();
  selected = summaryModelConfig(
    agentConfig(f.config.current, f.config.current.agents[0]),
  );
  assert.equal(selected.name, "summary-only");
  assert.equal(selected.reasoning, "low");
  assert.equal(selected.protocol, "chat-completions");
  assert.equal(selected.apiKeyEnv, "SUMMARY_KEY");
  assert.equal(f.config.current.models.main.reasoning, "high");
  assert.throws(
    () =>
      parseConfig({
        ...cfg,
        models: {
          ...cfg.models,
          summary: { contextWindow: 100000, maxOutput: 99000 },
        },
      }),
    /压缩模型上下文容量/,
  );
});

test("tool activity keeps typing through overlapping tools and closes on run failure", async (t) => {
  const f = await fixture(t);
  let opened = 0,
    closed = 0;
  const runtime = new Runtime(
    f.config,
    f.db,
    async () => {},
    llm,
    (_h, _l, record) => ({
      run: async (req) => {
        for (const tool of ["a", "b"])
          record({
            event_id: `${req.runId}:call:${tool}`,
            type: "tool_call",
            run_id: req.runId,
          });
        assert.equal(opened, 1);
        record({
          event_id: `${req.runId}:result:a`,
          type: "tool_result",
          run_id: req.runId,
        });
        assert.equal(closed, 0);
        record({
          event_id: `${req.runId}:result:b`,
          type: "tool_result",
          run_id: req.runId,
        });
        assert.equal(closed, 1);
        record({
          event_id: `${req.runId}:call:c`,
          type: "tool_call",
          run_id: req.runId,
        });
        assert.equal(opened, 2);
        throw Error("tool interrupted before result");
      },
    }),
  );
  runtime.registry.startTyping = (target) => {
    assert.equal(target.conversation, "owner");
    opened++;
    return () => {
      closed++;
    };
  };
  await runtime.start();
  f.cleanup.push(() => runtime.stop());
  runtime.ingress(event("typing"));
  runtime.tick();
  await wait(() => opened === 2 && runtime.status().active.length === 0);
  assert.equal(closed, 2);
});

test("typing abort stops refresh and failures never reject the run", async (t) => {
  const f = await fixture(t);
  const registry = new ChannelRegistry(
    f.config.current,
    f.db,
    () => f.root,
    () => {},
  );
  let calls = 0;
  registry.channels.set("local", {
    id: "local",
    send: async () => ({}),
    typing: async () => {
      calls++;
      throw Error("offline");
    },
  });
  const controller = new AbortController();
  const stop = registry.startTyping(
    { channel: "local", conversation: "owner" },
    controller.signal,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  controller.abort();
  stop();
  await new Promise((r) => setTimeout(r, 4100));
  assert.equal(calls, 1);
  registry.startTyping(
    { channel: "local", conversation: "owner" },
    controller.signal,
  );
  assert.equal(calls, 1);
  await registry.stop();
});
