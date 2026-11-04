import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ConfigSchema, parseConfig } from "../src/config/schema.js";
import { client } from "../src/admin/ui-client.js";

// Exercise the actual recursive form renderer, without a browser or live config.
function renderer() {
  const form = client.slice(
    client.indexOf("function form("),
    client.indexOf("let configGroup="),
  );
  const agents = client.slice(
    client.indexOf("async function renderAgents()"),
    client.indexOf("async function renderAgents()") +
      client
        .slice(client.indexOf("async function renderAgents()"))
        .indexOf("\nlet "),
  );
  const nodes: any[] = [];
  const fields = new Map<string, any>();
  const settingCode = client.slice(
    client.indexOf("const onceDrafts="),
    client.indexOf("let modelScope="),
  );
  const pathCode = client.slice(
    client.indexOf("function at("),
    client.indexOf("function form("),
  );
  const mergeCode = client.slice(
    client.indexOf("function merge("),
    client.indexOf("function refreshInheritanceHints("),
  );
  const writeCode = client.slice(
    client.indexOf("function writeExplicit("),
    client.indexOf("function inheritanceControl("),
  );
  const el = (tag: string, attrs = {}, ...children: any[]) => {
    const node = {
      tag,
      attrs,
      children: children.flat().filter(Boolean),
      append(...items: any[]) {
        this.children.push(...items.filter(Boolean));
      },
    };
    nodes.push(node);
    return node;
  };
  const cfg = parseConfig({
    channels: [{ id: "local", type: "webhook" }],
    agents: [
      {
        id: "main",
        name: "Hineni",
        defaultTarget: { channel: "local", conversation: "owner" },
      },
    ],
  });
  cfg.agents[0].overrides = {
    state: { emotionLabels: ["平静", "好奇"] },

    models: { main: { reasoning: "low" } },
    mcp: [{ id: "local", command: "node", args: ["server.js"] }],
  };
  let stored = structuredClone(cfg),
    storedRevision = "initial";
  let failSave = false;
  const storage = new Map<string, string>();
  const api = async (_url: string, method = "GET", body?: any) => {
    if (_url.startsWith("/v1/admin/file?"))
      return { content: '{"tasks":[]}', version: "tasks-v1" };
    if (method === "PUT") {
      if (failSave) throw Error("test disk failure");
      stored = structuredClone(body.config);
      storedRevision += "-saved";
    }
    return { config: structuredClone(stored), revision: storedRevision };
  };
  const $ = (id: string) => {
    const existing = nodes.find((n) => n.attrs.id === id);
    return existing ?? el("div", { id });
  };
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
  const document = {
    querySelectorAll: () =>
      nodes.filter((n) => "data-config-save-status" in n.attrs),
  };
  const saveCode = client.slice(
    client.indexOf("async function saveConfig("),
    client.indexOf("async function restart("),
  );
  const dirtyCode = client.slice(
    client.indexOf("let savingConfig="),
    client.indexOf("function agentOptions()"),
  );
  const setup = `let savedCfg=structuredClone(cfg), revision='initial',dirty=false,fileDirty=false,view='agents';
    const clone=structuredClone, agentId=cfg.agents[0].id;
    const refreshPromptPreviews=()=>{},agentOptions=()=>{},notify=()=>{},restart=async()=>{};
    const show=async()=>view==='settings'?renderSettings():renderAgents(),actionHelp=()=>null;
    let configGroup='style',configScope='agent';const groupIntro=()=>null,refreshInheritanceHints=()=>null;
    const helpData={lessons:{}},fieldHelp={},labels={};
    const overrideGroups=['models','history','context','memory','state','style','runtime','delivery','prompts','drives','scheduler','mcp'];
    const explanationKey=x=>x, inheritanceControl=()=>null,fieldExplanation=()=>null,inlineFieldExplanation=(p,s,v,update)=>{fields.set(p,{value:v,update});return null;};
    const btn=(text,fn)=>el('button',{text,fn}),panel=(title,...children)=>el('section',{title},...children);
    const replaceContent=(node,...children)=>{node.children=children.flat().filter(Boolean);};
    const task=fn=>fn();`;
  const run = new Function(
    "cfg",
    "schema",
    "el",
    "api",
    "$",
    "localStorage",
    "document",
    "fields",
    setup +
      pathCode +
      mergeCode +
      writeCode +
      dirtyCode +
      form +
      agents +
      settingCode +
      saveCode +
      ";return {form,renderAgents,saveConfig,getCfg:()=>cfg,getDirty:()=>dirty,setGroup:(g)=>{configGroup=g;view='settings';return renderSettings();},pendingConfigJson};",
  )(
    cfg,
    z.toJSONSchema(ConfigSchema),
    el,
    api,
    $,
    localStorage,
    document,
    fields,
  );
  return {
    ...run,
    nodes,
    fields,
    get cfg() {
      return run.getCfg();
    },
    storage,
    stored: () => stored,
    failSave: () => {
      failSave = true;
    },
  };
}

test("Agent form renders nested override lists and preserves model enum controls", async () => {
  const r = renderer();
  await r.renderAgents();
  assert.ok(
    r.nodes.some((n: any) => n.tag === "input" && n.attrs.value === "平静"),
  );
  assert.ok(
    r.nodes.some(
      (n: any) => n.tag === "input" && n.attrs.value === "server.js",
    ),
  );
  const reasoning = r.nodes.find(
    (n: any) =>
      n.tag === "select" &&
      n.children.some((c: any) => c.attrs?.value === "low"),
  );
  assert.ok(
    reasoning,
    "known enums must remain select controls inside overrides",
  );
  reasoning.attrs.onchange({ target: { value: "high" } });
  assert.equal(r.cfg.agents[0].overrides.models.main.reasoning, "high");
});

test("Schema-free arrays render safely, including nested arrays", () => {
  const r = renderer();
  r.form(["value", 12, ["nested"]], {}, () => {}, "compat");
  assert.ok(
    r.nodes.some((n: any) => n.tag === "input" && n.attrs.value === "nested"),
  );
});

test("Agent form remains connected after saving, then saving more edits", async () => {
  const r = renderer();
  await r.renderAgents();
  const name = () =>
    r.nodes
      .filter(
        (n: any) =>
          n.tag === "input" &&
          n.attrs.type === "text" &&
          n.attrs.value === "Hineni",
      )
      .at(-1);
  const first = name();
  first.attrs.oninput({ target: { value: "First save" } });
  await r.saveConfig();
  const second = r.nodes
    .filter((n: any) => n.tag === "input" && n.attrs.value === "First save")
    .at(-1);
  assert.ok(second, "saved config must rebuild field handlers");
  second.attrs.oninput({ target: { value: "Second save" } });
  await r.saveConfig(true);
  assert.equal(r.stored().agents[0].name, "Second save");
  assert.equal(r.cfg.agents[0].name, "Second save");
  assert.equal(r.getDirty(), false);
});

test("Failed save preserves edited config, automatic draft, and visible error", async () => {
  const r = renderer();
  await r.renderAgents();
  const field = r.nodes.find(
    (n: any) => n.tag === "input" && n.attrs.value === "Hineni",
  );
  field.attrs.oninput({ target: { value: "Keep my draft" } });
  r.failSave();
  await r.saveConfig(true);
  assert.equal(r.cfg.agents[0].name, "Keep my draft");
  assert.equal(r.stored().agents[0].name, "Hineni");
  assert.equal(
    JSON.parse(r.storage.get("hineni-config-draft")!).config.agents[0].name,
    "Keep my draft",
  );
  assert.equal(r.getDirty(), true);
  assert.ok(
    r.nodes.some((n: any) => n.textContent?.includes("test disk failure")),
  );
});

test("Settings retain edits across groups, repeated saves, and JSON application", async () => {
  const r = renderer();
  for (const [group, key, value] of [
    ["history", "pollMs", 777],
    ["context", "stateTokens", 1200],
    ["memory", "maxItems", 17],
    ["state", "baseline", 55],
    ["style", "casualChars", 333],
    ["runtime", "maxRounds", 31],
    ["delivery", "partIntervalMs", 90],
    ["scheduler", "randomMinMinutes", 80],
  ] as const) {
    await r.setGroup(group);
    r.fields.get("agents.0.overrides." + group + "." + key).update(value);
  }
  await r.saveConfig();
  await r.setGroup("history");
  r.fields.get("agents.0.overrides.history.pollMs").update(888);
  r.pendingConfigJson.set(
    "agents.0.overrides.prompts",
    JSON.stringify({ system: "Custom prompt" }),
  );
  await r.saveConfig(true);
  const o = r.stored().agents[0].overrides as any;
  assert.equal(o.history.pollMs, 888);
  assert.equal(o.style.casualChars, 333);
  assert.equal(o.state.baseline, 55);
  assert.equal(o.memory.maxItems, 17);
  assert.equal(o.runtime.maxRounds, 31);
  assert.equal(o.delivery.partIntervalMs, 90);
  assert.equal(o.scheduler.randomMinMinutes, 80);
  assert.equal(o.prompts.system, "Custom prompt");
});

test("Malformed JSON blocks saving without dropping its draft", async () => {
  const r = renderer();
  r.pendingConfigJson.set("agents.0.overrides.style", "{");
  await r.saveConfig(true);
  assert.equal(r.stored().agents[0].overrides.style, undefined);
  assert.deepEqual(
    JSON.parse(r.storage.get("hineni-config-draft")!).jsonEdits,
    [["agents.0.overrides.style", "{"]],
  );
});

test("cleanup UI selects runs and routes execution/context/log actions separately", async () => {
  const nodes: any[] = [],
    calls: any[] = [];
  const el = (tag: string, attrs: any = {}, ...children: any[]) => {
    const n: any = {
      tag,
      attrs,
      ...attrs,
      children: children.flat().filter(Boolean),
      append(...x: any[]) {
        this.children.push(...x);
      },
    };
    nodes.push(n);
    return n;
  };
  const api = async (url: string, method = "GET", body?: any) => {
    calls.push({ url, method, body });
    if (url === "/v1/logs/storage")
      return {
        database: "/test/data/runtime.sqlite",
        table: "logs",
        count: 1,
        stdout: "external",
      };
    if (url === "/v1/logs" && method === "GET")
      return [
        {
          level: "info",
          component: "test",
          at: new Date().toISOString(),
          message: "log",
          data: "{}",
        },
      ];
    if (method === "DELETE") return { deleted_runs: 1, deleted_logs: 1 };
    return [
      { id: "r1", started_at: new Date().toISOString(), status: "complete" },
    ];
  };
  const runCode = client.slice(
    client.indexOf("async function getRuns()"),
    client.indexOf("let detailSignature="),
  );
  const logsCode = client.slice(
    client.indexOf("async function renderLogs()"),
    client.indexOf("\nsetInterval("),
  );
  const ui = new Function(
    "el",
    "api",
    `
    let view='runs',agentId='main',selectedRun=null,runList=[],recordPath=null,contextRequest=null,contextSignature='',detailSignature='',logFilter='';
    const agentPath=()=>'/v1/agents/'+agentId,confirm=()=>true,notify=()=>{},show=async()=>{},time=s=>s,short=s=>s,stateNames={},empty=s=>el('div',{text:s}),panel=(title,...children)=>el('section',{title},...children),btn=(text,fn)=>el('button',{text,fn}),setTimeout=()=>{},task=fn=>fn(),loadRun=()=>{},$=()=>null,badge=s=>el('span',{text:s}),replaceContent=(n,...c)=>{n.children=c;};
    ${runCode}\n${logsCode}
    return {renderRuns,renderLogs,deleteRunRecords,runButtons,setView:v=>view=v,selectedRunRecords};
  `,
  )(el, api);
  await ui.renderRuns();
  assert.ok(nodes.some((n) => n.tag === "button" && n.text === "全部清理"));
  const checkbox = nodes.find(
    (n) => n.tag === "input" && n.type === "checkbox",
  );
  assert.ok(checkbox);
  checkbox.onchange({ target: { checked: true } });
  await ui.deleteRunRecords("runs", "selected");
  let last = calls.filter((c) => c.method === "DELETE").at(-1);
  assert.equal(last.url, "/v1/agents/main/execution-records");
  assert.deepEqual(last.body, { mode: "selected", run_ids: ["r1"] });
  ui.setView("context");
  await ui.deleteRunRecords("context", "all");
  last = calls.filter((c) => c.method === "DELETE").at(-1);
  assert.equal(last.url, "/v1/agents/main/context-records");
  assert.deepEqual(last.body, { mode: "all" });
  nodes.length = 0;
  await ui.renderLogs();
  assert.ok(nodes.some((n) => n.text?.includes("/test/data/runtime.sqlite")));
  await nodes.find((n) => n.tag === "button" && n.text === "按天数清理").fn();
  last = calls.filter((c) => c.method === "DELETE").at(-1);
  assert.equal(last.url, "/v1/logs");
  assert.equal(last.body.mode, "before");
  assert.ok(
    Math.abs(Date.now() - Date.parse(last.body.before) - 7 * 86400000) < 1000,
  );
});
