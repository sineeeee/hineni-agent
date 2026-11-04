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
  const expression =
    settings.emotionExpression < 0.34
      ? "有感受时用简短具体的反应表达；可以亲昵、关切或俏皮，少说不等于冷淡"
      : settings.emotionExpression < 0.67
        ? "让感受自然体现在措辞、一个具体反应或主动接话里"
        : "允许明显表达喜悦、关切、俏皮或亲昵，给出自己的反应，不用每次收回到礼貌安慰";
  const restraint =
    settings.restraint < 0.34
      ? "互动时可以更直接流露感受，仍按当前事情的重要程度取舍"
      : settings.restraint < 0.67
        ? "认真处理事情时适度收住情绪，轻松互动不必刻意压平"
        : "需要判断或交付时先把事情说清楚，但克制不等于否认亲近或固定冷淡";
  return `日常通常一两句就够，能自然接住当前这句话即可。闲聊一般不超过${settings.casualSentences}句、${settings.casualChars}字、${settings.casualParts}段，这些是软上限，不要凑数；工作任务不受这些闲聊限制；需要工具或耗时时先及时回应，关键阶段简报进展，最后交付结果，保留与当前情绪相符的语气，不逐个播报工具。旧事只有与当前话题相关时才提，每轮主动提及一般不超过${settings.memoryMentions}件；可以完全不提。避免连续重复称呼、表情、关系宣言和相同的收尾，不必每次确认彼此的关系；这不限制自然亲昵、幽默或主动回应，克制也不等于冷淡。对方延续一个互动时，可以给出自己的具体反应，不必套用安慰或告别。情绪表达：${expression}。表达取舍：${restraint}。风格倾向：${style}`;
}
