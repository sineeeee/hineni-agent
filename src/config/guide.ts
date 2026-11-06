/** Human-facing descriptions, kept separate from fieldHelp (which also enters style prompts). */
export const configurationGuide: Record<
  string,
  { flow: string; scope: string }
> = {
  server: {
    flow: "启动时创建 API 和管理页面监听。修改端口后需要打开新地址；改变管理口令后需要重新登录。",
    scope: "全局；保存配置并重启服务。",
  },
  model: {
    flow: "主模型负责聊天和工具循环；summary 独立负责历史压缩，默认关闭思考；fast 是五类辅助 JSON 调用的默认模型；embedding 只产生记忆向量。模型列表由接口地址和对应 key 获取，不代表列表中所有模型都支持当前任务。",
    scope: "全局默认，可在 agent 的 main 或 models 覆盖；保存并重启。",
  },
  history: {
    flow: "第二层从旧摘要检查点接上后续原文；工具结果只取尾部进入历史视图。超过阈值才调用 summary 批量压缩较早部分。压缩不改原始 JSONL；新输入取消未交接回复时会删除对应原文。",
    scope: "历史预算和 pollMs 均按当前 agent 生效。保存并重启。",
  },
  context: {
    flow: "第三层拼入 system、人格、Skills 目录、记忆和当前状态，再加第二层历史。开启spark时，与召回并行生成只供本轮使用的想象灵感；它可被忽略，不是记忆或执行结果。自身预算先裁剪；逼近模型实际窗口才要求第二层紧急压缩。",
    scope: "可按 agent 覆盖；保存并重启。token 是估算，不等于精确计费。",
  },
  memory: {
    flow: "每轮：提炼查询 → 词法/向量召回 → 加权、重排、去重复 → 时间邻居和联想 → 按预算拼入背景。后台索引维护和主 agent 的记忆整理是两件事。",
    scope:
      "每个 agent 独立设置维护频率与整理时间；保存到自己的 config.yaml，保存并重启。",
  },
  state: {
    flow: "读取状态时按时间回稳、清理过期念头；整轮第四层结束后调用 emotion 模型给出增量，程序限幅后写入 state.json。下一轮作为 Current state 背景。",
    scope: "可按 agent 覆盖；不等待平台送达。保存并重启，已有状态不立即重置。",
  },
  style: {
    flow: "所有风格项写进主模型 system 的 [Style]。这是表达指导，不是场景分类器或字数裁剪器；工作交付可以展开。",
    scope: "可按 agent 覆盖；保存并重启。只有模型读到提示词后影响表达。",
  },
  runtime: {
    flow: "第四层每轮新建 Pi 执行器，发现工具，连续调用模型和工具。结果实时落入第二层，整句输出进入发送队列。",
    scope:
      "每个 agent 独立；cancelGraceMs 控制自己的调度子进程停止宽限。保存并重启。",
  },
  delivery: {
    flow: "第二层发送队列串行送往第一层；第一层进一步拆分、显示输入状态并上传。不会把第四层已拆开的句块重新合并。",
    scope:
      "队列共用并串行投递，但每条输出按所属 agent 的 delivery 设置拆分、等待和重试。保存并重启。",
  },
  scheduler: {
    flow: "启动可编辑的定时子进程；默认脚本向第二层发 internal_event。新触发按同一打断逻辑处理，模型可选择沉默。重启重新抽随机时间，不补跑错过事件。",
    scope:
      "每个 agent 有自己的 schedule.ts、schedule.once.json 和进程；一次性任务由宿主调度，到期仍提交同一事件入口；主目录是公共默认值。自定义脚本只有读取相应字段才受其影响。保存后可只重启自己的脚本。",
  },
  drives: {
    flow: "读取 state 时驱动力向各自基线回稳；回合后模型提出增量，经敏感度和限幅处理。数值随当前状态给主模型，作为表达背景。",
    scope: "可按 agent 覆盖；不直接启动任务、不自行安排主动聊天。保存并重启。",
  },
  channels: {
    flow: "第一层连接平台；Telegram 先检查 allowedChats，再按 agent.defaultTarget/routes 分发。Bot token 是账号凭据，chat ID 是消息位置，两者都需要配置。",
    scope: "全局渠道，可绑定多个 agent；保存并重启。",
  },
  agents: {
    flow: "每个 ID 对应独立目录、历史、人格、状态、记忆和执行。默认目标也参加 Telegram 入站匹配；targets 只是主动发送别名，不等于接收路由。",
    scope: "保存并重启；新增会初始化目录，移除配置保留已有数据。",
  },
  target: {
    flow: "channel 选已配置渠道，conversation 是平台聊天 ID，thread 是可选话题 ID。普通回复回本轮来源；没有来源的内部提醒才用默认位置。",
    scope: "保存并重启。群聊中每个匹配到的 agent 各自接收一份经历。",
  },
  mcp: {
    flow: "每轮第四层连接启用的 MCP，发现并包装工具；本轮结束后关闭连接。command 与 url 二选一。",
    scope: "每个 agent 有自己的 MCP 清单、环境和开关；保存并重启。",
  },
  prompts: {
    flow: "支持 system、query、feelingQuery、searchDescription、rerank、emotion、spark、stateExpression。system 覆盖个人 system.md；其他覆盖个人 auxiliary.yaml 同名规则。stateExpression 直接解释主模型状态；辅助调用须保留所要求的 JSON 字段。",
    scope:
      "可按 agent 覆盖；配置中的覆盖保存并重启。删除键恢复文件或代码内默认提示词。",
  },
  root: {
    flow: "这些是存储路径和协议版本。运行中禁止通过管理页面迁移路径；迁移请停服务、备份并按运行文档操作。",
    scope: "全局；不建议在日常调参时改动。",
  },
};
export const fieldGuide: Record<string, string> = {};
function rows(group: string, text: string) {
  for (const line of text.trim().split("\n")) {
    const at = line.indexOf("|");
    fieldGuide[group + "." + line.slice(0, at)] = line.slice(at + 1);
  }
}
rows(
  "root",
  `version|配置格式版本，目前固定为 1。
dataDir|SQLite 索引和发送队列位置；改变路径不能替代数据迁移。
agentsDir|所有 agent 目录的根路径；原始记录、记忆、workspace 都在这里。`,
);
rows(
  "server",
  `host|绑定的网络地址。127.0.0.1 仅本机可访问；对外监听需自行部署访问保护。
port|接收统一事件、工具和管理 API 的端口，不是 Telegram 平台端口。
adminPort|浏览器工作台端口。改后访问新的端口；API 端口必须与它不同。
tokenEnv|管理口令的环境变量名；实际值在 .env，至少 24 字符。`,
);
rows(
  "model",
  `protocol|responses（默认）或 chat-completions。主调用和辅助调用各自使用槽位协议；压缩使用独立 summary 模型。Responses 使用 store:false，不使用远端会话 ID。向量忽略此项。保存并重启生效。
baseUrl|兼容接口根地址，通常到 /v1。模型列表和本槽位的请求使用此地址。
apiKeyEnv|当前 agent 的 .env 内的变量名，如 OPENAI_API_KEY；实际 key 在凭据区填写。不能把 key 本身填这里。
name|请求发给服务商的精确模型 ID。可从模型列表选择；列表不会检查工具、视觉或 JSON 支持。
contextWindow|主模型预算与压缩模型分批使用的窗口大小。填大不会扩展服务商限制；其他辅助/embedding 槽位的此项目前不限制请求。
maxOutput|主模型或辅助 JSON 调用的总输出 token 上限，推理可能占用其中一部分。历史摘要请求取 summary.maxOutput 与 history.summaryTokens 较大值；摘要实际保留文字仍受 summaryTokens 限制。embedding 忽略此项。
reasoning|主对话使用 main；摘要使用 summary，默认 off；辅助用途继承 fast。DeepSeek 摘要 off 显式发送 none；其他模型 off 不发送推理参数，按接口默认处理。向量忽略此项。
compat|第四层 Pi 的兼容键。直连 api.deepseek.com 自动默认 supportsDeveloperRole=false，保留 system 身份，并默认 supportsMidConvoSystemMessages=true 保留背景的位置；用户明确值优先，其他端点保持 Pi 默认。辅助调用直接发送 system，不使用此项。`,
);
rows(
  "history",
  `triggerTokens|旧摘要加待保留原文的估算 token 超过此值才压缩。越大越多原文、成本更高；查看历史页不会触发压缩。
targetTokens|压缩时从末尾尽量保留原文，容量扣除 summaryTokens 后作为保留目标。必须低于 triggerTokens，不是每轮硬裁切。
summaryTokens|滚动摘要最终保留的文字 token 上限。摘要请求的总输出额度取它与 models.summary.maxOutput 的较大值，为推理和 JSON 留空间；输出仍须完整且文字不超此值，否则不推进压缩检查点。保留重要事件、修正、未完成事项和工具结果。
toolTailTokens|历史视图仅保留工具结果末尾这些 token；工具名、参数仍在记录里，完整结果另存文件。不是当前工具循环的结果上限。
pollMs|当前 agent 的第二层隔多少毫秒检查新触发；同批消息一起处理，有在途工作先取消。值越小响应越及时，也增加检查频率。`,
);
rows(
  "context",
  `layer3Tokens|system、人格、能力目录、记忆、状态合计的硬预算。先裁系统部分，再按剩余容量截动态背景；不是历史预算。
memoryTokens|自动召回记忆序列化后的总预算，某条超出剩余容量时跳过该条，继续尝试后面的。增大能带更多记忆，也增加输入量。
stateTokens|Current state 的可读状态文本预算，包含心情、念头、关注点和交流间隔；不包含 activation、内部 ID 和更新时间。
safetyTokens|模型窗口减去输出预算后额外预留的余量。总输入触及剩余窗口时要求历史紧急压缩；增大让输入更保守。
spark|开启后，每轮让spark模型只看人格与本轮触发文本，返回一条可选的虚构联想。旧历史仍传给主模型，但不传给灵感模型；不写入state.json或memory.json。空结果、无文本、超时或错误时不注入，主流程继续；父运行取消仍立即取消。与召回并行，不改记忆检索。
sparkProbability|每轮独立抽签一次，0.55表示55%；未抽中不调用灵感模型。有开关、文字且抽中才尝试生成，仍可能返回空或被跳过。按运行轮次计算，不按发送分句或工具循环计算；不与thought/focus互斥。
sparkInputTokens|灵感模型的人格和当前输入合计预算，预留128 token给字段。当前输入取末尾，最多占剩余一半；人格取开头并使用剩余额度。缩小会丢掉部分人格或当前材料，不影响主模型获得的原始输入。
sparkTokens|从有效JSON里提取spark字符串后，最多保留这些token，放入第三层动态背景；不是模型请求的总输出额度，后者用models.spark.maxOutput或继承fast。
sparkTimeoutMs|最多等灵感请求这么多毫秒；超时记录context警告并跳过灵感。该请求和记忆召回并行，因此通常由两者较慢的一项决定准备时间。
trace|保存初始编排、第二层交接和每次主模型请求快照。关闭后不新增快照，已有文件仍保留；图片只记元数据。`,
);
rows(
  "memory",
  `enabled|关闭时自动召回返回空列表。不会删除 memory.json，也不会单独关闭手动记忆工具和所有维护流程。
query|启用时先调用 query 辅助模型生成线索；失败退回原查询。关闭则直接用最近对话材料检索。
feelingShare|两侧按名额分配，0.5即各半；共用maxItems总量，重复不占两个名额，缺额补足。时间联系与预算仍在之后执行。
feelingRecall|同一条记忆同时维护事实和感受索引。只影响自动召回；memory_search工具保留原事实搜索。两侧合并后共用所有后续参数。
feelingInputTokens|感受query读取本轮与近期用户输入的容量，不传入当前情绪或人格；事实query保持原流程。
feelingQueryTokens|截取小模型返回的feeling_query；为空或失败跳过感受侧，不替换事实query。
feelingVectorThreshold|感受侧独立相关门槛；同ID只入选一次，两侧相关分取较高值，原状态倍率只乘一次。
queryRecentMessages|本轮输入优先（可为内部触发），另取最近这些条真实用户输入帮助理解指代；旧内部触发、助手回复分句和工具事件不作为此前用户材料。
queryInputTokens|送给 query 模型的材料截取上限；越大包含更多话题，可能稀释当前重点。
queryDirections|保留辅助模型返回的前几条线索，拼成一个查询；当前不是并行多次向量搜索。
queryTimeoutMs|提炼查询的等待上限，超时用原查询继续。
queryCacheSeconds|相同查询材料复用线索的时间窗口；增大减少辅助调用。
recallTimeoutMs|向量查询与可选重排各自拥有此等待预算（默认各 8000 毫秒）。超时保留词法/已有排序，不中断主对话。
rrfK|词法和向量的排名融合常数；越大，各名次差距越平缓，随后还乘记忆权重。
vectorThreshold|候选需要词法有重叠或向量相似度超过此值。升高减少仅语义相关的弱候选。
rankWeights|RRF 相关性乘以 base + 各特征权重之和；不是必须加起来为 1 的概率。
candidates|加权后进入重排和去重复的候选上限；提高可能增加重排材料和耗时。
rerank|多条候选时调用 rerank 辅助模型排序，匹配编号得到最多约 25% 加分；显式 memory_search 不运行此步。
diversityPenalty|每选一条就对相近摘要降权，减少重复记忆。越大越偏多样性，建议 0–1。
maxItems|自动主召回最多条数（时间邻居占此预算）；一次联想还可额外追加一条，总量再受 memoryTokens 限制。
summaryTokens|每条进入上下文的记忆 summary 截取预算。
detailsItems|排名靠前多少条可以携带 details；其余只给摘要等基础字段。
detailsTokens|每条被展开 details 的 token 上限；不是每条记忆在文件中的存储上限。
temporalNeighbors|从第一条召回锚点附近补充多少条时间邻居，占用主召回条数预算。
temporalWindowHours|时间邻居的 occurred_at 与锚点允许相差的小时数。越大关联时间范围越宽。
associationProbability|有召回锚点时尝试额外联想的概率；0 关闭，1 每轮尝试，仍需存在满足条件的候选。
associationCooldown|同一联想至少隔多少轮才能再次选中；轮次计数保存在第二层派生状态。
associationTokens|额外联想的 summary 截取预算，前缀为“突然联想”。
baseHalfLifeDays|长期强度基础半衰期。按 strengthAt 经过时间衰减；越大越耐忘，不会删除原记忆。
importanceMultiplier|重要性把半衰期放大：基础天数 × (1 + 倍率 × (importance−1)/4)。重要性仍另参与排名。
reinforcementGain|回合后模型判为真正重温的候选，强度更新为 A + gain×(1−A)，并增加熟悉度；依赖 state.enabled。
activationEnabled|控制自动召回时是否为尚无标记的记忆写短期激活，已有标记不会在此刷新。当前回合后强化仍会写激活、排序仍读取已有激活，故不是彻底禁用激活的总开关。
activationMaxItems|自动召回写入时最多保留的激活条数；回合后强化另可写入。
activationHalfLifeMinutes|短期激活评分的半衰期；越小，上轮想起的加分越快淡去。
activationTtlHours|读取状态时清理超过此年龄的激活时间戳。
emotionHalfLifeDays|情绪关联评分按记忆发生时间衰减的半衰期；与长期强度半衰期独立。
searchDescription|维护时为缺少检索描述的记忆调用 maintenance 模型。已有描述不会仅因开关改变而重写。
descriptionTokens|生成检索描述时的内容截取预算；描述是派生索引，不改原记忆 details。
chunkTokens|维护时向量化文本的分片容量；分片越小通常请求条目越多。改值不自动作废既有向量。
chunkOverlap|相邻向量分片重叠量，须小于 chunkTokens；用于保留边界语义。
pollSeconds|当前 agent 后台检查记忆文件变动的间隔；不是每天整理提醒的间隔。
embeddingUpdate|debounced：检查时发现文件已稳定则维护；daily：依赖定时脚本维护。默认脚本的每日维护仍会运行。
debounceSeconds|debounced 模式文件最后修改后至少等待这些秒，且要等下一次后台检查；不是精确闹钟。
maintenanceTimeoutMs|维护单条记忆的 API 总时限，同时作为维护客户端超时。
maintenanceAttempts|维护 API 最大尝试次数，含第一次；用于维护客户端重试，不是重跑主任务。
maintenanceBatchItems|维护队列每批处理的记忆数；越大单批工作越多。
toolsEnabled|决定暴露 memory_search、memory_read；还受 runtime.toolsEnabled 总开关约束。
toolPageTokens|memory_search 单页返回 token 预算；显式查询不会替换自动召回上下文。
toolReadTokens|memory_read 单页详细内容预算；超出用 offset 翻页。
toolPageItems|memory_search 默认及最多每页条数；实际取 min(limit 或默认值, toolPageItems)，并受工具页 token 预算约束。
sleepCron|默认调度脚本按此时间先维护已有索引，再视 reviewEnabled 发整理提醒；使用 scheduler.timezone。
reviewEnabled|控制每日维护后是否发“整理记忆”的内部提醒，关闭不会阻止该次索引维护。
reviewBatchTokens|写入整理提醒中“每批约多少 token”的建议，不限制模型实际读取量；已生成 SYSTEM.md 的旧建议不会自动重写。
maxReviewItems|写入整理提醒的“最多几条”建议；不是 memory.json 写入条数校验器。
reviewOverlap|整理提醒建议回看多少条前文；具体怎么读由 Skill 和主模型执行。
smallDetailProbability|每日整理提醒额外加入“小细节建议”的随机概率；不直接随机写记忆。
smallDetailMax|抽中时建议额外保留多少条小细节。
noveltyAttention|启用时整理提醒加入“留意意外、变化与熟悉的小事”，由模型决定记什么。`,
);
rows(
  "rankWeights",
  `base|相关性融合分的基础系数，即使其他记忆特征弱也保留相关性的贡献。
strength|长期衰减强度 A 的系数；增大更偏向强度仍高的记忆。显式搜索把 A 设为 1。
importance|重要性 (importance−1)/4 的系数；与延长半衰期是两条独立影响。
familiarity|熟悉度 1−exp(−重温次数/5) 的系数；多次重温逐渐趋于饱和。
emotion|当前情绪与记忆情绪标签匹配、再按发生时间衰减的系数。
activation|最近激活记忆的加分系数，按 activationHalfLifeMinutes 快速衰减。`,
);
rows(
  "state",
  `enabled|整轮完成后才调用心情模型；关闭同时跳过这一路的记忆强化。第三层仅保留交流间隔背景，不拼完整情绪。
baseline|整体心情的回稳目标及新状态初始值；不是立即覆盖 state.json 的当前值。
moodHalfLifeHours|心情与 baseline 的差距每经过这些小时减半；读取状态时应用。
emotionHalfLifeMinutes|短期各情绪数值向 0 回落的半衰期，不等于整体心情回到 baseline。
emotionLabels|允许心情模型更新的情绪维度白名单；其他新名称被忽略，已有字段不会立即清除。
eventSensitivity|整体心情和情绪增量先乘此倍率，再做限幅；也作为 policy 传给辅助模型。驱动力使用各自 sensitivity。
moodDeltaLimit|每轮整体心情增减的绝对上限，最后数值限定 0–100。
dimensionDeltaLimit|每轮单个情绪/驱动力增减的上限；驱动力最后还受各自 min/max 限制。
surpriseMax|仅传给心情模型的意外放大参考，不是程序识别意外后自动乘此数。
repeatedStimulusMultiplier|仅传给心情模型的重复刺激参考；当前没有刺激重复计数器。
inputTokens|回合后判断材料的截取预算，包含本轮输入、产出的文字与工具等；不要求消息已经送达。
timeoutMs|回合后心情判断超时。当前也是辅助 OpenAI 客户端的默认超时，查询/召回另有更短 signal 限制。
reportChars|保存心情变化原因 cause 的字符上限。
thoughtsMax|本轮心情模型返回的念头列表最多保存几条，替换旧列表，不是长期记忆。
thoughtTtlHours|念头超过此年龄后在读取状态时移除。
thoughtHalfLifeHours|念头优先级排序的时间衰减半衰期；不直接删除念头。
thoughtContextProbability|候选念头存在且呈现条数大于0时，每轮按此概率决定是否带入。0.15表示15%；不改变保存、评分、替换和过期逻辑。
focusContextProbability|候选关注点存在且focusMax大于0时，每轮按此概率决定是否带入。0.2表示20%；未抽中不删除候选，不改变原始历史或决定任务是否执行。
thoughtContextItems|拼 Current state 时最多呈现前几条念头，不改变保存数量。
thoughtContextTokens|每条呈现念头的文本 token 截取上限。
focusMax|模型本轮返回关注点时最多保存的条数。
focusTtlHours|关注点久未更新后，在读取状态时清空。
gap|构建上下文时由第二层计算同一目标最近一次 agent_reply 文字块的提交间隔，写入 state.conversation_context；不以平台送达或整轮结束为计时起点。`,
);
rows(
  "style",
  `casualSentences|[Style] 中的闲聊句数建议；交付可展开，不硬截断。
casualChars|[Style] 中的闲聊字数建议；与实际模型 maxOutput 上限不同。
casualParts|写入 [Style] 的闲聊段数软上限；不是第一层消息分包数。
allowShortAck|提示模型是否允许一句简短附和；不会自动生成附和或强制回复。
warmth|亲和倾向：小于 .34 写“较少”，小于 .67 写“适中”，否则“较强”。
humor|幽默倾向，按 .34/.67 三档转成文字，不是随机插入笑话的概率。
directness|直接表达倾向，按 .34/.67 三档写入 [Style]。
emotionExpression|情绪外显倾向，按 .34/.67 三档写入 [Style]；不改变情绪计算。
restraint|有感受但暂时放下的倾向，按 .34/.67 三档写入 [Style]。
catchphraseCooldown|提示避免重复口头禅的回合数；目前无硬计数器保证冷却。
memoryMentions|闲聊主动提旧事的软上限；不会限制检索条数。
repeatMemoryCooldown|提示避免重复提同件旧事的回合数；与联想算法的 associationCooldown 不同。`,
);
rows(
  "runtime",
  `backend|当前固定 pi；不是可选模型，替换执行器需要实现代码适配。
maxRounds|一轮任务最多调用主模型的次数；到上限结束，不再无限工具循环。
timeoutMs|单次 Pi 主模型请求的等待上限；不是整个任务时限。
runTimeoutMs|一整轮任务的总时限；超时请求取消工具和模型。
toolTimeoutMs|工具默认时限，Shell 没显式 timeout 时也使用它。官方工具和 MCP 的取消配合仍依赖其实现。
shellMaxTimeoutMs|Shell 申请更长执行时间时的上限；毫秒配置会换算为秒交给 Pi。
mcpConnectTimeoutMs|单个 MCP 连接/发现过程等待上限；超时该连接失败。
toolsEnabled|关闭后本轮工具列表为空，文件、Shell、应用工具和 MCP 都不可用；不等于取消后台记忆 API。
skillsEnabled|决定是否把 Skill 名称、路径、简介放进 system 的能力目录；文件仍在磁盘，主模型按需 read。
mcpEnabled|控制每轮是否连接 mcp 配置服务；真正暴露仍受 toolsEnabled 控制。
webEnabled|控制 web_read 和 web_search 是否加入工具列表；搜索需要主服务端点支持 Responses web_search。
cancelGraceMs|当前 agent 的定时子进程重启时先终止、等待此宽限再强制结束；Pi Shell 按官方实现取消。
maxToolChars|当前工具循环返回模型的结果字符上限，过长留开头并标注截断；完整返回先写 history/tools，不丢原文件。`,
);
rows(
  "delivery",
  `typing|Telegram 工具执行时刷新 typing，结束、取消或整轮退出后停止；发送时仍展示 typing/upload_photo。纯模型思考不显示。
initialDelayMs|Telegram 每个待发送部分之前的固定延迟；不是按字符模拟打字。
partIntervalMs|串行队列每部分成功后等待的时间；增加会延迟其他渠道和 agent 的队列。
split|platform 按平台长度，paragraph 按段，sentence 按句进一步拆分；无法合并第四层已交付的句块。
attempts|确定失败的最多发送尝试次数；不确定结果不会盲目自动重发，需检查后手动重试。`,
);
rows(
  "scheduler",
  `enabled|是否启动调度子进程；关闭后默认每日维护提醒、随机聊天和梦境都没有脚本来触发。外部事件接口仍可用。
script|启动的脚本路径，可自行编辑；修改文件后点“重启定时脚本”，修改此配置应保存并重启服务。
timezone|默认脚本解析 cron 和主动时间段的时区；不改变历史 ISO 时间和 UTC 日志文件名。
randomChat|开启摸鱼/纯聊共用的随机计时器；到点按权重决定事件或安静。
leisureDailyLimit|每天最多抽几次随机机会，包含安静和提交失败；0表示不设次数上限，此时不读写每日计数。按timezone换日，个人.runtime/leisure-state.json只记日期与次数；重启保留次数。手动触发不计数。
moyuWeight|到点后抽到摸鱼的相对权重；概率=此值÷三项权重之和。只发读moyu Skill的事件，不执行Skill脚本；未安装Skill时回到纯聊天。
chatWeight|到点后抽到原有randomGreeting纯聊天的相对权重；不读取摸鱼Skill。三项都为0时安静。
quietWeight|到点后不提交事件的相对权重；安静也计入当日机会数，主模型不会被叫醒。
randomMinMinutes|每次随机等待的最短分钟数，重启重新抽取。
randomMaxMinutes|随机等待的最长分钟数，必须不小于最短值；在区间内均匀抽取。
activeStart|随机聊天允许时间段的开始小时（含），使用配置时区。
activeEnd|随机聊天允许时间段的结束小时（不含）；范围外跳过本次机会后重新计时，不延迟补发。
dreamEnabled|默认脚本是否安排梦境机会；与长期记忆写入规则独立。
dreamCron|梦境机会的 cron 表达式，默认每周日 04:00；当前不是随机做梦/次日必发消息。`,
);
rows(
  "drives",
  `enabled|是否回稳和接受该驱动力的模型增量；关闭后读取状态时移除此维度，不再回稳或接受新增量。
baseline|该驱动力初始化和回稳目标。改变后逐渐回稳，不立即重置。
halfLifeHours|偏离 baseline 的差距每这些小时减半。
sensitivity|该驱动力的模型增量先乘此倍率，再受 state.dimensionDeltaLimit 限幅。
min|该驱动力的最终下限；需要 min ≤ baseline ≤ max。
max|该驱动力的最终上限；不改变触发任务的概率。`,
);
rows(
  "channels",
  `id|渠道唯一名称，被 defaultTarget、routes、发送工具别名引用；改名需要同步引用。
type|telegram 使用 Bot API，webhook 向 URL 发送，未填 URL 的 webhook 是本地入口。
enabled|启动时是否连接该渠道；停用不删除历史。
tokenEnv|Telegram Bot token 所在环境变量名；默认 TELEGRAM_BOT_TOKEN。实际 token 在凭据区填写。
allowedChats|Telegram 入站允许列表，字符串 chat ID；空列表代表不额外限制。仍须匹配 agent 的接收位置，不会自动给所有 agent。
maxFileBytes|Telegram 下载附件大小上限，单位字节；超限产生附件失败事件。网页上传另有固定 20 MiB 上限。
url|webhook 出站地址；省略为本地收件箱，不能拿来接收 Telegram 消息。
secretEnv|webhook 出站 Bearer 凭据的变量名；不是管理入口的 HINENI_TOKEN。`,
);
rows(
  "agents",
  `id|独立 agent 的稳定编号，对应自己的目录和记录；已有 ID 不在表单中改名，迁移须处理数据路径。
name|工作台显示名；不会自动改 persona.md 的身份文字。
enabled|是否接收和处理新触发；停用后已有数据保留。
defaultTarget|没有来源的内部提醒默认发到这里；Telegram 也把这里当作入站匹配位置。
targets|模型 send_message/send_attachment 可用的目标别名；只配置别名不会让该位置的新消息路由给此 agent。
routes|额外的入站位置；多个匹配群目标的 agent 各自收到同一群消息。
skills|额外 Skill 目录；与自己的 skills 目录一起发现，文档不整篇自动注入。
main|该 agent 主模型覆盖，优先级高于 overrides.models.main，再高于全局 main。
overrides|只允许已列出的配置组深合并；数组整体替换。轮询、维护、发送和定时均读取当前 agent 的值，保存时写入个人 config.yaml。`,
);
rows(
  "target",
  `channel|选择 channels 中已存在的渠道 ID。
conversation|Telegram 的 chat ID，私聊通常为正整数、群通常为负整数；使用字符串保存。它不是 Bot token。
thread|可选 Telegram 话题 ID；省略时接收该聊天任意话题，回复使用实际来源话题。
kind|private 或 group；用于表达来源类型和群行为，不能代替真实 chat ID。`,
);
rows(
  "mcp",
  `name|工具名前缀标识，字母数字下划线，需与其他服务区分。
enabled|是否参与本轮连接和发现，仍受 runtime.mcpEnabled/toolsEnabled 控制。
command|stdio 服务启动程序；与 url 二选一，依赖必须已安装。
args|按顺序传给 command 的参数数组，不是整段 Shell 命令。
url|HTTP MCP 服务地址，与 command 二选一。
env|传给子进程的环境变量键值，明文配置会进入暂存，敏感值优先使用环境管理。
headersEnv|环境变量名，其值为请求头 JSON，HTTP MCP 建连时解析使用。`,
);
rows(
  "prompts",
  `system|替换基础 system 文本，然后仍会拼 persona、Project、Style；清除此键才重新使用 prompts/system.md。
summary|历史整理规则，读个人 auxiliary.yaml。输入是结构化历史资料，只返回 {"summary":"..."}；不回复旧对话。格式错误不推进压缩检查点。
query|替换查询线索提示词，要求返回 queries 数组；最近对话在输入里，不要改掉消费字段。
feelingQuery|替换感受查询规则，要求返回feeling_query字符串；空值跳过这一路。只接收输入及部分近期用户发言。
searchDescription|替换检索描述生成提示词，要求返回 search_text；维护时用于尚无描述的条目。
rerank|替换候选重排提示词，要求返回已存在编号的 ids 数组。
spark|修改本轮想象灵感生成规则，须返回spark字符串，允许空字符串。只看人格与本轮触发，不是状态评分或真实执行；保存个人auxiliary.yaml后下一次调用读取。
emotion|替换回合后判断提示词，保留 mood/emotions/drives/cause/thoughts/focus/memory_mentions 字段；程序仍会限幅。`,
);
export function guideKey(raw: string): string {
  let p = raw
    .replace(/^agents\.\d+\.overrides\./, "")
    .replace(/^agents\.\d+\.main\./, "model.")
    .replace(/^models\.[^.]+\./, "model.");
  p = p.replace(
    /^agents\.\d+\.(defaultTarget|routes\.\d+|targets\.[^.]+)\./,
    "target.",
  );
  p = p
    .replace(/^agents\.\d+\./, "agents.")
    .replace(/^channels\.\d+\./, "channels.")
    .replace(/^mcp\.\d+\./, "mcp.")
    .replace(/^drives\.[^.]+\./, "drives.")
    .replace(/^memory\.rankWeights\./, "rankWeights.");
  return p;
}
