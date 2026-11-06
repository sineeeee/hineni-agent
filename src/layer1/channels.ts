import fs from "node:fs/promises";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import telegramFetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { agentConfig, type Config } from "../config/schema.js";
import type {
  Channel,
  Delivery,
  Part,
  EventInput,
  Target,
  Attachment,
} from "../contracts/index.js";
import { Store } from "../layer2/store.js";
import { id, errorText, jsonWrite } from "../shared/files.js";
export class SendFailure extends Error {
  constructor(
    message: string,
    public uncertain = false,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export class ChannelRegistry {
  private telegramProxy = process.env.TELEGRAM_PROXY_URL
    ? new HttpsProxyAgent(process.env.TELEGRAM_PROXY_URL)
    : undefined;
  private downloads = new Set<Promise<void>>();
  private lifecycle = new AbortController();
  channels = new Map<string, Channel>();
  status: Record<string, string> = {};
  constructor(
    private cfg: Config,
    private db: Store,
    private agentRoot: (id: string) => string,
    private ingress: (e: EventInput) => unknown,
  ) {}
  async start() {
    for (const c of this.cfg.channels.filter((c) => c.enabled)) {
      if (c.type === "webhook") {
        this.channels.set(c.id, {
          id: c.id,
          send: async (d, p) => {
            if (!c.url) return { message_id: d.id + ":" + d.parts.indexOf(p!) }; // local inbox, visible in admin/API
            try {
              const r = await fetch(c.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": d.id + ":" + d.parts.indexOf(p!),
                  ...(c.secretEnv
                    ? {
                        Authorization: `Bearer ${process.env[c.secretEnv] ?? ""}`,
                      }
                    : {}),
                },
                body: JSON.stringify({
                  protocol_version: 1,
                  delivery: d,
                  part: p,
                }),
                signal: AbortSignal.timeout(30000),
              });
              if (!r.ok)
                throw new SendFailure(
                  `Webhook HTTP ${r.status}`,
                  r.status >= 500,
                );
              return { message_id: r.headers.get("x-message-id") ?? undefined };
            } catch (e) {
              if (e instanceof SendFailure) throw e;
              throw new SendFailure(errorText(e), true);
            }
          },
        });
        this.status[c.id] = c.url ? "ready" : "local inbox";
        continue;
      }
      const token = process.env[c.tokenEnv ?? "TELEGRAM_BOT_TOKEN"];
      if (!token) {
        this.status[c.id] = "missing token";
        continue;
      }
      const bot = new Bot(token, {
        client: {
          timeoutSeconds: 30,
          ...(this.telegramProxy
            ? { baseFetchConfig: { agent: this.telegramProxy } }
            : {}),
        },
      });
      const channel: Channel = {
        id: c.id,
        typing: async (target) => {
          await bot.api.sendChatAction(
            target.conversation,
            "typing",
            target.thread ? { message_thread_id: Number(target.thread) } : {},
          );
        },
        send: async (d, p) => {
          const owner = this.cfg.agents.find((a) => a.id === d.agent_id);
          const cfg = owner ? agentConfig(this.cfg, owner) : this.cfg;
          const t = d.target,
            chat = t.conversation;
          const extra = t.thread ? { message_thread_id: Number(t.thread) } : {};
          try {
            if (d.action === "react") {
              await bot.api.setMessageReaction(chat, Number(d.message_id), [
                { type: "emoji", emoji: d.emoji as any },
              ]);
              return { message_id: d.message_id };
            }
            let typing: NodeJS.Timeout | undefined;
            if (cfg.delivery.typing) {
              const show = () =>
                bot.api
                  .sendChatAction(
                    chat,
                    p?.type === "image" ? "upload_photo" : "typing",
                    extra,
                  )
                  .catch(() => {});
              await show();
              typing = setInterval(show, 4000);
            }
            try {
              if (cfg.delivery.initialDelayMs)
                await new Promise((r) =>
                  setTimeout(r, cfg.delivery.initialDelayMs),
                );
              let sent: any;
              if (p?.type === "text")
                sent = await bot.api.sendMessage(chat, p.text, extra);
              else if (p) {
                const a = this.db.getAttachment(d.agent_id, p.attachment_id);
                if (!a || a.status !== "ready")
                  throw new SendFailure("Attachment is not ready");
                const file = new InputFile(a.path, a.name);
                sent =
                  p.type === "image"
                    ? await bot.api.sendPhoto(chat, file, {
                        ...extra,
                        caption: p.caption,
                      })
                    : await bot.api.sendDocument(chat, file, {
                        ...extra,
                        caption: p.caption,
                      });
              }
              return { message_id: sent ? String(sent.message_id) : undefined };
            } finally {
              if (typing) clearInterval(typing);
            }
          } catch (e: any) {
            if (e instanceof SendFailure) throw e;
            throw new SendFailure(
              errorText(e),
              !e.error_code || e.error_code >= 500,
              (e.parameters?.retry_after ?? 0) * 1000,
            );
          }
        },
        stop: async () => {
          if (bot.isRunning()) await bot.stop();
        },
      };
      bot.on("message", async (ctx) => {
        const chat = String(ctx.chat.id);
        // Discovery stores chat location only; unmatched message bodies never enter an agent.
        const seenKey = `telegram-chats:${c.id}`;
        const seen = this.db
          .get<any[]>(seenKey, [])
          .filter(
            (x) =>
              x.conversation !== chat ||
              x.thread !== String(ctx.message.message_thread_id ?? ""),
          );
        seen.unshift({
          conversation: chat,
          thread: String(ctx.message.message_thread_id ?? ""),
          kind: ctx.chat.type === "private" ? "private" : "group",
          title:
            "title" in ctx.chat
              ? ctx.chat.title
              : [ctx.chat.first_name, ctx.chat.last_name]
                  .filter(Boolean)
                  .join(" "),
          seen_at: new Date().toISOString(),
          allowed: !c.allowedChats.length || c.allowedChats.includes(chat),
        });
        this.db.set(seenKey, seen.slice(0, 50));
        if (c.allowedChats.length && !c.allowedChats.includes(chat)) return;
        const target: Target = {
          channel: c.id,
          conversation: chat,
          kind: ctx.chat.type === "private" ? "private" : "group",
          ...(ctx.message.message_thread_id
            ? { thread: String(ctx.message.message_thread_id) }
            : {}),
        };
        const agents = this.cfg.agents.filter(
          (a) =>
            a.enabled &&
            [a.defaultTarget, ...a.routes].some(
              (t) =>
                t.channel === target.channel &&
                t.conversation === chat &&
                (!t.thread || t.thread === target.thread),
            ),
        );
        for (const a of agents) {
          const duplicateId = `${c.id}:${ctx.update.update_id}:${a.id}`;
          if (this.db.getEvent(a.id, duplicateId)) continue;
          const attachment = ctx.message.photo?.at(-1) ?? ctx.message.document;
          const ref = attachment ? id() : undefined;
          const event: EventInput = {
            protocol_version: 1,
            event_id: `${c.id}:${ctx.update.update_id}:${a.id}`,
            agent_id: a.id,
            type: "incoming_message",
            source: c.id,
            text: ctx.message.text ?? ctx.message.caption ?? "",
            occurred_at: new Date(ctx.message.date * 1000).toISOString(),
            reply_target: target,
            source_message_id: String(ctx.message.message_id),
            reply_to_message_id: ctx.message.reply_to_message
              ? String(ctx.message.reply_to_message.message_id)
              : undefined,
            sender: {
              id: String(ctx.from.id),
              name: [ctx.from.first_name, ctx.from.last_name]
                .filter(Boolean)
                .join(" "),
              kind: ctx.from.is_bot ? "agent" : "user",
            },
            attachments: ref ? [ref] : [],
            data: {},
          };
          if (ref && attachment) {
            const doc = ctx.message.document;
            const file = path.join(this.agentRoot(a.id), "attachments", ref);
            const record: Attachment = {
              id: ref,
              agent_id: a.id,
              path: file,
              name: doc?.file_name ?? ref + ".jpg",
              mime: doc?.mime_type ?? "image/jpeg",
              status: "pending",
            };
            this.db.attachment(record);
            await jsonWrite(file + ".json", record);
            this.ingress(event);
            const job = this.download(
              bot,
              attachment.file_id,
              attachment.file_size ?? 0,
              c.maxFileBytes,
              record,
              event,
            ).catch((e) => this.db.log("error", "attachment", errorText(e)));
            this.downloads.add(job);
            void job.finally(() => this.downloads.delete(job));
          } else this.ingress(event);
        }
      });
      bot.catch((e) => this.db.log("error", "telegram", errorText(e.error)));
      try {
        await bot.init(
          AbortSignal.any([
            this.lifecycle.signal,
            AbortSignal.timeout(30000),
          ]) as unknown as Parameters<typeof bot.init>[0],
        );
        this.channels.set(c.id, channel);
        this.status[c.id] = "ready";
        void bot.start({ allowed_updates: ["message"] }).catch((e) => {
          this.status[c.id] = "failed";
          this.db.log("error", "telegram", errorText(e));
        });
      } catch (e) {
        this.status[c.id] = "failed";
        this.db.log("error", "telegram", errorText(e));
      }
    }
  }
  private async download(
    bot: Bot,
    fileId: string,
    size: number,
    max: number,
    a: Attachment,
    original: EventInput,
  ) {
    try {
      if (size > max) throw Error("Attachment exceeds configured limit");
      const f = await bot.api.getFile(fileId);
      if (!f.file_path) throw Error("No platform file path");
      const r = await telegramFetch(
        `https://api.telegram.org/file/bot${bot.token}/${f.file_path}`,
        {
          agent: this.telegramProxy,
          signal: AbortSignal.any([
            this.lifecycle.signal,
            AbortSignal.timeout(120000),
          ]),
        },
      );
      if (!r.ok) throw Error(`Download HTTP ${r.status}`);
      await fs.mkdir(path.dirname(a.path), { recursive: true });
      const handle = await fs.open(a.path + ".partial", "w", 0o600);
      let bytes = 0;
      try {
        for await (const chunk of r.body as any) {
          bytes += chunk.length;
          if (bytes > max) throw Error("Attachment exceeds configured limit");
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      await fs.rename(a.path + ".partial", a.path);
      a.status = "ready";
    } catch (e) {
      a.status = "failed";
      a.error = errorText(e);
      await fs.rm(a.path + ".partial", { force: true }).catch(() => {});
    }
    this.db.attachment(a);
    await jsonWrite(a.path + ".json", a);
    this.ingress({
      ...original,
      event_id: original.event_id + ":" + a.status,
      type: a.status === "ready" ? "attachment_ready" : "attachment_failed",
      parent_event_id: original.event_id,
      text:
        a.status === "ready"
          ? `附件已就绪：${a.name}；本地路径 ${a.path}`
          : `附件获取失败：${a.name}；${a.error}`,
      data: { attachment_id: a.id },
    });
  }
  /** Best-effort activity, scoped to one run; never enters history or the outbox. */
  startTyping(target: Target, signal: AbortSignal): () => void {
    const channel = this.channels.get(target.channel);
    if (!channel?.typing || signal.aborted || this.lifecycle.signal.aborted)
      return () => {};
    let stopped = false,
      pending = false;
    const show = async () => {
      if (stopped || pending) return;
      pending = true;
      try {
        await channel.typing!(target);
      } catch {
        /* Status must not fail a tool. */
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void show(), 4000);
    timer.unref();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      signal.removeEventListener("abort", stop);
      this.lifecycle.signal.removeEventListener("abort", stop);
    };
    signal.addEventListener("abort", stop, { once: true });
    this.lifecycle.signal.addEventListener("abort", stop, { once: true });
    void show();
    return stop;
  }
  async shareAttachment(from: string, to: string, ref: string) {
    const original = this.db.getAttachment(from, ref);
    if (!original || original.status !== "ready") return undefined;
    const copy = { ...original, id: id(), agent_id: to };
    copy.path = path.join(this.agentRoot(to), "attachments", copy.id);
    await fs.mkdir(path.dirname(copy.path), { recursive: true });
    await fs.copyFile(original.path, copy.path);
    await jsonWrite(copy.path + ".json", copy);
    this.db.attachment(copy);
    return copy.id;
  }
  async stop() {
    this.lifecycle.abort(new Error("Shutdown"));
    await Promise.allSettled(this.downloads);
    await Promise.allSettled(
      [...this.channels.values()].map((c) => c.stop?.()),
    );
  }
}
export function splitParts(
  parts: Part[],
  mode: Config["delivery"]["split"],
  max = 3800,
): Part[] {
  return parts.flatMap((p) => {
    if (p.type !== "text") return [p];
    const units =
      mode === "sentence"
        ? (p.text.match(/[^。！？\n]+[。！？\n]?/g) ?? [p.text])
        : mode === "paragraph"
          ? p.text.split(/\n\n+/)
          : [p.text];
    return units.filter(Boolean).flatMap((s) => {
      const chars = Array.from(s),
        out: Part[] = [];
      while (chars.length)
        out.push({ type: "text", text: chars.splice(0, max).join("") });
      return out;
    });
  });
}
