import fs from "node:fs/promises";
import path from "node:path";
import type { Runtime } from "../layer2/runtime.js";
import { agentConfig } from "../config/schema.js";
import { loadPromptMapping } from "../config/prompt-mapping.js";
import { auxiliaryPrompt } from "../config/auxiliary.js";
import { History } from "../layer2/history.js";
import { skillsList } from "../layer3/context.js";
import {
  assembleSystem,
  assembleBackground,
  recallMaterial,
} from "../layer3/prompt-assembly.js";
import { selectStateContext } from "../layer3/state-context.js";
import { createTurnSpark } from "../layer3/spark.js";
import { tokens } from "../shared/tokens.js";
import type { Event } from "../contracts/index.js";

export interface PromptStage {
  id: string;
  group: string;
  title: string;
  kind: string;
  prompt: string;
  input: string;
  cumulative?: string;
  explanation: string;
  parameters: unknown;
}
const pretty = (x: unknown) => JSON.stringify(x, null, 2);
export async function contextPreview(
  runtime: Runtime,
  agentId: string,
  text: string,
  trigger: "user" | "random_chat" = "user",
  random: () => number = Math.random,
) {
  const agent = runtime.cfg.agents.find((a) => a.id === agentId);
  const memory = runtime.memories.get(agentId);
  if (!agent || !memory) throw Error("Unknown or inactive agent");
  const cfg = agentConfig(runtime.cfg, agent),
    root = runtime.agentRoot(agentId),
    projectRoot = runtime.config.root();
  const session = await memory.inspectionSession(),
    { snapshot, calls, trace } = session;
  const now = snapshot.now,
    target = agent.defaultTarget;
  const event: Event = {
    protocol_version: 1,
    event_id: "context-preview",
    agent_id: agentId,
    seq: 0,
    claimed: 0,
    source: "preview",
    received_at: new Date(now).toISOString(),
    occurred_at: new Date(now).toISOString(),
    type: trigger === "user" ? "incoming_message" : "internal_event",
    text,
    reply_target: target,
    sender: {
      id: "preview",
      name: "预览输入",
      kind: trigger === "user" ? "user" : "system",
    },
    attachments: [],
    data: trigger === "user" ? {} : { kind: "random_chat" },
  };
  // History is used only for the same input formatter, never view/compaction/unansweredBatch.
  const historyFormatter = new History(runtime.db, cfg, session.llm);
  const inputText = historyFormatter.modelText(event);
  const material = recallMaterial(inputText, [], cfg.memory.queryInputTokens);
  trace.query = { original: material, expanded: material };
  const persona = await fs.readFile(path.join(root, "persona.md"), "utf8");
  let sparkDraw: number | null = null,
    sparkError = "";
  const [memories, spark] = await Promise.all([
    session.memory.recall(material),
    createTurnSpark({
      root,
      cfg,
      llm: session.llm,
      persona,
      batch: [event],
      signal: new AbortController().signal,
      random: () => {
        sparkDraw = random();
        return sparkDraw;
      },
      onIssue: (e) => {
        sparkError = String(e);
      },
    }),
  ]);
  const state = structuredClone(snapshot.state);
  if (cfg.state.gap)
    state.conversation_context = runtime.db.gap(agentId, target);
  else delete state.conversation_context;
  const draws: Record<string, unknown> = {};
  const selection = selectStateContext(state, cfg, random, (key, result) => {
    draws[key] = result;
  });
  const mapping = await loadPromptMapping(root);
  const base =
    cfg.prompts.system ??
    (await fs.readFile(path.join(root, "prompts/system.md"), "utf8"));
  const skills = cfg.runtime.skillsEnabled
    ? await skillsList([path.join(root, "skills"), ...agent.skills])
    : [];
  const stable = assembleSystem({
    cfg,
    agent,
    root,
    projectRoot,
    base,
    persona,
    skills,
  });
  const expression = cfg.state.enabled
    ? await auxiliaryPrompt(root, cfg, "stateExpression")
    : "";
  const background = assembleBackground({
    cfg,
    target,
    memories,
    state,
    mapping,
    selection,
    stateExpression: expression,
    spark,
    system: stable.system,
    now,
  });
  const stages: PromptStage[] = [];
  const add = (
    id: string,
    group: string,
    title: string,
    kind: string,
    prompt: string,
    input: unknown,
    explanation: string,
    parameters: unknown,
    cumulative?: string,
  ) => {
    stages.push({
      id,
      group,
      title,
      kind,
      prompt,
      input: typeof input === "string" ? input : pretty(input),
      explanation,
      parameters,
      ...(cumulative === undefined ? {} : { cumulative }),
    });
  };
  add(
    "input",
    "输入与检索",
    "本轮输入与检索材料",
    "检索输入",
    material,
    text,
    "把你填写的文字按正式输入规则包装，再构造召回材料。本轮输入优先，先裁到queryInputTokens的70%。\n\n**本试算省略全部历史和此前用户输入**，也不把未答消息重新加进来；下面的空‘此前用户输入’段是有意保留的格式。普通输入不会新增聊天记录，内部触发带真实类型标记。",
    {
      "memory.queryInputTokens": cfg.memory.queryInputTokens,
      inputLimit: Math.floor(cfg.memory.queryInputTokens * 0.7),
      trigger,
      target,
    },
  );
  const queryCall = calls.find((c) => c.purpose === "query");
  add(
    "query",
    "输入与检索",
    "Query小模型：提示词与实际输出",
    queryCall?.error ? "回退" : queryCall ? "辅助模型" : "跳过",
    queryCall
      ? "# System\n\n" +
          queryCall.system +
          "\n\n# 输入\n\n" +
          pretty(queryCall.input) +
          "\n\n# 输出\n\n" +
          (queryCall.error ?? pretty(queryCall.output))
      : "本次没有调用query模型。",
    material,
    "按照当前query规则，补出查询句；返回空、失败或超时都保留原始材料。试算的query缓存独立且初始为空。辅助请求的System和输入在左侧是实际传给模型的内容，错误也会如实显示。",
    {
      enabled: cfg.memory.enabled,
      query: cfg.memory.query,
      directions: cfg.memory.queryDirections,
      timeoutMs: cfg.memory.queryTimeoutMs,
      inputTokens: cfg.memory.queryInputTokens,
      model: { ...cfg.models.fast, ...cfg.models.query, apiKeyEnv: undefined },
    },
  );
  add(
    "expanded",
    "输入与检索",
    "合并原材料与查询句",
    "检索输入",
    trace.query.expanded,
    queryCall?.output ?? material,
    "把有效查询句追加到原材料后面，不替换原输入。接下来把这份材料截取最多1000 token去向量化；文字匹配仍使用完整合并材料。",
    {
      "memory.queryDirections": cfg.memory.queryDirections,
      embeddingInputTokens: 1000,
    },
  );
  const embedCall = calls.find((c) => c.purpose === "embedding");
  add(
    "embedding",
    "输入与检索",
    "向量请求与返回规模",
    embedCall?.error ? "回退" : embedCall ? "向量模型" : "跳过",
    embedCall
      ? pretty({
          input: embedCall.input,
          output: embedCall.output,
          error: embedCall.error,
        })
      : "没有进行向量查询。",
    trace.query.expanded,
    "使用现有记忆向量计算语义接近程度，不在本次重新建立记忆向量。向量请求失败时退回文字匹配；这里显示向量数量和维度，不把大矩阵塞进页面。",
    {
      "models.embedding.name": cfg.models.embedding.name,
      "memory.recallTimeoutMs": cfg.memory.recallTimeoutMs,
    },
  );
  const entries = trace.search?.entries ?? [];
  add(
    "ranking",
    "记忆筛选",
    "相关性与五种记忆因素",
    "中间资料",
    pretty(entries),
    embedCall?.output ?? trace.query.expanded,
    "先过相关性门槛：有文字重合，或语义相似度超过门槛。把文字与语义的**名次**融合，再乘状态倍率；倍率是基础底分加五项贡献，不是六种记忆。\n\n每条的factors含自然强度、重要性、短期激活、熟悉度、情绪联系及contributions；initial_score是重排前分数。只有候选名额内的条目才继续。这里是计算资料，不会整份送给主模型。\n\n计算方式：重要性归一值=(importance−1)/4；半衰期H=baseHalfLifeDays×(1+importanceMultiplier×归一重要性)；剩余强度=保存强度×2^(−过去天数/H)；激活=2^(−过去分钟数/activationHalfLifeMinutes)；熟悉度=1−exp(−重温次数/5)。情绪联系取名称匹配的当前情绪最大值÷100，再按记忆发生至今的天数衰减。\n\n融合相关分=1/(rrfK+文字名次)+1/(rrfK+语义名次)；initial_score=融合相关分×各contributions之和。",
    {
      "memory.vectorThreshold": cfg.memory.vectorThreshold,
      "memory.rrfK": cfg.memory.rrfK,
      "memory.candidates": cfg.memory.candidates,
      "memory.rankWeights": cfg.memory.rankWeights,
      "memory.baseHalfLifeDays": cfg.memory.baseHalfLifeDays,
      "memory.importanceMultiplier": cfg.memory.importanceMultiplier,
      "memory.activationHalfLifeMinutes": cfg.memory.activationHalfLifeMinutes,
      "memory.emotionHalfLifeDays": cfg.memory.emotionHalfLifeDays,
    },
  );
  const rerankCall = calls.find((c) => c.purpose === "rerank");
  add(
    "rerank",
    "记忆筛选",
    "小模型重排与相似内容去重",
    rerankCall?.error ? "回退" : "中间资料",
    pretty({
      request: rerankCall,
      selected: trace.search?.selected_ids ?? [],
      scores: entries.filter((e: any) => e.candidate),
    }),
    entries.filter((e: any) => e.candidate),
    "重排模型只看查询、候选编号和概括，返回偏好顺序，在现有分数上最多额外加25%。随后逐条选入；每选一条就降低与它概括太相似的剩余条目分数，直到名额用完。\n\n重排超时或失败继续用原排名。selected_score是被选中时经过相似惩罚的分数，search_rank是这一步的名次，还不是最后送入Prompt的顺序。",
    {
      "memory.rerank": cfg.memory.rerank,
      "memory.maxItems": cfg.memory.maxItems,
      "memory.diversityPenalty": cfg.memory.diversityPenalty,
      "memory.recallTimeoutMs": cfg.memory.recallTimeoutMs,
      rerankMaxBonus: 0.25,
    },
  );
  const phases = trace.phases as any[];
  let previous: unknown =
    phases.find((p) => p.key === "retrieval")?.items ?? [];
  for (const key of ["temporal", "association", "budget"]) {
    const p = phases.find((p) => p.key === key);
    const info =
      key === "temporal"
        ? {
            title: "时间联系：带出邻近经历",
            text: "围绕排名第一条的发生时间，找窗口内最接近的条目。带入的邻居会替换部分尾部名额，所以检索选中不一定最终保留。",
            params: {
              temporalNeighbors: cfg.memory.temporalNeighbors,
              temporalWindowHours: cfg.memory.temporalWindowHours,
              maxItems: cfg.memory.maxItems,
            },
          }
        : key === "association"
          ? {
              title: "随机联想：抽签与实际结果",
              text: "独立抽签后，只从人物相同或发生在一天内、且不在名单中的记忆里选。冷却按召回轮数计算。试算读取真实冷却，但不推进轮数或写回；再次试算可能不同。",
              params: {
                associationProbability: cfg.memory.associationProbability,
                associationCooldown: cfg.memory.associationCooldown,
                associationTokens: cfg.memory.associationTokens,
                draw: p?.draw,
                round: p?.round,
              },
            }
          : {
              title: "记忆篇幅：裁切与预算取舍",
              text: "每条概括先裁切；只有前detailsItems条保留细节，其余细节置空。逐条计算序列化后的token成本，放得下才加入。这里的items就是实际进入本轮记忆段的对象，编号和内容都来自真实处理结果。",
              params: {
                summaryTokens: cfg.memory.summaryTokens,
                detailsItems: cfg.memory.detailsItems,
                detailsTokens: cfg.memory.detailsTokens,
                "context.memoryTokens": cfg.context.memoryTokens,
              },
            };
    add(
      key,
      "记忆筛选",
      info.title,
      p ? "中间资料" : "跳过",
      p ? pretty(p) : "本次没有进入这个步骤（记忆关闭、没有条目或无结果）。",
      previous,
      info.text,
      info.params,
    );
    previous = p?.items ?? previous;
  }
  add(
    "rules",
    "稳定规则",
    "基础规则与人格",
    "主模型system片段",
    stable.rulesPersona,
    stable.rulesPersonaRaw,
    "读取当前agent的基础行为与人格，分别标成Operating rules和Persona，再共同裁到4000 token。它们不是临时情绪评分；长文件可能在这里被裁切，比较‘上一步输入’和‘本步产物’即可看到。",
    {
      baseSource:
        cfg.prompts.system === undefined
          ? path.join(root, "prompts/system.md")
          : "有效配置 prompts.system",
      personaSource: path.join(root, "persona.md"),
      sharedLimit: 4000,
      beforeTokens: tokens(stable.rulesPersonaRaw),
      afterTokens: tokens(stable.rulesPersona),
    },
    stable.rulesPersona,
  );
  add(
    "project",
    "稳定规则",
    "项目、目录、目标与Skills说明",
    "主模型system片段",
    "[Project]\n" + stable.project,
    { root, projectRoot, targets: agent.targets, skills },
    "列出Hineni身份、文档位置、工作目录、记忆位置、可用目标别名及Skill简介。只发现Skill名称/说明/路径，**不会执行脚本或读取整份Skill正文加入Prompt**。项目块最多5000 token，追加到规则和人格后。",
    {
      "runtime.skillsEnabled": cfg.runtime.skillsEnabled,
      skillDirectories: [path.join(root, "skills"), ...agent.skills],
      projectLimit: 5000,
    },
    stable.rulesPersona + "\n[Project]\n" + stable.project,
  );
  add(
    "style",
    "稳定规则",
    "表达风格映射与稳定前缀预算",
    "主模型system片段",
    "[Style]\n" + stable.style,
    cfg.style,
    "用当前style参数生成表达指导，追加在项目说明后，再对整个稳定system做一次预算裁切。数值是指导表达，不是硬截断模型回复；左侧可切到累积Prompt核对整段。",
    {
      style: cfg.style,
      "context.layer3Tokens": cfg.context.layer3Tokens,
      "context.stateTokens": cfg.context.stateTokens,
      stableLimit: stable.limit,
      rawTokens: tokens(stable.raw),
      finalTokens: tokens(stable.system),
    },
    stable.system,
  );
  add(
    "decay",
    "状态与灵感",
    "已有状态按时间回稳",
    "中间资料",
    pretty({
      mood: state.mood,
      emotions: state.emotions,
      drives: state.drives,
      thoughts: state.thoughts,
      focus: state.focus,
      conversation_context: state.conversation_context,
    }),
    snapshot.storedState,
    "按试算开始时刻计算心情、情绪和驱动力的回归，清掉过期念头与关注。交流间隔只读取默认回复位置的上一条回应时间，不展开聊天正文。\n\n**本轮输入不会在这里重新打情绪分。** 情绪小模型要等第四层整轮结束才更新；本试算不进入第四层，也不保存任何回稳结果或激活。",
    {
      asOf: new Date(now).toISOString(),
      moodBaseline: cfg.state.baseline,
      moodHalfLifeHours: cfg.state.moodHalfLifeHours,
      emotionHalfLifeMinutes: cfg.state.emotionHalfLifeMinutes,
      drives: cfg.drives,
      thoughtTtlHours: cfg.state.thoughtTtlHours,
      focusTtlHours: cfg.state.focusTtlHours,
    },
  );
  const info: Record<
    string,
    { title: string; input: unknown; parameters: unknown; explanation: string }
  > = {
    time: {
      title: "当前时间变成自然描述",
      input: now,
      parameters: {
        timezone: cfg.scheduler.timezone,
        template: mapping.text.now,
      },
      explanation: "把统一的试算时刻按配置时区和时段写成一句话。",
    },
    gap: {
      title: "交流间隔映射",
      input: state.conversation_context,
      parameters: { enabled: cfg.state.gap, bands: mapping.gap },
      explanation:
        "先算距离本位置上次回应多久，再选达到的最高一档。显示分钟/小时等自然描述，不因此猜测对方还在做旧事。",
    },
    mood: {
      title: "整体心情映射",
      input: state.mood,
      parameters: mapping.mood,
      explanation:
        "心情先四舍五入，再选达到的最高分档，把label放进模板；不会把心情分数直接要求模型表演。",
    },
    emotions: {
      title: "单项情绪筛选与强度措辞",
      input: state.emotions,
      parameters: { allowed: cfg.state.emotionLabels, ...mapping.emotions },
      explanation:
        "只保留允许名称且达到最低分的情绪，从高到低取最多maxItems项，每项按强度分档后拼成一句。名称与强度均来自当前状态，不是记忆emotion里的intensity。",
    },
    drives: {
      title: "驱动力偏离基线的表达",
      input: state.drives,
      parameters: { drives: cfg.drives, mapping: mapping.drives },
      explanation:
        "比较当前值与各自baseline，只显示超过偏离门槛的项目；按偏离大小取前几项，映射成比平常更强或弱一些。它不是关系好坏分。",
    },
    cause: {
      title: "旧感受缘由的时间映射",
      input: { cause: state.cause, assessed_at: state.assessed_at },
      parameters: mapping.cause,
      explanation:
        "根据上次评分时间选择‘最近/早些时候/此前’等措辞，再放入旧缘由。它只是来历，不是本轮任务。关闭cause或没有缘由时不写这一段。",
    },
    thoughts: {
      title: "念头抽签、数量与裁切",
      input: state.thoughts,
      parameters: {
        probability: cfg.state.thoughtContextProbability,
        max: cfg.state.thoughtContextItems,
        tokens: cfg.state.thoughtContextTokens,
        selected: selection.thoughts,
        drawResult: draws.thoughts,
        template: mapping.text.thought,
      },
      explanation:
        "每轮只抽一次是否展示已有候选。抽中后按数量与token上限取文字；没有候选不凭空生成。试算不更新候选。",
    },
    focus: {
      title: "关注抽签与模板",
      input: state.focus,
      parameters: {
        probability: cfg.state.focusContextProbability,
        max: cfg.state.focusMax,
        selected: selection.focus,
        drawResult: draws.focus,
        template: mapping.text.focus,
      },
      explanation:
        "独立抽签决定本轮是否呈现旧关注，不把关注当作新命令，也不随机取消实际工作。",
    },
  };
  let cumulativeState = "";
  for (const key of [
    "time",
    "gap",
    "mood",
    "emotions",
    "drives",
    "cause",
    "thoughts",
    "focus",
  ]) {
    const lines = background.stateSteps.sections
      .filter((x) => x.key === key)
      .map((x) => x.prompt)
      .join("\n");
    if (lines) cumulativeState += (cumulativeState ? "\n" : "") + lines;
    const meta = info[key];
    add(
      "state-" + key,
      "状态与灵感",
      meta.title,
      lines ? "主模型状态片段" : "跳过",
      lines || "此块本轮不注入：开关、候选、展示门槛或概率条件未满足。",
      meta.input,
      meta.explanation,
      meta.parameters,
      cumulativeState,
    );
  }
  add(
    "state-budget",
    "状态与灵感",
    "状态总预算与补充指导",
    "主模型状态片段",
    background.stateSteps.prompt + background.expressionPrompt,
    background.stateSteps.raw,
    "将刚才各小段按原顺序换行拼接，裁到stateTokens，再追加个人auxiliary.yaml的stateExpression指导。后者不调用模型；整个动态背景还要服从第三层总预算。",
    {
      "context.stateTokens": cfg.context.stateTokens,
      beforeTokens: tokens(background.stateSteps.raw),
      afterTokens: tokens(background.stateSteps.prompt),
      expressionSource:
        cfg.prompts.stateExpression === undefined
          ? path.join(root, "prompts/auxiliary.yaml")
          : "有效配置 prompts.stateExpression",
    },
    background.stateSteps.prompt + background.expressionPrompt,
  );
  const sparkCall = calls.find((c) => c.purpose === "spark");
  add(
    "spark",
    "状态与灵感",
    "本轮灵感：独立抽签与可选素材",
    sparkError ? "回退" : spark ? "主模型背景片段" : "跳过",
    background.sparkPrompt || "本轮没有灵感注入。",
    sparkCall
      ? {
          system: sparkCall.system,
          input: sparkCall.input,
          output: sparkCall.output,
          error: sparkCall.error,
        }
      : {
          enabled: cfg.context.spark,
          probability: cfg.context.sparkProbability,
          draw: sparkDraw,
        },
    "灵感只看人格和本轮输入，按配置概率尝试生成；不带旧历史、召回或状态。它与记忆召回可并行，这里仅按阅读顺序展示。未抽中、输出空或失败都跳过；有效文字裁切后套text.spark模板，不保存为记忆。",
    {
      enabled: cfg.context.spark,
      probability: cfg.context.sparkProbability,
      draw: sparkDraw,
      timeoutMs: cfg.context.sparkTimeoutMs,
      inputTokens: cfg.context.sparkInputTokens,
      outputTextTokens: cfg.context.sparkTokens,
      template: mapping.text.spark,
      error: sparkError || null,
    },
  );
  add(
    "dynamic",
    "最终交接",
    "合并记忆、状态、时间与灵感",
    "主模型system背景",
    background.dynamic,
    background.raw,
    "按‘参考身份/时间/默认位置 → 召回记忆 → 当前状态 → 状态表达指导 → 可选灵感’合并，再扣掉稳定system占用，剩余第三层额度就是本段上限。左侧产物是裁切后的实际动态背景。",
    {
      "context.layer3Tokens": cfg.context.layer3Tokens,
      stableTokens: tokens(stable.system),
      dynamicLimit: background.limit,
      beforeTokens: tokens(background.raw),
      afterTokens: tokens(background.dynamic),
    },
    background.dynamic,
  );
  const context = {
    system: stable.system,
    messages: historyFormatter.messages(
      agentId,
      [event],
      { role: "system", content: background.dynamic },
      { omitHistory: true },
    ),
  };
  const layout = [
    {
      role: "system",
      label: "稳定规则、人格、项目与风格",
      content: stable.system,
    },
    { role: "omitted", label: "对话历史位置（本次完全省略）", content: "" },
    ...context.messages.map((m) => ({
      ...m,
      label: m.role === "system" ? "本轮记忆与状态背景" : "本轮输入",
    })),
  ];
  const model = { ...cfg.models.main, ...agent.main },
    capacity = model.contextWindow - model.maxOutput - cfg.context.safetyTokens;
  const knownTokens = tokens(stable.system + background.dynamic + inputText);
  add(
    "final",
    "最终交接",
    "最终第三层Prompt顺序（省略历史）",
    "第三层交接预览",
    layout
      .map(
        (x) =>
          "# " +
          x.label +
          " [" +
          x.role +
          "]\n\n" +
          (x.content || "此处省略，不拼接、不压缩历史。"),
      )
      .join("\n\n"),
    { stable: stable.system, background: background.dynamic, input: inputText },
    "实际排列是稳定system → 历史位置 → 动态system背景 → 最新输入。本次历史明确省略，不能据此保证带上全部历史后的容量。\n\n这份结果止于第三层，不调用第四层主模型，不发现MCP工具、不执行任何工具，也不新增聊天、请求快照或运行记录；Pi在第四层还会添加工具说明并转换供应商协议。",
    {
      knownTokens,
      capacityWithoutOutputAndSafety: capacity,
      knownPartFits: knownTokens <= capacity,
      historyOmitted: true,
      thoughtFocusDraws: draws,
    },
    layout
      .map((x) => "[" + x.role + "] " + x.label + "\n" + x.content)
      .join("\n\n"),
  );
  return {
    agent_id: agentId,
    mode: "context",
    as_of: new Date(now).toISOString(),
    query: trace.query,
    search: trace.search,
    recall: trace.recall,
    phases,
    calls,
    output: memories,
    stages,
    context,
    layout,
    policy: { memory: cfg.memory, context: cfg.context },
    note: "完整第三层只读试算；省略历史及此前输入，不调用主模型。统一按试算开始时刻计算；随机分支独立抽签。辅助调用可能产生费用，不写记忆、索引、状态、激活、强化或查询缓存。",
  };
}
