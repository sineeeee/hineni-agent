/** Editable scheduling policy. POST events; the second layer handles interruption and routing. */
import fs from "node:fs";
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
// Scheduling owns frequency, mode and daily quota; Skills own execution.
async function leisureEvent(id: string, manual = false) {
  let kind = "moyu";
  if (!manual) {
    const { takeLeisureOpportunity } = await import(
      pathToFileURL(path.join(root, "src/shared/leisure.ts")).href
    );
    kind = await takeLeisureOpportunity(
      path.join(store.agentRoot(id), ".runtime", "leisure-state.json"),
      cfg.scheduler,
    );
  }
  if (kind === "quiet") return;
  if (kind === "chat") return event(id, randomGreeting, "random_chat");
  const skill = path.join(store.agentRoot(id), "skills", "moyu", "SKILL.md");
  if (!fs.existsSync(skill)) {
    if (manual) throw Error("Install skills/moyu first");
    return event(id, randomGreeting, "random_chat");
  }
  await event(
    id,
    `忽然想出去逛逛，看看有没有自己喜欢、也想带回来和对方聊的东西。这不是对方发来的消息。阅读 ${skill}，按里面的方法选来源、读取真实内容。从里面挑一两件自己有感受的，自然说就好；没有值得分享的就安静。`,
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
          `现在安静回顾一下自己的生活。先读 personal-memory Skill，先看生活日记，再对照尚未处理的聊天和工具记录；挑真正想留下的经历，用自己的口气写，不照抄工作SOP，没有值得记的就不添加。遵守Skill的必填字段、事实与感受分工、长度及整理游标限制，更新自己的 memory.json；这是后台整理，通常安静完成；只有需要用户处理的问题才联系他，不把整理步骤发进闲聊。每批约 ${effective.memory.reviewBatchTokens} token，最多 ${effective.memory.maxReviewItems} 条，回看 ${effective.memory.reviewOverlap} 条前文。${effective.memory.noveltyAttention ? "留意意外、变化与熟悉的小事。" : ""}${Math.random() < effective.memory.smallDetailProbability ? "本批条数上限内，可以保留最多 " + effective.memory.smallDetailMax + " 条有意思的小细节。" : ""}`,
          "memory_review",
        );
    });
    if (cfg.scheduler.dreamEnabled)
      cron(cfg.scheduler.dreamCron, () =>
        event(
          agent.id,
          "想把最近几天的片段编成一小段自己的故事。先读 dream-diary Skill，从真实记忆取材，写温柔、好奇、有一点异想天开的第一人称短文；遵守正文长度和写作规则，保存在自己的梦境目录。没有合适片段就略过，是否分享自己决定；创作不回填真实记忆。这不是用户的新消息。",
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
