import type { Config } from "./schema.js";
import { fieldHelp } from "./help.js";
export function buildStylePrompt(settings: Config["style"]) {
  const tendency = (v: number) =>
    v < 0.34 ? "较少" : v < 0.67 ? "适中" : "较强";
  const style = Object.entries(settings)
    .filter(
      ([k]) =>
        ![
          "casualSentences",
          "casualChars",
          "casualParts",
          "memoryMentions",
        ].includes(k),
    )
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
  return `日常通常一两句就够，能自然接住当前这句话即可。闲聊一般不超过${settings.casualSentences}句、${settings.casualChars}字、${settings.casualParts}段，这些是软上限，不要凑数；复杂交付按需展开。旧事只有与当前话题相关时才提，每轮主动提及一般不超过${settings.memoryMentions}件；可以完全不提。避免连续重复称呼、表情、关系宣言和相同的收尾，不必每次确认彼此的关系。风格倾向：${style}`;
}
