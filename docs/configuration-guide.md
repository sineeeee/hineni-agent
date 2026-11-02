# Hineni 配置指南

[返回完整手册](manual.md) · [逐项参数、存储位置与生效](configuration-reference.md) · [内部流程](internals.md)

新版界面操作见[工作台使用与调试](console.md)。

本指南解决“想改变一种行为，具体改哪里”。以下 YAML 都是合并到现有配置的片段，不是让你覆盖整个 config.yaml。示例中的域名、模型名、聊天 ID 或文件路径是占位值，需要替换。未指定的参数保持现状。

文件归属与迁移以 [Agent 独立配置](agent-layout.md) 为准。下方 models/history/memory/state/style/runtime/delivery/scheduler/mcp 等片段写入 `agents/<id>/config.yaml`；server/channels 写入根配置。

## 你现在先看这五项就够了

你的模型密钥和 Telegram 已经接好，不需要重新填写，也不要把下面的示例覆盖到当前配置。初次调体验只看：

| 顺序 | 先确认什么             | 当前位置                                                |
| ---- | ---------------------- | ------------------------------------------------------- |
| 1    | 聊天模型是不是你想用的 | 管理页“模型与密钥” → 主模型                             |
| 2    | 它是谁、怎样和你相处   | 管理页“文件与文档” → 人格与记忆 → persona.md            |
| 3    | 平时说几句话           | 配置 → style → casualSentences / casualChars            |
| 4    | 是否主动联系、什么时段 | 配置 → scheduler → randomChat / activeStart / activeEnd |
| 5    | 什么时候整理记忆       | 配置 → memory → sleepCron                               |

其余参数可以保持当前默认，遇到具体问题再查。下面是完整参考，不是要求你逐项手动填完。

Telegram 的 Chat ID 在 **agents/<id>/config.yaml**，不是 .env：默认位置在 `defaultTarget.conversation`，额外位置在 `routes[m].conversation`。网页“Telegram 接入”直接填写并显示具体字段路径；Bot Token 本身才在主目录 .env。详细操作和存储表见[网页指南](console.md#telegramtoken-和-chat-id-分别存哪里)。

每项表单的展开说明会显示写入文件、完整字段路径、默认值、流程影响、是否需要重启。恢复默认只改草稿；保存并重启后应用。模型列表在“模型与密钥”各槽位直接获取。

## 先弄清四种设置

| 种类           | 位置                                  | 写法与用途                                             |
| -------------- | ------------------------------------- | ------------------------------------------------------ |
| 凭据           | `agents/<id>/.env`（模型）或根 `.env`（连接）                                | `变量名=实际值`，例如 OPENAI_API_KEY；不放在模型名称里 |
| 程序参数       | `agents/<id>/config.yaml` 或管理页“配置”          | 控制模型、路由、预算、开关、定时和算法                 |
| 人格与行为文字 | persona.md、prompts/system.md、Skills | 告诉模型怎么交流、怎么完成某类任务                     |
| 当前数据       | memory.json、state.json、history/     | 这是已经形成的记忆和经历，不是参数表                   |

不要为了修改基础心情去改 state.json：改 state.baseline 会改变今后回稳目标；state.json 记录它此刻的实际状态。修改 baseline 不会立刻把此刻心情重置为该值。

### 管理页怎么保存

1. 打开 `http://127.0.0.1:8788`，填 `.env` 中的 HINENI_TOKEN，点“连接”。
2. 进入“配置”，选择一组。普通值直接填；嵌套对象也有数字、开关与下拉表单，仍保留高级 JSON 编辑。
3. 个人配置的高级 JSON 只显示明确覆盖的字段，不要再包一层组名。例如 scheduler 填 `{ "randomChat": false }`；其余字段继承公共默认。
4. 保留仍需自己设置的字段，删除字段表示恢复继承；整组填 null 表示整组继承。点“保存配置”。校验失败会显示原因，未通过不会保存。
5. 点“保存并重启”后验证，也可先保存、再点顶部“重启服务”。“重启定时脚本”只重启当前 agent 的调度。

在 JSON 中布尔值写 true/false，不加引号，不写注释。YAML 用空格缩进，聊天 ID 建议写成带引号的字符串。页面保存整个配置并检查 revision；提示配置已变化时重新连接读取，避免覆盖另一份修改。

配置组内某些未知字段可能被 schema 丢弃，prompts 的未知名称也可能保存但不被消费。只使用文档列出的字段，不能以“保存成功”推断新字段生效。

### 修改后什么时候生效

| 修改                                    | 生效方式                                           |
| --------------------------------------- | -------------------------------------------------- |
| config.yaml、.env、agent 列表、MCP 配置 | 重启主程序                                         |
| persona.md、prompts/system.md、Skills   | 下一轮读取；已有运行保持原上下文                   |
| memory.json                             | 下次读取/召回先同步词法内容；向量按维护策略更新    |
| agents/<id>/schedule.ts 或个人 scheduler 参数 | 保存后单独重启该 agent 定时脚本                                   |
| src/ 源码                               | 先 npm run build，再重启主程序；npm start 用 dist/ |

外部修改任一配置后，在网页点重新读取；保存会检测磁盘冲突。只改调度参数或脚本可单独重启该 agent 的脚本；模型、记忆等运行设置需要重启主程序。

## 模型、地址和密钥

### 换聊天模型

```yaml
models:
  main:
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
    name: gpt-4.1
    contextWindow: 1047576
    maxOutput: 8192
    reasoning: off
    compat: {}
```

换兼容服务时同时核实 name、baseUrl、apiKeyEnv、真实上下文容量、输出容量以及工具/图片支持。contextWindow 是程序预算声明，填大不会让服务商真的支持更大的上下文。

如果新服务用独立密钥，可以在 `agents/<id>/.env` 增加 `MAIN_MODEL_KEY=实际值`，再让 models.main.apiKeyEnv 写 `MAIN_MODEL_KEY`。apiKeyEnv 填的是变量名，不是 key 本身。程序启动时加载 `.env`；已有进程环境变量通常优先于 dotenv 文件。

### 单独换心情或查询模型

```yaml
models:
  emotion:
    name: gpt-4.1-mini
    maxOutput: 2000
  query:
    name: gpt-4.1-mini
```

query、maintenance、emotion、rerank 会继承 fast，只有写出的字段覆盖。修改 main 不会同时改变 fast 和 embedding。第二层压缩使用 main；记忆整理 Skill 也由主 agent 的 main 执行。

| 模型字段      | 类型/默认规则               | 实际作用                                                   |
| ------------- | --------------------------- | ---------------------------------------------------------- |
| protocol | responses（默认）/ chat-completions | 本槽位的请求协议，保存并重启生效；向量调用忽略 |
| baseUrl       | URL；默认 OpenAI `/v1`      | 请求端点                                                   |
| apiKeyEnv     | 字符串；默认 OPENAI_API_KEY | 读取凭据的变量名                                           |
| name          | 字符串                      | 服务商的精确模型 ID                                        |
| contextWindow | 数值，schema 最少 100000    | 主模型容量预算；不是向量模型输入上限声明                   |
| maxOutput     | 数值，至少 1                | 主调用或快模型输出上限；摘要调用另用 history.summaryTokens |
| reasoning     | off/minimal/low/medium/high | 当前只透传到第四层 Pi 主调用                               |
| compat        | 对象                        | 当前只透传到 Pi 的 OpenAI 适配器；键由所装 Pi 版本定义     |

主模型、辅助模型和历史压缩均支持 Responses / Chat Completions，默认 Responses。旧配置未写 protocol 时也使用 Responses；只支持旧接口的供应商请明确选择 chat-completions。Responses 每次完整传入上下文，store:false，不使用 previous_response_id 或远端会话。辅助调用要求支持 JSON object 输出；向量调用只消费 embedding 的地址、key 和模型名，embedding.maxOutput/contextWindow/reasoning 不控制向量请求。主调用的 reasoning/compat 不会自动套用到摘要、快模型或网页搜索。

网页搜索另外调用主端点的 Responses web_search。服务商只支持 Chat Completions 时，聊天可用而 web_search 仍可能失败。

## 人格、基础提示词和回复篇幅

改 `agents/main/persona.md` 来定义身份、个性、交流偏好。agents[].name 是系统显示名，不会自动替换人格文件中的“你叫某某”。改名字时两处一起看。

`prompts/system.md` 管通用行为：如何理解外部经历、如何面对打断、怎样用工具、何时沉默、什么算完成。`agents/main/SYSTEM.md` 则是环境手册，模型按需读，不会整篇自动插入 system prompt。

例如希望日常更短：

```yaml
style:
  casualSentences: 2
  casualChars: 80
  casualParts: 2
  warmth: 0.6
  humor: 0.2
  directness: 0.7
```

style 全部是提示词倾向。句数、字数、段数不硬裁切；catchphraseCooldown/repeatMemoryCooldown 也只是提示，当前没有专门计数器保证严格冷却。warmth/humor/directness/restraint/emotionExpression 在拼接时按小于 0.34、0.34–0.67、小于阈值之外分别写成“较少、适中、较强”。建议按 0–1 理解，即使某些字段 schema 没有上界。

发送切分与篇幅不同。第四层已经按完整句块输出，delivery.split 只能进一步拆分，不能把多个已提交句块合成一条长消息。

```yaml
delivery:
  typing: true
  initialDelayMs: 500
  partIntervalMs: 300
  split: platform
  attempts: 3
```

initialDelayMs 是 Telegram 每个发送部分前等待；partIntervalMs 是队列每个已发送部分后等待。它们是固定延迟，不是按字数计算的真实打字速度。全局队列串行，调大延迟会拖慢其他 agent 和渠道。

## 历史与上下文容量

当前默认：

```yaml
history:
  triggerTokens: 600000
  targetTokens: 350000
  summaryTokens: 12000
  toolTailTokens: 200
  pollMs: 500
context:
  layer3Tokens: 32000
  memoryTokens: 20000
  stateTokens: 1000
  safetyTokens: 16384
  trace: true
```

历史达到阈值才压缩旧部分，保留近期原文和累计摘要。不是按“今天/昨天”切换，不是每轮压缩，也不是实际每轮一定使用 600k。原始历史永远另存，摘要只影响自动传给模型的内容。

memoryTokens、stateTokens 都包含在 layer3Tokens 里。必须满足 `memoryTokens + stateTokens <= layer3Tokens`；还要给基础提示词、人格和 Skills 目录留空间。`targetTokens < triggerTokens`。建议让 history.triggerTokens + context.layer3Tokens + 主输出预留 + safetyTokens 小于真实模型窗口。

主输出上限与 history.summaryTokens 独立，摘要上限也必须是服务商允许的值。token 使用 o200k_base 估算，图片按每图 4096 预算；这不是服务商准确计费统计，也不是完整请求的精确尺寸保证。

关闭 trace 可减少上下文快照文件积累，但将失去逐轮检查编排内容的入口。当前没有自动清理历史、日志和 trace 的保留期策略。

## 记忆：分别调写入、索引、召回和遗忘

这四件事分开：主 agent 写 memory.json；系统为其生成检索索引；每轮选择相关记忆；时间与重温改变召回权重。

### 写入与维护时间

```yaml
memory:
  reviewEnabled: true
  sleepCron: "0 3 * * *"
  reviewBatchTokens: 12000
  maxReviewItems: 8
  embeddingUpdate: daily
```

03:00 只是默认时间，可改为你希望的睡眠时段。reviewBatchTokens/maxReviewItems/reviewOverlap/noveltyAttention/smallDetailProbability/smallDetailMax 是给主模型的整理提示，不是程序强制限制它写入的条数。

daily：定时脚本先索引已有记忆，再发整理提醒；新写记忆通常要等下一次维护才有向量。需要更快更新时，可以选：

```yaml
memory:
  embeddingUpdate: debounced
  pollSeconds: 300
  debounceSeconds: 120
```

文件静置至少 120 秒后，在下一次约 300 秒间隔的检查中维护；不是准确 120 秒触发。daily 定时任务仍存在。手动调用 `POST /v1/agents/main/memory/reindex` 也可维护；接口同时返回 ready、pending 和 failed，失败写日志；工作台按钮可后台执行并查看进度。

### 召回质量与等待

`queryRecentMessages=8`：取近期用户/内部事件帮助理解本轮输入，不取助手的分句回复。`queryDirections=3`：查询模型最多返回三段线索，当前实现是合成同一查询，替代原材料，而不是三条独立向量查询。

`queryTimeoutMs=8000` 控制查询提炼，`recallTimeoutMs=8000` 是向量查询和重排各自的预算。默认如下，可以按服务速度调整：

```yaml
memory:
  queryTimeoutMs: 8000
  recallTimeoutMs: 8000
```

代价是回复可能变慢。超时退回原查询、词法和已有排名，不代表整轮失败。没有向量的记忆仍能词法检索。当前词法是轻量字词重叠，不是完整 BM25；向量是本地余弦检索，不依赖单独向量库服务。

`candidates` 控制排名候选数，`maxItems` 控制主召回条数，`detailsItems/detailsTokens` 控制带多少详情；memoryTokens 再兜住总量。temporalNeighbors 从第一条召回结果附近补时间邻居。associationProbability 是有召回锚点后再联想的概率，不是对所有记忆均匀随机抽取。

### 遗忘和再次想起

baseHalfLifeDays 越大，强度衰减越慢；importanceMultiplier 让重要记忆更耐久。默认重要性 1 的半衰期 30 天、重要性 5 的半衰期 90 天。遗忘降权，不删除 memory.json 原文。

自动召回会短期激活；afterRun 快模型认为“本轮真正重温”时，reinforcementGain 提升长期强度并增加熟悉度。activationHalfLifeMinutes 控制短期淡去，activationTtlHours 控制清理时间。准确公式见内部流程。

rankWeights 同时控制相关性基础、强度、重要性、熟悉度、情绪关联和短期激活的权重，当前并不要求总和为 1。没有一个独立的“所有事件越近越优先”开关；发生时间主要用于时间邻居和情绪关联衰减，长期强度从索引创建/强化时间开始计。

### memory.json 的格式

```json
{
  "memory": [
    {
      "id": "example-tea-001",
      "type": "event",
      "occurred_at": "2026-11-01T10:00:00+08:00",
      "summary": "对方说晚上喝浓茶容易睡不着",
      "details": "这是示例内容，请换成真实经历。",
      "people": ["用户"],
      "emotion": "关心",
      "importance": 3
    }
  ]
}
```

occurred_at、summary 必填；日期请使用有效 ISO 时间。id 应唯一，缺少时程序生成。importance 为 1–5。details 默认空，people 默认空数组，type 默认 event；agent_name 可选，emotion 可选。额外字段会保留，但默认检索正文只用 summary/details/people；检索描述模型能看到完整条目。不自动建立出处、替代链、recorded_at 或 related_id。

编辑后用原子替换保存。格式错误时当前进程沿用上一份有效记忆，重启后没有旧内存缓存会退为空视图；系统不会因此删除错误文件。不要把索引缓存当成唯一记忆文件。

## 心情、驱动力与交流间隔

```yaml
state:
  enabled: true
  baseline: 70
  moodHalfLifeHours: 12
  emotionHalfLifeMinutes: 90
  moodDeltaLimit: 3
  dimensionDeltaLimit: 5
  eventSensitivity: 1
  gap: true
```

baseline 是整体心情的常态；moodHalfLifeHours 越长，心情越持久。moodDeltaLimit/dimensionDeltaLimit 限制每次变化，不是整体范围，心情与普通情绪最终限制在 0–100。

drives 支持配置任意名称的维度。已有 curiosity/social/responsibility/introspection/missing/closeness/fatigue/stress/joy，分别近似好奇、社交、责任、反省、思念、亲近、疲惫、压力、愉快。

| drives.<名称> 字段 | 作用                                |
| ------------------ | ----------------------------------- |
| enabled            | 是否保留、更新该维度                |
| baseline           | 常态值                              |
| halfLifeHours      | 回归常态的半衰期，至少 0.1 小时     |
| sensitivity        | 快模型建议增量的倍率                |
| min/max            | 数值边界；需要 min ≤ baseline ≤ max |

它们是模型表达背景，不是独立人格 agent，也没有另外一个“欲望规划器”。surpriseMax/repeatedStimulusMultiplier 作为政策传给快模型，不是程序检测到意外/重复后必定乘的系数。

gap 由第二层按当前回复位置最近一次提交的文字块计算，写到 state.conversation_context。不是按 Telegram 是否送达或用户是否读到计算。

关闭 state.enabled 会同时跳过 afterRun 的记忆强化；关闭 memory.enabled 则主要关闭自动召回和全局维护检查，不会自动移除 memory_search 工具或停掉定时脚本的记忆任务。要彻底停用，需要分别检查下面的开关表。

## 定时与主动联系

只想正常聊天、暂时不主动找你：

```yaml
scheduler:
  randomChat: false
  dreamEnabled: false
```

这仍保留每日记忆整理。想停止全部默认调度则设 scheduler.enabled=false，意味着每日整理和 daily 索引也不再由脚本触发，但主程序的后台文件检查仍存在。

```yaml
scheduler:
  timezone: Asia/Shanghai
  activeStart: 9
  activeEnd: 22
  randomMinMinutes: 90
  randomMaxMinutes: 240
  dreamCron: "0 4 * * 0"
memory:
  sleepCron: "0 3 * * *"
```

开始小时包含，结束小时不包含；当前只能表达同一天内 start < end，不能直接写 22–8 的跨夜时段。随机计时到期后检查当前小时，不在时段内就跳过这次并重新抽取。activeStart/End 只限制随机聊天，不限制做梦、每日记忆和外部脚本。

Cron 是“分 时 日 月 周”：`0 3 * * *` 为每天 03:00；`0 4 * * 0` 为每周日 04:00。schema 不验证 cron 语法，错误会导致脚本报错并重启，需查看 scheduler 日志。

脚本可以向统一 `/v1/events` 发 internal_event，格式见协议。脚本宿主启动时会注入 HINENI_API 和现有环境变量。子进程退出后约 5 秒拉起；重启清零随机计时。没有任务完成账本或崩溃后续跑机制。

### 手动触发一次随机招呼

本机当前 `scheduler.randomMinMinutes=20`、`randomMaxMinutes=70`，保留北京时间 08:00–22:00。计时到期若不在此范围就跳过并重新抽取；重启从头计时。招呼文字在 `agents/<id>/schedule.ts` 的 `randomGreeting`（main 使用 `agents/main/schedule.ts`）。

在项目根目录执行：

```sh
node --env-file=.env --import tsx agents/main/schedule.ts --once random_chat --agent main
```

只向 `/v1/events` 提交一条 `internal_event`，使用定时任务同一段文字，然后退出。手动触发绕过时间段和随机聊天开关，不修改后台倒计时；会进入正常打断流程，回复走该 agent 的默认渠道。成功输出表示事件已接收，不保证模型已完成或消息已送达。此命令需要主服务正在运行。

UI：配置 → 主动行为与定时 → 关闭 `randomChat` → 保存并重启，只停止未来的随机招呼，不影响每日记忆整理与做梦，也不撤回已经进第二层的事件。当前 agent 的 `enabled=false` 停止自己的调度脚本。当前没有任意自定义任务的逐项暂停/立即执行列表；多个自定义任务的单独开关需要脚本自己读取配置，主程序不能从任意脚本中自动识别任务。

触发推理统一使用事件协议；`/v1/scheduler/restart`、服务重启和记忆索引维护仍是独立管理接口，不是另一条 agent 对话入口。

## Telegram、其他入口与多个 agent

channels 定义“用哪个账号/桥”，agent 的 defaultTarget/routes 定义“这个 agent 接哪个位置”，targets 定义“模型主动发送时可用哪些别名”。targets 本身不增加接收位置。

根配置的连接部分：

```yaml
channels:
  - id: telegram
    type: telegram
    tokenEnv: TELEGRAM_BOT_TOKEN
    allowedChats: ["123456789"]
agents:
  - id: main
```

`agents/main/config.yaml` 的个人绑定部分（保留该文件其他配置）：

```yaml
id: main
name: Hineni
defaultTarget:
  channel: telegram
  conversation: "123456789"
  kind: private
targets:
  tg_private:
    channel: telegram
    conversation: "123456789"
    kind: private
routes: []
```

数组片段应修改对应项，不要整组替换掉已有 local 渠道、其他 agent 或别名。当前安装的实际聊天 ID 已经填好，无需改成示例值。

| channels[] 字段 | 作用                                                                    |
| --------------- | ----------------------------------------------------------------------- |
| id              | 唯一渠道编号，被 Target.channel 引用                                    |
| type            | telegram 或 webhook                                                     |
| enabled         | 默认 true；是否启动此接入/发送渠道                                      |
| tokenEnv        | Telegram token 变量名，未指定时读取 TELEGRAM_BOT_TOKEN                  |
| allowedChats    | Telegram 入站聊天 ID 白名单，空数组表示不在此处过滤；agent 路由仍需匹配 |
| maxFileBytes    | Telegram 入站附件上限，默认 20 MiB                                      |
| url             | webhook 出站地址；缺省为本地收件箱                                      |
| secretEnv       | webhook 出站 Bearer 密钥变量名                                          |

通用 HTTP 入站走 HINENI_TOKEN 鉴权，携带 agent_id 直接进第二层；不会按 Telegram 的 allowedChats 自动过滤。HTTP 上传上限固定 20 MiB，不随 channel.maxFileBytes 变化。

| 个人配置字段   | 作用                                                            |
| --------------- | --------------------------------------------------------------- |
| id/name/enabled | 稳定编号、显示名、是否参与处理                                  |
| defaultTarget   | 内部触发默认发送位置，也作为 Telegram 接收路由                  |
| routes          | 更多接收位置，可以加入群聊                                      |
| targets         | 给 send_message/send_attachment/react_to_message 使用的目标别名 |
| skills          | 额外 Skill 目录，建议绝对路径；自带 skills/ 始终另行发现        |
| models.main     | 此 agent 的主模型设置                                       |
| models/memory/scheduler 等 | 各组独立设置（API 的 overrides 是合并视图）                                          |

Target 字段：channel、conversation 必填；thread 可指定话题；kind 可设 private/group。配置只验证渠道编号存在，不验证实际账号权限、聊天是否存在或渠道已启用。

用网页新增 agent，保存生成独立配置与空密钥文件，重启补齐人格、记忆、状态、workspace 和 history。共享群聊要让多个 agent 的 routes 都包含同一 group Target；已发送群消息会明确转给参与者。目前没有自动群聊降频。

磁盘中每个 agent 的配置直接使用顶层 models/history/context/memory/state/style/runtime/delivery/prompts/drives/scheduler/mcp。API 为兼容表单保留 overrides 合并视图；保存时拆回各文件。轮询、后台维护、投递参数和定时任务均读取所属 agent 的值。公共队列仍串行发送，连接与数据库仍共用。

## 工具、Skills 和 MCP

| 开关                  | 实际效果与关联                                                               |
| --------------------- | ---------------------------------------------------------------------------- |
| runtime.toolsEnabled  | 关闭后主模型没有注册工具，包含沉默、发送附件、网页和 MCP 工具                |
| runtime.skillsEnabled | 关闭自动 Skills 目录注入；不限制已经知道路径的模型读取文件                   |
| runtime.webEnabled    | 从注册表去掉 web_read/web_search；不限制 bash 联网                           |
| runtime.mcpEnabled    | 不建立 MCP 连接；目前即使 toolsEnabled=false，mcpEnabled=true 仍会先尝试建连 |
| memory.toolsEnabled   | 从注册表去掉 memory_search/memory_read                                       |
| memory.enabled        | 关闭自动记忆召回；不是所有记忆相关行为的总电源                               |
| state.enabled         | 关闭快模型心情判断及该流程中的记忆强化；上下文只保留交流间隔背景             |
| memory.reviewEnabled  | 默认脚本不提交每日整理事件；仍先执行索引维护                                 |
| scheduler.enabled     | 停止当前 agent 的定时脚本                                                         |

这些是编排开关，不是权限隔离开关。文件与终端工具可接触运行账户能访问的文件；多个 agent 在同一账户下也可能显式读取彼此文件。

添加 Skill：把 SKILL.md 和配套脚本放在 `agents/main/skills/名称/`。目录发现最多向下三级；只注入名称、简介、路径，主模型按需 read 全文。脚本通过 bash 调用。Python 包、浏览器、凭据等仍按该 Skill 要求安装，系统不会自动保证任意第三方 Skill 可运行。

MCP stdio 示例：

```yaml
mcp:
  - name: local_tools
    command: node
    args: ["/absolute/path/to/mcp-server.mjs"]
    env: {}
```

MCP HTTP 示例：

```yaml
mcp:
  - name: remote_tools
    url: https://example.com/mcp
    headersEnv: MY_MCP_HEADERS
```

name 只用字母数字、下划线、连字符；enabled 默认 true。command 和 url 必须恰好选一个。args 是命令参数数组，env 是传给子进程的实际环境变量覆盖，不是变量名映射；子进程接收当前 agent 的独立环境。HTTP 的 headersEnv 才是变量名，其值是 JSON 请求头，如 `{"Authorization":"Bearer …"}`。

每轮建立 MCP、列出工具和资源，用完关闭。单个服务建连失败会让本轮失败，不是自动忽略该服务。当前支持工具和资源，不包含完整 MCP prompts/交互授权流程。配好后先用该服务的简单查询验证。

## Prompt 覆盖与输入输出要求

prompts 里设置的是完整文字，不是文件路径；未填则使用默认模板。只有下面这些键会被消费：

| 键                | 模型输入                                     | 输出要求                                                                       |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| system            | 主模型的基础规则，随后还会拼人格与系统背景   | 自然回复或工具调用；默认读取当前 agent 的 prompts/system.md                                 |
| query             | text，最近聊天截取                           | JSON：queries 字符串数组                                                       |
| searchDescription | memory，完整记忆条目                         | JSON：search_text 字符串                                                       |
| rerank            | query、候选 id/summary                       | JSON：ids，只返回已有编号                                                      |
| emotion           | persona、policy、state、input、候选 memories | JSON：mood 增量、emotions/drives 增量、cause、thoughts、focus、memory_mentions |

JSON 包装会附加“Return one JSON object”。请保留字段名，否则可能降级、忽略结果或记日志。emotion 中未返回数组通常保留旧值，返回空 thoughts/focus 则清空；thoughts/focus 是当前列表，不是追加事件。默认完整文字与拼接顺序见[内部流程](internals.md#第三层上下文与提示词)。历史压缩提示词当前写在 shared/models.ts，没有 prompts.summary 覆盖项。

## 顶层字段与校验关系

version 固定 1；dataDir 默认 data；agentsDir 默认 agents；目录相对项目根目录，项目根默认进程工作目录，可用 HINENI_ROOT 指定。不要为了“换名字”修改已有 agent_id 或 agentsDir，它们决定实际数据位置。

server.host 默认 127.0.0.1，port/adminPort 默认 8787/8788 且必须不同；tokenEnv 默认 HINENI_TOKEN，值至少 24 字符。两个端口都有同一组鉴权 API，adminPort 额外提供网页根路径。仅网页壳不要求口令。

其他主要校验：渠道/agent 编号不能重复；Target 必须引用存在渠道；随机最大间隔不小于最小；activeStart < activeEnd，范围在 0–24；chunkOverlap < chunkTokens；驱动力 min ≤ baseline ≤ max；主/快模型输出与安全预留不能耗尽窗口。并非所有数值范围和跨字段关系都被 schema 覆盖，修改后仍需验证实际行为。

## 验证修改和排错

配置完成后走这四步，不要仅看“保存成功”：

1. 重启后重新连接管理页，确认配置是刚保存的值，restart_required=false。
2. 发一条普通消息，看 run 是否 complete、delivery 是否 sent。
3. 针对所改能力做一个小任务，例如“读取刚写的文件并作为附件发来”。用 trace 和工具记录核对实际动作。
4. 观察日志。模型状态 configured=true 只代表 key 存在；语义检索降级仍可正常聊天，但体验不同。

| 现象                | 优先查看                                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| 页面 401            | 管理口令是否是 HINENI_TOKEN，程序是否载入新 .env                                 |
| Telegram 没收到入站 | 渠道状态、token、allowedChats、defaultTarget/routes、群权限、是否另有同 bot 实例 |
| 有 run 但报错       | 执行记录 error；模型权限、地址、JSON 输出支持、MCP 建连                          |
| run 成功但没消息    | 是否主动选择 silent；发送队列的 failed/uncertain 状态                            |
| 发成很多条          | 第四层句块与 delivery.split 的二次切分；style 只控制表达倾向                     |
| 想不起新记忆        | memory.json 是否有效、索引有无向量、maintenance 日志和超时降级                   |
| 心情没变            | 是否有实际输出/工具/沉默结果、state.enabled、mood 日志；模型可以建议零变化       |
| 定时不执行          | scheduler 状态、cron 时区、程序是否在线、脚本是否报错、时段限制                  |
| 修改源码无效        | 是否重新 build，运行的是否还是旧 dist                                            |

开发者可在项目根目录进行只读配置校验：

```sh
node --input-type=module -e 'import fs from "node:fs"; import YAML from "yaml"; import {parseConfig} from "./dist/src/config/schema.js"; parseConfig(YAML.parse(fs.readFileSync("config.yaml","utf8"))); console.log("配置格式通过");'
```

它不联网、不验证账号可用性。运行代码改动后执行 npm run check、npm test、npm run build；涉及真实渠道或模型再做相应实测。备份与 VPS 启动见[运行与迁移](operations.md)。

Telegram 启动连接最多等待约 30 秒；无法连接时渠道标记 failed，工作台和调度仍可启动。此时主动事件仍会被处理，但发往 Telegram 的消息可能无法送达；网络恢复后重启服务重新连接。

接口格式参考 [OpenAI Responses 迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses)。协议只决定请求表达，不改变 Hineni 的四层分工。


召回查询的 queryTimeoutMs 默认 8000；recallTimeoutMs 默认 8000，向量查询和重排分别计时。已有个人配置中的明确值继续优先，需自行保存并重启调整。queryRecentMessages 现在只参考用户输入与内部触发；本轮输入优先，助手分句不占条数。查询模型可返回空 queries 跳过旧事召回。

stateTokens 控制给主模型的可读状态背景，不再把 state.json 整份塞入。activation、内部 ID 和更新时间留在文件供程序计算。casualSentences/casualChars/casualParts/memoryMentions 映射成闲聊软上限，不是每次必须达到的目标。
