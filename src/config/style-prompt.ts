import type { Config } from "./schema.js";
import { fieldHelp } from "./help.js";
export function buildStylePrompt(settings: Config["style"]) {
  const tendency = (v: number) =>
    v < 0.34 ? "较少" : v < 0.67 ? "适中" : "较强";
  const style = Object.entries(settings)
    .map(
      ([k, v]) =>
        (fieldHelp.style[k] ?? k) +
        ": " +
        ([
          "warmth",
          "humor",
          "directness",
          "restraint",
          "emotionExpression",
        ].includes(k) && typeof v === "number"
          ? tendency(v)
          : v),
    )
    .join("；");
  return `日常优先${settings.casualSentences}句、约${settings.casualChars}字；复杂交付按需展开。风格倾向：${style}`;
}
