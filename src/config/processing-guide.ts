/** Developer-facing paths describe real consumers; no changes to runtime policy. */
export interface ProcessingGuide {
  steps: string[];
  code: string[];
}
const stages: Record<string, ProcessingGuide> = {
  root: {
    steps: [
      "ConfigStore 先读取根目录 config.yaml 的公共设置和默认值，再读取 agents/<id>/config.yaml；各 agent 的独立设置组装成内存中的 overrides，parseConfig 检查约束。保存时再拆回各文件。个人字段优先，缺省字段继承公共默认；普通保存只保留明确设置的字段。",
      "ConfigStore.resolve 将相对路径换成项目下的真实目录。修改目录不是迁移操作；历史文件和数据库需要另外迁移。",
    ],
    code: [
      "src/config/store.ts · ConfigStore.load / resolve",
      "src/config/schema.ts · parseConfig / agentConfig",
    ],
  },
  server: {
    steps: [
      "启动时读取 server，创建 API 和管理网页两个监听地址。每个请求读取 Bearer 口令，与启动时从环境变量取得的口令比较。",
      "保存配置只更新文件和管理端草稿值；重建服务后新监听地址和新口令才接管请求。",
    ],
    code: [
      "src/admin/server.ts · servers",
      "src/application.ts · startManaged",
    ],
  },
  model: {
    steps: [
      "先由 agentConfig 合并该 agent 的有效模型配置。主模型交给 PiExecutor；query、maintenance、emotion、rerank 分别把自己的字段覆盖在 fast 上；embedding 单独使用向量模型。",
      "主模型发出聊天与工具请求。辅助模型以 system=该用途的指令、user=本次材料的 JSON 发 Chat Completions，并要求返回 JSON；向量模型走 embeddings。列表读取是独立 /models 请求，不会验证模型是否支持全部功能。",
      "模型设置不由运行结果回写。辅助结果由记忆或心情模块接收，影响本轮回忆或下一轮状态。",
    ],
    code: [
      "src/config/schema.ts · agentConfig",
      "src/shared/models.ts · OpenAIModels.model / json / embed",
      "src/layer4/pi.ts · PiExecutor",
    ],
  },
  history: {
    steps: [
      "ContextBuilder.build 调用 History.view：从数据库的 history:<agent_id> 读取已压缩到哪个事件（through）和累计摘要（summary），再读取 through 之后的事件。投递确认和 run_finished 不加入这份历史。",
      "History.render 保留事件时间、来源、发言人、正文和附件说明；旧工具结果只取末尾 toolTailTokens。估算“旧摘要＋剩余原文”的 token 数。",
      "超过 triggerTokens 时，从最新内容往前尽量留出 targetTokens−summaryTokens 的原文空间，其余较早事件分批交给 main 模型总结，输入同时包含旧摘要。总结成功后把新的 through/summary 写回数据库；原始 JSONL 不改。",
      "最后把累计摘要和保留原文交给第三层，放到第一条 user 消息的 [Recorded experience] 背景中。下一轮从新 through 接续，而不是再总结全部历史。",
    ],
    code: [
      "src/layer2/history.ts · History.render / view",
      "src/shared/models.ts · OpenAIModels.summarize",
      "src/layer3/context.ts · ContextBuilder.build",
    ],
  },
  context: {
    steps: [
      "每轮先获得第二层历史，再自动查找记忆、更新交流间隔并读取状态。基础 prompt＋persona 合计先取最多 4000 token；随后附加最多 5000 token 的 [Project]（目录、发送目标、Skills 清单）和 [Style]。",
      "system 先按 layer3Tokens−stateTokens−200 预留空间裁切。另把回忆写入 [Recalled memories]，把状态写入 [Current state]，再按 layer3Tokens 减 system 实际长度裁切这份动态背景。这里裁的是文本，过小可能截断 JSON 的末尾。",
      "检查主模型容量：可用输入≈contextWindow−maxOutput−safetyTokens。如果 system、历史和动态背景仍超限，才要求第二层再压缩历史；图片另按每张 4096 token 预留。仍装不下就报错。",
      "trace 开启时保存构建结果和 layer2 交接材料到 .runtime/traces/<run>.json；第四层还把每次主请求保存到 .runtime/requests/<run>/。不回写这些预算参数。",
    ],
    code: [
      "src/layer3/context.ts · ContextBuilder.build",
      "src/layer4/pi.ts · transformContext / request trace",
      "src/shared/tokens.ts · cut / tokens",
    ],
  },
  memory: {
    steps: [
      "MemoryService.recall 接收最近对话材料。需要时由 query 小模型产生 queries，程序把前 queryDirections 条合成一个搜索句；失败或超时使用原材料。",
      "search 同步 memory.json 的文字内容，分别计算词语重叠和向量相似度，筛掉完全不相关条目，再结合长期强度、重要性、熟悉度、情绪和短期激活排序。可再用 rerank 小模型加分、降低重复摘要的排名。",
      "recall 按 maxItems 选主回忆，再补时间邻居或一条突然联想；按 summaryTokens、detailsItems/detailsTokens 和 memoryTokens 装入结果；某条装不下则跳过该条，继续尝试后面的。ContextBuilder 把这些条目作为 [Recalled memories] 背景交给主模型，不要求它逐条说出来。",
      "自动想起可更新 state.json 的 activation 时间；真正聊起后的长期加深由 afterRun 另做。memory.json 原文不因一次召回被改写。",
    ],
    code: [
      "src/layer3/memory.ts · recall / search",
      "src/layer3/context.ts · ContextBuilder.build",
    ],
  },
  rankWeights: {
    steps: [
      "先算文字匹配和语义匹配的两个名次：R=1/(rrfK+文字名次)+1/(rrfK+语义名次)，名次从 1 开始。",
      "计算最终基础分：R×(base + strength×A + importance×I + familiarity×F + emotion×E + activation×B)。A 是衰减后的长期强度；I=(importance−1)/4；F=1−exp(−重温次数/5)；B 是最近想起的短期热度；E 是与当前情绪匹配且随发生时间淡去的程度。",
      "按分数取 candidates，再重排和减少重复；最终只把选中的记忆放入上下文，不把这套权重直接念给主模型。参数不回写，实际分数每次搜索重新算。",
    ],
    code: ["src/layer3/memory.ts · search"],
  },
  state: {
    steps: [
      "MemoryService.state 先读 state.json，以 updated_at 到现在经过的时间补算消退。整体心情=baseline+(旧心情−baseline)×2^(−经过小时/moodHalfLifeHours)；各项短期情绪=旧值×2^(−经过分钟/emotionHalfLifeMinutes)。过期念头、关注点和激活标记在此清理。",
      "第四层启动后有文字、工具结果或主动沉默并结束，Runtime 才把这轮交给后台 afterRun；不等待发送成功。afterRun 给 emotion 模型的 user 材料包含 persona、policy、state、本轮 input 和候选 memories。",
      "收到建议后：整体心情增量先乘 eventSensitivity，再限制到 ±moodDeltaLimit，累加后限制在 0–100。单项情绪和驱动力用各自倍率，限制到 ±dimensionDeltaLimit，再限制最终范围。返回 thoughts/focus 数组时替换当前列表；未返回时保留旧列表。",
      "updateState 串行写 state.json。下一轮 ContextBuilder 读取它，裁到 stateTokens 后拼入 [Current state]。旧轮后台尚未完成时，新轮可能先读到旧状态。单纯 GET state 会补算但不保证当场写文件；经过 updateState 才保存。",
    ],
    code: [
      "src/layer3/memory.ts · state / updateState / afterRun",
      "src/layer2/runtime.ts · moodChains",
      "src/layer3/context.ts · ContextBuilder.build",
    ],
  },
  drives: {
    steps: [
      "每次 MemoryService.state 读取状态，已关闭的驱动力被移除；开启的按“baseline+(旧值−baseline)×2^(−经过小时/halfLifeHours)”向自己的常态恢复。",
      "afterRun 接收 emotion 模型建议的 drives.<名称> 增量，乘这项 sensitivity，再限制到 ±state.dimensionDeltaLimit，累加后限制到本项 min/max；未知或已关闭的名称忽略。",
      "结果通过 updateState 存入 state.json.drives，下一轮随 [Current state] 给主模型。这个分数本身不会触发随机聊天或定时任务；没有另一个欲望调度器。",
    ],
    code: [
      "src/layer3/memory.ts · state / afterRun",
      "src/layer3/context.ts · ContextBuilder.build",
    ],
  },
  style: {
    steps: [
      "ContextBuilder 在每轮开始读取有效 style 配置，写成 system 中的 [Style] 段。开头是“日常优先N句、约M字；复杂交付按需展开”。",
      "warmth、humor、directness、restraint、emotionExpression 小于 0.34 写“较少”，小于 0.67 写“适中”，其余写“较强”；其他字段使用数值或 true/false 写入。这里没有另一次场景判断 API。",
      "主模型结合完整背景决定怎样表达。程序不根据这几个数字裁剪已生成回复，也不为口头禅或重复旧事维护严格计数；最终发送拆分另由第四层和 delivery 处理。",
    ],
    code: [
      "src/layer3/context.ts · ContextBuilder.build",
      "src/config/style-prompt.ts · buildStylePrompt",
      "src/config/help.ts · fieldHelp.style",
    ],
  },
  runtime: {
    steps: [
      "Runtime 启动一轮独立工作并设置总时限，PiExecutor 新建临时 Agent，把第三层的 system/messages 作为输入。按开关注册 Pi 文件、Shell、网页、应用工具和 MCP；Skills 清单已在第三层加入。",
      "每次模型和工具请求分别使用超时限制；模型可以输出文字、调用工具、看工具结果再继续。工具调用与完整返回先记入第二层；给当前模型看的文本结果超长时保留开头和完整文件路径。",
      "完整文字块按生成顺序交给发送队列。达到轮次/总时间上限或有新触发时结束本轮。新触发会删除同一聊天位置尚未交给第一层的旧回复及原始正文；已交接的任务继续，超时/手动停止不额外清理队列。下一轮新建 Pi Agent，从我们自己的记录重新获得经历。",
    ],
    code: [
      "src/layer2/runtime.ts · run / cancel",
      "src/layer4/pi.ts · PiExecutor",
      "src/layer4/tools.ts · appTools",
      "src/layer4/mcp.ts",
    ],
  },
  delivery: {
    steps: [
      "第四层提交文字或发送工具动作后，第二层记入发送队列。Outbox 在入队时按 split 拆成 parts，串行取任务交给第一层；交接前可被同一聊天的新触发删除，交接后整条任务继续发送。",
      "Telegram 发送每个部分之前按 initialDelayMs 等待，可显示 typing/upload_photo；每部分成功后队列按 partIntervalMs 再等待。已成功部分记录状态，确定失败按 attempts 重试，不确定是否送达则等人工检查。",
      "发送结果作为 delivery_result 回到第二层保存，不触发再次推理。这里使用所属 agent 的有效 delivery 配置，个人字段优先，缺省字段继承公共默认。",
    ],
    code: [
      "src/layer2/outbox.ts · Outbox",
      "src/layer1/channels.ts · ChannelRegistry",
    ],
  },
  scheduler: {
    steps: [
      "Scheduler 为每个启用的 agent 启动自己的脚本进程；读取其独立 config.yaml，安排自己的每日维护、做梦和随机机会。脚本带 agent_id 向同一个 /v1/events 提交事件。",
      "随机等待分钟数=min+Math.random()×(max−min)；到期按 timezone 算当前小时，只有 activeStart≤小时<activeEnd 才向 /v1/events 发 internal_event。然后重新抽下一段等待。",
      "内部事件带基础提示文字，进入第二层普通触发流程，再经过第三层和第四层；模型可选择沉默。参数不是每秒回写的状态；重启脚本会重新抽时间，不保存下次触发点或补跑错过事件。",
    ],
    code: [
      "src/scheduler.ts · Scheduler",
      "scripts/schedule.ts · cron / event / arm",
      "src/layer2/runtime.ts · ingress",
    ],
  },
  channels: {
    steps: [
      "启动时 ChannelRegistry 按 type/enabled 建立连接。Telegram 使用 process.env[tokenEnv] 登录，收到消息先登记聊天位置，再检查 allowedChats。",
      "允许的消息再匹配启用 agent 的 defaultTarget 和 routes；匹配成功才附上 agent_id，把文字、来源、时间、附件关系统一送到第二层。未匹配的消息不进入 agent 对话。",
      "回复方向由 Target 指定渠道和聊天 ID。Bot Token 只从 .env/进程环境读取，配置保存的是变量名；观察到新聊天只更新数据库的已见位置，不擅自改绑定。",
    ],
    code: [
      "src/layer1/channels.ts · ChannelRegistry.start",
      "src/layer2/runtime.ts · ingress",
    ],
  },
  agents: {
    steps: [
      "初始化和重启读取根配置里的 agent ID 清单，加载各自 config.yaml、.env、提示词与脚本。运行时按 id 建立独立 MemoryService 和执行入口；内存 overrides 是兼容视图，磁盘只保存各自明确设置的字段。",
      "Telegram 的默认位置和 routes 参加入站匹配，targets 仅作为模型发送工具能选的别名放入 [Project]。普通回复由本轮来源决定，无来源的内部事件才使用 defaultTarget。",
      "同一 agent 的多渠道经历进入同一份历史；不同 id 各有记忆、状态和工作目录。移出配置不删除文件，name 只改显示名，不自动改 persona。",
    ],
    code: [
      "src/init.ts · initialize",
      "src/config/schema.ts · agentConfig",
      "src/layer2/runtime.ts · Runtime",
      "src/layer3/context.ts · ContextBuilder.build",
    ],
  },
  target: {
    steps: [
      "入站时用 channel、conversation 和可选 thread 匹配 agent 绑定；kind 表示私聊或群聊。默认位置和额外 routes 都参加匹配，发送别名 targets 不参加。",
      "ContextBuilder 使用本批最后一个触发的 reply_target；没有该字段才用 agent.defaultTarget。第四层的正常回复沿用它，显式发送工具可以选择另一目标。",
      "第二层发送队列保留目标，第一层把统一字段换成 Telegram 的 chat_id/message_thread_id 等平台字段。目标不会通过情绪或记忆自动改写。",
    ],
    code: [
      "src/layer1/channels.ts · ChannelRegistry",
      "src/layer3/context.ts · ContextBuilder.build",
      "src/layer4/tools.ts · target lookup",
    ],
  },
  mcp: {
    steps: [
      "每轮执行开始，读取启用的 MCP 项；command 用本机子进程，url 用 HTTP。进程环境使用当前 agent 的独立环境，再覆盖 mcp[].env；HTTP 从当前 agent 的 headersEnv 环境变量解析请求头 JSON。",
      "连接后读取工具定义，加入本轮 Pi Agent 的工具清单。模型选择工具时，调用转到 MCP 服务；结果按普通工具结果记录并继续推理。",
      "本轮结束关闭连接。连接超时或格式错误会使本轮失败，当前不是自动忽略故障服务。不会把 env 或请求头主动写进模型提示词。",
    ],
    code: ["src/layer4/mcp.ts", "src/layer4/pi.ts · PiExecutor"],
  },
  prompts: {
    steps: [
      "对应模块优先使用 cfg.prompts.<用途>，未配置才读取默认文本。system 的默认来源是当前 agent 的 prompts/system.md；其他辅助用途的默认指令在 MemoryService 代码内。",
      "system 后面仍拼人格、[Project] 和 [Style]。辅助指令交给 OpenAIModels.json，自动附加“Return one JSON object.”，本次材料作为独立 user JSON 发送。",
      "返回值必须使用各用途约定的字段，程序才会消费它。它不是由主模型修改自身 prompt 的接口；参数保存后重新加载，已有运行不追溯改变。",
    ],
    code: [
      "src/layer3/context.ts · ContextBuilder.build",
      "src/layer3/memory.ts · recall / sync / afterRun",
      "src/shared/models.ts · OpenAIModels.json",
    ],
  },
};
const query: ProcessingGuide = {
  steps: [
    "ContextBuilder 从第二层取最近 queryRecentMessages 条用户话、内部触发和 agent_reply，按历史格式串成材料；工具事件不计入。",
    "recall 以这份材料做缓存键。query 开启且缓存不可用时，把开头 queryInputTokens 个 token 交给 query 模型，system 使用 prompts.query 或默认“最多三条查找旧事的查询”。",
    "取返回 queries 的前 queryDirections 条，合成一个查询；它们不是多次独立检索。成功结果只缓存在本进程，queryCacheSeconds 后失效。失败或超过 queryTimeoutMs 就用原材料。",
    "search 再把查询开头最多 1000 token 交给 embedding，把结果用于语义比较；词法匹配也用查询文本。查询句本身不直接替换主模型历史，只有最终回忆进入 [Recalled memories]。",
  ],
  code: [
    "src/layer3/context.ts · ContextBuilder.build",
    "src/layer3/memory.ts · recall / search",
    "src/shared/models.ts · json / embed",
  ],
};
const maintenance: ProcessingGuide = {
  steps: [
    "sync(false) 读 memory.json，按条目内容和向量模型签名检查变化，更新搜索用的文字副本。原文变化或向量模型变化会使相应旧描述/向量失效，但仅修改分片参数不会重做已有向量。",
    "sync(true) 按 maintenanceBatchItems 分批、批内逐条处理缺少向量的记忆。searchDescription 开启且还没描述时，给 maintenance 模型完整条目，取 search_text 的前 descriptionTokens。",
    "把“检索描述＋原记忆文字”按 chunkTokens 和 chunkOverlap 切片，再调用 embedding；一批最多 20 个片段。单条受 maintenanceTimeoutMs 限制，成功结果写入 .runtime/search-index.json；失败记日志，保留 memory.json。",
    "daily 由定时脚本调用；debounced 由后台每 pollSeconds 检查文件修改时间，静置超过 debounceSeconds 后调用。自带每日维护在 debounced 模式仍会执行。",
  ],
  code: [
    "src/layer3/memory.ts · sync / mutateIndex",
    "src/layer2/runtime.ts · maintenance loop",
    "scripts/schedule.ts · daily maintenance",
    "src/shared/models.ts · client / embed",
  ],
};
const review: ProcessingGuide = {
  steps: [
    "schedule.ts 按该 agent 的 memory.sleepCron 和当前 agent 的 timezone 计算下次时间。到点先调用 /memory/reindex 维护已有条目，完成后检查 reviewEnabled。",
    "启用整理时发送内部提醒：“每批约 reviewBatchTokens token，最多 maxReviewItems 条，回看 reviewOverlap 条前文”。noveltyAttention 决定是否追加“留意意外、变化与熟悉的小事”；随机抽中 smallDetailProbability 才追加“额外保留最多 smallDetailMax 条小细节”。",
    "第二层把提醒当新事件处理，主模型按 personal-memory Skill 读取原记录并写 memory.json；程序没有硬限制它写几条。这些值不会直接改变当天聊天 prompt，也不会由这次整理自动回写。",
    "新写记忆的文字在下次同步可检索；因为当天索引维护在提醒之前，新向量可能要等后续 debounced 或下次维护。已生成 SYSTEM.md 内的旧建议不会自动改写，修改规则时也应检查 Skill/环境手册。",
  ],
  code: [
    "scripts/schedule.ts · cron callback",
    "templates/skills/personal-memory/SKILL.md",
    "src/layer3/memory.ts · sync",
  ],
};
const reinforcement: ProcessingGuide = {
  steps: [
    "每次搜索时，把记忆重要性转换为 I=(importance−1)/4，再算长期半衰期 H=baseHalfLifeDays×(1+importanceMultiplier×I)。长期强度 A=上次保存强度×2^(−距 strengthAt 的天数/H)。这里只算分，不删除 memory.json。",
    "自动回忆选中条目时，只在尚无标记时向 state.json.activation 写当前时间，已有标记不刷新；搜索时短期热度 B=2^(−距离激活的分钟数/activationHalfLifeMinutes)。超过 activationTtlHours 的标记在 state() 读取时清理。",
    "整轮后的 emotion 模型返回 memory_mentions，只有出现在本轮候选中的有效编号才算真正重温。afterRun 更新强度为 A+reinforcementGain×(1−A)，刷新 strengthAt、熟悉次数加一，并刷新 activation。",
    "长期强度和熟悉次数存 .runtime/search-index.json，短期标记存 state.json。下一轮重新计算排序，因而可能更容易想起。state.enabled=false 会跳过 afterRun；activationEnabled 只控制自动召回处的写入，不能完全禁用所有短期影响。",
  ],
  code: ["src/layer3/memory.ts · search / recall / afterRun / state"],
};
export function processingGuide(key: string): ProcessingGuide {
  const [group, field] = key.split(".");
  if (group === "memory") {
    if (/^query/.test(field)) return query;
    if (
      [
        "temporalNeighbors",
        "temporalWindowHours",
        "associationProbability",
        "associationTokens",
        "associationCooldown",
      ].includes(field)
    )
      return {
        steps: [
          "先按搜索排名取得主回忆，把第一条作为锚点。时间邻居按 occurred_at 与锚点相差的小时数筛选、从近到远排序；补入前 temporalNeighbors 条，挤掉末尾部分主回忆，尽量保持 maxItems 名额。",
          "每次自动召回把数据库 recallRound:<agent_id> 加一。抽中 associationProbability 且已有锚点时，从未入选的记忆里挑候选：与锚点有相同 people 项，或发生时间相差不足 24 小时；距离上次联想的轮数必须大于 associationCooldown。",
          "从符合条件的候选中随机选一条，在摘要前加“[突然联想]”，按 associationTokens 截短并清空 details。联想可比 maxItems 多一条，但仍受 summaryTokens 和整体 memoryTokens 限制，装不下会被跳过。",
          "数据库 associations:<agent_id> 记录已选联想的轮数，后续用于冷却检查；不是改写 memory.json 的内容。这只是交给主模型的背景，最终是否提起由它决定。",
        ],
        code: [
          "src/layer3/memory.ts · MemoryService.recall",
          "src/layer2/store.ts · Store.get / set",
        ],
      };

    if (
      [
        "searchDescription",
        "descriptionTokens",
        "chunkTokens",
        "chunkOverlap",
        "pollSeconds",
        "embeddingUpdate",
        "debounceSeconds",
        "maintenanceTimeoutMs",
        "maintenanceAttempts",
        "maintenanceBatchItems",
      ].includes(field)
    )
      return maintenance;
    if (
      [
        "sleepCron",
        "reviewEnabled",
        "reviewBatchTokens",
        "maxReviewItems",
        "reviewOverlap",
        "smallDetailProbability",
        "smallDetailMax",
        "noveltyAttention",
      ].includes(field)
    )
      return review;
    if (
      [
        "baseHalfLifeDays",
        "importanceMultiplier",
        "reinforcementGain",
        "activationEnabled",
        "activationMaxItems",
        "activationHalfLifeMinutes",
        "activationTtlHours",
      ].includes(field)
    )
      return reinforcement;
    if (
      field === "rankWeights" ||
      field === "rrfK" ||
      field === "emotionHalfLifeDays"
    )
      return stages.rankWeights;
    if (/^tool/.test(field))
      return {
        steps: [
          "第四层按开关提供 memory_search（query/offset/limit）和 memory_read（id/offset/version） 工具。模型主动调用时，工具到 MemoryService 查询本 agent 的记忆，不借用其他 agent 的资料。",
          "memory_search 以显式搜索模式运行：仍找相关记忆，但长期强度暂按 1、跳过辅助重排；按 toolPageItems 和 toolPageTokens 返回一页。memory_read 按 toolReadTokens 分页返回原条目的完整内容。",
          "工具结果通过第二层记录后回到这一轮模型循环；不会重建之前自动选出的回忆。查到的记忆可进入本轮候选，供回合后判断是否真正重温。",
        ],
        code: [
          "src/layer4/tools.ts · memory_search / memory_read",
          "src/layer3/memory.ts · search / items",
          "src/layer4/pi.ts · tool callbacks",
        ],
      };
  }
  if (key === "state.gap")
    return {
      steps: [
        "ContextBuilder 选定这一轮回复目标后，调用第二层 Store.gap；查询同一 agent、同一目标最近一条 agent_reply 文字块。",
        "计算当前时刻减那条记录的提交时间，返回 seconds_since_last_response、上次时间和 response_id；没有历史回复则间隔未知。不是按 Telegram 送达算，也不是一轮生成结束算。",
        "通过 MemoryService.updateState 写到 state.json.conversation_context。下一轮又重新计算；ContextBuilder 把当轮值放到 [Current state]，同时保存在 trace.layer2 供检查。关闭 gap 会移除状态中的这个字段。",
      ],
      code: [
        "src/layer2/store.ts · Store.gap",
        "src/layer3/context.ts · ContextBuilder.build",
        "src/layer3/memory.ts · updateState",
      ],
    };
  return stages[group] ?? stages.root;
}
