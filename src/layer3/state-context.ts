import type { State } from "./memory.js";
import type { Config } from "../config/schema.js";
import { cut } from "../shared/tokens.js";

/** Model-facing view only; state.json keeps the full operational state. */
export function stateContext(state: State, cfg: Config): string {
  const gap = state.conversation_context as
    { seconds_since_last_response?: number | null } | undefined;
  const lines: string[] = [];
  if (cfg.state.gap)
    lines.push(
      typeof gap?.seconds_since_last_response === "number"
        ? `距同一聊天位置上次回应约 ${Math.round(gap.seconds_since_last_response)} 秒。`
        : "此聊天位置暂无上次回应记录。",
    );
  if (cfg.state.enabled) {
    const values = (record: Record<string, number>) =>
      Object.entries(record)
        .filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => `${k}=${Math.round(v * 10) / 10}`)
        .join("、");
    lines.push(
      `心情 ${Math.round(state.mood)} / 100；这只是表达背景，不是本轮必须讨论的话题。`,
    );
    if (state.cause) lines.push("上轮状态的缘由：" + state.cause);
    if (Object.keys(state.emotions).length)
      lines.push("情绪强度（0–100）：" + values(state.emotions));
    lines.push("驱动力（0–100）：" + values(state.drives));
    for (const thought of state.thoughts.slice(
      0,
      cfg.state.thoughtContextItems,
    ))
      lines.push(
        "此前浮现的念头：" + cut(thought.text, cfg.state.thoughtContextTokens),
      );
    if (state.focus.length)
      lines.push(
        "此前关注：" + state.focus.join("、") + "。话题变化时可自然放下。",
      );
  }
  return cut(lines.join("\n"), cfg.context.stateTokens);
}
