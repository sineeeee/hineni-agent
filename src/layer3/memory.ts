import {
  balancedMemories,
  memoryFactors,
  synchronizeMemoryIndex,
} from "./memory-ranking.js";
import { auxiliaryPrompt } from "../config/auxiliary.js";
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
export interface IndexOptions {
  side?: "both" | "fact" | "feeling";
  ids?: string[];
  force?: boolean;
}
export interface State {
  updated_at: string;
  assessed_at?: string;
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
  private feelingCache = new Map<string, { at: number; text: string }>();
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
  private preview?: {
    items: Memory[];
    index: Record<string, any>;
    state: State;
    now: number;
  };
  private observation?: {
    query?: (value: any) => void;
    search?: (value: any) => void;
    recall?: (value: any) => void;
    phase?: (value: any) => void;
  };
  private now() {
    return this.preview?.now ?? Date.now();
  }
  private validItems: Memory[] = [];
  private itemsValid = false;
  private lifecycle = new AbortController();
  close() {
    this.lifecycle.abort(new Error("Shutdown"));
    return this.indexingTask;
  }
  async items() {
    if (this.preview) return structuredClone(this.preview.items);
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
  async state(source?: State, now = this.now()): Promise<State> {
    const s = source
      ? structuredClone(source)
      : this.preview
        ? structuredClone(this.preview.state)
        : await readJson<State>(path.join(this.root, "state.json"), {
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
      if (!this.preview) await jsonWrite(path.join(this.root, "state.json"), s);
      return s;
    });
    this.stateChain = job.catch(() => {});
    return job;
  }
  private contentChain: Promise<unknown> = Promise.resolve();
  private pendingEnrichment = false;
  private enriching = false;
  private indexingTask?: Promise<void>;
  private progress = {
    status: "idle",
    total: 0,
    processed: 0,
    failed: 0,
    current_id: "",
    error: "",
    started_at: "",
    finished_at: "",
  };
  async indexStatus() {
    const items = await this.items(),
      index = await this.index();
    const ready = items.filter(
      (m) =>
        index[m.id]?.version === 2 &&
        index[m.id]?.embeddingModel ===
          this.cfg.models.embedding.baseUrl +
            "|" +
            this.cfg.models.embedding.name &&
        index[m.id]?.vectors?.length &&
        (!this.cfg.memory.feelingRecall ||
          !index[m.id]?.feelingText ||
          index[m.id]?.feelingVectors?.length) &&
        index[m.id].hash ===
          createHash("sha256").update(JSON.stringify(m)).digest("hex"),
    ).length;
    return {
      ...this.progress,
      job_total: this.progress.total,
      fact_ready: items.filter((m) => index[m.id]?.vectors?.length).length,
      feeling_ready: items.filter((m) => index[m.id]?.feelingVectors?.length)
        .length,
      feeling_total: items.filter((m) => index[m.id]?.feelingText).length,
      total: items.length,
      ready,
      pending: items.length - ready,
    };
  }
  startIndexing(options: IndexOptions = {}) {
    if (this.indexingTask || this.enriching) return;
    this.progress = {
      status: "running",
      total: 0,
      processed: 0,
      failed: 0,
      current_id: "",
      error: "",
      started_at: new Date().toISOString(),
      finished_at: "",
    };
    this.indexingTask = this.sync(true, options)
      .then(
        () => {},
        (e) => {
          this.progress.status = "failed";
          this.progress.error = errorText(e);
          this.progress.finished_at = new Date().toISOString();
          this.db.log("warn", "memory", "manual index failed", {
            agent: this.agentId,
            error: errorText(e),
          });
        },
      )
      .finally(() => {
        this.indexingTask = undefined;
        if (this.pendingEnrichment && !this.lifecycle.signal.aborted) {
          this.pendingEnrichment = false;
          this.startIndexing();
        }
      });
  }
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
  async sync(enrich = false, options: IndexOptions = {}) {
    if (this.preview) return this.items();
    const signature =
      this.cfg.models.embedding.baseUrl + "|" + this.cfg.models.embedding.name;
    const items = await this.mutateIndex(async (index) => {
      // Read inside the index queue: an earlier snapshot must not resurrect deleted rows.
      const latest = await this.items();
      if (!this.itemsValid) {
        if (enrich) throw Error("memory.json 无效，请先修正文件。");
        return latest;
      }
      synchronizeMemoryIndex(latest, index, signature, this.now());
      return latest;
    });
    if (!this.itemsValid) return items;
    if (!enrich || this.enriching) return items;
    if (options.ids?.some((id) => !items.some((m) => m.id === id)))
      throw Error("重建列表含不存在的记忆，请刷新后重试。");
    this.enriching = true;
    const work = options.ids
      ? items.filter((m) => options.ids!.includes(m.id))
      : items;
    const factSide = options.side !== "feeling";
    const feelingSide =
      options.side !== "fact" &&
      (this.cfg.memory.feelingRecall ||
        options.side === "feeling" ||
        options.side === "both");
    this.progress = {
      status: "running",
      total: work.length,
      processed: 0,
      failed: 0,
      current_id: "",
      error: "",
      started_at: new Date().toISOString(),
      finished_at: "",
    };
    try {
      if (options.force)
        await this.mutateIndex(async (index) => {
          for (const m of work)
            if (index[m.id]) {
              if (factSide) {
                index[m.id].vectors = [];
                index[m.id].description = "";
              }
              if (feelingSide) index[m.id].feelingVectors = [];
            }
        });
      const snapshot = await this.index();
      // Network work happens outside the index writer so normal recall remains responsive.
      for (
        let start = 0;
        start < work.length;
        start += this.cfg.memory.maintenanceBatchItems
      ) {
        for (const m of work.slice(
          start,
          start + this.cfg.memory.maintenanceBatchItems,
        )) {
          if (this.lifecycle.signal.aborted) break;
          const row = snapshot[m.id];
          if (!row) {
            this.progress.processed++;
            continue;
          }
          if (
            (!factSide || row.vectors.length) &&
            (!feelingSide || !row.feelingText || row.feelingVectors?.length)
          ) {
            this.progress.processed++;
            continue;
          }
          this.progress.current_id = m.id;
          try {
            const deadline = AbortSignal.any([
              this.lifecycle.signal,
              AbortSignal.timeout(this.cfg.memory.maintenanceTimeoutMs),
            ]);
            const embedPieces = async (text: string) => {
              const pieces = chunks(
                text,
                this.cfg.memory.chunkTokens,
                this.cfg.memory.chunkOverlap,
              );
              const vectors: number[][] = [];
              for (let p = 0; p < pieces.length; p += 20)
                vectors.push(
                  ...(await this.llm.embed(pieces.slice(p, p + 20), deadline)),
                );
              if (
                vectors.length !== pieces.length ||
                vectors.some((v) => !v.length)
              )
                throw Error("Incomplete memory embeddings");
              return vectors;
            };
            const save = async (fields: Record<string, unknown>) =>
              this.mutateIndex(async (current) => {
                if (
                  current[m.id]?.hash === row.hash &&
                  current[m.id]?.embeddingModel === signature
                )
                  Object.assign(current[m.id], fields);
              });
            const outcomes = await Promise.allSettled([
              (async () => {
                if (!factSide || row.vectors.length) return;
                let description = row.description;
                if (this.cfg.memory.searchDescription && !description) {
                  const d = await this.llm.json(
                    await auxiliaryPrompt(
                      this.root,
                      this.cfg,
                      "searchDescription",
                    ),
                    {
                      memory: {
                        summary: m.summary,
                        details: m.details,
                        people: m.people,
                        agent_name: m.agent_name,
                      },
                    },
                    deadline,
                    "maintenance",
                  );
                  description = cut(
                    String(d.search_text ?? ""),
                    this.cfg.memory.descriptionTokens,
                  );
                }
                await save({
                  description,
                  vectors: await embedPieces(description + "\n" + row.text),
                });
              })(),
              (async () => {
                if (
                  !feelingSide ||
                  !row.feelingText ||
                  row.feelingVectors?.length
                )
                  return;
                await save({
                  feelingVectors: await embedPieces(row.feelingText),
                });
              })(),
            ]);
            const failures = outcomes.filter((x) => x.status === "rejected");
            if (failures.length)
              throw new AggregateError(
                failures.map((x) => (x as PromiseRejectedResult).reason),
                failures
                  .map((x) => errorText((x as PromiseRejectedResult).reason))
                  .join("; "),
              );
          } catch (e) {
            this.progress.failed++;
            this.progress.error = errorText(e);
            this.db.log("warn", "memory", "index enrichment failed", {
              agent: this.agentId,
              id: m.id,
              error: errorText(e),
            });
          } finally {
            this.progress.processed++;
          }
        }
      }
    } finally {
      this.progress.status =
        this.progress.failed || this.lifecycle.signal.aborted
          ? "failed"
          : "completed";
      this.progress.current_id = "";
      this.progress.finished_at = new Date().toISOString();
      this.enriching = false;
      if (
        !this.indexingTask &&
        this.pendingEnrichment &&
        !this.lifecycle.signal.aborted
      ) {
        this.pendingEnrichment = false;
        this.startIndexing();
      }
    }
    return items;
  }
  async index() {
    if (this.preview) return structuredClone(this.preview.index);
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
    feelingQuery = "",
  ) {
    const items = await this.sync(false),
      index = await this.index(),
      state = await this.state();
    if (!items.length) return [];
    const deadline = AbortSignal.timeout(this.cfg.memory.recallTimeoutMs);
    const searchSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    // Each route can fall back independently; one failed query cannot erase the other.
    const vectors = await Promise.all(
      [cut(query, 1000), ...(feelingQuery ? [feelingQuery] : [])].map(
        async (text, route) => {
          try {
            return (await this.llm.embed([text], searchSignal))[0] ?? [];
          } catch (e) {
            this.db.log(
              "warn",
              "memory",
              "semantic recall unavailable; lexical fallback",
              { route: route ? "feeling" : "fact", error: errorText(e) },
            );
            return [];
          }
        },
      ),
    );
    const fq = terms(feelingQuery);
    const q = terms(query),
      ranked = items
        .filter((m) => index[m.id])
        .map((m) => {
          const row = index[m.id],
            t = terms(row.text);
          const lex =
            [...q].filter((k) => t.has(k)).length / Math.max(1, q.size);
          const sem = vectors.length
            ? Math.max(
                0,
                ...row.vectors.map((v: number[]) => cosine(vectors[0], v)),
              )
            : 0;
          const ft = terms(row.feelingText ?? "");
          const feelingLex = feelingQuery
            ? [...fq].filter((k) => ft.has(k)).length / Math.max(1, fq.size)
            : 0;
          const feelingSem = vectors[1]
            ? Math.max(
                0,
                ...(row.feelingVectors ?? []).map((v: number[]) =>
                  cosine(vectors[1], v),
                ),
              )
            : 0;
          const factors = memoryFactors(
            m,
            row,
            state,
            this.cfg.memory,
            this.now(),
            explicit,
          );
          return {
            m,
            feelingLex,
            feelingSem,
            lex,
            sem,
            factors,
            A: factors.strength,
            I: factors.importance,
            B: factors.activation,
            E: factors.emotion,
            F: factors.familiarity,
          };
        });
    const lex = [...ranked].sort((a, b) => b.lex - a.lex),
      sem = [...ranked].sort((a, b) => b.sem - a.sem);
    const fl = [...ranked].sort((a, b) => b.feelingLex - a.feelingLex),
      fs = [...ranked].sort((a, b) => b.feelingSem - a.feelingSem);
    const factEligible = (x: (typeof ranked)[number]) =>
      x.lex > 0 || x.sem > this.cfg.memory.vectorThreshold;
    const feelingEligible = (x: (typeof ranked)[number]) =>
      !!feelingQuery &&
      (x.feelingLex > 0 ||
        x.feelingSem > this.cfg.memory.feelingVectorThreshold);
    const rrf = (
      x: (typeof ranked)[number],
      a: typeof ranked,
      b: typeof ranked,
    ) =>
      1 / (this.cfg.memory.rrfK + a.indexOf(x) + 1) +
      1 / (this.cfg.memory.rrfK + b.indexOf(x) + 1);
    let results = ranked
      .filter((x) => factEligible(x) || feelingEligible(x))
      .map((x) => ({
        ...x,
        score:
          Math.max(
            factEligible(x) ? rrf(x, lex, sem) : 0,
            feelingEligible(x) ? rrf(x, fl, fs) : 0,
          ) * x.factors.multiplier,
      }))
      .sort((a, b) => b.score - a.score);
    const share = feelingQuery && !explicit ? this.cfg.memory.feelingShare : 0;
    results = balancedMemories(
      results,
      this.cfg.memory.candidates,
      share,
      factEligible,
      feelingEligible,
    ).map((x) => x.value);
    const initialScores = new Map(results.map((x) => [x.m.id, x.score]));
    if (this.cfg.memory.rerank && results.length > 1 && !explicit)
      try {
        const out = await this.llm.json(
          await auxiliaryPrompt(this.root, this.cfg, "rerank"),
          {
            query,
            feeling_query: feelingQuery,
            memories: results.map((x) => ({
              id: x.m.id,
              summary: x.m.summary,
              ...(feelingQuery
                ? { feeling: x.m.emotion?.feeling, labels: x.m.emotion?.labels }
                : {}),
            })),
          },
          signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(this.cfg.memory.recallTimeoutMs),
              ])
            : AbortSignal.timeout(this.cfg.memory.recallTimeoutMs),
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
    const rerankedScores = new Map(results.map((x) => [x.m.id, x.score]));
    const picks = balancedMemories(
      results,
      limit,
      share,
      factEligible,
      feelingEligible,
      (next, remaining) => {
        const a = terms(next.m.summary);
        for (const x of remaining) {
          const b = terms(x.m.summary),
            overlap =
              [...a].filter((t) => b.has(t)).length /
              Math.max(1, new Set([...a, ...b]).size);
          x.score *= 1 - this.cfg.memory.diversityPenalty * overlap;
        }
      },
    );
    const selected = picks
      .map((x) => x.value)
      .sort((a, b) => b.score - a.score);
    this.observation?.search?.({
      query,
      feeling_query: feelingQuery,
      quotas: {
        fact: limit - Math.round(limit * share),
        feeling: Math.round(limit * share),
      },
      explicit,
      entries: ranked.map((x) => ({
        id: x.m.id,
        lexical: x.lex,
        semantic: x.sem,
        factors: x.factors,
        feeling_lexical: x.feelingLex,
        feeling_semantic: x.feelingSem,
        allocated_route:
          picks.find((p) => p.value.m.id === x.m.id)?.route ?? null,
        matched_routes: [
          factEligible(x) ? "fact" : "",
          feelingEligible(x) ? "feeling" : "",
        ].filter(Boolean),
        eligible: factEligible(x) || feelingEligible(x),
        candidate: initialScores.has(x.m.id),
        initial_score: initialScores.get(x.m.id) ?? null,
        reranked_score: rerankedScores.get(x.m.id) ?? null,
        selected_score: selected.find((y) => y.m.id === x.m.id)?.score ?? null,
        search_rank:
          selected.findIndex((y) => y.m.id === x.m.id) < 0
            ? null
            : selected.findIndex((y) => y.m.id === x.m.id) + 1,
      })),
      selected_ids: selected.map((x) => x.m.id),
    });
    this.db.log(
      "debug",
      this.preview ? "memory-preview" : "recall",
      "ranked memories",
      {
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
      },
    );
    return selected.map((x) => x.m);
  }
  private async feelingQuery(material: string, signal?: AbortSignal) {
    if (!this.cfg.memory.feelingRecall) return "";
    const text = cut(material, this.cfg.memory.feelingInputTokens);
    const cached = this.feelingCache.get(text);
    if (
      cached &&
      Date.now() - cached.at < this.cfg.memory.queryCacheSeconds * 1000
    )
      return cached.text;
    try {
      const deadline = AbortSignal.timeout(this.cfg.memory.queryTimeoutMs);
      const result = await this.llm.json(
        await auxiliaryPrompt(this.root, this.cfg, "feelingQuery"),
        { route: "feeling", text },
        signal ? AbortSignal.any([signal, deadline]) : deadline,
        "query",
      );
      const q =
        typeof result.feeling_query === "string"
          ? cut(result.feeling_query.trim(), this.cfg.memory.feelingQueryTokens)
          : "";
      this.feelingCache.set(text, { at: Date.now(), text: q });
      if (this.feelingCache.size > 50)
        this.feelingCache.delete(this.feelingCache.keys().next().value!);
      return q;
    } catch (e) {
      this.db.log("warn", "memory", "feeling query skipped", {
        error: errorText(e),
      });
      return "";
    }
  }
  async recall(query: string, signal?: AbortSignal) {
    if (!this.cfg.memory.enabled) return [];
    if (!(await this.items()).length) return [];
    const feelingPending = this.feelingQuery(query, signal);
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
            await auxiliaryPrompt(this.root, this.cfg, "query"),
            { text: cut(query, this.cfg.memory.queryInputTokens) },
            signal ? AbortSignal.any([signal, deadline]) : deadline,
            "query",
          );
          if (Array.isArray(r.queries))
            q +=
              "\n" +
              r.queries
                .filter((x: unknown) => typeof x === "string" && x.trim())
                .slice(0, this.cfg.memory.queryDirections)
                .join("\n");
          this.queryCache.set(query, { at: Date.now(), text: q });
          if (this.queryCache.size > 50)
            this.queryCache.delete(this.queryCache.keys().next().value!);
        }
      } catch (e) {
        this.db.log("warn", "memory", "query fallback", {
          error: errorText(e),
        });
      }
    const feelingQuery = await feelingPending;
    this.observation?.query?.({
      original: query,
      expanded: q,
      feeling: feelingQuery,
    });
    if (!q.trim()) return [];
    const found = await this.search(
      q,
      false,
      this.cfg.memory.maxItems,
      signal,
      feelingQuery,
    );
    const all = await this.items();
    const reasons = Object.fromEntries(found.map((m) => [m.id, "relevant"]));
    this.observation?.phase?.({
      key: "retrieval",
      items: structuredClone(found),
    });
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
      for (const m of neighbors) reasons[m.id] = "temporal";
    }
    this.observation?.phase?.({
      key: "temporal",
      items: structuredClone(found),
      reasons: { ...reasons },
    });
    const round = this.db.get(`recallRound:${this.agentId}`, 0) + 1;
    if (!this.preview) this.db.set(`recallRound:${this.agentId}`, round);
    const assoc = this.db.get<Record<string, number>>(
      `associations:${this.agentId}`,
      {},
    );
    const associationDraw = Math.random();
    if (
      associationDraw < this.cfg.memory.associationProbability &&
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
        reasons[m.id] = "association";
        if (!this.preview) this.db.set(`associations:${this.agentId}`, assoc);
      }
    }
    this.observation?.phase?.({
      key: "association",
      items: structuredClone(found),
      reasons: { ...reasons },
      draw: associationDraw,
      round,
    });
    let budget = this.cfg.context.memoryTokens;
    const decisions: unknown[] = [];
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
      decisions.push({
        id: m.id,
        position: i,
        cost,
        remaining_before: budget,
        included: cost <= budget,
        summary: x.summary,
        details: x.details,
      });
      if (cost <= budget) {
        out.push(x);
        budget -= cost;
      }
    }
    this.observation?.phase?.({
      key: "budget",
      items: structuredClone(out),
      decisions,
      remaining: budget,
    });
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
    this.observation?.recall?.({
      expanded_ids: found.map((m) => ({ id: m.id, reason: reasons[m.id] })),
      packed: out,
    });
    return out;
  }
  async changeMemory(
    action: "create" | "update" | "delete",
    expectedVersion: string,
    entry?: unknown,
    entryId?: string,
    rebuild = false,
  ) {
    const job = this.contentChain.then(async () => {
      const file = path.join(this.root, "memory.json");
      const raw = await readJson<any>(file, { memory: [] });
      z.object({ memory: z.array(Item) })
        .passthrough()
        .parse(raw);
      const version = createHash("sha256")
        .update(JSON.stringify(raw))
        .digest("hex");
      if (version !== expectedVersion)
        throw Object.assign(Error("记忆已被其他操作修改，请刷新后再编辑。"), {
          statusCode: 409,
        });
      let changedId = entryId;
      if (action === "delete") {
        if (!raw.memory.some((m: any) => m.id === entryId))
          throw Error("Unknown memory");
        raw.memory = raw.memory.filter((m: any) => m.id !== entryId);
      } else {
        const parsed = Item.extend({
          summary: z.string().trim().min(1),
          occurred_at: z
            .string()
            .refine((s) => Number.isFinite(Date.parse(s)), "日期无效"),
        }).parse(entry);
        if (action === "create") {
          changedId = id();
          raw.memory.push({ ...parsed, id: changedId });
        } else {
          const i = raw.memory.findIndex((m: any) => m.id === entryId);
          if (i < 0) throw Error("Unknown memory");
          if (parsed.id && parsed.id !== entryId) throw Error("不能修改记忆ID");
          raw.memory[i] = { ...parsed, id: entryId };
        }
      }
      await jsonWrite(file, raw);
      await this.sync(false);
      if (action === "delete") {
        await this.updateState((s) => {
          delete s.activation[entryId!];
        });
        const associations = this.db.get<Record<string, unknown>>(
          `associations:${this.agentId}`,
          {},
        );
        delete associations[entryId!];
        this.db.set(`associations:${this.agentId}`, associations);
      }
      if (rebuild && action !== "delete") {
        if (this.enriching || this.indexingTask) this.pendingEnrichment = true;
        else this.startIndexing({ ids: [changedId!], side: "both" });
      }
      return {
        id: changedId,
        saved: true,
        indexing: rebuild && action !== "delete",
        version: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      };
    });
    this.contentChain = job.catch(() => {});
    return job;
  }
  indexingBusy() {
    return !!this.indexingTask || this.enriching;
  }
  requestIndexing(options: IndexOptions) {
    if (this.enriching || this.indexingTask)
      throw Object.assign(Error("索引维护正在运行，请完成后再重建。"), {
        statusCode: 409,
      });
    this.startIndexing(options);
  }
  private async inspectionSnapshot() {
    const raw = await readJson<any>(path.join(this.root, "memory.json"), {
      memory: [],
    });
    const parsed = z
      .object({ memory: z.array(Item) })
      .passthrough()
      .parse(raw);
    const items = parsed.memory.map((m) => {
      if (!m.id)
        throw Error(
          "记忆缺少id，请先让正常索引同步补齐，再检查；预览不会改文件。",
        );
      return m as Memory;
    });
    if (new Set(items.map((m) => m.id)).size !== items.length)
      throw Error("duplicate memory id");
    const storedIndex = structuredClone(await this.index());
    const index = structuredClone(storedIndex);
    const now = Date.now(),
      signature =
        this.cfg.models.embedding.baseUrl +
        "|" +
        this.cfg.models.embedding.name;
    synchronizeMemoryIndex(items, index, signature, now);
    const storedState = await readJson<State | null>(
      path.join(this.root, "state.json"),
      null,
    );
    const state = await this.state(storedState ?? undefined, now);
    return {
      items,
      rawItems: raw.memory,
      version: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      index,
      storedIndex,
      storedState,
      state,
      now,
    };
  }
  async inspectMemories(entryId?: string) {
    const snap = await this.inspectionSnapshot();
    if (entryId && !snap.items.some((m) => m.id === entryId))
      throw Error("Unknown memory for this agent");
    const databaseIndex = this.db.get<Record<string, any> | null>(
      `index:${this.agentId}`,
      null,
    );
    return {
      agent_id: this.agentId,
      version: snap.version,
      as_of: new Date(snap.now).toISOString(),
      paths: {
        memory: path.join(this.root, "memory.json"),
        index: path.join(this.root, ".runtime/search-index.json"),
        state: path.join(this.root, "state.json"),
        database:
          (this.db.db.prepare("PRAGMA database_list").all() as any[]).find(
            (x) => x.name === "main",
          )?.file ?? "runtime.sqlite",
        database_key: `index:${this.agentId}`,
      },
      index_source: databaseIndex === null ? "file_fallback" : "database",
      policy: {
        memory: this.cfg.memory,
        memoryTokens: this.cfg.context.memoryTokens,
        emotionLabels: this.cfg.state.emotionLabels,
      },
      current_emotions: snap.state.emotions,
      rows: snap.items
        .filter((m) => !entryId || m.id === entryId)
        .map((m) => {
          const stored = snap.storedIndex[m.id];
          const { vectors, feelingVectors, ...fields } = stored ?? {};
          return {
            id: m.id,
            memory: snap.rawItems.find((x: any) => x.id === m.id),
            stored_index: stored
              ? {
                  ...fields,
                  ...(entryId ? { vectors, feelingVectors } : {}),
                  feeling_vector_count: feelingVectors?.length ?? 0,
                  feeling_vector_dimensions: [
                    ...new Set(
                      (feelingVectors ?? []).map((v: number[]) => v.length),
                    ),
                  ],
                  vector_count: vectors?.length ?? 0,
                  vector_dimensions: [
                    ...new Set((vectors ?? []).map((v: number[]) => v.length)),
                  ],
                }
              : null,
            index_current:
              !!stored &&
              stored.version === 2 &&
              stored.hash === snap.index[m.id].hash &&
              stored.embeddingModel === snap.index[m.id].embeddingModel,
            factors: memoryFactors(
              m,
              snap.index[m.id],
              snap.state,
              this.cfg.memory,
              snap.now,
            ),
            configured_emotion_matches: this.cfg.state.emotionLabels.filter(
              (name) => JSON.stringify(m.emotion ?? "").includes(name),
            ),
            activation_at: snap.state.activation[m.id]
              ? new Date(snap.state.activation[m.id]).toISOString()
              : null,
          };
        }),
    };
  }
  async inspectionSession() {
    const snap = await this.inspectionSnapshot();
    const calls: Array<{
      purpose: string;
      system?: string;
      input: unknown;
      output?: unknown;
      error?: string;
    }> = [];
    const llm: Intelligence = {
      json: async (prompt, input, signal, purpose) => {
        const call = {
          purpose:
            purpose === "query" && (input as any)?.route === "feeling"
              ? "feelingQuery"
              : (purpose ?? "query"),
          system: prompt,
          input,
        } as (typeof calls)[number];
        calls.push(call);
        try {
          return (call.output = await this.llm.json(
            prompt,
            input,
            signal,
            purpose,
          ));
        } catch (e) {
          call.error = errorText(e);
          throw e;
        }
      },
      embed: async (texts, signal) => {
        const call = {
          purpose: "embedding",
          input: texts,
        } as (typeof calls)[number];
        calls.push(call);
        try {
          const output = await this.llm.embed(texts, signal);
          call.output = {
            count: output.length,
            dimensions: output.map((v) => v.length),
          };
          return output;
        } catch (e) {
          call.error = errorText(e);
          throw e;
        }
      },
      summarize: (...args) => this.llm.summarize(...args),
    };
    const preview = new MemoryService(
      this.root,
      this.agentId,
      this.db,
      this.cfg,
      llm,
    );
    preview.preview = {
      items: snap.items,
      index: snap.index,
      state: snap.state,
      now: snap.now,
    };
    const trace: any = {
      query: { original: "", expanded: "" },
      phases: [],
      search: null,
      recall: null,
    };
    preview.observation = {
      query: (x) => (trace.query = x),
      search: (x) => (trace.search = x),
      recall: (x) => (trace.recall = x),
      phase: (x) => trace.phases.push(x),
    };
    return { snapshot: snap, memory: preview, llm, calls, trace };
  }
  async simulateRecall(query: string, mode: "recall" | "search" = "recall") {
    const {
      snapshot: snap,
      memory: preview,
      calls,
      trace,
    } = await this.inspectionSession();
    trace.query = { original: query, expanded: query };
    const output =
      mode === "recall"
        ? await preview.recall(query)
        : await preview.search(query, true, this.cfg.memory.maxItems);
    return {
      agent_id: this.agentId,
      mode,
      as_of: new Date(snap.now).toISOString(),
      policy: {
        memory: this.cfg.memory,
        memoryTokens: this.cfg.context.memoryTokens,
      },
      calls,
      ...trace,
      output,
      note: "使用当前运行配置和隔离快照。可能调用付费辅助模型；不会写记忆、索引、激活、强化、召回计数或真实查询缓存，不会触发聊天。自动模式的联想抽签独立于正式对话。",
    };
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
      await auxiliaryPrompt(this.root, this.cfg, "emotion"),
      {
        persona: cut(persona, 1000),
        policy: {
          scale:
            "0–100; return point deltas, not proportions; application applies multipliers once",
          emotionLabels: this.cfg.state.emotionLabels,
          drives: Object.fromEntries(
            Object.entries(this.cfg.drives).filter(([, d]) => d.enabled),
          ),
          sensitivity: this.cfg.state.eventSensitivity,
          moodDeltaLimit: this.cfg.state.moodDeltaLimit,
          dimensionDeltaLimit: this.cfg.state.dimensionDeltaLimit,
          surpriseMax: this.cfg.state.surpriseMax,
          repeatedStimulusMultiplier: this.cfg.state.repeatedStimulusMultiplier,
        },
        state: {
          mood: state.mood,
          emotions: state.emotions,
          drives: state.drives,
          cause: state.cause,
          assessed_at: state.assessed_at,
          thoughts: state.thoughts,
          focus: state.focus,
        },
        input: (() => {
          const { recent_dialogue, ...current } = (input ?? {}) as Record<
            string,
            unknown
          >;
          const recent = cut(
            String(recent_dialogue ?? ""),
            Math.min(2000, Math.floor(this.cfg.state.inputTokens / 3)),
          );
          return {
            recent_dialogue: recent,
            current: cut(
              JSON.stringify(current),
              Math.max(0, this.cfg.state.inputTokens - tokens(recent)),
            ),
          };
        })(),
        memories: candidates.map((x) => ({ id: x.id, summary: x.summary })),
      },
      AbortSignal.any([
        this.lifecycle.signal,
        AbortSignal.timeout(this.cfg.state.timeoutMs),
      ]),
      "emotion",
    );
    const applied: Record<string, number> = {};
    const ignored: string[] = [];
    await this.updateState((s) => {
      s.assessed_at = new Date().toISOString();
      const beforeMood = s.mood;
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
      applied.mood = s.mood - beforeMood;
      for (const field of ["emotions", "drives"] as const)
        for (const [k, v] of Object.entries(result[field] ?? {}).slice(0, 12)) {
          if (field === "drives" && !this.cfg.drives[k]?.enabled) {
            ignored.push(field + "." + k);
            continue;
          }
          if (
            field === "emotions" &&
            !this.cfg.state.emotionLabels.includes(k)
          ) {
            ignored.push(field + "." + k);
            continue;
          }
          const d = field === "drives" ? this.cfg.drives[k] : undefined;
          const before = s[field][k] ?? 0;
          s[field][k] = clamp(
            (s[field][k] ?? 0) +
              delta(
                Number(v) * (d?.sensitivity ?? this.cfg.state.eventSensitivity),
                this.cfg.state.dimensionDeltaLimit,
              ),
            d?.min ?? 0,
            d?.max ?? 100,
          );
          applied[field + "." + k] = s[field][k] - before;
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
    this.db.log("info", "mood", "Emotion update applied", {
      run_id: runId,
      applied,
      ignored,
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
