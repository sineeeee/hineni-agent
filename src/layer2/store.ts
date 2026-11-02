import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { Journal } from "./journal.js";
import path from "node:path";
import type {
  EventInput,
  Event,
  Delivery,
  Attachment,
  Target,
} from "../contracts/index.js";
import { targetKey, triggerTypes } from "../contracts/index.js";
type EraseJob = {
  agent: string;
  all: boolean;
  ids: string[];
  files: string[];
  attachments: string[];
  replacements: Array<[string, string]>;
};
export class Store {
  db: DatabaseSync;
  constructor(
    file: string,
    private journal?: Journal,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
 PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,agent_id TEXT NOT NULL,type TEXT NOT NULL,run_id TEXT,received_at TEXT NOT NULL,payload TEXT NOT NULL,claimed INTEGER NOT NULL DEFAULT 0,UNIQUE(agent_id,event_id));
 CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id,seq);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,error TEXT);
 CREATE INDEX IF NOT EXISTS events_run ON events(agent_id,run_id,seq);
 CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',part_index INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,error TEXT);
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,agent_id TEXT,payload TEXT);
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS logs(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT,level TEXT,component TEXT,message TEXT,data TEXT);
 `);
    if (
      !(this.db.prepare("PRAGMA table_info(deliveries)").all() as any[]).some(
        (c) => c.name === "handed_off",
      )
    ) {
      this.db.exec(
        "ALTER TABLE deliveries ADD COLUMN handed_off INTEGER NOT NULL DEFAULT 0",
      );
      this.db.exec(
        "UPDATE deliveries SET handed_off=1 WHERE status!='queued' OR part_index>0 OR attempts>0",
      );
    }
    // An interrupted physical deletion is completed before history recovery can resurrect it.
    for (const row of this.db
      .prepare("SELECT value FROM kv WHERE key LIKE 'prune-outbox:%'")
      .all() as any[])
      this.applyPrune(JSON.parse(row.value));
    for (const row of this.db
      .prepare("SELECT value FROM kv WHERE key LIKE 'erase-events:%'")
      .all() as any[])
      this.applyErase(JSON.parse(row.value));
  }
  rebuild(agents: string[]) {
    if (this.journal)
      for (const agent of agents)
        for (const event of this.journal.read(agent)) {
          if (!this.getEvent(agent, event.event_id)) {
            const indexed = this.index(event);
            this.db
              .prepare("UPDATE events SET claimed=1 WHERE seq=?")
              .run(indexed.seq);
          }
        }
  }
  recover() {
    this.db.exec("UPDATE events SET claimed=1 WHERE claimed=0");
    this.db
      .prepare(
        "UPDATE runs SET status='cancelled',ended_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
    this.db.exec(
      "UPDATE deliveries SET status='uncertain',error='process stopped during platform send; inspect before retry' WHERE status='sending'",
    );
  }
  append(input: EventInput): Event {
    const existing = this.getEvent(input.agent_id, input.event_id);
    if (existing) return existing;
    this.journal?.append(input);
    return this.index(input);
  }
  index(input: EventInput): Event {
    const now = (input as any).received_at ?? new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events(event_id,agent_id,type,run_id,received_at,payload) VALUES(?,?,?,?,?,?)",
      )
      .run(
        input.event_id,
        input.agent_id,
        input.type,
        input.run_id ?? null,
        now,
        JSON.stringify(input),
      );
    const row = this.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND event_id=?")
      .get(input.agent_id, input.event_id);
    return this.decode(row);
  }
  decode(row: any): Event {
    return {
      ...JSON.parse(row.payload),
      seq: Number(row.seq),
      received_at: row.received_at,
      claimed: Number(row.claimed),
    };
  }
  events(agent: string, after = 0, limit = 500) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE agent_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(agent, after, limit)
      .map((r) => this.decode(r));
  }
  all(agent: string, after = 0) {
    return this.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND seq>? ORDER BY seq")
      .all(agent, after)
      .map((r) => this.decode(r));
  }
  recent(agent: string, types: string[], limit: number) {
    const placeholders = types.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM events WHERE agent_id=? AND type IN (${placeholders}) ORDER BY seq DESC LIMIT ?`,
      )
      .all(agent, ...types, limit)
      .map((r) => this.decode(r))
      .reverse();
  }
  runEvents(agent: string, runId: string) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE agent_id=? AND run_id=? ORDER BY seq",
      )
      .all(agent, runId)
      .map((r) => this.decode(r));
  }
  pending(agent: string) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE agent_id=? AND claimed=0 AND type IN ('incoming_message','internal_event','attachment_ready','attachment_failed') ORDER BY seq",
      )
      .all(agent)
      .map((r) => this.decode(r));
  }
  claim(agent: string, events: Event[], runId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of events)
        this.db.prepare("UPDATE events SET claimed=1 WHERE seq=?").run(e.seq);
      this.db
        .prepare("INSERT INTO runs VALUES(?,?,?,?,NULL,NULL)")
        .run(runId, agent, "running", new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  finish(runId: string, status: string, error?: string) {
    this.db
      .prepare("UPDATE runs SET status=?,ended_at=?,error=? WHERE id=?")
      .run(status, new Date().toISOString(), error ?? null, runId);
  }
  getEvent(agent: string, ref: string) {
    const r = this.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND event_id=?")
      .get(agent, ref);
    return r ? this.decode(r) : undefined;
  }
  eraseEvents(agent: string, selected: string[] | "all") {
    if (!this.journal) throw Error("History journal is unavailable");
    const all = selected === "all";
    const ids = all ? [] : [...new Set(selected)];
    if (!all && (!ids.length || ids.length > 500))
      throw Error("Select 1 to 500 records");
    const selectedRows = all
      ? []
      : ids.flatMap((id) => {
          const e = this.getEvent(agent, id);
          return e ? [e] : [];
        });
    if (!all && selectedRows.length !== ids.length)
      throw Error("Some selected records no longer exist; refresh first");
    const removed = new Set(selectedRows.map((e) => e.event_id));
    const replacements: Array<[string, string]> = [];
    if (!all) {
      const affectedRuns = new Set(
        selectedRows
          .filter((e) => e.type === "agent_reply" && e.run_id)
          .map((e) => e.run_id!),
      );
      for (const run of affectedRuns) {
        const retained = this.runEvents(agent, run).filter(
          (e) => !removed.has(e.event_id),
        );
        const text = retained
          .filter((e) => e.type === "agent_reply")
          .map((e) => e.text)
          .join("\n");
        for (const e of retained.filter((e) => e.type === "run_finished")) {
          const result = JSON.parse(e.text);
          replacements.push([
            e.event_id,
            JSON.stringify({ ...result, text }),
          ]);
        }
      }
    }
    const attachments = all
      ? (this.db
          .prepare("SELECT id FROM attachments WHERE agent_id=?")
          .all(agent) as Array<{ id: string }>).map((x) => x.id)
      : [...new Set(selectedRows.flatMap((e) => e.attachments))].filter((id) => {
          for (const row of this.db
            .prepare("SELECT event_id,payload FROM events WHERE agent_id=?")
            .iterate(agent) as Iterable<any>) {
            if (
              !removed.has(row.event_id) &&
              (JSON.parse(row.payload) as EventInput).attachments.includes(id)
            )
              return false;
          }
          return true;
        });
    const attachmentFiles = attachments.flatMap((id) => {
      const a = this.getAttachment(agent, id);
      return a ? [a.path] : [];
    });
    const toolFiles = selectedRows.flatMap((e) =>
      e.type === "tool_result" && typeof e.data.result_file === "string"
        ? [e.data.result_file]
        : [],
    );
    const runs = all
      ? (this.db
          .prepare("SELECT id FROM runs WHERE agent_id=?")
          .all(agent) as Array<{ id: string }>).map((x) => x.id)
      : [];
    const copied = all
      ? this.journal.snapshotsForRuns(agent, runs)
      : this.journal.copiedSnapshots(
          agent,
          selectedRows.map((e) => e.event_id),
          selectedRows.map((e) => e.text),
        );
    const deletedCount = all
      ? Number(
          (this.db
            .prepare("SELECT COUNT(*) AS count FROM events WHERE agent_id=?")
            .get(agent) as { count: number }).count,
        )
      : selectedRows.length;
    const job: EraseJob = {
      agent,
      all,
      ids: selectedRows.map((e) => e.event_id),
      files: [...new Set([...attachmentFiles, ...toolFiles, ...copied])],
      attachments,
      replacements,
    };
    this.set("erase-events:" + agent, job);
    this.applyErase(job);
    return {
      deleted_events: deletedCount,
      deleted_attachments: attachments.length,
    };
  }
  private applyErase(job: EraseJob) {
    const ids = new Set(job.ids);
    if (job.all) this.journal?.clear(job.agent);
    else this.journal?.prune(job.agent, ids, new Map(job.replacements));
    this.journal?.eraseRelatedFiles(job.agent, job.files);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (job.all) {
        this.db.prepare("DELETE FROM events WHERE agent_id=?").run(job.agent);
        this.db.prepare("DELETE FROM runs WHERE agent_id=?").run(job.agent);
        this.db
          .prepare("DELETE FROM deliveries WHERE json_extract(payload,'$.agent_id')=?")
          .run(job.agent);
        this.db.prepare("DELETE FROM attachments WHERE agent_id=?").run(job.agent);
      } else {
        for (const [id, text] of job.replacements) {
          const e = this.getEvent(job.agent, id);
          if (!e) continue;
          const { seq, claimed, received_at, ...payload } = e;
          this.db
            .prepare("UPDATE events SET payload=? WHERE agent_id=? AND event_id=?")
            .run(JSON.stringify({ ...payload, text }), job.agent, id);
        }
        for (const id of ids) {
          this.db
            .prepare("DELETE FROM events WHERE agent_id=? AND event_id=?")
            .run(job.agent, id);
          this.db.prepare("DELETE FROM deliveries WHERE id=?").run(id);
        }
        for (const id of job.attachments)
          this.db
            .prepare("DELETE FROM attachments WHERE agent_id=? AND id=?")
            .run(job.agent, id);
      }
      this.set(
        "history-revision:" + job.agent,
        this.get("history-revision:" + job.agent, 0) + 1,
      );
      this.db.prepare("DELETE FROM kv WHERE key=?").run("erase-events:" + job.agent);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  clearSummary(agent: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM kv WHERE key=?").run("history:" + agent);
      this.set(
        "history-revision:" + agent,
        this.get("history-revision:" + agent, 0) + 1,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get<T>(key: string, fallback: T): T {
    const r: any = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  attachment(a: Attachment) {
    this.db
      .prepare(
        "INSERT INTO attachments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(a.id, a.agent_id, JSON.stringify(a));
  }
  getAttachment(agent: string, id: string): Attachment | undefined {
    const r: any = this.db
      .prepare("SELECT payload FROM attachments WHERE id=? AND agent_id=?")
      .get(id, agent);
    return r ? JSON.parse(r.payload) : undefined;
  }
  enqueue(d: Delivery) {
    this.db
      .prepare("INSERT OR IGNORE INTO deliveries(id,payload) VALUES(?,?)")
      .run(d.id, JSON.stringify(d));
  }
  markHandedOff(id: string, index: number, attempts: number) {
    this.db
      .prepare(
        "UPDATE deliveries SET handed_off=1,status='sending',part_index=?,attempts=? WHERE id=?",
      )
      .run(index, attempts, id);
  }
  purgeUnsent(agent: string, target: Target) {
    const rows = (
      this.db
        .prepare("SELECT * FROM deliveries WHERE handed_off=0")
        .all() as any[]
    ).filter((row) => {
      const d: Delivery = JSON.parse(row.payload);
      return d.agent_id === agent && targetKey(d.target) === targetKey(target);
    });
    if (!rows.length) return;
    const job = {
      agent,
      ids: rows.map((r) => r.id as string),
      runs: [
        ...new Set(rows.map((r) => (JSON.parse(r.payload) as Delivery).run_id)),
      ],
    };
    // Only IDs, never discarded bodies; removed when the physical deletion completes.
    this.set("prune-outbox:" + agent, job);
    this.applyPrune(job);
  }
  retainedReplyText(agent: string, run: string) {
    return this.runEvents(agent, run)
      .filter((e) => e.type === "agent_reply")
      .map((e) => e.text)
      .join("\n");
  }
  pruneRunSnapshots(agent: string, run: string) {
    this.journal?.pruneSnapshots(agent, new Set([run]));
  }
  private applyPrune(job: { agent: string; ids: string[]; runs: string[] }) {
    const ids = new Set(job.ids);
    const replacements = new Map<string, string>();
    const deleted = job.ids.flatMap((id) => {
      const e = this.getEvent(job.agent, id);
      return e ? [e] : [];
    });
    for (const run of job.runs) {
      const events = this.runEvents(job.agent, run);
      const text = events
        .filter((e) => e.type === "agent_reply" && !ids.has(e.event_id))
        .map((e) => e.text)
        .join("\n");
      for (const e of events.filter((e) => e.type === "run_finished")) {
        const result = JSON.parse(e.text);
        replacements.set(e.event_id, JSON.stringify({ ...result, text }));
      }
    }
    this.journal?.prune(job.agent, ids, replacements);
    this.journal?.pruneSnapshots(job.agent, new Set(job.runs), ids);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [id, text] of replacements) {
        const e = this.getEvent(job.agent, id)!;
        const { seq, claimed, received_at, ...payload } = e;
        this.db
          .prepare(
            "UPDATE events SET payload=? WHERE agent_id=? AND event_id=?",
          )
          .run(JSON.stringify({ ...payload, text }), job.agent, id);
      }
      for (const id of ids) {
        this.db.prepare("DELETE FROM deliveries WHERE id=?").run(id);
        this.db
          .prepare("DELETE FROM events WHERE agent_id=? AND event_id=?")
          .run(job.agent, id);
      }
      const checkpoint = this.get("history:" + job.agent, { through: 0 });
      if (deleted.some((e) => e.seq <= checkpoint.through))
        this.db
          .prepare("DELETE FROM kv WHERE key=?")
          .run("history:" + job.agent);
      this.set(
        "history-revision:" + job.agent,
        this.get("history-revision:" + job.agent, 0) + 1,
      );
      this.db
        .prepare("DELETE FROM kv WHERE key=?")
        .run("prune-outbox:" + job.agent);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  nextDelivery(): any {
    return this.db
      .prepare(
        "SELECT * FROM deliveries WHERE status IN ('queued','retry') ORDER BY seq LIMIT 1",
      )
      .get();
  }
  deliveryUpdate(
    id: string,
    status: string,
    index: number,
    attempts: number,
    error: string | null = null,
    next = 0,
  ) {
    this.db
      .prepare(
        "UPDATE deliveries SET status=?,part_index=?,attempts=?,error=?,next_at=? WHERE id=?",
      )
      .run(status, index, attempts, error, next, id);
  }
  gap(agent: string, t: Target) {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE agent_id=? AND type='agent_reply' ORDER BY seq DESC",
      )
      .all(agent);
    const e = rows
      .map((r) => this.decode(r))
      .find(
        (e) =>
          e.reply_target &&
          targetKey(e.reply_target) === targetKey(t) &&
          e.text,
      );
    const now = Date.now();
    return {
      target_ref: targetKey(t),
      last_response_id: e?.data.response_id ?? null,
      last_response_at: e?.received_at ?? null,
      as_of: new Date(now).toISOString(),
      seconds_since_last_response: e
        ? Math.max(0, (now - Date.parse(e.received_at)) / 1000)
        : null,
    };
  }
  isEcho(agent: string, messageId: string, target: Target) {
    return !!this.db
      .prepare(
        "SELECT seq FROM events WHERE agent_id=? AND type='delivery_result' AND json_extract(payload,'$.data.message_id')=? AND json_extract(payload,'$.reply_target.channel')=? AND json_extract(payload,'$.reply_target.conversation')=? LIMIT 1",
      )
      .get(agent, messageId, target.channel, target.conversation);
  }
  private secrets = new Set<string>();
  addSecrets(env: NodeJS.ProcessEnv) {
    for (const [key, value] of Object.entries(env))
      if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && value && value.length >= 8)
        this.secrets.add(value);
  }
  log(level: string, component: string, message: string, data: unknown = {}) {
    const redact = (text: string) => {
      for (const [k, v] of Object.entries(process.env))
        if (/KEY|TOKEN|SECRET|PASSWORD/.test(k) && v && v.length >= 8)
          text = text.split(v).join("[redacted]");
      for (const value of this.secrets)
        text = text.split(value).join("[redacted]");
      return text;
    };
    this.db
      .prepare(
        "INSERT INTO logs(at,level,component,message,data) VALUES(?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        level,
        component,
        redact(message),
        redact(JSON.stringify(data)),
      );
  }
  logs(limit = 100) {
    return this.db
      .prepare("SELECT * FROM logs ORDER BY seq DESC LIMIT ?")
      .all(limit);
  }
  close() {
    this.db.close();
  }
}
