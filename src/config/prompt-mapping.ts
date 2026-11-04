import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const promptMappingDefaults = {
  mood: {
    bands: [
      { min: 0, text: "比较沉重" },
      { min: 25, text: "有些低落" },
      { min: 42, text: "平稳" },
      { min: 62, text: "轻松、舒展" },
      { min: 80, text: "明朗、心里有余裕" },
    ],
    template: "此刻的心情底色：{label}。",
  },
  emotions: {
    min: 1,
    maxItems: 2,
    bands: [
      { min: 0, text: "还留有一点余韵" },
      { min: 15, text: "隐约存在" },
      { min: 40, text: "比较明显" },
      { min: 70, text: "非常明显" },
    ],
    item: "{name}{label}",
    template: "其中，{items}。",
    separator: "，",
  },
  drives: {
    minDeviation: 5,
    maxItems: 2,
    stronger: "更强",
    weaker: "弱一些",
    names: {
      curiosity: "好奇",
      social: "交流意愿",
      responsibility: "责任感",
      introspection: "自省",
      missing: "惦记对方",
      closeness: "想亲近对方",
      fatigue: "疲劳",
      stress: "压力",
      joy: "愉悦倾向",
    },
    item: "{name}比平常{direction}",
    template: "此刻的倾向：{items}。",
    separator: "，",
  },
  gap: {
    unknown: "这里还没有此前回应的时间记录。",
    bands: [
      { min: 0, text: "刚刚还在交谈，可以自然接着聊。" },
      { min: 60, text: "距离上次回应{duration}，仍可接着当前话题。" },
      {
        min: 900,
        text: "距离上次回应{duration}，对话停了一会儿。可以自然重新开口，不必重复上一段收尾，也不假定对方的处境没变。",
      },
      {
        min: 7200,
        text: "距离上次回应{duration}，已有一段间隔。把旧话题当作此前经历，按现在的时间和新输入重新接话，不假定对方还在做之前的事。",
      },
    ],
  },
  cause: {
    enabled: true,
    unknown: "此前一轮",
    bands: [
      { min: 0, text: "最近一轮" },
      { min: 900, text: "早些时候" },
      { min: 7200, text: "此前" },
    ],
    dated: "{label}（{time}）",
    template:
      "{when}留下的感受缘由：{cause}。这是来历，不是当前待办，也不代表旧情境仍在继续。",
  },
  text: {
    now: "现在是 {time}。",
    spark: "突然浮起的一个小想法：{text}",
    thought: "此前浮现过的念头（可放下）：{text}",
    focus: "此前关注（不是本轮指令）：{items}。新话题或时间变化时可放下。",
    focusSeparator: "、",
  },
};
const text = z.string().min(1).max(4000);
const template = (keys: string[]) =>
  text.refine(
    (s) => [...s.matchAll(/\{([^{}]+)\}/g)].every((m) => keys.includes(m[1])),
    "Unknown template placeholder",
  );
const bands = (max: number, keys: string[] = []) =>
  z
    .array(
      z
        .object({
          min: z.number().finite().min(0).max(max),
          text: template(keys),
        })
        .strict(),
    )
    .min(1)
    .max(20)
    .refine(
      (a) =>
        a[0].min === 0 && a.every((v, i) => i === 0 || v.min > a[i - 1].min),
      "Bands must start at 0 and have strictly increasing min values",
    );
const schema = z
  .object({
    mood: z
      .object({ bands: bands(100), template: template(["label"]) })
      .strict(),
    emotions: z
      .object({
        min: z.number().min(0).max(100),
        maxItems: z.number().int().min(0).max(20),
        bands: bands(100),
        item: template(["name", "label"]),
        template: template(["items"]),
        separator: text,
      })
      .strict(),
    drives: z
      .object({
        minDeviation: z.number().min(0).max(100),
        maxItems: z.number().int().min(0).max(20),
        stronger: text,
        weaker: text,
        names: z.record(z.string(), text),
        item: template(["name", "direction"]),
        template: template(["items"]),
        separator: text,
      })
      .strict(),
    gap: z
      .object({ unknown: text, bands: bands(31536000, ["duration"]) })
      .strict(),
    cause: z
      .object({
        enabled: z.boolean(),
        unknown: text,
        bands: bands(31536000),
        dated: template(["label", "time"]),
        template: template(["when", "cause"]),
      })
      .strict(),
    text: z
      .object({
        now: template(["time"]),
        spark: template(["text"]),
        thought: template(["text"]),
        focus: template(["items"]),
        focusSeparator: text,
      })
      .strict(),
  })
  .strict();
export type PromptMapping = z.infer<typeof schema>;
// Objects inherit missing fields; arrays replace the whole table. Never mutate defaults.
function merge(base: any, value: any): any {
  if (value === undefined) return structuredClone(base);
  if (
    base &&
    value &&
    typeof base === "object" &&
    typeof value === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(value)])].map((k) => [
        k,
        merge(base[k], value[k]),
      ]),
    );
  }
  return value;
}
export function parsePromptMapping(content: string): PromptMapping {
  const raw = YAML.parse(content);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Prompt mapping must be a YAML object (use {} for defaults)");
  return schema.parse(merge(promptMappingDefaults, raw));
}
export async function loadPromptMapping(root: string): Promise<PromptMapping> {
  try {
    return parsePromptMapping(
      await fs.readFile(path.join(root, "prompts/prompt-mapping.yaml"), "utf8"),
    );
  } catch (e: any) {
    if (e.code === "ENOENT") return structuredClone(promptMappingDefaults);
    throw Error("Invalid prompts/prompt-mapping.yaml: " + e.message);
  }
}
export function bandLabel(
  value: number,
  table: { min: number; text: string }[],
): string {
  return (
    [...table].reverse().find((b) => value >= b.min)?.text ?? table[0].text
  );
}
export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{([^{}]+)\}/g,
    (match, key) => values[key] ?? match,
  );
}
