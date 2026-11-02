import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config/schema.js";
import type { Intelligence } from "../shared/models.js";
import { Store } from "../layer2/store.js";
import { clamp, id, jsonWrite, readJson, errorText } from "../shared/files.js";
import { chunks, cut, tokens } from "../shared/tokens.js";
const Item = z
  .object({
    id: z.string().optional(),
    agent_name: z.string().optional(),
    type: z.string().default("event"),
    people: z.array(z.any()).default([]),
    occurred_at: z.string(),
    summary: z.string(),
    details: z.string().default(""),
    emotion: z.any().optional(),
    importance: z.number().min(1).max(5).default(3),
  })
  .passthrough();
export type Memory = z.infer<typeof Item> & { id: string };
export interface State {
  updated_at: string;
  mood: number;
  emotions: Record<string, number>;
  drives: Record<string, number>;
  cause: string;
  thoughts: Array<{ text: string; at: string }>;
  focus: string[];
  focus_updated_at?: string;
  activation: Record<string, number>;
  conversation_context?: unknown;
}
const cosine = (a: number[], b: number[]) =>
  a.length === b.length
    ? a.reduce((s, v, i) => s + v * b[i], 0) /
      (Math.hypot(...a) * Math.hypot(...b) || 1)
    : 0;
const terms = (s: string) =>
  new Set(
    (
      s.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]/gu) ?? ([] as string[])
    ).concat([...s.matchAll(/[\p{Script=Han}]{2}/gu)].map((x) => x[0])),
  );
export class MemoryService {
  private queryCache = new Map<string, { at: number; text: string }>();
  private stateChain: Promise<unknown> = Promise.resolve();
  private indexChain: Promise<unknown> = Promise.resolve();
  constructor(
    public root: string,
    public agentId: string,
    private db: Store,
    private cfg: Config,
    private llm: Intelligence,
  ) {}
  private validItems: Memory[] = [];
  private itemsValid = false;
  private lifecycle = new AbortController();
  close() {
    this.lifecycle.abort(new Error("Shutdown"));
  }
  async items() {
    try {
      const file = path.join(this.root, "memory.json");
      const raw = await readJson<any>(file, { memory: [] });
      const parsed = z
        .object({ memory: z.array(Item) })
        .passthrough()
        .parse(raw);
      let changed = false;
      const out = parsed.memory.map((x) => {
        if (!x.id) {
          x.id = id();
          changed = true;
        }
        return x as Memory;
      });
      if (new Set(out.map((x) => x.id)).size !== out.length)
        throw Error("duplicate memory id");
      if (changed) await jsonWrite(file, { ...raw, memory: out });
      this.itemsValid = true;
      this.validItems = out;
      return out;
    } catch (e) {
      this.itemsValid = false;
      this.db.log(
        "warn",
        "memory",
        "Invalid memory file; retaining last valid in-memory view",
        { error: errorText(e) },
      );
      return this.validItems;
    }
  }
  async state(): Promise<State> {
    const now = Date.now();
    const s = await readJson<State>(path.join(this.root, "state.json"), {
      updated_at: new Date(now).toISOString(),
      mood: this.cfg.state.baseline,
      emotions: {},
      drives: Object.fromEntries(
        Object.entries(this.cfg.drives)
          .filter(([, d]) => d.enabled)
          .map(([k, d]) => [k, d.baseline]),
      ),
      cause: "",
      thoughts: [],
      focus: [],
      activation: {},
    });
    const hours = Math.max(0, (now - Date.parse(s.updated_at)) / 3600000);
    s.mood =
      this.cfg.state.baseline +
      (s.mood - this.cfg.state.baseline) *
        2 ** (-hours / this.cfg.state.moodHalfLifeHours);
    for (const k of Object.keys(s.emotions))
      s.emotions[k] *=
        2 ** ((-hours * 60) / this.cfg.state.emotionHalfLifeMinutes);
    for (const [k, d] of Object.entries(this.cfg.drives)) {
      if (!d.enabled) {
        delete s.drives[k];
        continue;
      }
      s.drives[k] =
        d.baseline +
        ((s.drives[k] ?? d.baseline) - d.baseline) *
          2 ** (-hours / d.halfLifeHours);
    }
    s.thoughts = s.thoughts.filter(
      (x) => now - Date.parse(x.at) < this.cfg.state.thoughtTtlHours * 3600000,
    );
    for (const k of Object.keys(s.activation))
      if (now - s.activation[k] > this.cfg.memory.activationTtlHours * 3600000)
        delete s.activation[k];
    if (
      s.focus_updated_at &&
      now - Date.parse(s.focus_updated_at) >
        this.cfg.state.focusTtlHours * 3600000
    )
      s.focus = [];
    s.thoughts.sort(
      (a, b) =>
        2 **
          (-(now - Date.parse(b.at)) /
            3600000 /
            this.cfg.state.thoughtHalfLifeHours) -
        2 **
          (-(now - Date.parse(a.at)) /
            3600000 /
            this.cfg.state.thoughtHalfLifeHours),
    );
    s.updated_at = new Date(now).toISOString();
    return s;
  }
  updateState(fn: (s: State) => void) {
    const job = this.stateChain.then(async () => {
      const s = await this.state();
      fn(s);
      await jsonWrite(path.join(this.root, "state.json"), s);
      return s;
    });
    this.stateChain = job.catch(() => {});
    return job;
  }
  private enriching = false;
  private mutateIndex<T>(
    fn: (index: Record<string, any>) => Promise<T>,
  ): Promise<T> {
    const job = this.indexChain.then(async () => {
      const index = await this.index();
      const result = await fn(index);
      await this.saveIndex(index);
      return result;
    });
    this.indexChain = job.catch(() => {});
    return job;
  }
  async sync(enrich = false) {
    const items = await this.items();
    if (!this.itemsValid) return items;
    const signature =
      this.cfg.models.embedding.baseUrl + "|" + this.cfg.models.embedding.name;
    await this.mutateIndex(async (index) => {
      const valid = new Set(items.map((m) => m.id));
      for (const key of Object.keys(index))
        if (!valid.has(key)) delete index[key];
      for (const m of items) {
        const hash = createHash("sha256")
            .update(JSON.stringify(m))
            .digest("hex"),
          old = index[m.id];
        if (!old || old.hash !== hash || old.embeddingModel !== signature)
          index[m.id] = {
            hash,
            text:
              m.summary + "\n" + m.details + "\n" + JSON.stringify(m.people),
            description: "",
            vectors: [],
            strength: old?.strength ?? 1,
            strengthAt: old?.strengthAt ?? new Date().toISOString(),
            familiarity: old?.familiarity ?? 0,
            embeddingModel: signature,
          };
      }
    });
    if (!enrich || this.enriching) return items;
    this.enriching = true;
    try {
      const snapshot = await this.index();
      // Network work happens outside the index writer so normal recall remains responsive.
      for (
        let start = 0;
        start < items.length;
        start += this.cfg.memory.maintenanceBatchItems
      ) {
        for (const m of items.slice(
          start,
          start + this.cfg.memory.maintenanceBatchItems,
        )) {
          if (this.lifecycle.signal.aborted) break;
          const row = snapshot[m.id];
          if (row.vectors.length) continue;
          try {
            let description = row.description;
            const deadline = AbortSignal.any([
              this.lifecycle.signal,
              AbortSignal.timeout(this.cfg.memory.maintenanceTimeoutMs),
            ]);
            if (this.cfg.memory.searchDescription && !description) {
              const d = await this.llm.json(
                this.cfg.prompts.searchDescription ??
                  '根据原记忆生成简短检索句，保留具体人物、事件和可能唤起的表达，不能编造。返回 {"search_text":"..."}',
                { memory: m },
                deadline,
                "maintenance",
              );
              description = cut(
                String(d.search_text ?? ""),
                this.cfg.memory.descriptionTokens,
              );
            }
            const pieces = chunks(
                description + "\n" + row.text,
                this.cfg.memory.chunkTokens,
                this.cfg.memory.chunkOverlap,
              ),
              vectors: number[][] = [];
            for (let p = 0; p < pieces.length; p += 20)
              vectors.push(
                ...(await this.llm.embed(pieces.slice(p, p + 20), deadline)),
              );
            await this.mutateIndex(async (current) => {
              if (
                current[m.id]?.hash === row.hash &&
                current[m.id]?.embeddingModel === signature
              ) {
                current[m.id].description = description;
                current[m.id].vectors = vectors;
              }
            });
          } catch (e) {
            this.db.log("warn", "memory", "index enrichment failed", {
              agent: this.agentId,
              id: m.id,
              error: errorText(e),
            });
          }
        }
      }
    } finally {
      this.enriching = false;
    }
    return items;
  }
  async index() {
    const cached = this.db.get<Record<string, any> | null>(
      `index:${this.agentId}`,
      null,
    );
    return (
      cached ??
      (await readJson<Record<string, any>>(
        path.join(this.root, ".runtime", "search-index.json"),
        {},
      ))
    );
  }
  private async saveIndex(index: Record<string, any>) {
    this.db.set(`index:${this.agentId}`, index);
    await jsonWrite(
      path.join(this.root, ".runtime", "search-index.json"),
      index,
    );
  }
  async search(
    query: string,
    explicit = false,
    limit = this.cfg.memory.maxItems,
    signal?: AbortSignal,
  ) {
    const items = await this.sync(false),
      index = await this.index(),
      state = await this.state();
    if (!items.length) return [];
    const deadline = AbortSignal.timeout(this.cfg.memory.recallTimeoutMs);
    const searchSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    let vectors: number[][] = [];
    try {
      vectors = await this.llm.embed([cut(query, 1000)], searchSignal);
    } catch (e) {
      this.db.log(
        "warn",
        "memory",
        "semantic recall unavailable; lexical fallback",
        { error: errorText(e) },
      );
    }
    const q = terms(query),
      ranked = items.map((m) => {
        const row = index[m.id],
          t = terms(row.text);
        const lex = [...q].filter((k) => t.has(k)).length / Math.max(1, q.size);
        const sem = vectors.length
          ? Math.max(
              0,
              ...row.vectors.map((v: number[]) => cosine(vectors[0], v)),
            )
          : 0;
        const I = (m.importance - 1) / 4;
        const days = Math.max(
          0,
          (Date.now() - Date.parse(row.strengthAt)) / 86400000,
        );
        const A = explicit
          ? 1
          : row.strength *
            2 **
              (-days /
                (this.cfg.memory.baseHalfLifeDays *
                  (1 + this.cfg.memory.importanceMultiplier * I)));
        const B = state.activation[m.id]
          ? 2 **
            (-(Date.now() - state.activation[m.id]) /
              60000 /
              this.cfg.memory.activationHalfLifeMinutes)
          : 0;
        const emotionText = JSON.stringify(m.emotion ?? "");
        const daysOld = Math.max(
          0,
          (Date.now() - Date.parse(m.occurred_at)) / 86400000,
        );
        const E =
          Math.max(
            0,
            ...Object.entries(state.emotions)
              .filter(([k]) => emotionText.includes(k))
              .map(([, v]) => v / 100),
          ) *
          2 ** (-daysOld / this.cfg.memory.emotionHalfLifeDays);
        return {
          m,
          lex,
          sem,
          A: clamp(A, 0, 1),
          I,
          B,
          E: Number.isFinite(E) ? E : 0,
          F: 1 - Math.exp(-row.familiarity / 5),
        };
      });
    const lex = [...ranked].sort((a, b) => b.lex - a.lex),
      sem = [...ranked].sort((a, b) => b.sem - a.sem);
    const weights = this.cfg.memory.rankWeights;
    let results = ranked
      .filter((x) => x.lex > 0 || x.sem > this.cfg.memory.vectorThreshold)
      .map((x) => ({
        ...x,
        score:
          (1 / (this.cfg.memory.rrfK + lex.indexOf(x) + 1) +
            1 / (this.cfg.memory.rrfK + sem.indexOf(x) + 1)) *
          (weights.base +
            weights.strength * x.A +
            weights.importance * x.I +
            weights.activation * x.B +
            weights.familiarity * x.F +
            weights.emotion * x.E),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.memory.candidates);
    if (this.cfg.memory.rerank && results.length > 1 && !explicit)
      try {
        const out = await this.llm.json(
          this.cfg.prompts.rerank ??
            '按与查询的直接相关性排列记忆编号。只返回 {"ids":["..."]}，不增添编号。',
          {
            query,
            memories: results.map((x) => ({
              id: x.m.id,
              summary: x.m.summary,
            })),
          },
          searchSignal,
          "rerank",
        );
        const order = Array.isArray(out.ids) ? out.ids : [];
        for (const x of results) {
          const rank = order.indexOf(x.m.id);
          if (rank >= 0)
            x.score *=
              1 + (0.25 * (order.length - rank)) / Math.max(1, order.length);
        }
        results.sort((a, b) => b.score - a.score);
      } catch (e) {
        this.db.log("warn", "memory", "rerank fallback", {
          error: errorText(e),
        });
      }
    const selected: typeof results = [];
    while (results.length && selected.length < limit) {
      results.sort((a, b) => b.score - a.score);
      const next = results.shift()!;
      selected.push(next);
      const a = terms(next.m.summary);
      for (const x of results) {
        const b = terms(x.m.summary),
          overlap =
            [...a].filter((t) => b.has(t)).length /
            Math.max(1, new Set([...a, ...b]).size);
        x.score *= 1 - this.cfg.memory.diversityPenalty * overlap;
      }
    }
    this.db.log("debug", "recall", "ranked memories", {
      agent: this.agentId,
      selected: selected.map((x) => ({
        id: x.m.id,
        score: x.score,
        semantic: x.sem,
        lexical: x.lex,
        strength: x.A,
        activation: x.B,
        emotion: x.E,
      })),
    });
    return selected.map((x) => x.m);
  }
  async recall(query: string, signal?: AbortSignal) {
    if (!this.cfg.memory.enabled) return [];
    if (!(await this.items()).length) return [];
    let q = query;
    if (this.cfg.memory.query)
      try {
        const cached = this.queryCache.get(query);
        if (
          cached &&
          Date.now() - cached.at < this.cfg.memory.queryCacheSeconds * 1000
        )
          q = cached.text;
        else {
          const deadline = AbortSignal.timeout(this.cfg.memory.queryTimeoutMs);
          const r = await this.llm.json(
            this.cfg.prompts.query ??
              '根据当前消息和近文生成最多三条查找旧事的查询。返回 {"queries":["..."]}，保留未知，不编造。',
            { text: cut(query, this.cfg.memory.queryInputTokens) },
            signal ? AbortSignal.any([signal, deadline]) : deadline,
            "query",
          );
          if (Array.isArray(r.queries))
            q +=
              "\n" +
              r.queries.slice(0, this.cfg.memory.queryDirections).join("\n");
          this.queryCache.set(query, { at: Date.now(), text: q });
          if (this.queryCache.size > 50)
            this.queryCache.delete(this.queryCache.keys().next().value!);
        }
      } catch (e) {
        this.db.log("warn", "memory", "query fallback", {
          error: errorText(e),
        });
      }
    const found = await this.search(q, false, this.cfg.memory.maxItems, signal);
    const all = await this.items();
    if (found.length) {
      const anchor = found[0];
      const neighbors = all
        .filter(
          (m) =>
            !found.some((x) => x.id === m.id) &&
            Math.abs(
              Date.parse(m.occurred_at) - Date.parse(anchor.occurred_at),
            ) <=
              this.cfg.memory.temporalWindowHours * 3600000,
        )
        .sort(
          (a, b) =>
            Math.abs(
              Date.parse(a.occurred_at) - Date.parse(anchor.occurred_at),
            ) -
            Math.abs(
              Date.parse(b.occurred_at) - Date.parse(anchor.occurred_at),
            ),
        )
        .slice(0, this.cfg.memory.temporalNeighbors);
      found.splice(Math.max(1, this.cfg.memory.maxItems - neighbors.length));
      found.push(...neighbors);
    }
    const round = this.db.get(`recallRound:${this.agentId}`, 0) + 1;
    this.db.set(`recallRound:${this.agentId}`, round);
    const assoc = this.db.get<Record<string, number>>(
      `associations:${this.agentId}`,
      {},
    );
    if (
      Math.random() < this.cfg.memory.associationProbability &&
      found.length
    ) {
      const anchor = found[0];
      const pool = all.filter(
        (m) =>
          !found.some((f) => f.id === m.id) &&
          round - (assoc[m.id] ?? -100) > this.cfg.memory.associationCooldown &&
          (m.people.some((p) =>
            anchor.people.some((a) => JSON.stringify(a) === JSON.stringify(p)),
          ) ||
            Math.abs(
              Date.parse(m.occurred_at) - Date.parse(anchor.occurred_at),
            ) < 86400000),
      );
      if (pool.length) {
        const m = pool[Math.floor(Math.random() * pool.length)];
        found.push({
          ...m,
          summary:
            "[突然联想] " + cut(m.summary, this.cfg.memory.associationTokens),
          details: "",
        });
        assoc[m.id] = round;
        this.db.set(`associations:${this.agentId}`, assoc);
      }
    }
    let budget = this.cfg.context.memoryTokens;
    const out: Memory[] = [];
    for (const [i, m] of found.entries()) {
      const x = {
        ...m,
        summary: cut(m.summary, this.cfg.memory.summaryTokens),
        details:
          i < this.cfg.memory.detailsItems
            ? cut(m.details, this.cfg.memory.detailsTokens)
            : "",
      };
      const cost = tokens(JSON.stringify(x));
      if (cost <= budget) {
        out.push(x);
        budget -= cost;
      }
    }
    await this.updateState((s) => {
      if (this.cfg.memory.activationEnabled) {
        for (const m of out)
          if (!s.activation[m.id]) s.activation[m.id] = Date.now();
        const keep = Object.entries(s.activation)
          .sort((a, b) => b[1] - a[1])
          .slice(0, this.cfg.memory.activationMaxItems);
        s.activation = Object.fromEntries(keep);
      }
    });
    return out;
  }
  async afterRun(runId: string, input: unknown, candidates: Memory[]) {
    if (!this.cfg.state.enabled) return;
    const key = `moodDone:${runId}`;
    if (this.db.get(key, false)) return;
    const state = await this.state();
    const persona = await fs.readFile(
      path.join(this.root, "persona.md"),
      "utf8",
    );
    const result = await this.llm.json(
      this.cfg.prompts.emotion ??
        '判断这一轮实际经历带来的心情变化，定时提醒不是用户原话，未完成不算成功。返回 {"mood":增量,"emotions":{名称:增量},"drives":{名称:增量},"cause":"简短原因","thoughts":["念头"],"focus":["关注点"],"memory_mentions":["真正重温的候选编号"]}。允许零变化，仅作为背景的记忆不算重温。',
      {
        persona: cut(persona, 1000),
        policy: {
          sensitivity: this.cfg.state.eventSensitivity,
          surpriseMax: this.cfg.state.surpriseMax,
          repeatedStimulusMultiplier: this.cfg.state.repeatedStimulusMultiplier,
        },
        state,
        input: cut(JSON.stringify(input), this.cfg.state.inputTokens),
        memories: candidates.map((x) => ({ id: x.id, summary: x.summary })),
      },
      AbortSignal.any([
        this.lifecycle.signal,
        AbortSignal.timeout(this.cfg.state.timeoutMs),
      ]),
      "emotion",
    );
    await this.updateState((s) => {
      const delta = (v: any, limit: number) =>
        Number.isFinite(Number(v)) ? clamp(Number(v), -limit, limit) : 0;
      s.mood = clamp(
        s.mood +
          delta(
            Number(result.mood) * this.cfg.state.eventSensitivity,
            this.cfg.state.moodDeltaLimit,
          ),
        0,
        100,
      );
      for (const field of ["emotions", "drives"] as const)
        for (const [k, v] of Object.entries(result[field] ?? {}).slice(0, 12)) {
          if (field === "drives" && !this.cfg.drives[k]?.enabled) continue;
          if (field === "emotions" && !this.cfg.state.emotionLabels.includes(k))
            continue;
          const d = field === "drives" ? this.cfg.drives[k] : undefined;
          s[field][k] = clamp(
            (s[field][k] ?? 0) +
              delta(
                Number(v) * (d?.sensitivity ?? this.cfg.state.eventSensitivity),
                this.cfg.state.dimensionDeltaLimit,
              ),
            d?.min ?? 0,
            d?.max ?? 100,
          );
        }
      if (typeof result.cause === "string")
        s.cause = result.cause.slice(0, this.cfg.state.reportChars);
      if (Array.isArray(result.thoughts))
        s.thoughts = result.thoughts
          .filter((x: any) => typeof x === "string")
          .slice(0, this.cfg.state.thoughtsMax)
          .map((text: string) => ({
            text: text.slice(0, 300),
            at: new Date().toISOString(),
          }));
      if (Array.isArray(result.focus)) {
        s.focus_updated_at = new Date().toISOString();
        s.focus = result.focus
          .filter((x: any) => typeof x === "string")
          .slice(0, this.cfg.state.focusMax);
      }
    });
    const reinforce = this.indexChain.then(async () => {
      const index = await this.index();
      const mentions = Array.isArray(result.memory_mentions)
        ? result.memory_mentions
        : [];
      for (const id of new Set<string>(mentions)) {
        const row = index[id],
          m = candidates.find((m) => m.id === id);
        if (!row || !m) continue;
        const H =
          this.cfg.memory.baseHalfLifeDays *
          (1 + (this.cfg.memory.importanceMultiplier * (m.importance - 1)) / 4);
        const A =
          row.strength *
          2 **
            (-Math.max(
              0,
              (Date.now() - Date.parse(row.strengthAt)) / 86400000,
            ) /
              H);
        row.strength = A + this.cfg.memory.reinforcementGain * (1 - A);
        row.strengthAt = new Date().toISOString();
        row.familiarity++;
        await this.updateState((s) => {
          s.activation[id] = Date.now();
        });
      }
      await this.saveIndex(index);
      this.db.set(key, true);
    });
    this.indexChain = reinforce.catch(() => {});
    await reinforce;
  }
}
