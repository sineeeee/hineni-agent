import {
  assembleSystem,
  assembleBackground,
  recallMaterial,
} from "./prompt-assembly.js";
import { loadPromptMapping } from "../config/prompt-mapping.js";
import { auxiliaryPrompt } from "../config/auxiliary.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { Config, AgentConfig } from "../config/schema.js";
import type { Intelligence } from "../shared/models.js";
import type { Event, ContextBundle, ModelMessage } from "../contracts/index.js";
import { Store } from "../layer2/store.js";
import { History } from "../layer2/history.js";
import { MemoryService } from "./memory.js";
import { cut, tokens } from "../shared/tokens.js";
import { selectStateContext } from "./state-context.js";
import { createTurnSpark } from "./spark.js";
import { atomicWrite, errorText } from "../shared/files.js";
export async function skillsList(dirs: string[]) {
  const found: Array<{ name: string; file: string; description: string }> = [];
  async function walk(dir: string, depth = 0) {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name === "SKILL.md") {
        const text = await fs.readFile(p, "utf8");
        found.push({
          name: text.match(/^name:\s*(.+)$/m)?.[1] ?? path.basename(dir),
          file: p,
          description:
            text.match(/^description:\s*(.+)$/m)?.[1] ?? text.slice(0, 150),
        });
      }
    }
  }
  for (const d of dirs) await walk(d);
  return found;
}
export class ContextBuilder {
  constructor(
    private db: Store,
    private cfg: Config,
    private agent: AgentConfig,
    private root: string,
    private promptsRoot: string,
    private history: History,
    private memory: MemoryService,
    private llm: Intelligence,
    private projectRoot?: string,
  ) {}
  async build(
    batch: Event[],
    runId: string,
    signal: AbortSignal,
  ): Promise<ContextBundle> {
    const triggerIds = batch.map((e) => e.event_id);
    batch = this.history.unansweredBatch(this.agent.id, batch);
    const inputIds = new Set(batch.map((e) => e.event_id));
    const latest = batch.at(-1)!;
    const target = latest.reply_target ?? this.agent.defaultTarget;
    const inputText = batch.map((e) => this.history.modelText(e)).join("\n");
    let history = await this.history.view(
      this.agent.id,
      signal,
      undefined,
      inputIds,
    );
    // Keep the current trigger dominant; assistant output chunks are not query turns.
    const previous = this.db
      .recent(
        this.agent.id,
        ["incoming_message"],
        this.cfg.memory.queryRecentMessages,
      )
      .filter((e) => !batch.some((b) => b.event_id === e.event_id));
    const persona = await fs.readFile(
      path.join(this.root, "persona.md"),
      "utf8",
    );
    const [memories, spark] = await Promise.all([
      this.memory.recall(
        recallMaterial(
          inputText,
          previous.map((e) => e.text),
          this.cfg.memory.queryInputTokens,
        ),
        signal,
      ),
      createTurnSpark({
        root: this.root,
        cfg: this.cfg,
        llm: this.llm,
        persona,
        batch,
        signal,
        onIssue: (e) =>
          this.db.log("warn", "context", "spark skipped", {
            run_id: runId,
            error: errorText(e),
          }),
      }),
    ]);
    signal.throwIfAborted();
    const state = await this.memory.updateState((s) => {
      if (this.cfg.state.gap)
        s.conversation_context = this.db.gap(this.agent.id, target);
      else delete s.conversation_context;
    });
    const mapping = await loadPromptMapping(this.root);
    const stateSelection = selectStateContext(state, this.cfg);
    const base =
      this.cfg.prompts.system ??
      (await fs.readFile(path.join(this.promptsRoot, "system.md"), "utf8"));
    const skills = this.cfg.runtime.skillsEnabled
      ? await skillsList([path.join(this.root, "skills"), ...this.agent.skills])
      : [];
    const system = assembleSystem({
      cfg: this.cfg,
      agent: this.agent,
      root: this.root,
      projectRoot: this.projectRoot,
      base,
      persona,
      skills,
    }).system;
    const dynamic = assembleBackground({
      cfg: this.cfg,
      target,
      memories,
      state,
      mapping,
      selection: stateSelection,
      stateExpression: this.cfg.state.enabled
        ? await auxiliaryPrompt(this.root, this.cfg, "stateExpression")
        : "",
      spark,
      system,
      now: Date.now(),
    }).dynamic;
    const model = { ...this.cfg.models.main, ...this.agent.main };
    const max =
      model.contextWindow - model.maxOutput - this.cfg.context.safetyTokens;
    let total = tokens(system + history + dynamic + inputText);
    if (total > max) {
      history = await this.history.view(
        this.agent.id,
        signal,
        Math.max(500, max - tokens(system + dynamic + inputText) - 4096),
        inputIds,
      );
      total = tokens(system + history + dynamic + inputText);
      if (total > max)
        throw Error("Context exceeds model capacity after history compaction");
    }
    // Stable history comes first; this run's background sits just before new triggers.
    const composeMessages = () =>
      this.history.messages(this.agent.id, batch, {
        role: "system",
        content: dynamic,
      });
    const messages: ModelMessage[] = composeMessages();
    const images = [];
    const imageRefs = new Set<string>();
    for (const e of batch)
      for (const ref of e.attachments) {
        if (imageRefs.has(ref)) continue;
        imageRefs.add(ref);
        const a = this.db.getAttachment(this.agent.id, ref);
        if (
          a?.status === "ready" &&
          /^image\/(png|jpeg|webp|gif)$/.test(a.mime)
        ) {
          const data = await fs.readFile(a.path);
          if (data.length <= 10 * 1024 * 1024)
            images.push({
              type: "image" as const,
              data: data.toString("base64"),
              mimeType: a.mime,
            });
        }
      }
    if (images.length) {
      const imageReserve = images.length * 4096;
      if (tokens(system + history + dynamic + inputText) + imageReserve > max) {
        history = await this.history.view(
          this.agent.id,
          signal,
          Math.max(
            500,
            max - tokens(system + dynamic + inputText) - imageReserve - 4096,
          ),
          inputIds,
        );
        messages.splice(0, messages.length, ...composeMessages());
      }
      if (tokens(system + history + dynamic + inputText) + imageReserve > max)
        throw Error("Too many images for model context; split the input");
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "本轮附件图片（与上方附件列出的顺序一致）：" },
          ...images,
        ],
      });
    }
    if (this.cfg.context.trace)
      await atomicWrite(
        path.join(this.root, ".runtime", "traces", runId + ".json"),
        JSON.stringify(
          {
            injections: { ...stateSelection, spark: !!spark },
            layer2: {
              history,
              conversation_context: state.conversation_context ?? null,
              target,
              trigger_ids: triggerIds,
              input_ids: batch.map((e) => e.event_id),
              through: this.db.get(`history:${this.agent.id}`, { through: 0 })
                .through,
            },
            system,
            messages: messages.map((m) => ({
              ...m,
              content:
                typeof m.content === "string"
                  ? m.content
                  : m.content.map((c) =>
                      c.type === "image"
                        ? {
                            type: c.type,
                            mimeType: c.mimeType,
                            bytes: c.data.length,
                          }
                        : c,
                    ),
            })),
            memoryIds: memories.map((m) => m.id),
          },
          null,
          2,
        ),
      );
    return { system, messages, memories, target, inputText };
  }
}
