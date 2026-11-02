import fs from "node:fs";
import path from "node:path";
import type { EventInput } from "../contracts/index.js";

/** Append-only source of truth. A flushed line is readable immediately by agent tools. */
export class Journal {
  constructor(private agentsDir: string) {}
  append(event: EventInput) {
    const dir = path.join(this.agentsDir, event.agent_id, "history");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      new Date().toISOString().slice(0, 10) + ".jsonl",
    );
    if (fs.existsSync(file)) {
      const check = fs.openSync(file, "r");
      const size = fs.fstatSync(check).size;
      const last = Buffer.alloc(1);
      if (size) fs.readSync(check, last, 0, 1, size - 1);
      fs.closeSync(check);
      if (size && last[0] !== 10) {
        const data = fs.readFileSync(file),
          split = data.lastIndexOf(10) + 1;
        fs.writeFileSync(file + ".torn-" + Date.now(), data.subarray(split), {
          mode: 0o600,
        });
        fs.truncateSync(file, split);
      }
    }
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(
        fd,
        JSON.stringify({ ...event, received_at: new Date().toISOString() }) +
          "\n",
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  *read(agentId: string): Generator<EventInput> {
    const dir = path.join(this.agentsDir, agentId, "history");
    if (!fs.existsSync(dir)) return;
    for (const name of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".jsonl"))
      .sort()) {
      const lines = fs.readFileSync(path.join(dir, name), "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          yield JSON.parse(lines[i]);
        } catch {
          if (i === lines.length - 1) continue;
          throw Error(`Corrupt history: ${name}:${i + 1}`);
        }
      }
    }
  }
}
