/** Editable scheduling policy. POST events; the second layer handles interruption and routing. */
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CronExpressionParser } from "cron-parser";
// This file is copied into each agent directory; imports resolve from the application root.
let root =
  process.env.HINENI_ROOT ?? path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(root, "package.json"))) {
  const parent = path.dirname(root);
  if (parent === root)
    throw Error("Cannot locate Hineni root; set HINENI_ROOT");
  root = parent;
}
const { ConfigStore } = await import(
  pathToFileURL(path.join(root, "src/config/store.ts")).href
);
const { agentConfig } = await import(
  pathToFileURL(path.join(root, "src/config/schema.ts")).href
);
const store = new ConfigStore(path.join(root, "config.yaml"));
const all = await store.load();
const argument = process.argv.indexOf("--agent");
const agentId =
  process.env.HINENI_AGENT_ID ??
  (argument >= 0 ? process.argv[argument + 1] : undefined);
const selected = all.agents.find((a: any) => a.id === agentId && a.enabled);
if (!selected)
  throw Error("Specify an enabled agent via --agent <id> or HINENI_AGENT_ID");
const cfg = agentConfig(all, selected);
cfg.agents = [selected];
const sharedEnv = (await import("dotenv")).parse(
  fs.readFileSync(path.join(root, ".env")),
);
const endpoint =
  process.env.HINENI_API ?? `http://127.0.0.1:${cfg.server.port}`;
const auth = {
  Authorization: `Bearer ${process.env[cfg.server.tokenEnv] ?? sharedEnv[cfg.server.tokenEnv]}`,
  "Content-Type": "application/json",
};
async function event(agent_id: string, text: string, kind: string) {
  const r = await fetch(endpoint + "/v1/events", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      protocol_version: 1,
      event_id: randomUUID(),
      agent_id,
      type: "internal_event",
      source: "scheduler",
      text,
      data: { kind },
    }),
  });
  if (!r.ok) throw Error(`Event rejected ${r.status}`);
}
function cron(expression: string, job: () => Promise<void>) {
  const arm = () => {
    const next = CronExpressionParser.parse(expression, {
      tz: cfg.scheduler.timezone,
    })
      .next()
      .getTime();
    setTimeout(
      async () => {
        if (Date.now() < next) {
          arm();
          return;
        }
        try {
          await job();
        } catch (e) {
          console.error(String(e));
        } finally {
          arm();
        }
      },
      Math.min(2 ** 31 - 1, Math.max(1, next - Date.now())),
    );
  };
  arm();
}
const randomGreeting =
  "我想把自己感兴趣的一个小想法分享给对方。直接讲内容，让这个想法自己成立；讲完就好，不用附带对对方生活的安排或要求。对方没有发来新消息，也不用对方接话来完成这次分享。没有新内容就安静。";
const runFile = promisify(execFile);
async function leisureEvent(id: string, manual = false) {
  const dir = path.join(store.agentRoot(id), "workspace", "moyu");
  const dice = path.join(dir, "dice.py");
  if (!fs.existsSync(dice)) {
    if (manual) throw Error("Install workspace/moyu first");
    return event(id, randomGreeting, "random_chat");
  }
  const { stdout } = await runFile(
    "python3",
    [dice, manual ? "next" : "opportunity"],
    {
      timeout: 10000,
      env: { ...process.env, MOYU_TIMEZONE: cfg.scheduler.timezone },
    },
  );
  const choice = JSON.parse(stdout);
  if (choice.kind === "quiet") return;
  if (choice.kind === "chat") return event(id, randomGreeting, "random_chat");
  if (
    choice.kind !== "moyu" ||
    !Array.isArray(choice.sources) ||
    !choice.sources.length
  )
    throw Error("Invalid leisure decision");
  const ids = choice.sources.map((s: any) => s.id);
  if (
    !ids.every((s: unknown) => typeof s === "string" && /^[a-z0-9_-]+$/.test(s))
  )
    throw Error("Invalid source codes");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  const command = ["python3", path.join(dir, "fetch.py"), ...ids]
    .map(quote)
    .join(" ");
  await event(
    id,
    `忽然想出去逛逛，看看有没有自己喜欢、也想带回来和对方聊的东西。这不是对方发来的消息。先阅读 ${path.join(dir, "SOP.md")}，再运行 ${command}。本轮来源已选好：${choice.sources.map((s: any) => s.name).join("、")}。从真实内容里挑一两件自己有感受的，自然说就好；没有值得分享的就安静。`,
    "moyu_browse",
  );
}
const onceIndex = process.argv.indexOf("--once");
if (onceIndex !== -1) {
  const kind = process.argv[onceIndex + 1];
  const agentIndex = process.argv.indexOf("--agent");
  const id = agentIndex === -1 ? agentId : process.argv[agentIndex + 1];
  if (
    !["random_chat", "moyu"].includes(kind) ||
    !id ||
    !cfg.agents.some((a: any) => a.id === id && a.enabled)
  )
    throw Error("Usage: --once random_chat|moyu --agent <enabled agent id>");
  if (kind === "moyu") await leisureEvent(id, true);
  else await event(id, randomGreeting, "random_chat");
  console.log(`One ${kind} event accepted; no timer started.`);
} else {
  for (const agent of cfg.agents.filter((a: any) => a.enabled)) {
    const effective = agentConfig(cfg, agent);
    cron(effective.memory.sleepCron, async () => {
      const r = await fetch(
        endpoint + `/v1/agents/${agent.id}/memory/reindex`,
        {
          method: "POST",
          headers: auth,
          body: "{}",
        },
      );
      if (!r.ok) throw Error(`Index ${r.status}`);
      if (effective.memory.reviewEnabled)
        await event(
          agent.id,
          `现在进入每日整理时间。请阅读 personal-memory Skill，整理尚未处理的聊天经历，更新自己的 memory.json；这是后台整理，通常安静完成；只有需要用户处理的问题才联系他，不把整理步骤发进闲聊。每批约 ${effective.memory.reviewBatchTokens} token，最多 ${effective.memory.maxReviewItems} 条，回看 ${effective.memory.reviewOverlap} 条前文。${effective.memory.noveltyAttention ? "留意意外、变化与熟悉的小事。" : ""}${Math.random() < effective.memory.smallDetailProbability ? "这次可以额外保留最多 " + effective.memory.smallDetailMax + " 条有意思的小细节。" : ""}`,
          "memory_review",
        );
    });
    if (cfg.scheduler.dreamEnabled)
      cron(cfg.scheduler.dreamCron, () =>
        event(
          agent.id,
          "可以阅读 dream-diary Skill，用近期记忆做一段轻量联想。是否分享由你决定，想象与真实经历分清。",
          "dream",
        ),
      );
    if (cfg.scheduler.randomChat) {
      const arm = () => {
        const min = cfg.scheduler.randomMinMinutes,
          max = cfg.scheduler.randomMaxMinutes;
        setTimeout(
          async () => {
            try {
              const hour = Number(
                new Intl.DateTimeFormat("en-US", {
                  timeZone: cfg.scheduler.timezone,
                  hour: "numeric",
                  hourCycle: "h23",
                }).format(new Date()),
              );
              if (
                hour >= cfg.scheduler.activeStart &&
                hour < cfg.scheduler.activeEnd
              )
                await leisureEvent(agent.id);
            } catch (e) {
              console.error(String(e));
            } finally {
              arm();
            }
          },
          (min + Math.random() * (max - min)) * 60000,
        );
      };
      arm();
    }
  }
  console.log("Scheduler ready; restart resets random timers.");
}
