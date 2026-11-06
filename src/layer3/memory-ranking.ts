import { createHash } from "node:crypto";
import type { Config } from "../config/schema.js";

/** Shared by live retrieval and the read-only inspector. No persistence or model calls. */
export function memoryFactors(
  memory: {
    importance: number;
    occurred_at: string;
    emotion?: unknown;
    id: string;
  },
  row: { strength: number; strengthAt: string; familiarity: number },
  state: {
    activation: Record<string, number>;
    emotions: Record<string, number>;
  },
  cfg: Config["memory"],
  now: number,
  explicit = false,
) {
  const importance = (memory.importance - 1) / 4;
  const halfLifeDays =
    cfg.baseHalfLifeDays * (1 + cfg.importanceMultiplier * importance);
  const days = Math.max(0, (now - Date.parse(row.strengthAt)) / 86400000);
  const naturalStrength = Math.min(
    1,
    Math.max(0, row.strength * 2 ** (-days / halfLifeDays)),
  );
  const strength = explicit ? 1 : naturalStrength;
  const activation = state.activation[memory.id]
    ? 2 **
      (-(now - state.activation[memory.id]) /
        60000 /
        cfg.activationHalfLifeMinutes)
    : 0;
  const emotionText = JSON.stringify(memory.emotion ?? "");
  const matchedEmotions = Object.entries(state.emotions).filter(([name]) =>
    emotionText.includes(name),
  );
  const ageDays = Math.max(
    0,
    (now - Date.parse(memory.occurred_at)) / 86400000,
  );
  const rawEmotion =
    Math.max(0, ...matchedEmotions.map(([, value]) => value / 100)) *
    2 ** (-ageDays / cfg.emotionHalfLifeDays);
  const emotion = Number.isFinite(rawEmotion) ? rawEmotion : 0;
  const familiarity = 1 - Math.exp(-row.familiarity / 5);
  const contributions = {
    base: cfg.rankWeights.base,
    strength: cfg.rankWeights.strength * strength,
    importance: cfg.rankWeights.importance * importance,
    activation: cfg.rankWeights.activation * activation,
    familiarity: cfg.rankWeights.familiarity * familiarity,
    emotion: cfg.rankWeights.emotion * emotion,
  };
  return {
    strength,
    naturalStrength,
    importance,
    activation,
    familiarity,
    emotion,
    halfLifeDays,
    matchedEmotions: matchedEmotions.map(([name]) => name),
    contributions,
    multiplier: Object.values(contributions).reduce((sum, n) => sum + n, 0),
  };
}

/** Update derived rows consistently in live sync and a private preview copy. */
export function synchronizeMemoryIndex(
  items: Array<{
    id: string;
    summary: string;
    details: string;
    people: unknown[];
    emotion?: any;
    agent_name?: string;
  }>,
  index: Record<string, any>,
  signature: string,
  now: number,
) {
  const valid = new Set(items.map((m) => m.id));
  for (const key of Object.keys(index)) if (!valid.has(key)) delete index[key];
  for (const m of items) {
    const hash = createHash("sha256").update(JSON.stringify(m)).digest("hex"),
      old = index[m.id];
    const factText =
      m.summary +
      "\n" +
      m.details +
      "\n" +
      JSON.stringify(m.people) +
      "\n" +
      (m.agent_name ?? "");
    const feelingText = [
      Array.isArray(m.emotion?.labels)
        ? m.emotion.labels
            .filter((x: unknown) => typeof x === "string")
            .join("、")
        : "",
      typeof m.emotion?.feeling === "string" ? m.emotion.feeling : "",
    ]
      .filter(Boolean)
      .join("\n");
    const reusable = old?.version === 2 && old.embeddingModel === signature;
    if (
      !old ||
      old.hash !== hash ||
      old.embeddingModel !== signature ||
      old.version !== 2
    )
      index[m.id] = {
        hash,
        version: 2,
        text: factText,
        feelingText,
        feelingVectors:
          reusable && old.feelingText === feelingText
            ? (old.feelingVectors ?? [])
            : [],
        description: reusable && old.text === factText ? old.description : "",
        vectors: reusable && old.text === factText ? old.vectors : [],
        strength: old?.strength ?? 1,
        strengthAt: old?.strengthAt ?? new Date(now).toISOString(),
        familiarity: old?.familiarity ?? 0,
        embeddingModel: signature,
      };
  }
}

/** Quotas concern retrieval slots, before temporal expansion and prompt budgeting. */
export function balancedMemories<T extends { score: number }>(
  rows: T[],
  limit: number,
  feelingShare: number,
  fact: (row: T) => boolean,
  feeling: (row: T) => boolean,
  onPick?: (picked: T, remaining: T[]) => void,
): Array<{ value: T; route: "fact" | "feeling" }> {
  const pool = [...rows],
    selected: Array<{ value: T; route: "fact" | "feeling" }> = [];
  const quotas = {
    feeling: Math.round(limit * feelingShare),
    fact: limit - Math.round(limit * feelingShare),
  };
  const used = { fact: 0, feeling: 0 };
  while (pool.length && selected.length < limit) {
    pool.sort((a, b) => b.score - a.score);
    const preferred =
      used.fact < quotas.fact &&
      (used.feeling >= quotas.feeling ||
        used.fact / Math.max(1, quotas.fact) <=
          used.feeling / Math.max(1, quotas.feeling))
        ? "fact"
        : "feeling";
    let route: "fact" | "feeling" = preferred;
    let i = pool.findIndex(route === "fact" ? fact : feeling);
    if (i < 0) {
      route = route === "fact" ? "feeling" : "fact";
      i = pool.findIndex(route === "fact" ? fact : feeling);
    }
    if (i < 0) break;
    const [value] = pool.splice(i, 1);
    used[route]++;
    selected.push({ value, route });
    onPick?.(value, pool);
  }
  return selected;
}
