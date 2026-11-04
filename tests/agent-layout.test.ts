import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import YAML from "yaml";
import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { initialize } from "../src/init.js";
import { ConfigStore } from "../src/config/store.js";
import { parseConfig, agentConfig } from "../src/config/schema.js";
import { OpenAIModels } from "../src/shared/models.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/layer2/store.js";
import { Journal } from "../src/layer2/journal.js";
import { Runtime } from "../src/layer2/runtime.js";
import { servers } from "../src/admin/server.js";
async function setup(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hineni-layout-"));
  for (const dir of ["templates", "prompts", "scripts"])
    await fs.cp(path.resolve(dir), path.join(root, dir), { recursive: true });
  await fs.copyFile(
    path.resolve("package.json"),
    path.join(root, "package.json"),
  );
  await fs.symlink(path.resolve("src"), path.join(root, "src"));
  await fs.symlink(
    path.resolve("node_modules"),
    path.join(root, "node_modules"),
  );
  const old = parseConfig({
    channels: [{ id: "local", type: "webhook" }],
    agents: [
      {
        id: "main",
        name: "A",
        defaultTarget: { channel: "local", conversation: "owner" },
      },
    ],
    scheduler: { enabled: false },
    models: { main: { name: "model-a" } },
  });
  await fs.writeFile(path.join(root, "config.yaml"), YAML.stringify(old));
  await fs.writeFile(
    path.join(root, ".env"),
    "HINENI_TOKEN=test-management-token-123456789\nOPENAI_API_KEY=key-for-main-12345\nTELEGRAM_BOT_TOKEN=shared-bot-token\n",
  );
  await initialize(root);
  const config = new ConfigStore(path.join(root, "config.yaml"));
  await config.load();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, config };
}
async function wait(fn: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Timed out");
}

test("legacy migration preserves explicit settings; new agents inherit defaults", async (t) => {
  const { root, config } = await setup(t);
  const rootRaw = YAML.parse(await fs.readFile(config.file, "utf8"));
  assert.equal(rootRaw.layoutVersion, 2);
  assert.deepEqual(rootRaw.agents, [{ id: "main" }]);
  const local = YAML.parse(
    await fs.readFile(path.join(root, "agents/main/config.yaml"), "utf8"),
  );
  assert.equal(local.models.main.name, "model-a");
  assert.equal(local.overrides, undefined);
  assert.equal(local.scheduler.script, "schedule.ts");
  const shared = dotenv.parse(await fs.readFile(path.join(root, ".env")));
  assert.equal(shared.OPENAI_API_KEY, undefined);
  assert.equal(shared.TELEGRAM_BOT_TOKEN, "shared-bot-token");
  assert.equal(config.agentEnv("main").OPENAI_API_KEY, "key-for-main-12345");
  assert.equal(config.agentEnv("main").HINENI_TOKEN, undefined);
  await config.save({
    ...config.current,
    agents: [
      ...config.current.agents,
      {
        id: "b",
        name: "B",
        enabled: false,
        defaultTarget: { channel: "local", conversation: "b" },
      },
    ],
  });
  assert.equal(config.agentEnv("b").OPENAI_API_KEY, "");
  await config.save({
    ...config.current,
    models: {
      ...config.current.models,
      main: { ...config.current.models.main, name: "new-default" },
    },
  });
  assert.equal(
    agentConfig(config.current, config.current.agents[0]).models.main.name,
    "model-a",
  );
  await config.save({
    ...config.current,
    agents: [
      ...config.current.agents,
      {
        id: "c",
        name: "C",
        enabled: false,
        defaultTarget: { channel: "local", conversation: "c" },
      },
    ],
  });
  assert.equal(
    agentConfig(config.current, config.current.agents[2]).models.main.name,
    "new-default",
  );
  assert.equal(
    await fs.readFile(path.join(root, "agents/b/prompts/system.md"), "utf8"),
    await fs.readFile(path.join(root, "prompts/system.md"), "utf8"),
  );
  const ownFile = path.join(root, "agents/main/config.yaml");
  const external = YAML.parse(await fs.readFile(ownFile, "utf8"));
  external.name = "External edit";
  await fs.writeFile(ownFile, YAML.stringify(external));
  await assert.rejects(
    config.save(config.current, config.revision),
    /配置文件已在外部修改/,
  );
  await config.refreshFromDisk();
  assert.equal(config.current.agents[0].name, "External edit");
});

test("same credential variable resolves independently for concurrent model requests", async (t) => {
  const { root, config } = await setup(t);
  await config.save({
    ...config.current,
    agents: [
      ...config.current.agents,
      {
        id: "b",
        name: "B",
        defaultTarget: { channel: "local", conversation: "b" },
      },
    ],
  });
  await fs.writeFile(
    path.join(root, "agents/b/.env"),
    "OPENAI_API_KEY=key-for-b-12345\n",
  );
  await config.load();
  const keys: string[] = [];
  const server = http.createServer((req, res) => {
    keys.push(String(req.headers.authorization));
    req.resume();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as any).port;
  await Promise.all(
    config.current.agents.map((a) => {
      const c = agentConfig(config.current, a);
      c.models.embedding.baseUrl = `http://127.0.0.1:${port}`;
      return new OpenAIModels(c, config.agentEnv(a.id)).embed(["test"]);
    }),
  );
  assert.deepEqual(
    keys.sort(),
    ["Bearer key-for-b-12345", "Bearer key-for-main-12345"].sort(),
  );
  assert.equal(config.agentEnv("b").TELEGRAM_BOT_TOKEN, undefined);
});

test("agent scheduler processes, environments and restart scopes are independent", async (t) => {
  const { root, config } = await setup(t);
  await config.save({
    ...config.current,
    agents: [
      ...config.current.agents.map((a) => ({
        ...a,
        overrides: {
          ...a.overrides,
          scheduler: { ...(a.overrides.scheduler as any), enabled: true },
        },
      })),
      {
        id: "b",
        name: "B",
        defaultTarget: { channel: "local", conversation: "b" },
        overrides: { scheduler: { enabled: true } },
      },
    ],
  });
  await fs.writeFile(
    path.join(root, "agents/b/.env"),
    "OPENAI_API_KEY=key-for-b-12345\n",
  );
  await config.load();
  for (const a of config.current.agents)
    await fs.writeFile(
      path.join(config.agentRoot(a.id), "schedule.ts"),
      `import fs from 'node:fs';fs.writeFileSync('probe.json',JSON.stringify({id:process.env.HINENI_AGENT_ID,key:process.env.OPENAI_API_KEY}));setInterval(()=>{},1000);`,
    );
  const db = new Store(
    path.join(root, "data/runtime.sqlite"),
    new Journal(path.join(root, "agents")),
  );
  const s = new Scheduler(config, db);
  t.after(async () => {
    await s.stop();
    db.close();
  });
  await s.start();
  await wait(async () => {
    try {
      await fs.access(path.join(root, "agents/b/probe.json"));
      await fs.access(path.join(root, "agents/main/probe.json"));
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(root, "agents/b/probe.json"), "utf8"),
    ),
    { id: "b", key: "key-for-b-12345" },
  );
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(root, "agents/main/probe.json"), "utf8"),
    ),
    { id: "main", key: "key-for-main-12345" },
  );
  const pid = s.status().agents.b.pid;
  const old = s.status().agents.main.pid;
  await s.restart("main");
  assert.equal(s.status().agents.b.pid, pid);
  assert.notEqual(s.status().agents.main.pid, old);
  // Editing YAML directly must affect script selection and enabled without a UI GET first.
  const mainFile = path.join(root, "agents/main/config.yaml");
  const personal = YAML.parse(await fs.readFile(mainFile, "utf8"));
  const beforeInvalid = s.status().agents.main.pid;
  await fs.writeFile(
    mainFile,
    YAML.stringify({
      ...personal,
      scheduler: {
        ...personal.scheduler,
        randomMinMinutes: 70,
        randomMaxMinutes: 20,
      },
    }),
  );
  await assert.rejects(s.restart("main"), /invalid random interval/);
  assert.equal(s.status().agents.main.pid, beforeInvalid);
  await fs.copyFile(
    path.join(root, "agents/main/schedule.ts"),
    path.join(root, "agents/main/custom.ts"),
  );
  personal.scheduler.script = "custom.ts";
  await fs.writeFile(mainFile, YAML.stringify(personal));
  await s.restart("main");
  assert.equal(
    s.status().agents.main.script,
    path.join(root, "agents/main/custom.ts"),
  );
  assert.notEqual(s.status().agents.main.pid, beforeInvalid);
  personal.scheduler.enabled = false;
  await fs.writeFile(mainFile, YAML.stringify(personal));
  await s.restart("main");
  assert.equal(s.status().agents.main.running, false);
  assert.equal(s.status().agents.b.pid, pid);
});

test("admin credential writes and model discovery use selected agent; public tokens stay shared", async (t) => {
  const { root, config } = await setup(t);
  await config.save({
    ...config.current,
    agents: [
      ...config.current.agents,
      {
        id: "b",
        name: "B",
        defaultTarget: { channel: "local", conversation: "b" },
      },
    ],
  });
  process.env.HINENI_TOKEN = "test-management-token-123456789";
  const db = new Store(
    path.join(root, "data/runtime.sqlite"),
    new Journal(path.join(root, "agents")),
  );
  const runtime = new Runtime(config, db, async () => {});
  const s = new Scheduler(config, db);
  const web = await servers(config, runtime, s);
  t.after(async () => {
    await web.close();
    await runtime.stop();
    db.close();
  });
  const app = (web as any).admin;
  // servers exposes its Fastify handles as api/admin for injection.
  const headers = { authorization: "Bearer " + process.env.HINENI_TOKEN };
  const response = await app.inject({
    method: "PUT",
    url: "/v1/credentials",
    headers,
    payload: {
      agent_id: "b",
      name: "OPENAI_API_KEY",
      value: "new-b-key-12345",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(config.agentEnv("main").OPENAI_API_KEY, "key-for-main-12345");
  assert.equal(
    dotenv.parse(await fs.readFile(path.join(root, "agents/b/.env")))
      .OPENAI_API_KEY,
    "new-b-key-12345",
  );
  const denied = await app.inject({
    method: "PUT",
    url: "/v1/credentials",
    headers,
    payload: {
      agent_id: "b",
      name: "HINENI_TOKEN",
      value: "other-management-token-12345",
    },
  });
  assert.equal(denied.statusCode, 400);
  const listing = await app.inject({
    method: "GET",
    url: "/v1/credentials?agent=b",
    headers,
  });
  assert.equal(listing.statusCode, 200);
  assert.ok(!listing.body.includes("new-b-key-12345"));
});

test("the copied default script sends one event to its own agent using the shared protocol", async (t) => {
  const { root, config } = await setup(t);
  const events: any[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      events.push({
        url: req.url,
        payload: JSON.parse(body),
        auth: req.headers.authorization,
      });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      path.resolve("node_modules/tsx/dist/loader.mjs"),
      path.join(root, "agents/main/schedule.ts"),
      "--once",
      "random_chat",
    ],
    {
      cwd: config.agentRoot("main"),
      env: {
        ...config.agentEnv("main"),
        HINENI_ROOT: root,
        HINENI_AGENT_ID: "main",
        HINENI_API: `http://127.0.0.1:${(server.address() as any).port}`,
      },
      timeout: 10000,
    },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].url, "/v1/events");
  assert.equal(events[0].payload.agent_id, "main");
  assert.equal(events[0].payload.type, "internal_event");
  assert.equal(events[0].payload.data.kind, "random_chat");
  assert.equal(events[0].auth, "Bearer test-management-token-123456789");
});

test("sparse config inherits by field; saving preserves absence, false, zero and explicit empty arrays", async (t) => {
  const { root, config } = await setup(t);
  await config.save({
    ...config.current,
    agents: [
      ...config.current.agents,
      {
        id: "b",
        name: "B",
        defaultTarget: { channel: "local", conversation: "b" },
        overrides: {
          style: { casualSentences: 1 },
          state: { enabled: false },
          memory: { smallDetailProbability: 0 },
          mcp: [],
        },
      },
    ],
  });
  const file = path.join(root, "agents/b/config.yaml");
  let disk = YAML.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(disk.style, { casualSentences: 1 });
  assert.equal(disk.models, undefined);
  assert.equal(disk.scheduler, undefined);
  assert.equal(disk.state.enabled, false);
  assert.equal(disk.memory.smallDetailProbability, 0);
  assert.deepEqual(disk.mcp, []);
  const base = {
    ...config.current,
    style: { ...config.current.style, casualChars: 87, casualSentences: 9 },
    mcp: [
      {
        name: "default_tools",
        command: "node",
        args: [],
        enabled: true,
        env: {},
      },
    ],
  };
  await config.save(base);
  let b = config.current.agents.find((a) => a.id === "b")!;
  assert.equal(agentConfig(config.current, b).style.casualChars, 87);
  assert.equal(agentConfig(config.current, b).style.casualSentences, 1);
  assert.deepEqual(agentConfig(config.current, b).mcp, []);
  await config.save(config.current);
  disk = YAML.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(disk.style, { casualSentences: 1 });
  assert.equal(disk.models, undefined);
  // Explicitly copying defaults pins them, even when their value currently equals the default.
  b = config.current.agents.find((a) => a.id === "b")!;
  b.overrides.style = { ...config.current.style };
  await config.save(config.current);
  await config.save({
    ...config.current,
    style: { ...config.current.style, casualChars: 222 },
  });
  b = config.current.agents.find((a) => a.id === "b")!;
  assert.equal(agentConfig(config.current, b).style.casualChars, 87);
  delete (b.overrides.style as any).casualChars;
  await config.save(config.current);
  b = config.current.agents.find((a) => a.id === "b")!;
  assert.equal(agentConfig(config.current, b).style.casualChars, 222);
  assert.equal(
    YAML.parse(await fs.readFile(file, "utf8")).style.casualChars,
    undefined,
  );
});

test("fresh installation creates sparse main config and separates root and model credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hineni-fresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ["templates", "prompts", "scripts"])
    await fs.cp(path.resolve(dir), path.join(root, dir), { recursive: true });
  await initialize(root);
  const shared = YAML.parse(
    await fs.readFile(path.join(root, "config.yaml"), "utf8"),
  );
  const personal = YAML.parse(
    await fs.readFile(path.join(root, "agents/main/config.yaml"), "utf8"),
  );
  assert.equal(shared.layoutVersion, 2);
  assert.deepEqual(shared.agents, [{ id: "main" }]);
  assert.equal(personal.models, undefined);
  assert.equal(personal.scheduler, undefined);
  assert.equal(
    dotenv.parse(await fs.readFile(path.join(root, ".env"))).OPENAI_API_KEY,
    undefined,
  );
  assert.equal(
    dotenv.parse(await fs.readFile(path.join(root, "agents/main/.env")))
      .OPENAI_API_KEY,
    "",
  );
  const store = new ConfigStore(path.join(root, "config.yaml"));
  await store.load();
  await store.save({
    ...store.current,
    style: { ...store.current.style, casualChars: 222 },
  });
  assert.equal(
    agentConfig(store.current, store.current.agents[0]).style.casualChars,
    222,
  );
  await fs.writeFile(
    path.join(root, "agents/main/persona.md"),
    "Personal text to preserve",
  );
  await initialize(root);
  assert.equal(
    await fs.readFile(path.join(root, "agents/main/persona.md"), "utf8"),
    "Personal text to preserve",
  );
});

test("saved personal configuration survives fresh load and stale pre-restart edits are rejected", async (t) => {
  const { root, config } = await setup(t);
  const stale = structuredClone(config.current),
    oldRevision = config.revision;
  const edited = structuredClone(config.current),
    own = edited.agents[0].overrides as any;
  own.history.pollMs = 777;
  own.style.casualChars = 333;
  own.state.baseline = 55;
  own.state.emotionLabels = ["平静"];
  own.models.main.name = "changed-model";
  own.runtime.maxRounds = 31;
  own.scheduler.randomMinMinutes = 80;
  own.delivery.partIntervalMs = 90;
  own.memory.maxItems = 17;
  own.prompts = { system: "Keep this prompt" };
  await config.save(edited, oldRevision);
  await config.save(config.current, config.revision);
  const restart = new ConfigStore(path.join(root, "config.yaml"));
  await restart.load();
  assert.deepEqual(restart.current.agents[0].overrides, own);
  assert.equal(restart.revision, config.revision);
  await assert.rejects(restart.save(stale, oldRevision), /配置已被/);
  const bytes = await fs.readFile(config.file, "utf8");
  const invalid = structuredClone(restart.current);
  (invalid.agents[0].overrides.history as any).targetTokens = 9999999;
  assert.throws(() => restart.save(invalid, restart.revision));
  assert.equal(await fs.readFile(config.file, "utf8"), bytes);
});

test("manual leisure submits one normal internal event without changing automatic quota", async (t) => {
  const { root } = await setup(t);
  const dir = path.join(root, "agents/main/workspace/moyu");
  await fs.cp(path.resolve("templates/activities/moyu"), dir, {
    recursive: true,
    filter: (p) => !p.includes("__pycache__"),
  });
  const received: any[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, body: JSON.parse(body) });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as import("node:net").AddressInfo;
  await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(root, "agents/main/schedule.ts"),
      "--once",
      "moyu",
      "--agent",
      "main",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HINENI_ROOT: root,
        HINENI_AGENT_ID: "main",
        HINENI_API: `http://127.0.0.1:${address.port}`,
      },
    },
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/v1/events");
  assert.equal(received[0].body.agent_id, "main");
  assert.equal(received[0].body.type, "internal_event");
  assert.equal(received[0].body.data.kind, "moyu_browse");
  assert.match(received[0].body.text, /SOP\.md/);
  assert.match(received[0].body.text, /fetch\.py/);
  const state = JSON.parse(
    await fs.readFile(path.join(dir, "state.json"), "utf8"),
  );
  assert.equal(state.opportunities, 0);
});
