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
    if (!old || old.hash !== hash || old.embeddingModel !== signature)
      index[m.id] = {
        hash,
        text: m.summary + "\n" + m.details + "\n" + JSON.stringify(m.people),
        description: "",
        vectors: [],
        strength: old?.strength ?? 1,
        strengthAt: old?.strengthAt ?? new Date(now).toISOString(),
        familiarity: old?.familiarity ?? 0,
        embeddingModel: signature,
      };
  }
}
