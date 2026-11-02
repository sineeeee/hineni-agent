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
  const setup = `const clone=structuredClone, agentId=cfg.agents[0].id;
    const helpData={lessons:{}},fieldHelp={},labels={};
    const overrideGroups=['models','history','context','memory','state','style','runtime','delivery','prompts','drives','scheduler','mcp'];
    const explanationKey=x=>x, inheritanceControl=()=>null,fieldExplanation=()=>null,inlineFieldExplanation=()=>null;
    const btn=(text,fn)=>el('button',{text,fn}),panel=(title,...children)=>el('section',{title},...children);
    const configActions=()=>null,markDirty=()=>{},task=fn=>fn();`;
  const run = new Function(
    "cfg",
    "schema",
    "el",
    setup + form + agents + ";return {form,renderAgents};",
  )(cfg, z.toJSONSchema(ConfigSchema), el);
  return { ...run, nodes, cfg };
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
