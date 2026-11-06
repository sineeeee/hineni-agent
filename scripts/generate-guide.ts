import fs from "node:fs/promises";
import { z } from "zod";
import { ConfigSchema, parseConfig } from "../src/config/schema.js";
import { configurationGuide, fieldGuide } from "../src/config/guide.js";
import { fieldLessons } from "../src/config/learning.js";
import { processingGuide } from "../src/config/processing-guide.js";
import { describeFile } from "../src/admin/file-guide.js";
const schema: any = z.toJSONSchema(ConfigSchema);
const defaults = parseConfig({
  channels: [{ id: "local", type: "webhook" }],
  agents: [
    {
      id: "main",
      name: "Hineni",
      defaultTarget: { channel: "local", conversation: "owner" },
    },
  ],
});
const property = (group: string, key: string) => {
  const p = schema.properties;
  if (group === "model") return p.models.properties.main.properties[key];
  if (group === "rankWeights")
    return p.memory.properties.rankWeights.properties[key];
  if (group === "target")
    return p.agents.items.properties.defaultTarget.properties[key];
  if (group === "drives") return p.drives.additionalProperties.properties[key];
  if (["channels", "agents", "mcp"].includes(group))
    return p[group].items.properties[key];
  if (group === "prompts") return { type: "string" };
  if (group === "root") return p[key];
  return p[group]?.properties?.[key];
};
const storage = (group: string, key: string) =>
  group === "root"
    ? key
    : group === "model"
      ? `models.<用途>.${key}`
      : group === "rankWeights"
        ? `memory.rankWeights.${key}`
        : group === "target"
          ? `defaultTarget.${key} / routes[m].${key} / targets.<别名>.${key}`
          : group === "drives"
            ? `drives.<名称>.${key}`
            : ["agents", "channels", "mcp"].includes(group)
              ? `${group}[n].${key}`
              : `${group}.${key}`;
let text =
  "# 逐项配置：含义、处理流程与更新方式\n\n本文件与网页共用 config/guide.ts、learning.ts、processing-guide.ts，由 npm run docs 生成。规则来自当前实现。网页显示实际安装目录和数组序号；本文的 n、m、用途、名称是需要替换的路径位置。参数默认值不是你现在保存的值。\n\n公共设施和公共默认值在根 config.yaml；个人设置写 agents/<id>/config.yaml，模型 Key 写同目录 .env，Bot Token 与管理令牌写根 .env。详见 agent-layout.md。配置保存并重启后用于新运行。参数是规则，不随聊天自行变化；程序更新的状态、索引、摘要会在各流程中说明。\n\n";
for (const group of [...Object.keys(configurationGuide), "rankWeights"]) {
  const section = configurationGuide[group] ?? configurationGuide.memory;
  text += `## ${group === "rankWeights" ? "memory.rankWeights" : group}\n\n${section.flow}\n\n适用范围：${section.scope}\n\n`;
  if (group === "model")
    text +=
      "以下默认值以 main 为例。fast 默认 gpt-4.1-mini/maxOutput 2000；embedding 默认 text-embedding-3-small/maxOutput 1；query、maintenance、emotion、rerank 默认继承 fast。网页按具体用途显示。\n\n";
  const entries = Object.entries(fieldGuide).filter(([k]) =>
    k.startsWith(group + "."),
  );
  const flows = new Map<
    string,
    { name: string; flow: ReturnType<typeof processingGuide> }
  >();
  for (const [key] of entries) {
    const flow = processingGuide(key),
      signature = JSON.stringify(flow);
    if (!flows.has(signature))
      flows.set(signature, {
        name: (fieldLessons[key]?.title || key) + "等参数的处理流程",
        flow,
      });
  }
  for (const { name, flow } of flows.values()) {
    text += `### ${name}\n\n`;
    flow.steps.forEach((step, i) => {
      text += `${i + 1}. ${step}\n`;
    });
    text +=
      "\n实现位置：" +
      flow.code.map((x) => "`" + x + "`").join("；") +
      "。\n\n";
  }
  for (const [name, technical] of entries) {
    const key = name.slice(group.length + 1),
      lesson = fieldLessons[name],
      s = property(group, key) || {};
    let d = s.default;
    if (group === "rankWeights") d = (defaults.memory.rankWeights as any)[key];
    else if (d === undefined && group in defaults)
      d = (defaults as any)[group]?.[key];
    text += `### ${lesson.title} · ${key}\n\n保存位置：${["root", "server", "channels"].includes(group) ? "根 config.yaml" : "agents/<id>/config.yaml（根文件保留公共默认值）"} → \`${storage(group, key)}\`。默认：${d === undefined ? "可选；未设置时按继承/调用规则处理" : "\`" + JSON.stringify(d) + "\`"}。\n\n`;
    text += `**含义。** ${lesson.meaning}\n\n**调整结果。** ${lesson.effect}\n\n**具体影响。** ${technical}\n\n`;
    text += `**处理过程。** 见本组“${flows.get(JSON.stringify(processingGuide(name)))!.name}”，该参数在上述具体步骤使用。\n\n**更新与下一轮。** ${lesson.when}\n\n`;
  }
}
text +=
  "## 默认驱动力初值\n\n这些是新状态的初始常态；修改配置不立即重置已有分数。\n\n|维度|常态|偏离常态的差距减半时间（小时）|\n|---|---|---|\n";
for (const [k, v] of Object.entries(defaults.drives))
  text += `|${k}|${v.baseline}|${v.halfLifeHours}|\n`;
await fs.writeFile("docs/configuration-reference.md", text);
let files =
  "# 文件如何参与运行\n\n网页会显示当前安装位置的绝对路径。本文以默认 agents/<agent_id>/ 为例；每个 agent 都有自己的文件。配置是固定规则，下面文件是人格文字、当前数据或可执行脚本。\n\n";
for (const name of [
  "agents/<agent_id>/config.yaml",
  "agents/<agent_id>/schedule.ts",
  "agents/<agent_id>/prompts/system.md",
  "agents/<agent_id>/persona.md",
  "agents/<agent_id>/memory.json",
  "agents/<agent_id>/state.json",
  "agents/<agent_id>/SYSTEM.md",
  "prompts/system.md",
  "agents/<agent_id>/prompts/auxiliary.yaml",
  "agents/<agent_id>/prompts/prompt-mapping.yaml",
  "agents/<agent_id>/schedule.once.json",
  "scripts/schedule.ts",
  "agents/<agent_id>/skills/personal-memory/SKILL.md",
  "agents/<agent_id>/skills/dream-diary/SKILL.md",
  "agents/<agent_id>/workspace/工作文件",
  "agents/<agent_id>/skills/moyu/scripts/dice.py",
  "docs/manual.md",
  "docs/configuration-reference.md",
  "docs/internals.md",
  "docs/protocol.md",
]) {
  const f = describeFile(name);
  files += `## ${f.title}\n\n路径：\`${name}\`。\n\n${f.purpose}\n\n**谁更新、何时生效。** ${f.effect}\n\n`;
  f.steps.forEach((step, i) => {
    files += `${i + 1}. ${step}\n`;
  });
  files += "\n";
  if (Object.keys(f.fields).length) {
    files += "|字段|用途与影响|\n|---|---|\n";
    for (const [k, v] of Object.entries(f.fields)) files += `|\`${k}\`|${v}|\n`;
    files += "\n";
  }
  if (f.code.length)
    files +=
      "实现位置：" + f.code.map((x) => "`" + x + "`").join("；") + "。\n\n";
}
await fs.writeFile("docs/files-guide.md", files.trimEnd() + "\n");
