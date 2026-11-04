import { modelCompat } from "./model-compat.js";
import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  type AgentTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { streamSimple as streamChat } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import {
  createCodingTools,
  createGrepTool,
  createFindTool,
  createLsTool,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  Executor,
  RunRequest,
  RunResult,
  EventInput,
} from "../contracts/index.js";
import type { Intelligence } from "../shared/models.js";
import { errorText } from "../shared/files.js";
import { cut, tokens, chunks as tokenChunks } from "../shared/tokens.js";
import { Chunker } from "./chunker.js";
import { mcpTools } from "./mcp.js";
import { appTools, type ToolHost } from "./tools.js";
export class PiExecutor implements Executor {
  constructor(
    private host: ToolHost,
    private llm: Intelligence,
    private record: (
      event: Omit<
        EventInput,
        "protocol_version" | "agent_id" | "source" | "attachments" | "data"
      > & { data?: Record<string, unknown> },
    ) => void,
  ) {}
  async run(req: RunRequest): Promise<RunResult> {
    const h = this.host,
      cfg = h.cfg;
    let silent = false,
      rounds = 0,
      text = "",
      failure: string | undefined;
    const used: string[] = [];
    const m = { ...cfg.models.main, ...h.agent.main };
    const key = (h.env ?? process.env)[m.apiKeyEnv];
    if (!key)
      return {
        reason: "error",
        text: "",
        tools: [],
        memoryIds: [],
        error: `Missing ${m.apiKeyEnv}`,
      };
    let chunk = 0,
      messageIndex = -1,
      messageChunk = 0;
    const memoryIds = new Set(req.context.memories.map((m) => m.id));
    const chunks = new Chunker((t) => {
      if (req.signal.aborted) return;
      text += t + "\n";
      h.send(
        [{ type: "text", text: t }],
        req.context.target,
        `text-${chunk++}`,
        "send",
        undefined,
        undefined,
        {
          responseId: `${req.runId}:message:${messageIndex}`,
          chunkIndex: messageChunk++,
        },
      );
    });
    const toolDir = path.join(h.root, "history", "tools", req.runId);
    fs.mkdirSync(toolDir, { recursive: true });
    const native = createLocalBashOperations();
    let activeShell = "shell";
    const coding = createCodingTools(path.join(h.root, "workspace"), {
      bash: {
        exposeSessionEnvironment: false,
        operations: {
          exec: async (command, cwd, options) =>
            native.exec(command, cwd, {
              ...options,
              env: h.env ?? options.env,
              timeout: Math.min(
                options.timeout ?? cfg.runtime.toolTimeoutMs / 1000,
                cfg.runtime.shellMaxTimeoutMs / 1000,
              ),
              onData: (data) => {
                fs.appendFileSync(
                  path.join(toolDir, activeShell + ".stdout"),
                  data,
                );
                options.onData(data);
              },
            }),
        },
      },
    });
    let mcp: { tools: AgentTool[]; close: () => Promise<void> } = {
      tools: [],
      close: async () => {},
    };
    try {
      if (cfg.runtime.mcpEnabled) mcp = await mcpTools(cfg, req.signal, h.env);
      const all = cfg.runtime.toolsEnabled
        ? [
            ...coding,
            createGrepTool(path.join(h.root, "workspace")),
            createFindTool(path.join(h.root, "workspace")),
            createLsTool(path.join(h.root, "workspace")),
            ...appTools({
              ...h,
              rememberMemory: (id) => memoryIds.add(id),
              silent: () => {
                silent = true;
              },
            }),
            ...mcp.tools,
          ]
        : [];
      const names = new Set<string>();
      for (const t of all) {
        if (names.has(t.name)) throw Error(`Duplicate tool name: ${t.name}`);
        names.add(t.name);
      }
      const tools = all.map((t) => ({
        ...t,
        execute: async (
          callId: string,
          args: any,
          signal?: AbortSignal,
          update?: any,
        ) => {
          activeShell = callId.replace(/[^\w-]/g, "_");
          const timeout =
            t.name === "bash"
              ? Math.min(
                  (args.timeout ?? cfg.runtime.toolTimeoutMs / 1000) * 1000,
                  cfg.runtime.shellMaxTimeoutMs,
                )
              : cfg.runtime.toolTimeoutMs;
          const deadline = AbortSignal.timeout(timeout);
          const s = signal ? AbortSignal.any([signal, deadline]) : deadline;
          return t.execute(callId, args, s, update);
        },
      }));
      const guidelines = [
        ...new Set(
          all.flatMap((t) => ((t as any).promptGuidelines ?? []) as string[]),
        ),
      ].filter((rule) => !/PI_|coding assistant|harness/i.test(rule));
      const systemPrompt =
        req.context.system +
        (guidelines.length
          ? "\n[Tool usage]\n" +
            guidelines.map((rule) => "- " + rule).join("\n")
          : "");
      let requestIndex = 0;
      const agent = new Agent({
        initialState: {
          systemPrompt,
          tools,
          model: {
            id: m.name,
            name: m.name,
            api:
              m.protocol === "responses"
                ? "openai-responses"
                : "openai-completions",
            provider: "openai",
            baseUrl: m.baseUrl,
            reasoning: m.reasoning !== "off",
            compat: modelCompat(m),
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow,
            maxTokens: m.maxOutput,
          },
          thinkingLevel: m.reasoning,
        },
        streamFn: (model, context, options) => {
          req.signal.throwIfAborted();
          if (cfg.context.trace) {
            const dir = path.join(h.root, ".runtime", "requests", req.runId);
            fs.mkdirSync(dir, { recursive: true });
            const snapshot = JSON.stringify(
              {
                run_id: req.runId,
                request_index: requestIndex,
                captured_at: new Date().toISOString(),
                model: m.name,
                protocol: m.protocol,
                compat: model.compat,
                context,
              },
              (_key, value) => {
                if (
                  value &&
                  typeof value === "object" &&
                  value.type === "image" &&
                  typeof value.data === "string"
                )
                  return {
                    ...value,
                    data: undefined,
                    image_data_omitted: true,
                    base64_chars: value.data.length,
                  };
                return value;
              },
              2,
            );
            const file = path.join(dir, String(requestIndex++) + ".json");
            fs.writeFileSync(file + ".tmp", snapshot, { mode: 0o600 });
            fs.renameSync(file + ".tmp", file);
          }
          return (m.protocol === "responses" ? streamResponses : streamChat)(
            model as any,
            context,
            {
              ...options,
              apiKey: key,
              maxTokens: m.maxOutput,
              signal: options?.signal
                ? AbortSignal.any([
                    options.signal,
                    AbortSignal.timeout(cfg.runtime.timeoutMs),
                  ])
                : AbortSignal.timeout(cfg.runtime.timeoutMs),
            },
          );
        },
        getApiKey: () => key,
        toolExecution: "sequential",
        identity: { attribution: null },
        beforeToolCall: async () =>
          silent
            ? {
                block: true,
                reason: "This run elected silence",
                terminate: true,
              }
            : undefined,
        afterToolCall: async (ctx) => {
          const file = path.join(
            toolDir,
            ctx.toolCall.id.replace(/[^\w-]/g, "_") + ".json",
          );
          fs.writeFileSync(
            file,
            JSON.stringify(
              {
                tool: ctx.toolCall.name,
                args: ctx.args,
                result: ctx.result,
                isError: ctx.isError,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          this.record({
            event_id: `${req.runId}:result:${ctx.toolCall.id}`,
            type: "tool_result",
            run_id: req.runId,
            text: JSON.stringify(ctx.result),
            data: {
              tool: ctx.toolCall.name,
              call_id: ctx.toolCall.id,
              result_file: file,
              is_error: ctx.isError,
            },
          });
          return {
            content: ctx.result.content.map((c) =>
              c.type === "text"
                ? {
                    ...c,
                    text:
                      c.text.length > cfg.runtime.maxToolChars
                        ? c.text.slice(0, cfg.runtime.maxToolChars) +
                          `\n[Full result: ${file}]`
                        : c.text,
                  }
                : c,
            ),
          };
        },
        finishTurn: () => {
          rounds++;
          if (silent || rounds >= cfg.runtime.maxRounds)
            return { action: "end" };
        },
        transformContext: async (messages, signal) => {
          const limit =
            m.contextWindow -
            m.maxOutput -
            cfg.context.safetyTokens -
            tokens(systemPrompt) -
            tokens(
              JSON.stringify(
                tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
              ),
            );
          if (limit < 2000)
            throw Error("System and tools exceed model context budget");
          const inspect = JSON.stringify(messages, (_k, v) =>
            typeof v === "string" &&
            v.length > 20000 &&
            /^[A-Za-z0-9+/=]+$/.test(v)
              ? "[image bytes]"
              : v,
          );
          if (tokens(inspect) <= limit) return messages;
          // Emergency compaction is ours; Pi never invents another persona or restores a session.
          const budget = Math.min(
            cfg.history.summaryTokens,
            Math.floor(limit / 4),
          );
          let summary = "";
          for (const piece of tokenChunks(
            inspect,
            Math.max(1000, limit - budget - 1024),
            0,
          ))
            summary = await this.llm.summarize(
              summary + "\n" + piece,
              budget,
              signal,
            );
          return [
            {
              role: "user",
              content:
                "本轮工作记录压缩（已经执行的动作不要重做）：\n" +
                summary +
                "\n当前请求：\n" +
                cut(
                  req.context.inputText,
                  Math.max(500, limit - budget - 1024),
                ),
              timestamp: Date.now(),
            },
          ] as AgentMessage[];
        },
      });
      const abort = () => agent.abort();
      req.signal.addEventListener("abort", abort, { once: true });
      agent.subscribe((event) => {
        if (
          event.type === "message_start" &&
          event.message.role === "assistant"
        ) {
          messageIndex++;
          messageChunk = 0;
        }
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        )
          chunks.push(event.assistantMessageEvent.delta);
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          const msg = event.message as any;
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            failure = msg.errorMessage;
            chunks.discard();
          } else chunks.flush();
        }
        if (event.type === "tool_execution_start") {
          used.push(event.toolName);
          this.record({
            event_id: `${req.runId}:call:${event.toolCallId}`,
            type: "tool_call",
            run_id: req.runId,
            text: JSON.stringify({ tool: event.toolName, args: event.args }),
            data: { tool: event.toolName, call_id: event.toolCallId },
          });
        }
        if (
          event.type === "tool_execution_end" &&
          !h.db.getEvent(req.agentId, `${req.runId}:result:${event.toolCallId}`)
        )
          this.record({
            event_id: `${req.runId}:result:${event.toolCallId}`,
            type: "tool_result",
            run_id: req.runId,
            text: JSON.stringify(event.result),
            data: { tool: event.toolName, is_error: event.isError },
          });
      });
      try {
        req.signal.throwIfAborted();
        await agent.prompt(
          req.context.messages.map((x) =>
            x.role === "assistant"
              ? {
                  role: "assistant",
                  content:
                    typeof x.content === "string"
                      ? [{ type: "text", text: x.content }]
                      : x.content,
                  api:
                    m.protocol === "responses"
                      ? "openai-responses"
                      : "openai-completions",
                  provider: "openai",
                  model: m.name,
                  stopReason: "stop",
                  timestamp: Date.now(),
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                }
              : { ...x, timestamp: Date.now() },
          ) as AgentMessage[],
        );
        failure ??= agent.state.errorMessage;
      } finally {
        req.signal.removeEventListener("abort", abort);
      }
      return {
        reason: req.signal.aborted
          ? "cancelled"
          : failure
            ? "error"
            : silent
              ? "silent"
              : rounds >= cfg.runtime.maxRounds
                ? "limit"
                : "complete",
        text,
        tools: used,
        error: failure,
        memoryIds: [...memoryIds],
      };
    } catch (e) {
      return {
        reason: req.signal.aborted ? "cancelled" : "error",
        text,
        tools: used,
        error: errorText(e),
        memoryIds: [...memoryIds],
      };
    } finally {
      chunks.discard();
      await mcp.close();
    }
  }
}
