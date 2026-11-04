import { randomUUID } from "node:crypto";
import type { Target } from "../src/contracts/index.js";
import { Store } from "../src/layer2/store.js";

/** Seed an already delivered conversation, not pending current input. */
export function seedDeliveredDialogue(
  db: Store,
  agentId: string,
  target: Target,
  turns: Array<["user" | "assistant", string]>,
) {
  for (const [role, text] of turns) {
    const id = randomUUID();
    const reply = db.append({
      protocol_version: 1,
      event_id: id,
      agent_id: agentId,
      type: role === "user" ? "incoming_message" : "agent_reply",
      source: "synthetic",
      text,
      reply_target: target,
      attachments: [],
      ...(role === "user"
        ? { sender: { id: "test-owner", name: "user", kind: "user" as const } }
        : { run_id: id }),
      data:
        role === "assistant"
          ? { delivery: { parts: [{ type: "text", text }] } }
          : {},
    });
    if (role === "assistant")
      db.append({
        protocol_version: 1,
        event_id: randomUUID(),
        agent_id: agentId,
        type: "delivery_result",
        source: "synthetic",
        run_id: id,
        text: "sent",
        reply_target: target,
        attachments: [],
        data: { delivery_id: reply.event_id, index: 0 },
      });
  }
}
