import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedDeliveredDialogue } from "../scripts/dialogue-fixture.js";
import { Store } from "../src/layer2/store.js";
import { History } from "../src/layer2/history.js";
import { parseConfig } from "../src/config/schema.js";

test("delivered seed stays in history; only genuinely unanswered input joins the new batch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hineni-seed-"));
  const db = new Store(path.join(root, "db.sqlite"));
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = { channel: "local", conversation: "owner" };
  const llm = {
    json: async () => ({}),
    embed: async () => [],
    summarize: async () => "",
  };
  const history = new History(
    db,
    parseConfig({
      channels: [{ id: "local", type: "webhook" }],
      agents: [{ id: "main", name: "Main", defaultTarget: target }],
    }),
    llm,
  );
  seedDeliveredDialogue(db, "main", target, [
    ["user", "old work"],
    ["assistant", "work finished"],
  ]);
  const append = (text: string) =>
    db.append({
      protocol_version: 1,
      event_id: text,
      agent_id: "main",
      type: "incoming_message",
      source: "synthetic",
      sender: { id: "owner", name: "user", kind: "user" },
      text,
      reply_target: target,
      attachments: [],
      data: {},
    });
  const current = append("new topic");
  assert.deepEqual(
    history.unansweredBatch("main", [current]).map((e) => e.text),
    ["new topic"],
  );
  assert.match(JSON.stringify(history.messages("main", [current])), /old work/);
  seedDeliveredDialogue(db, "main", target, [
    ["assistant", "new topic answered"],
    ["user", "unfinished note"],
  ]);
  const next = append("follow-up");
  assert.deepEqual(
    history.unansweredBatch("main", [next]).map((e) => e.text),
    ["unfinished note", "follow-up"],
  );
});
