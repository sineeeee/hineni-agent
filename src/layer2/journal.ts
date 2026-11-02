import fs from "node:fs";
import path from "node:path";
import type { EventInput } from "../contracts/index.js";

/** Live source of truth. Unhanded outgoing messages may be physically removed on interruption. */
export class Journal {
  constructor(private agentsDir: string) {}
  root(agent: string) {
    return path.join(this.agentsDir, agent);
  }
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
  /** Rewrite only affected files; no backup copy retains the discarded text. */
  prune(agent: string, ids: Set<string>, replacementText: Map<string, string>) {
    const dir = path.join(this.agentsDir, agent, "history");
    if (!fs.existsSync(dir)) return;
    // A torn tail is diagnostic text, not a valid event. Drop it if it copies a removed record.
    for (const name of fs.readdirSync(dir).filter((x) => x.includes(".torn-"))) {
      const file = path.join(dir, name);
      const raw = fs.readFileSync(file, "utf8");
      if ([...ids].some((id) => raw.includes(id))) fs.rmSync(file, { force: true });
    }
    for (const name of fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".jsonl"))) {
      const file = path.join(dir, name);
      const original = fs.readFileSync(file, "utf8");
      if (
        ![...ids, ...replacementText.keys()].some((id) => original.includes(id))
      )
        continue;
      let changed = false;
      const lines: string[] = [];
      for (const line of original.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (ids.has(event.event_id)) {
          changed = true;
          continue;
        }
        const text = replacementText.get(event.event_id);
        if (text !== undefined && text !== event.text) {
          event.text = text;
          changed = true;
          lines.push(JSON.stringify(event));
        } else lines.push(line);
      }
      if (!changed) continue;
      const temp = file + ".prune.tmp";
      const fd = fs.openSync(temp, "w", 0o600);
      try {
        fs.writeFileSync(fd, lines.length ? lines.join("\n") + "\n" : "");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
    }
  }
  /** Remove one agent's durable conversation, leaving its other personal files alone. */
  clear(agent: string) {
    fs.rmSync(path.join(this.agentsDir, agent, "history"), {
      recursive: true,
      force: true,
    });
  }
  /** Remove only files identified as copies of records being erased. */
  eraseRelatedFiles(agent: string, files: string[]) {
    const root = this.root(agent);
    for (const file of files) {
      const resolved = path.resolve(file);
      const relative = path.relative(root, resolved).split(path.sep);
      const attachment = relative[0] === "attachments";
      const tool = relative[0] === "history" && relative[1] === "tools";
      if (
        relative.some((p) => p === ".." || p === "") ||
        !(attachment || tool)
      )
        throw Error("Record path escapes history storage");
      fs.rmSync(resolved, { force: true });
      if (attachment)
        fs.rmSync(resolved + ".json", { force: true });
    }
  }
  pruneSnapshots(
    agent: string,
    runIds: Set<string>,
    eventIds = new Set<string>(),
  ) {
    const runtime = path.join(this.agentsDir, agent, ".runtime");
    for (const run of runIds) {
      fs.rmSync(path.join(runtime, "requests", run), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(runtime, "traces", run + ".json"), { force: true });
    }
    // Later snapshots can have copied an earlier queued reply into their history.
    const scan = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (
          entry.name.endsWith(".json") &&
          [...eventIds].some((id) => fs.readFileSync(file, "utf8").includes(id))
        )
          fs.rmSync(file);
      }
    };
    if (eventIds.size) {
      scan(path.join(runtime, "requests"));
      scan(path.join(runtime, "traces"));
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
