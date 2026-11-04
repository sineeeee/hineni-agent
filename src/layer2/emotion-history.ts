import type { Event } from "../contracts/index.js";
import { cut, tokens } from "../shared/tokens.js";

/** Consecutive inputs plus subsequent assistant chunks form one exchange.
 * Capture before execution; no late reads during asynchronous mood scoring. */
export function emotionHistory(
  events: Event[],
  currentIds: Set<string>,
  budget = 2000,
) {
  const turns: string[][] = [];
  let answered = false;
  for (const e of events) {
    if (currentIds.has(e.event_id) || !e.text.trim()) continue;
    if (!["incoming_message", "internal_event", "agent_reply"].includes(e.type))
      continue;
    if (e.type === "agent_reply" && e.event_id.endsWith(":error")) continue;
    const reply = e.type === "agent_reply";
    if (!turns.length || (!reply && answered)) {
      turns.push([]);
      answered = false;
    }
    const who = reply
      ? "assistant"
      : e.type === "internal_event"
        ? "internal_event (not user speech)"
        : (e.sender?.name ?? "user");
    const target = e.reply_target;
    turns
      .at(-1)!
      .push(
        `[${e.occurred_at ?? e.received_at} ${who}${target ? " @" + target.channel + ":" + target.conversation : ""}] ${cut(e.text, 800)}`,
      );
    if (reply) answered = true;
  }
  const selected: string[] = [];
  let remaining = Math.max(0, budget);
  for (const turn of turns.slice(-5).reverse()) {
    const text = turn.join("\n");
    if (tokens(text) > remaining) {
      if (!selected.length && remaining > 0)
        selected.unshift(cut(text, remaining) + " [truncated]");
      break;
    }
    selected.unshift(text);
    remaining -= tokens(text);
  }
  return selected.join("\n\n");
}
