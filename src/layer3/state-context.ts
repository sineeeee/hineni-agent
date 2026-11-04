import { chance } from "../shared/probability.js";
import {
  promptMappingDefaults,
  bandLabel,
  fillTemplate,
  type PromptMapping,
} from "../config/prompt-mapping.js";
import type { State } from "./memory.js";
import type { Config } from "../config/schema.js";
import { cut } from "../shared/tokens.js";

import { localMoment } from "../shared/time-context.js";

export function gapContext(
  seconds: number | null | undefined,
  mapping: PromptMapping = promptMappingDefaults,
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
    return mapping.gap.unknown;

  const duration =
    seconds < 60
      ? "不足 1 分钟"
      : seconds < 3600
        ? `约 ${Math.floor(seconds / 60)} 分钟`
        : seconds < 86400
          ? `约 ${Math.floor(seconds / 3600)} 小时`
          : `约 ${Math.floor(seconds / 86400)} 天`;
  return fillTemplate(bandLabel(seconds, mapping.gap.bands), { duration });
}
export type StateSelection = { thoughts: boolean; focus: boolean };
export function selectStateContext(
  state: State,
  cfg: Config,
  random: () => number = Math.random,
  observe?: (
    key: "thoughts" | "focus",
    result: {
      eligible: boolean;
      probability: number;
      draw: number | null;
      selected: boolean;
    },
  ) => void,
): StateSelection {
  const choose = (
    key: "thoughts" | "focus",
    eligible: boolean,
    probability: number,
  ) => {
    let draw: number | null = null;
    const selected =
      eligible &&
      chance(probability, () => {
        draw = random();
        return draw;
      });
    observe?.(key, { eligible, probability, draw, selected });
    return selected;
  };
  return {
    thoughts: choose(
      "thoughts",
      cfg.state.enabled &&
        cfg.state.thoughtContextItems > 0 &&
        state.thoughts.length > 0,
      cfg.state.thoughtContextProbability,
    ),
    focus: choose(
      "focus",
      cfg.state.enabled && cfg.state.focusMax > 0 && state.focus.length > 0,
      cfg.state.focusContextProbability,
    ),
  };
}
/** Only a short interpretation reaches the main model; full numbers stay in state.json. */
export function stateContextSteps(
  state: State,
  cfg: Config,
  now = Date.now(),
  mapping: PromptMapping = promptMappingDefaults,
  selection: StateSelection = { thoughts: true, focus: true },
) {
  const gap = state.conversation_context as
    { seconds_since_last_response?: number | null } | undefined;
  const sections: Array<{ key: string; prompt: string }> = [];
  const add = (key: string, prompt: string) => sections.push({ key, prompt });
  add(
    "time",
    fillTemplate(mapping.text.now, {
      time: localMoment(now, cfg.scheduler.timezone),
    }),
  );
  if (cfg.state.gap)
    add("gap", gapContext(gap?.seconds_since_last_response, mapping));
  if (cfg.state.enabled) {
    const mood = Math.round(state.mood);
    add(
      "mood",
      fillTemplate(mapping.mood.template, {
        label: bandLabel(mood, mapping.mood.bands),
      }),
    );
    const emotions = Object.entries(state.emotions)
      .filter(
        ([key, value]) =>
          cfg.state.emotionLabels.includes(key) &&
          Number.isFinite(value) &&
          value >= mapping.emotions.min,
      )
      .sort((a, b) => b[1] - a[1])
      .slice(0, mapping.emotions.maxItems)
      .map(([key, value]) =>
        fillTemplate(mapping.emotions.item, {
          name: key,
          label: bandLabel(value, mapping.emotions.bands),
        }),
      );
    if (emotions.length)
      add(
        "emotions",
        fillTemplate(mapping.emotions.template, {
          items: emotions.join(mapping.emotions.separator),
        }),
      );
    const drives = Object.entries(state.drives)
      .filter(
        ([key, value]) =>
          cfg.drives[key]?.enabled &&
          Number.isFinite(value) &&
          Math.abs(value - cfg.drives[key].baseline) >=
            mapping.drives.minDeviation,
      )
      .sort(
        (a, b) =>
          Math.abs(b[1] - cfg.drives[b[0]].baseline) -
          Math.abs(a[1] - cfg.drives[a[0]].baseline),
      )
      .slice(0, mapping.drives.maxItems)
      .map(([key, value]) =>
        fillTemplate(mapping.drives.item, {
          name: mapping.drives.names[key] ?? key,
          direction:
            value > cfg.drives[key].baseline
              ? mapping.drives.stronger
              : mapping.drives.weaker,
        }),
      );
    if (drives.length)
      add(
        "drives",
        fillTemplate(mapping.drives.template, {
          items: drives.join(mapping.drives.separator),
        }),
      );
    if (state.cause && mapping.cause.enabled) {
      const age = state.assessed_at
        ? Math.max(0, now - Date.parse(state.assessed_at))
        : NaN;
      const when = Number.isFinite(age)
        ? fillTemplate(mapping.cause.dated, {
            label: bandLabel(age / 1000, mapping.cause.bands),
            time: localMoment(
              Date.parse(state.assessed_at!),
              cfg.scheduler.timezone,
            ),
          })
        : mapping.cause.unknown;
      add(
        "cause",
        fillTemplate(mapping.cause.template, {
          when,
          cause: state.cause.replace(/[。！？.!?]+$/, ""),
        }),
      );
    }
    for (const thought of (selection.thoughts ? state.thoughts : []).slice(
      0,
      cfg.state.thoughtContextItems,
    ))
      add(
        "thoughts",
        fillTemplate(mapping.text.thought, {
          text: cut(thought.text, cfg.state.thoughtContextTokens),
        }),
      );
    if (selection.focus && cfg.state.focusMax > 0 && state.focus.length)
      add(
        "focus",
        fillTemplate(mapping.text.focus, {
          items: state.focus
            .slice(0, cfg.state.focusMax)
            .join(mapping.text.focusSeparator),
        }),
      );
  }
  const raw = sections.map((x) => x.prompt).join("\n");
  return { sections, raw, prompt: cut(raw, cfg.context.stateTokens) };
}

export function stateContext(
  state: State,
  cfg: Config,
  now = Date.now(),
  mapping: PromptMapping = promptMappingDefaults,
  selection: StateSelection = { thoughts: true, focus: true },
): string {
  return stateContextSteps(state, cfg, now, mapping, selection).prompt;
}
