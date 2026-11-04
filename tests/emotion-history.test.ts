import test from "node:test";
import assert from "node:assert/strict";
import { emotionHistory } from "../src/layer2/emotion-history.js";
import type { Event } from "../src/contracts/index.js";
const event = (i: number, type: string, text: string) =>
  ({
    event_id: String(i),
    type,
    text,
    received_at: "2026-11-03T06:00:00Z",
    sender: { name: "user" },
    reply_target: { channel: "telegram", conversation: "1" },
  }) as Event;
test("emotion history counts exchanges rather than assistant chunks and excludes current input", () => {
  const events: Event[] = [];
  for (let i = 0; i < 7; i++)
    events.push(
      event(i * 10, "incoming_message", `input-${i}`),
      event(i * 10 + 1, "agent_reply", `reply-${i}-a`),
      event(i * 10 + 2, "agent_reply", `reply-${i}-b`),
    );
  events.push(event(100, "incoming_message", "current"));
  const out = emotionHistory(events, new Set(["100"]));
  assert.ok(!out.includes("input-1"));
  assert.ok(out.includes("input-2"));
  assert.ok(out.includes("reply-6-b"));
  assert.ok(!out.includes("current"));
  assert.ok(out.includes("2026-11-03"));
});
test("emotion history skips tool/error records, preserves internal source and has bounded text", () => {
  const events = [
    event(1, "internal_event", "timer"),
    event(2, "tool_result", "not-dialogue"),
    event(3, "agent_reply", "hello"),
  ];
  const err = event(4, "agent_reply", "failure");
  err.event_id = "run:error";
  events.push(err);
  const out = emotionHistory(events, new Set());
  assert.ok(out.includes("not user speech"));
  assert.ok(!out.includes("not-dialogue"));
  assert.ok(!out.includes("failure"));
  assert.equal(emotionHistory(events, new Set(), 0), "");
  assert.ok(
    emotionHistory(
      [event(1, "incoming_message", "word ".repeat(10000))],
      new Set(),
      100,
    ).length < 1000,
  );
});
