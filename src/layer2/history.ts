import type { Event } from "../contracts/index.js";
import type { Config } from "../config/schema.js";
import type { Intelligence } from "../shared/models.js";
import { tokens, tail, cut, chunks } from "../shared/tokens.js";
import { Store } from "./store.js";
export class History {
  constructor(
    private db: Store,
    private cfg: Config,
    private llm: Intelligence,
  ) {}
  render(e: Event) {
    let text = e.text;
    if (e.type === "tool_result")
      text = tail(text, this.cfg.history.toolTailTokens);
    return `${e.type === "internal_event" ? "[内部事件，并非用户发言]\n" : ""}[${e.occurred_at ?? e.received_at} ${e.type} source=${e.source} speaker=${e.sender?.name ?? ""} event=${e.event_id} platform_message=${e.source_message_id ?? ""} reply_to=${e.reply_to_message_id ?? ""} target=${JSON.stringify(e.reply_target ?? {})}]\n${text}${e.attachments.length ? "\nattachments=" + JSON.stringify(e.attachments.map((id) => this.db.getAttachment(e.agent_id, id) ?? { id })) : ""}`;
  }
  /** Read-only inspection: never compresses, changes a checkpoint, or calls a model. */
  inspect(agent: string) {
    const checkpoint = this.db.get(`history:${agent}`, {
      through: 0,
      summary: "",
    });
    const events = this.db
      .all(agent, checkpoint.through)
      .filter((e) => !["delivery_result", "run_finished"].includes(e.type));
    const remaining = events.map((e) => this.render(e)).join("\n\n");
    return {
      through: checkpoint.through,
      summary: checkpoint.summary,
      remaining,
      remaining_events: events.length,
      latest_seq: events.at(-1)?.seq ?? checkpoint.through,
      estimated_tokens: tokens(checkpoint.summary + remaining),
      trigger_tokens: this.cfg.history.triggerTokens,
      target_tokens: this.cfg.history.targetTokens,
      tool_tail_tokens: this.cfg.history.toolTailTokens,
    };
  }
  async view(agent: string, signal?: AbortSignal, forcedTarget?: number) {
    let checkpoint = this.db.get(`history:${agent}`, {
      through: 0,
      summary: "",
    });
    let events = this.db
      .all(agent, checkpoint.through)
      .filter((e) => !["delivery_result", "run_finished"].includes(e.type));
    let rows = events.map((e) => this.render(e));
    const size = tokens(checkpoint.summary + rows.join("\n"));
    const target = forcedTarget ?? this.cfg.history.targetTokens;
    if (
      size > (forcedTarget ?? this.cfg.history.triggerTokens) &&
      events.length > 0
    ) {
      let keep = 0,
        split = events.length;
      while (
        split > 1 &&
        keep + tokens(rows[split - 1]) < target - this.cfg.history.summaryTokens
      ) {
        keep += tokens(rows[--split]);
      }
      const old = rows.slice(0, split);
      let summary = checkpoint.summary;
      let batch = "";
      const batchMax = Math.min(
        100000,
        this.cfg.models.main.contextWindow -
          this.cfg.models.main.maxOutput -
          this.cfg.context.safetyTokens -
          this.cfg.history.summaryTokens,
      );
      for (const row of old)
        for (const piece of chunks(row, batchMax, 0)) {
          if (tokens(batch) + tokens(piece) > batchMax && batch) {
            summary = await this.llm.summarize(
              summary + "\n" + batch,
              this.cfg.history.summaryTokens,
              signal,
            );
            batch = "";
          }
          batch += piece + "\n";
        }
      if (batch)
        summary = await this.llm.summarize(
          summary + "\n" + batch,
          this.cfg.history.summaryTokens,
          signal,
        );
      signal?.throwIfAborted();
      checkpoint = { through: events[split - 1].seq, summary };
      this.db.set(`history:${agent}`, checkpoint);
      rows = rows.slice(split);
    }
    return (
      (checkpoint.summary
        ? "[Earlier history summary]\n" + checkpoint.summary + "\n"
        : "") + rows.join("\n\n")
    );
  }
}
