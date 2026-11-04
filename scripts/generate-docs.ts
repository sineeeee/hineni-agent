import fs from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import { ConfigSchema, parseConfig } from "../src/config/schema.js";
import { EventSchema } from "../src/contracts/index.js";
import { fieldHelp } from "../src/config/help.js";
const cfg = parseConfig({
  channels: [
    { id: "local", type: "webhook" },
    { id: "telegram", type: "telegram", tokenEnv: "TELEGRAM_BOT_TOKEN" },
  ],
  agents: [
    {
      id: "main",
      name: "Hineni",
      defaultTarget: { channel: "local", conversation: "owner" },
      targets: { local: { channel: "local", conversation: "owner" } },
    },
  ],
});
await fs.writeFile("config.example.yaml", YAML.stringify(cfg));
await fs.writeFile(
  "docs/config.schema.json",
  JSON.stringify(z.toJSONSchema(ConfigSchema), null, 2) + "\n",
);
await fs.writeFile(
  "docs/event.schema.json",
  JSON.stringify(z.toJSONSchema(EventSchema), null, 2) + "\n",
);
let text =
  "# 配置参考\n\n根文件是公共设施与公共默认值；个人配置在 agents/<id>/config.yaml。下方 agents[].overrides 是 API 合并视图，磁盘中个人设置直接使用顶层字段。详见 agent-layout.md。\n\n本表列出 schema 默认值，不是当前安装值；当前值由根 config.yaml 默认值与 agents/<id>/config.yaml 的个人字段共同决定。先读[配置指南](configuration-guide.md)理解操作、模型/渠道/agent/MCP 嵌套字段和开关关联，再按本表查具体参数。Token 是估算值；style、回顾提示和部分情绪政策属于模型软指导，其他参数也需结合消费流程理解。保存配置后重启主程序生效。完整样例见 config.example.yaml。\n\n";
for (const [group, values] of Object.entries(cfg)) {
  if (!values || typeof values !== "object" || Array.isArray(values)) continue;
  text += "## " + group + "\n\n| 字段 | 默认 | 作用 |\n|---|---|---|\n";
  for (const [key, v] of Object.entries(values)) {
    const display = JSON.stringify(v).replaceAll("|", "\\|");
    text +=
      "| `" +
      key +
      "` | `" +
      display +
      "` | " +
      (fieldHelp[group]?.[key] ??
        (group === "drives"
          ? "维度开关、基线、回稳半衰期、敏感度与上下界"
          : "见模型/路径说明")) +
      " |\n";
  }
  text += "\n";
}
text +=
  "## 模型、渠道和 agent\n\n模型包含 name、baseUrl、apiKeyEnv、contextWindow、maxOutput、reasoning、compat。query/maintenance/emotion/rerank 可部分覆盖 fast；主模型和向量分别配置。compat 透传 Pi OpenAI 适配选项。\n\nagents[]：id、name、enabled、defaultTarget、targets（发送别名）、routes（接收位置）、skills（额外技能路径）、main（主模型覆盖）、overrides。overrides 支持 models/history/context/memory/state/style/runtime/delivery/prompts/drives/scheduler/mcp；对象逐字段合并、数组整体替换；同一轮保持配置快照。\n\nchannels[]：id、type（telegram/webhook）、enabled、tokenEnv、url、secretEnv、allowedChats、maxFileBytes。Telegram 文件默认20 MiB；Webhook入站上限20 MiB。\n\nmcp[]：name、enabled、command/args 或 url（二选一）、env、headersEnv。HTTP headersEnv 的变量值是 JSON 请求头。\n\n## Prompt 覆盖\n\nprompts 可设置 system / query / searchDescription / rerank / emotion / stateExpression，值为完整提示词。system 默认读取当前 agent 的 prompts/system.md；其余先读个人 prompts/auxiliary.yaml，再回退内置默认。状态和表达参数自动渲染，主模型不需要额外调用情绪记录工具。\n\n## 路径与生效\n\ndataDir 默认 data；agentsDir 默认 agents，均相对项目根目录。memory.json 只由 Skill 或明确编辑写入，程序派生检索信息位于 .runtime/search-index.json。persona、Skills、system prompt 的文件修改下一轮读取。调度脚本需显式重启。\n";
await fs.writeFile("docs/config.md", text);

await import("./generate-guide.js");
