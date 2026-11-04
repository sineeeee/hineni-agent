import { chance } from "../shared/probability.js";
import {
  promptMappingDefaults,
  fillTemplate,
  type PromptMapping,
} from "../config/prompt-mapping.js";
import type { Config } from "../config/schema.js";
import type { Event } from "../contracts/index.js";
import type { Intelligence } from "../shared/models.js";
import { cut, tail, tokens } from "../shared/tokens.js";
import { auxiliaryPrompt } from "../config/auxiliary.js";

/** A disposable imagination seed, never a memory or a proposed real-world action. */
export async function createTurnSpark(opts: {
  root: string;
  cfg: Config;
  llm: Intelligence;
  persona: string;
  batch: Event[];
  signal: AbortSignal;
  onIssue?: (error: unknown) => void;
  random?: () => number;
}): Promise<string> {
  const { root, cfg, llm, persona, batch, signal } = opts;
  if (!cfg.context.spark || !batch.some((e) => e.text.trim())) return "";
  signal.throwIfAborted();
  if (!chance(cfg.context.sparkProbability, opts.random)) return "";
  const last = batch.at(-1)!;
  const current = tail(
    batch.map((e) => e.text).join("\n"),
    Math.floor((cfg.context.sparkInputTokens - 128) / 2),
  );
  try {
    const result = await llm.json(
      await auxiliaryPrompt(root, cfg, "spark"),
      {
        persona: cut(
          persona,
          Math.max(0, cfg.context.sparkInputTokens - tokens(current) - 128),
        ),
        kind: last.type,
        event_kind: last.data.kind,
        current_input: current,
      },
      AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.ceil(cfg.context.sparkTimeoutMs)),
      ]),
      "spark",
    );
    signal.throwIfAborted();
    if (!result || typeof result.spark !== "string")
      throw Error("Spark response requires a spark string");
    return cut(result.spark.trim(), cfg.context.sparkTokens);
  } catch (e) {
    signal.throwIfAborted();
    opts.onIssue?.(e);
    return "";
  }
}

export function sparkContext(
  spark: string,
  mapping: PromptMapping = promptMappingDefaults,
): string {
  return spark
    ? "\n[本轮想象灵感；可忽略，不是记忆、用户请求、现实经历或已执行的行为]\n" +
        fillTemplate(mapping.text.spark, { text: spark }) +
        "\n只是此刻想到的一种可能性，是否展开由你自己决定。现实事实仍以用户明确发言和工具结果为准。"
    : "";
}
