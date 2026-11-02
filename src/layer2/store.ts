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
export class Store {
  db: DatabaseSync;
  constructor(
    file: string,
    private journal?: Journal,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
 PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,agent_id TEXT NOT NULL,type TEXT NOT NULL,run_id TEXT,received_at TEXT NOT NULL,payload TEXT NOT NULL,claimed INTEGER NOT NULL DEFAULT 0,UNIQUE(agent_id,event_id));
 CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id,seq);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,agent_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,error TEXT);
 CREATE INDEX IF NOT EXISTS events_run ON events(agent_id,run_id,seq);
 CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',part_index INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,error TEXT);
 CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,agent_id TEXT,payload TEXT);
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS logs(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT,level TEXT,component TEXT,message TEXT,data TEXT);
 `);
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
