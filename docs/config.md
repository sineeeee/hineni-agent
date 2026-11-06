# 配置参考

根文件是公共设施与公共默认值；个人配置在 agents/<id>/config.yaml。下方 agents[].overrides 是 API 合并视图，磁盘中个人设置直接使用顶层字段。详见 agent-layout.md。

本表列出 schema 默认值，不是当前安装值；当前值由根 config.yaml 默认值与 agents/<id>/config.yaml 的个人字段共同决定。先读[配置指南](configuration-guide.md)理解操作、模型/渠道/agent/MCP 嵌套字段和开关关联，再按本表查具体参数。Token 是估算值；style、回顾提示和部分情绪政策属于模型软指导，其他参数也需结合消费流程理解。保存配置后重启主程序生效。完整样例见 config.example.yaml。

## server

| 字段 | 默认 | 作用 |
|---|---|---|
| `host` | `"127.0.0.1"` | 监听地址；默认仅本机 |
| `port` | `8787` | 统一事件与工具 API 端口 |
| `adminPort` | `8788` | 管理页面端口 |
| `tokenEnv` | `"HINENI_TOKEN"` | 管理令牌的环境变量名 |

## models

| 字段 | 默认 | 作用 |
|---|---|---|
| `main` | `{"protocol":"responses","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","name":"gpt-4.1","contextWindow":1047576,"maxOutput":8192,"reasoning":"off","compat":{}}` | 主对话和执行模型 |
| `fast` | `{"protocol":"responses","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","name":"gpt-4.1-mini","contextWindow":1047576,"maxOutput":2000,"reasoning":"off","compat":{}}` | 快速模型默认值 |
| `embedding` | `{"protocol":"responses","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","name":"text-embedding-3-small","contextWindow":1047576,"maxOutput":1,"reasoning":"off","compat":{}}` | 记忆向量模型 |
| `summary` | `{"protocol":"responses","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","name":"gpt-4.1","contextWindow":1047576,"maxOutput":8192,"reasoning":"off","compat":{}}` | 独立压缩模型，默认关闭思考 |

## history

| 字段 | 默认 | 作用 |
|---|---|---|
| `triggerTokens` | `600000` | 历史视图达到此容量后批量压缩 |
| `targetTokens` | `350000` | 压缩后近期原文与摘要的目标容量 |
| `summaryTokens` | `12000` | 旧经历摘要容量 |
| `toolTailTokens` | `200` | 自动上下文中工具结果末尾的保留量 |
| `pollMs` | `500` | 第二层检查新增事件的间隔（毫秒） |

## context

| 字段 | 默认 | 作用 |
|---|---|---|
| `layer3Tokens` | `32000` | 人格、能力、状态、自动召回合计硬上限 |
| `memoryTokens` | `20000` | 自动召回记忆总预算 |
| `stateTokens` | `1000` | 情绪、念头、交流间隔预算 |
| `safetyTokens` | `16384` | 模型输入输出之外的安全余量 |
| `trace` | `true` | 保存每次实际上下文快照 |
| `spark` | `false` | 生成本轮临时想象灵感 |
| `sparkProbability` | `1` | 每轮尝试灵感的概率（0～1） |
| `sparkInputTokens` | `4000` | 灵感模型可读的人格与本轮输入总量 |
| `sparkTokens` | `120` | 传给主模型的灵感文字上限 |
| `sparkTimeoutMs` | `6000` | 等待灵感模型的最长毫秒数 |

## memory

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 自动记忆编排总开关 |
| `feelingRecall` | `true` | 同时检索记忆的感受侧 |
| `feelingShare` | `0.5` | 感受侧召回名额比例（0～1） |
| `feelingInputTokens` | `1800` | 感受查询可读的输入容量 |
| `feelingQueryTokens` | `160` | 生成的感受查询长度上限 |
| `feelingVectorThreshold` | `0.25` | 感受侧语义相似度门槛 |
| `queryRecentMessages` | `8` | 查询模型参考的近期用户输入条数 |
| `queryInputTokens` | `2500` | 查询模型输入容量 |
| `queryTimeoutMs` | `8000` | 查询模型等待上限（毫秒） |
| `queryCacheSeconds` | `60` | 相同查询缓存时长（秒） |
| `recallTimeoutMs` | `8000` | 向量查询和重排各自等待上限（毫秒） |
| `rrfK` | `60` | 多路召回排名融合常数 |
| `vectorThreshold` | `0.18` | 语义相似度过滤阈值，需要随模型实测调整 |
| `diversityPenalty` | `0.15` | 近似记忆重复出现的降权强度 |
| `summaryTokens` | `160` | 单条摘要展示容量 |
| `temporalNeighbors` | `2` | 补充的时间邻居条数 |
| `temporalWindowHours` | `24` | 邻居允许相差的小时数 |
| `associationTokens` | `250` | 联想摘要容量 |
| `activationEnabled` | `true` | 短期激活开关 |
| `activationMaxItems` | `12` | 保留的短期激活条数 |
| `emotionHalfLifeDays` | `7` | 情绪关联信号的半衰期（天） |
| `descriptionTokens` | `120` | 单条检索描述容量 |
| `debounceSeconds` | `120` | 合并文件变更的稳定等待时间（秒） |
| `maintenanceTimeoutMs` | `60000` | 维护单条记忆的 API 总时限（毫秒） |
| `maintenanceAttempts` | `3` | 维护请求最多尝试次数 |
| `maintenanceBatchItems` | `20` | 每批维护的记忆数 |
| `toolsEnabled` | `true` | 主动查找与读取记忆工具 |
| `toolPageTokens` | `3000` | 主动搜索单页容量 |
| `toolReadTokens` | `4000` | 主动读取单页容量 |
| `toolPageItems` | `10` | 主动搜索每页条数 |
| `reviewOverlap` | `4` | 回顾时建议带上的前文条数 |
| `smallDetailProbability` | `0.15` | 回顾时额外关注小细节的概率 |
| `smallDetailMax` | `1` | 额外小细节建议条数 |
| `noveltyAttention` | `true` | 回顾时提醒留意意外与变化 |
| `query` | `true` | 调用快速模型提炼查询 |
| `rerank` | `true` | 快速模型辅助重排 |
| `searchDescription` | `true` | 为记忆补充检索句 |
| `maxItems` | `12` | 相关记忆上限（联想可额外一条） |
| `detailsItems` | `6` | 优先展开细节的条数 |
| `detailsTokens` | `2000` | 单条细节容量 |
| `candidates` | `40` | 合并的候选数量 |
| `queryDirections` | `3` | 最多查询方向数 |
| `baseHalfLifeDays` | `30` | 长期记忆强度基础半衰期（天） |
| `importanceMultiplier` | `2` | 重要性延长半衰期的倍率 |
| `reinforcementGain` | `0.2` | 真正重温后补回的强度比例 |
| `activationHalfLifeMinutes` | `30` | 短期激活半衰期（分钟） |
| `activationTtlHours` | `3` | 短期激活最长存在时间（小时） |
| `associationProbability` | `0.2` | 每轮一次自然联想的概率 |
| `associationCooldown` | `8` | 同一联想的冷却回合数 |
| `pollSeconds` | `300` | 记忆文件后台检查间隔（秒） |
| `embeddingUpdate` | `"daily"` | daily 睡眠时维护；debounced 文件稳定后维护 |
| `sleepCron` | `"0 3 * * *"` | 每日回顾与维护时间，按 scheduler.timezone |
| `reviewEnabled` | `true` | 按时向主 agent 提交记忆整理机会 |
| `reviewBatchTokens` | `12000` | Skill 每批建议阅读容量 |
| `maxReviewItems` | `8` | Skill 每批建议新增条数 |
| `chunkTokens` | `800` | 记忆向量分片容量 |
| `chunkOverlap` | `80` | 分片重叠容量 |
| `rankWeights` | `{"base":0.5,"strength":0.15,"importance":0.15,"familiarity":0.05,"emotion":0.05,"activation":0.1}` | 相关性之外的强度、重要性、熟悉、情绪与激活权重 |

## state

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 整轮结束后后台更新心情 |
| `emotionLabels` | `["愉快","安心","好奇","担忧","失落","烦躁"]` | 允许更新的短期情绪维度 |
| `eventSensitivity` | `1` | 情绪变化敏感度 |
| `surpriseMax` | `1.5` | 提示词中的意外事件最大放大参考 |
| `repeatedStimulusMultiplier` | `0.5` | 提示词中的重复刺激减弱参考 |
| `reportChars` | `120` | 当前情绪原因的字数限制 |
| `thoughtContextItems` | `1` | 每轮呈现的念头数 |
| `thoughtContextProbability` | `1` | 旧念头进入本轮上下文的概率（0～1） |
| `focusContextProbability` | `1` | 关注点进入本轮上下文的概率（0～1） |
| `thoughtContextTokens` | `300` | 单条念头容量 |
| `thoughtHalfLifeHours` | `6` | 念头优先级衰减半衰期（小时） |
| `focusMax` | `2` | 当前关注点数量 |
| `focusTtlHours` | `24` | 未更新关注点的退出时间（小时） |
| `baseline` | `70` | 整体心情的常态值（0–100） |
| `moodHalfLifeHours` | `12` | 整体心情回稳半衰期（小时） |
| `emotionHalfLifeMinutes` | `90` | 短期情绪回零半衰期（分钟） |
| `moodDeltaLimit` | `3` | 每轮整体心情增减上限 |
| `dimensionDeltaLimit` | `5` | 每轮单维情绪或驱动力增减上限 |
| `inputTokens` | `6000` | 后台心情判断的本轮材料与最近交流总容量 |
| `timeoutMs` | `10000` | 后台心情 API 超时（毫秒） |
| `thoughtsMax` | `3` | 当前最多保留的念头数 |
| `thoughtTtlHours` | `24` | 念头最长保留时间（小时） |
| `gap` | `true` | 把距离上次提交文字回复的间隔交给第三层 |

## style

| 字段 | 默认 | 作用 |
|---|---|---|
| `casualParts` | `3` | 闲聊段数软上限 |
| `emotionExpression` | `0.35` | 情绪外显倾向 |
| `restraint` | `0.6` | 有感受但暂时放下的倾向 |
| `catchphraseCooldown` | `5` | 提示避免重复口头禅的回合数 |
| `memoryMentions` | `1` | 闲聊主动提旧事的软上限 |
| `repeatMemoryCooldown` | `8` | 提示避免重复旧事的回合数 |
| `allowShortAck` | `true` | 允许一句很短的附和 |
| `casualChars` | `150` | 闲聊字数软目标 |
| `casualSentences` | `3` | 闲聊句数软目标 |
| `warmth` | `0.6` | 亲和倾向 |
| `humor` | `0.3` | 幽默倾向 |
| `directness` | `0.7` | 直接表达倾向 |

## runtime

| 字段 | 默认 | 作用 |
|---|---|---|
| `mcpConnectTimeoutMs` | `30000` | MCP 建连等待上限（毫秒） |
| `shellMaxTimeoutMs` | `1800000` | Shell 可申请的最长执行时间（毫秒） |
| `backend` | `"pi"` | 执行器标识；当前是 Pi 适配器 |
| `maxRounds` | `50` | 一次工作最多调用主模型的轮数 |
| `timeoutMs` | `300000` | 单次主模型请求最长等待（毫秒） |
| `runTimeoutMs` | `3600000` | 整个工作回合最长时间（毫秒） |
| `toolTimeoutMs` | `120000` | 普通工具默认超时（毫秒） |
| `toolsEnabled` | `true` | 基础工具总开关 |
| `skillsEnabled` | `true` | 把 Skills 目录加入能力说明 |
| `mcpEnabled` | `true` | 连接配置的 MCP 服务 |
| `webEnabled` | `true` | 网页读取与搜索工具 |
| `cancelGraceMs` | `5000` | 重启调度脚本时的终止宽限（毫秒）；Pi Shell 按其自身取消策略 |
| `maxToolChars` | `16000` | 本轮交给模型的单条工具结果字符上限，完整记录保留 |

## delivery

| 字段 | 默认 | 作用 |
|---|---|---|
| `typing` | `true` | 工具执行和发送时展示正在输入 |
| `initialDelayMs` | `0` | 发送每段前延迟（毫秒） |
| `partIntervalMs` | `0` | 消息部分之间的间隔（毫秒） |
| `split` | `"platform"` | 按平台长度、段落或句子拆分 |
| `attempts` | `3` | 确定失败时最多发送尝试次数 |

## scheduler

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 运行可编辑定时脚本 |
| `script` | `"schedule.ts"` | 定时脚本路径 |
| `timezone` | `"Asia/Shanghai"` | 定时表达式与主动时间段使用的时区 |
| `randomChat` | `true` | 随机摸鱼与聊天机会 |
| `leisureDailyLimit` | `5` | 每天随机机会总上限（0为不限） |
| `moyuWeight` | `65` | 摸鱼机会权重 |
| `chatWeight` | `20` | 纯聊天机会权重 |
| `quietWeight` | `15` | 安静机会权重 |
| `randomMinMinutes` | `60` | 随机等待下限（分钟） |
| `randomMaxMinutes` | `180` | 随机等待上限（分钟） |
| `activeStart` | `8` | 主动聊天开始小时 |
| `activeEnd` | `22` | 主动聊天结束小时 |
| `dreamCron` | `"0 4 * * 0"` | 梦境机会 cron 表达式 |
| `dreamEnabled` | `true` | 低频梦境联想机会 |

## prompts

| 字段 | 默认 | 作用 |
|---|---|---|

## drives

| 字段 | 默认 | 作用 |
|---|---|---|
| `curiosity` | `{"enabled":true,"baseline":55,"halfLifeHours":6,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `social` | `{"enabled":true,"baseline":40,"halfLifeHours":6,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `responsibility` | `{"enabled":true,"baseline":50,"halfLifeHours":12,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `introspection` | `{"enabled":true,"baseline":30,"halfLifeHours":12,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `missing` | `{"enabled":true,"baseline":20,"halfLifeHours":12,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `closeness` | `{"enabled":true,"baseline":20,"halfLifeHours":12,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `fatigue` | `{"enabled":true,"baseline":10,"halfLifeHours":3,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `stress` | `{"enabled":true,"baseline":10,"halfLifeHours":6,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |
| `joy` | `{"enabled":true,"baseline":60,"halfLifeHours":6,"sensitivity":1,"min":0,"max":100}` | 维度开关、基线、回稳半衰期、敏感度与上下界 |

## 模型、渠道和 agent

模型包含 name、baseUrl、apiKeyEnv、contextWindow、maxOutput、reasoning、compat。main、fast、summary 是三个独立模型配置，summary 思考默认 off；query/maintenance/emotion/rerank 可部分覆盖 fast；主模型和向量分别配置。compat 透传 Pi OpenAI 适配选项。

agents[]：id、name、enabled、defaultTarget、targets（发送别名）、routes（接收位置）、skills（额外技能路径）、main（主模型覆盖）、overrides。overrides 支持 models/history/context/memory/state/style/runtime/delivery/prompts/drives/scheduler/mcp；对象逐字段合并、数组整体替换；同一轮保持配置快照。

channels[]：id、type（telegram/webhook）、enabled、tokenEnv、url、secretEnv、allowedChats、maxFileBytes。Telegram 文件默认20 MiB；Webhook入站上限20 MiB。

mcp[]：name、enabled、command/args 或 url（二选一）、env、headersEnv。HTTP headersEnv 的变量值是 JSON 请求头。

## Prompt 覆盖

prompts 可设置 system / summary / query / feelingQuery / searchDescription / rerank / emotion / spark / stateExpression，值为完整提示词。system 默认读取当前 agent 的 prompts/system.md；其余先读个人 prompts/auxiliary.yaml，再回退内置默认。状态和表达参数自动渲染，主模型不需要额外调用情绪记录工具。

## 路径与生效

dataDir 默认 data；agentsDir 默认 agents，均相对项目根目录。memory.json 只由 Skill 或明确编辑写入，程序派生检索信息位于 .runtime/search-index.json。persona、Skills、system prompt 的文件修改下一轮读取。调度脚本需显式重启。
