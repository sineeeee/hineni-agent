import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseConfig, agentConfig, type Config } from "./config/schema.js";
import { ConfigStore } from "./config/store.js";
import { atomicWrite } from "./shared/files.js";
export async function initialize(root: string) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "config.yaml");
  let cfg: Config;
  try {
    await fs.access(file);
    cfg = undefined as unknown as Config;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    cfg = parseConfig({
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
    // Fresh installations use sparse personal settings; legacy files migrate on load.
    await new ConfigStore(file).save(cfg);
  }
  const env = path.join(root, ".env");
  try {
    await fs.access(env);
  } catch {
    await atomicWrite(
      env,
      `HINENI_TOKEN=${randomBytes(32).toString("hex")}\nTELEGRAM_BOT_TOKEN=\n`,
    );
  }
  const store = new ConfigStore(file);
  cfg = await store.load();
  for (const agent of cfg.agents) {
    const effective = agentConfig(cfg, agent);
    const dir = path.resolve(root, cfg.agentsDir, agent.id);
    for (const sub of [
      "workspace",
      "history",
      "attachments",
      "skills",
      ".runtime",
    ])
      await fs.mkdir(path.join(dir, sub), { recursive: true });
    for (const [name, content] of [
      [
        "persona.md",
        await fs.readFile(path.join(root, "templates/persona.md"), "utf8"),
      ],
      ["memory.json", '{"memory":[]}\n'],
      [
        "SYSTEM.md",
        `# 自己的环境\n\nAgent: ${agent.id}\n项目：${root}\n自己的根目录：${dir}\n工作目录：${dir}/workspace\n人格：persona.md\n长期记忆：memory.json\n当前状态：state.json（系统维护当前快照）\n真实经历：history/YYYY-MM-DD.jsonl（实时追加）\n完整工具结果：history/tools/\n附件：attachments/，.json 为状态说明\n技能：skills/*/SKILL.md\n\n使用 history_search/history_read 查询自己的原始经历，使用 memory_search/memory_read 查询更多长期记忆。也可以直接读文件。系统负责每轮自动编排，不需要每次翻这些文件。\n\n记忆整理建议：每批 ${effective.memory.reviewBatchTokens} token，最多 ${effective.memory.maxReviewItems} 条；按需自行分批。\n定时脚本：${path.resolve(dir, effective.scheduler.script)}\n接口说明：${root}/docs/protocol.md\n自己的配置：${dir}/config.yaml\n自己的模型凭据：${dir}/.env\n自己的基础提示词：${dir}/prompts/system.md\n公共默认与连接配置：${root}/config.yaml\n\n定时与配置操作：先读 skills/system-operations/SKILL.md；文件归属与继承见项目 docs/agent-layout.md。修改自己的调度参数或脚本后调用 restart_scheduler；实际脚本路径以自己的有效 scheduler.script 为准。\n`,
      ],
    ]) {
      try {
        await fs.writeFile(path.join(dir, name), content, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    let removedSkills: string[] = [];
    try {
      removedSkills = JSON.parse(
        await fs.readFile(
          path.join(dir, ".runtime", "removed-skills.json"),
          "utf8",
        ),
      );
    } catch {}
    for (const name of await fs.readdir(path.join(root, "templates/skills"))) {
      if (removedSkills.includes(name)) continue;
      await fs.cp(
        path.join(root, "templates/skills", name),
        path.join(dir, "skills", name),
        { recursive: true, force: false, errorOnExist: false },
      );
    }
  }
  return cfg;
}
