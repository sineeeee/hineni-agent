import { agentConfig, type Config } from "../config/schema.js";
import type { Delivery, EventInput, Part, Target } from "../contracts/index.js";
import { targetKey } from "../contracts/index.js";
import { Store } from "./store.js";
import {
  ChannelRegistry,
  SendFailure,
  splitParts,
} from "../layer1/channels.js";
import { errorText } from "../shared/files.js";
export class Outbox {
  private busy = false;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  constructor(
    private db: Store,
    private cfg: Config,
    private registry: ChannelRegistry,
    private ingress: (e: EventInput) => unknown,
  ) {}
  private settings(id: string) {
    const a = this.cfg.agents.find((a) => a.id === id);
    return a ? agentConfig(this.cfg, a) : this.cfg;
  }
  queue(d: Delivery) {
    const parts = d.parts.flatMap((p) =>
      p.type !== "text" && p.caption && p.caption.length > 1000
        ? [
            { type: "text" as const, text: p.caption },
            { ...p, caption: undefined },
          ]
        : [p],
    );
    d = {
      ...d,
      parts: splitParts(parts, this.settings(d.agent_id).delivery.split),
    };
    // Journal first. Recovery can reconstruct a queue row if a process stopped between writes.
    this.db.append({
      protocol_version: 1,
      event_id: d.id,
      agent_id: d.agent_id,
      type:
        d.action === "react" || !d.parts.some((p) => p.type === "text")
          ? "outbound_action"
          : "agent_reply",
      source: "layer4",
      run_id: d.run_id,
      reply_target: d.target,
      text: d.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n"),
      attachments: d.parts.flatMap((p) =>
        p.type === "text" ? [] : [p.attachment_id],
      ),
      data: {
        delivery: d,
        response_id: d.response_id,
        chunk_index: d.chunk_index,
      },
    });
    this.db.enqueue(d);
  }
  recover() {
    for (const a of this.cfg.agents)
      for (const e of this.db.all(a.id))
        if (e.data.delivery) {
          const d = e.data.delivery as Delivery;
          const exists = this.db.db
            .prepare("SELECT id FROM deliveries WHERE id=?")
            .get(d.id);
          if (!exists) {
            this.db.enqueue(d);
            this.db.deliveryUpdate(
              d.id,
              "uncertain",
              0,
              0,
              "Recovered journal without queue state; inspect before retry",
            );
          }
        }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 200);
  }
  async tick() {
    if (this.busy || this.stopping) return;
    const row = this.db.nextDelivery();
    if (!row || row.next_at > Date.now()) return;
    this.busy = true;
    const d = JSON.parse(row.payload) as Delivery;
    const cfg = this.settings(d.agent_id);
    let index = row.part_index;
    try {
      const channel = this.registry.channels.get(d.target.channel);
      if (!channel) throw new SendFailure("Channel unavailable");
      const parts: Array<Part | undefined> =
        d.action === "react" ? [undefined] : d.parts;
      for (; index < parts.length; index++) {
        this.db.deliveryUpdate(d.id, "sending", index, row.attempts);
        const sent = await channel.send(d, parts[index]);
        this.db.deliveryUpdate(d.id, "queued", index + 1, 0);
        this.db.append({
          protocol_version: 1,
          event_id: `${d.id}:sent:${index}`,
          agent_id: d.agent_id,
          type: "delivery_result",
          source: d.target.channel,
          run_id: d.run_id,
          reply_target: d.target,
          text: "sent",
          attachments: [],
          data: { delivery_id: d.id, index, ...sent },
        });
        // Telegram bots do not receive each other's messages: mirror successful shared-group sends.
        if (d.action === "send" && d.target.kind === "group")
          for (const a of this.cfg.agents.filter(
            (a) =>
              a.enabled &&
              a.id !== d.agent_id &&
              [a.defaultTarget, ...a.routes].some(
                (t) =>
                  t.kind === "group" && targetKey(t) === targetKey(d.target),
              ),
          )) {
            const p = parts[index];
            const shared =
              p && p.type !== "text"
                ? await this.registry.shareAttachment(
                    d.agent_id,
                    a.id,
                    p.attachment_id,
                  )
                : undefined;
            this.ingress({
              protocol_version: 1,
              event_id: `peer:${d.id}:${index}:${a.id}`,
              agent_id: a.id,
              type: "incoming_message",
              source: d.target.channel,
              reply_target: d.target,
              text: p?.type === "text" ? p.text : (p?.caption ?? "[附件]"),
              sender: {
                id: d.agent_id,
                name:
                  this.cfg.agents.find((x) => x.id === d.agent_id)?.name ??
                  d.agent_id,
                kind: "agent",
              },
              attachments: shared ? [shared] : [],
              data: { peer_delivery: d.id },
            });
          }
        if (cfg.delivery.partIntervalMs)
          await new Promise((r) => setTimeout(r, cfg.delivery.partIntervalMs));
      }
      this.db.deliveryUpdate(d.id, "sent", index, 0);
    } catch (e) {
      const err = e as SendFailure,
        attempts = row.attempts + 1;
      const status = err.uncertain
        ? "uncertain"
        : attempts >= cfg.delivery.attempts
          ? "failed"
          : "retry";
      const saved: any = this.db.db
        .prepare("SELECT part_index FROM deliveries WHERE id=?")
        .get(d.id);
      this.db.deliveryUpdate(
        d.id,
        status,
        Math.max(index, Number(saved?.part_index ?? 0)),
        attempts,
        errorText(e),
        Date.now() + Math.max(err.retryAfter ?? 0, 1000 * 2 ** attempts),
      );
      this.db.log("error", "delivery", errorText(e), {
        delivery_id: d.id,
        status,
      });
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }
}
