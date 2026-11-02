import OpenAI from "openai";
import type { Config } from "../config/schema.js";
export interface Intelligence {
  json(
    system: string,
    input: unknown,
    signal?: AbortSignal,
    purpose?: "query" | "maintenance" | "emotion" | "rerank",
  ): Promise<any>;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  summarize(
    text: string,
    budget: number,
    signal?: AbortSignal,
  ): Promise<string>;
}
export class OpenAIModels implements Intelligence {
  constructor(
    private cfg: Config,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}
  model(which: string) {
    return {
      ...this.cfg.models[
        which === "main" ? "main" : which === "embedding" ? "embedding" : "fast"
      ],
      ...(this.cfg.models as any)[which],
    };
  }
  client(which: string) {
    const m = this.model(which),
      key = this.env[m.apiKeyEnv];
    if (!key) throw Error(`Missing environment variable ${m.apiKeyEnv}`);
    return new OpenAI({
      baseURL: m.baseUrl,
      apiKey: key,
      maxRetries:
        which === "maintenance" ? this.cfg.memory.maintenanceAttempts - 1 : 1,
      timeout:
        which === "maintenance"
          ? this.cfg.memory.maintenanceTimeoutMs
          : this.cfg.state.timeoutMs,
    });
  }
  async json(
    system: string,
    input: unknown,
    signal?: AbortSignal,
    purpose: "query" | "maintenance" | "emotion" | "rerank" = "query",
  ) {
    const model = this.model(purpose);
    const r = await this.client(purpose).chat.completions.create(
      {
        model: model.name,
        messages: [
          { role: "system", content: system + " Return one JSON object." },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: model.maxOutput,
      },
      { signal },
    );
    const t = r.choices[0]?.message.content;
    if (!t) throw Error("Empty fast-model response");
    return JSON.parse(t);
  }
  async embed(texts: string[], signal?: AbortSignal) {
    const r = await this.client("embedding").embeddings.create(
      {
        model: this.cfg.models.embedding.name,
        input: texts,
        encoding_format: "float",
      },
      { signal },
    );
    return r.data.sort((a, b) => a.index - b.index).map((x) => x.embedding);
  }
  async summarize(text: string, budget: number, signal?: AbortSignal) {
    const r = await this.client("main").chat.completions.create(
      {
        model: this.cfg.models.main.name,
        messages: [
          {
            role: "system",
            content:
              "压缩较早聊天经历以便继续交流。保留重要事件、用户修正、未完成事项、工具已取得结果及不确定性。合并旧摘要，不虚构完成情况。只输出摘要。",
          },
          { role: "user", content: text },
        ],
        max_completion_tokens: budget,
      },
      { signal, timeout: 300000 },
    );
    const t = r.choices[0]?.message.content;
    if (!t || r.choices[0].finish_reason === "length")
      throw Error("Compaction incomplete");
    return t;
  }
}
