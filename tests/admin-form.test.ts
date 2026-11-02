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
    client.indexOf("async function renderSettings()"),
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
  const setup = `let savedCfg=structuredClone(cfg), revision='initial',dirty=false,view='agents';
    const clone=structuredClone, agentId=cfg.agents[0].id;
    const refreshPromptPreviews=()=>{},agentOptions=()=>{},notify=()=>{},restart=async()=>{};
    const show=async()=>view==='settings'?renderSettings():renderAgents(),actionHelp=()=>null;
    let configGroup='style',configScope='agent';const groupIntro=()=>null,refreshInheritanceHints=()=>null;
    const helpData={lessons:{}},fieldHelp={},labels={};
    const overrideGroups=['models','history','context','memory','state','style','runtime','delivery','prompts','drives','scheduler','mcp'];
    const explanationKey=x=>x, inheritanceControl=()=>null,fieldExplanation=()=>null,inlineFieldExplanation=(p,s,v,update)=>{fields.set(p,{value:v,update});return null;};
    const btn=(text,fn)=>el('button',{text,fn}),panel=(title,...children)=>el('section',{title},...children);
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
