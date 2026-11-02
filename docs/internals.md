# Hineni 内部流程与维护说明

[完整手册](manual.md) · [配置操作](configuration-guide.md) · [参数默认值](config.md) · [外部协议](protocol.md)

本文解释当前代码的算法、文件责任和调用顺序。每节给出代码入口，供人和 AI 定位。没有写成已实现的功能，不应仅凭设计文档推断存在。

管理 API 与新版界面见[工作台说明](console.md)。main.ts 现在通过 application.ts 创建和重启组件；以下四层运行流程保持不变。

配置磁盘布局见 [Agent 独立配置](agent-layout.md)，内存仍使用合并后的 Config，不改变四层事件协议。

## 启动、配置和运行组件

入口：[main.ts](../src/main.ts)、[init.ts](../src/init.ts)、[schema.ts](../src/config/schema.ts)。

1. 以 HINENI_ROOT 或当前工作目录作为根目录。initialize 读取/校验 config.yaml；缺少时生成初始配置，已有无效配置会直接报错。
2. 缺少 .env 时生成管理令牌和空密钥字段。为配置中每个 agent 创建目录和初始文件。现有人格、记忆、SYSTEM.md 不覆盖；基础 Skills 以不覆盖已有文件的方式复制。
3. 加载 .env，创建 ConfigStore、SQLite Store、Journal、Scheduler、Runtime 和两个 Fastify 服务。`init` 子命令到初始化为止，不启动服务。
4. 从附件清单恢复附件索引；从 JSONL 补入数据库缺失事件。旧事件标记已处理，旧 running 标记 cancelled，旧 sending 标记 uncertain。
5. 创建各 agent 的 MemoryService；连接渠道；启动发送轮询 200ms、触发轮询 history.pollMs、维护检查 memory.pollSeconds。
6. 监听 API/admin 端口，启动调度脚本子进程。启动失败会关闭已经打开的组件。

Runtime 保存启动时配置快照。管理页 PUT config 先校验、比较 revision、原子写盘并更新 ConfigStore，但不改变已创建 Runtime，所以显示需要重启。agentConfig 对允许范围深合并；agent.main 最后覆盖主模型。磁盘中每个 agent 独立存顶层配置，overrides 仅是内存/API 表达。模型与工具环境显式传入，不把私有 .env 写进 process.env。

SIGINT/SIGTERM：停调度 → 请求取消各 agent → 等待执行收尾 → 停发送和渠道 → 等后台更新及维护结束 → 关 HTTP 和数据库。不是瞬间强杀；已经发生的外部动作不会回滚。

## 四层之间的对象与编号

定义：[contracts/index.ts](../src/contracts/index.ts)。

| 对象/编号       | 意义与边界                                                         |
| --------------- | ------------------------------------------------------------------ |
| EventInput      | 自有事件，第一层/脚本/第四层写入第二层；无 Pi 类型                 |
| Event           | EventInput 加数据库 seq、received_at、claimed                      |
| Target          | channel + conversation + 可选 thread/kind；标识消息位置            |
| ContextBundle   | 第三层输出：system、messages、候选 memories、target、inputText     |
| RunRequest      | agentId、runId、context、AbortSignal                               |
| RunResult       | reason、产生的文字、用过的工具、记忆候选编号和可选 error           |
| Delivery        | 出站动作、目标、parts、各级编号；第二层队列交给第一层              |
| event_id        | 同一 agent 内幂等键；重复提交返回旧事件，不替换内容                |
| seq             | SQLite 插入顺序；当前库内全局递增，不是平台时间，也不在原 JSONL 中 |
| run_id          | 一次完整执行，包含多次模型请求与工具调用                           |
| response_id     | 一条 assistant 消息；工具主动发消息有自己的 response_id            |
| chunk_index     | 一条 response 的文字块编号；第一层还可以把块拆成 parts             |
| call_id         | 工具调用与结果配对                                                 |
| parent_event_id | 附件 ready/failed 关联最初消息                                     |

完整字段、入站示例、HTTP 地址见[协议](protocol.md)。JSONL 按 agent 分文件，SQLite seq 不是可在丢库重建后继续使用的永久编号；外部关联优先使用 event_id/run_id。

## 第一层接入、附件与路由

代码：[channels.ts](../src/layer1/channels.ts)、[server.ts](../src/admin/server.ts)。

### Telegram 文字

当前使用 grammY 长轮询，只订阅 message，不处理 edited_message、按钮回调、语音转写或消息删除同步。收到消息先检查 channel.allowedChats，再找到 defaultTarget 或 routes 匹配聊天位置的已启用 agent；每个匹配者得到独立事件。消息事件 ID 由渠道、Telegram update ID 和 agent ID 构成。

事件包含平台时间、用户 ID/姓名、平台消息 ID、被回复消息 ID、正文、Target 和附件引用。Telegram 对象只在第一层解释。第二层检查 agent/渠道/附件引用合法性后追加；不会再主动轮询 Telegram。

defaultTarget 同时是接收路由和内部触发默认目标；targets 只供模型选择出站别名。Webhook 入站由提交者明确给 agent_id，不走 Telegram 路由筛选。

### Telegram 图片与文件

当前识别 message.photo 的最大版本，或一个 document；媒体组按各条消息处理，没有专门相册合并。

1. 先分配稳定附件 ID/路径，在 SQLite 和旁边 JSON 清单保存 pending。
2. 原消息带附件引用进入第二层；它可以先触发推理。
3. 异步下载到 `.partial`，过程中累计大小检查；成功原子改名为稳定文件并标 ready，失败标 failed。
4. 再提交 attachment_ready/attachment_failed，继承原 sender/target/platform ID，关联 parent_event_id。下一次轮询会看到新的触发，可能打断尚在处理的旧轮。

下载超时当前为 120 秒；入站附件默认上限 20 MiB。主模型视觉只注入本轮触发引用中 ready、png/jpeg/webp/gif、大小不超过 10 MiB 的图片；相同 ID 本轮去重。历史里的旧图片只有记录与路径，不会自动每轮重传像素。其他文件由工具读取处理。

HTTP 上传是先 POST base64 到 attachments 接口，得到 ready 引用，再 POST 事件。上传本身不触发推理；HTTP 大小上限目前固定 20 MiB。

### Webhook 与本地入口

外部 POST /v1/events 使用统一协议，只允许 incoming_message/internal_event。API 会校验 agent、目标渠道和附件引用，但 source 字符串不是另一次渠道认证；持有管理令牌的调用者能够指定 agent。

Webhook channel 有 url 时用于出站 POST；没 url 时是本地收件箱，投递返回本地 message_id。当前网页试聊硬编码 local/owner；删除 local 渠道后这个试聊入口需要相应修改。

## 第二层记录、触发与打断

代码：[runtime.ts](../src/layer2/runtime.ts)、[store.ts](../src/layer2/store.ts)、[journal.ts](../src/layer2/journal.ts)。

### 记录如何落盘

Store.append 先按 agent_id + event_id 去重，再 Journal.append，最后写 SQLite 索引。JSONL 每次写入后 fsync，可立即读取；不是数据库定时导出。received_at 是本地接收时间，occurred_at 保留来源时间。

日期文件名按 UTC。异常退出造成尾部半行时，下次追加会把半行单独保存在 `.torn-时间` 文件后截去损坏尾部；历史中间损坏行在重建时会报错，不静默忽略。

SQLite 表：events 保存索引与 claimed，runs 保存运行状态，deliveries 保存发送进度，attachments 保存清单，kv 保存摘要检查点/检索缓存/心情去重等，logs 保存程序诊断。日志会替换已知环境变量名含 KEY/TOKEN/SECRET/PASSWORD 的长值，但模型可主动读取的文件和原始工具结果不是通用脱敏系统。

### 一轮如何开始

每次 tick 对每个已启用 agent 找 claimed=0 的四类触发：incoming_message、internal_event、attachment_ready、attachment_failed。同批按 seq 排序，合并接手，不人为增加“连续输入等待窗口”。

若该 agent 没在执行：事务标记这批已接手，建立 run，构建第三层上下文，再启动第四层。默认回复位置取这批最后一条 reply_target，没有则用 defaultTarget。多个 agent 可并行，但单个 agent 同时只有一个活动 run。

若还在执行：向当前 AbortController 发取消；等它真正结束并释放 active 后，再从尚未接手事件启动新轮。它不是一到新消息就同时开第二个工具进程。进入新轮时旧工作已记录的工具和文字仍在历史里。

第二层只保证记录与调度，不保证模型一定正确续接所有未完任务。被接手的事件不会因为 run 失败自动重新执行；用户或脚本可以发新事件要求继续。

### 哪些输出不触发推理

tool_call、tool_result、agent_reply、outbound_action、delivery_result、run_finished 只记录。来自平台的已知本 agent 消息回声会按已保存的平台消息 ID/渠道/会话识别为 delivery_result。其他 agent 的群消息则属于新的明确输入，见发送流程。

### 交流间隔

Store.gap 按当前 Target 的 channel/conversation/thread 找最近一条有文字的 agent_reply，返回 last_response_id、last_response_at、as_of 和 seconds_since_last_response。没有历史回复时为 null。

时间从第二层接到最后一个文字块起算，不从第四层完成、Telegram 送达或已读起算。response_id 被保留，但当前算法并不先把一个 response 的全部句块合并后另算开始时间。第三层接收这个结果写入 state.conversation_context，不向第一层查询。

## 第二层历史压缩

代码：[history.ts](../src/layer2/history.ts)、[models.ts](../src/shared/models.ts)。

历史视图是“累计旧摘要 + 检查点之后的事件原文”。渲染每条事件时带时间、类型、来源、发言人、消息编号、目标、正文和附件清单；工具结果正文只带末尾 toolTailTokens。delivery_result/run_finished 不进入自动历史视图，仍可主动查询原始记录。

当视图超过 triggerTokens：从最新往前保留原文，目标近期原文约 `targetTokens - summaryTokens`；较早部分连同旧摘要分批交给 main，总结为不超过 summaryTokens 的摘要。每批上限最多 100k，并考虑主模型预算。摘要与 through_seq 保存在 SQLite kv 的 history:<agent>。

摘要默认提示词：

> 压缩较早聊天经历以便继续交流。保留重要事件、用户修正、未完成事项、工具已取得结果及不确定性。合并旧摘要，不虚构完成情况。只输出摘要。

模型返回空摘要或因长度截断时，压缩失败，不推进检查点；这轮会进入错误处理。超大单事件和真实请求开销可能让目标值不能精确命中。极限容量检查可传 forcedTarget 强制更小历史；原 JSONL 始终保留。

当前不是“24 小时原文加昨日摘要”，也没有按自然日清空原文。日期只用于存档，压缩按容量发生。

## 第三层长期记忆与索引

代码：[memory.ts](../src/layer3/memory.ts)。

### 读取和派生索引

memory.json 为 `{memory:[条目...]}`。基础字段和示例见配置指南；额外字段保留，缺 ID 时程序补写。重复 ID 或格式错误写 warn，并在当前进程沿用上一份有效视图。

每次 sync(false) 比较条目完整 JSON 的 SHA256 和向量模型签名（baseUrl + name）。删除条目会移除索引；条目或模型变化会清空派生描述/向量，保留已有 strength、strengthAt、familiarity。词法正文是 summary + details + people。

sync(true) 在此基础上，对还没有向量的条目调用 maintenance 模型生成 description，再将 description + 原正文按 chunkTokens 切片、chunkOverlap 重叠，调用 embedding。逐条处理，向量每批最多 20 个片段；maintenanceBatchItems 是遍历分批，不是每次只处理这些条就停止，也不是并行度。

网络请求在索引写锁之外完成；写回时再检查原条目 hash 和模型签名，避免旧结果覆盖新记忆。单条失败记录后继续其他条。索引保存在 SQLite kv 和 `.runtime/search-index.json`，读取优先 SQLite 缓存；手改索引文件不保证覆盖当前缓存。

description 是辅助描述，当前向量文本仍包含原 summary/details/people；不是只向量化关键词。searchDescription 关闭后已存在向量不会立刻重建。改变分片/描述策略也没有纳入现有模型签名自动失效逻辑，不能假设保存参数后所有旧索引自动重算。

### 自动召回的步骤

1. memory.enabled=false 或没有记忆时直接返回空列表。
2. 从最近 queryRecentMessages 条 incoming/internal/agent_reply 构造查询材料，截到 queryInputTokens。query 开启时快模型生成 queries；原材料加这些线索拼为同一查询，按完整输入缓存 queryCacheSeconds。
3. search 先 sync(false)，然后向量化查询前 1000 token。向量 API 失败或超时用空向量继续词法检索。向量与后面的重排共用 recallTimeoutMs。
4. 对每条记忆算词法、语义、强度、重要性、激活、熟悉度和情绪关联；词法命中或语义超过阈值的才入候选。
5. 融合排名，取 candidates；rerank 开启且候选多于一个时让快模型排列候选 ID，仅给予有限加权，不完全替代原分数。
6. 贪心选择，每选一条，按摘要重叠降低其他相似条目的分数。
7. 以第一条召回为锚，补 temporalWindowHours 内最多 temporalNeighbors 条时间邻居，替换靠后的主召回位置。
8. 按 associationProbability 尝试追加一条联想：与锚点有相同 people 或事件时间相差小于 24 小时，且未处于该条联想冷却中。摘要加“突然联想”，详情清空。
9. 每条摘要截到 summaryTokens，前 detailsItems 条保留最多 detailsTokens 详情，按 memoryTokens 预算放入；放不下的条目跳过。
10. 自动召回写入短期激活；已存在激活时间通常不刷新，避免仅“被背景带入”就永久强化。

### 排名公式

下面是实现公式，不是对真实人脑的科学断言。

| 符号 | 计算                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| lex  | 查询字词集合与正文集合交集 / 查询集合大小；英文词、汉字及简单双字片段                        |
| sem  | 查询向量与记忆各片段向量的最大余弦相似度，最低取 0                                           |
| I    | `(importance - 1) / 4`                                                                       |
| H    | `baseHalfLifeDays × (1 + importanceMultiplier × I)`                                          |
| A    | `strength × 2^(-距 strengthAt 的天数/H)`，限制到 0–1                                         |
| B    | `2^(-距激活时间的分钟数/activationHalfLifeMinutes)`，没有激活为 0                            |
| F    | `1 - exp(-familiarity/5)`                                                                    |
| E    | 记忆情绪文字中匹配当前情绪的最大强度/100，再乘按 occurred_at 计算的 emotionHalfLifeDays 衰减 |
| RRF  | `1/(rrfK+词法名次) + 1/(rrfK+语义名次)`，名次从 1 开始                                       |

基础分数是 RRF 乘 `(w.base + w.strength×A + w.importance×I + w.activation×B + w.familiarity×F + w.emotion×E)`。

重排最多将指定条目乘约 1.25；多样性处理按摘要集合 Jaccard 重叠乘 `1 - diversityPenalty×overlap`。当前无语义向量时仍保留一个全零语义排序分量；不是一套复杂的缺失信号自适应融合。

遗忘影响强度权重，不删除条目；新旧发生时间没有统一独立 recency 权重。老事件新导入时 strengthAt 从建立索引开始，不能理解成已按发生以来的全部时间遗忘。

### 主动查询与自动召回的区别

memory_search 和管理 API 的 memory/search 走 explicit=true：仍用词法/向量、候选和加权，但将长期强度 A 置为 1，跳过快模型重排、查询扩展、时间邻居和自然联想。它是帮助查旧事的入口，不保证能遍历无限条结果；candidates 仍限制候选数。

memory_search 按页返回 id/time/summary，offset 是条目偏移。memory_read 按 token 容量截取条目 JSON 字符串，offset 是字符偏移，用 hash version 检查条目是否变化。调用过的记忆 ID 加入本轮候选，之后才由 afterRun 判断是否真正重温。

## 第三层状态与回合后更新

state.json 只保存当前快照：updated_at、mood、emotions、drives、cause、thoughts、focus、focus_updated_at、activation、可选 conversation_context。没有独立的状态历史文件，但原始对话、工具和 run 记录仍在。

### 自然回稳

读取 state 时按距 updated_at 的时间补算：

- mood 向 state.baseline 指数回归，半衰期 moodHalfLifeHours。
- emotions 向 0 衰减，半衰期 emotionHalfLifeMinutes。
- 每个启用 drive 向自身 baseline 回归，半衰期自身 halfLifeHours；关闭维度会移除。
- 念头超过 thoughtTtlHours 清理，并按基于时间的衰减值排序；当前每条念头没有独立初始权重，所以这主要等价于新念头靠前。
- focus 超过 focusTtlHours 清空；activation 超过 activationTtlHours 清理。

state() 返回补算后的对象，updateState 才通过串行链原子保存。上下文构建、回合后和后台维护会用 updateState；单纯 GET state 的补算结果不一定立即落盘。

### 什么时机调用心情模型

Runtime 在第四层已启动并结束，且有产生文字、用过工具或选择 silent 时，排入该 agent 的后台 moodChain。上下文构建前就失败、或空输出且无工具的取消，不会调用。它不依赖第二层发送成功；新轮可以在旧轮心情后台处理期间开始，因此可能暂时读到旧状态。

输入是本轮触发文本、RunResult、工具结果尾部摘录、候选记忆摘要、当前状态和人格。候选是自动召回及工具查到的记忆，并不是整份 memory.json。工具通过 send_message 发出的文本未必出现在 RunResult.text，因此后台材料不是完整平台对话重放。

默认要求快模型返回 mood/emotions/drives 增量、cause、thoughts、focus、memory_mentions。程序乘敏感度并限幅，忽略未配置的情绪和驱动力名称；thoughts/focus 数组替换当前列表。心情变化允许为零。API 失败记录 warn，保留已有状态。

真正重温的候选由 memory_mentions 指定，逐条：先算当前衰减强度 A，再设 `strength = A + reinforcementGain × (1-A)`，更新 strengthAt，familiarity 加一，刷新激活时间。moodDone:<run> 用来避免正常重复处理。状态与索引/去重标记不是一个跨文件事务，进程在其中崩溃仍可能留下部分完成状态。

当前 state.enabled=false 会直接跳过整个 afterRun，包括强化。activationEnabled 只约束自动召回的激活写入，afterRun 强化仍会刷新激活；它不是完全清除和禁用激活影响的总开关。这些耦合要在进一步拆分时同步调整代码、配置说明和测试。

## 第三层上下文与提示词

代码：[context.ts](../src/layer3/context.ts)、[默认 system](../prompts/system.md)、[models.ts](../src/shared/models.ts)。

### 实际拼接顺序

1. 第二层历史视图先准备好，必要时压缩。
2. 召回记忆，更新交流间隔到 state。
3. system：基础规则（prompts.system 覆盖或文件）+ persona，合并先截至 4000 token。
4. system 继续添加 Project：agent 根目录、workspace、memory 路径、targets 别名、Skills 名称/简介/路径，最多 5000 token。
5. system 继续添加 Style：日常句数/字数与全部表达偏好，再按 layer3Tokens/stateTokens 预留截取。
6. messages 第一条 user 是带标签的历史经历文本。各事件在文本内标来源、类型和时间；不会把全部历史逐条还原成模型 assistant/tool 角色。
7. 第二条 user 是召回记忆 JSON、当前状态 JSON 和“处理最新触发事件”提示。状态按 stateTokens 截取，整体背景受 layer3Tokens 减 system 的余量限制。
8. 本轮 ready 图片额外作为 user 多模态消息加入。ContextBundle 另传 inputText、target 和 memoryIds 供执行器/后台使用。

内部事件在历史文本标“内部事件，并非用户发言”，实际消息包装仍为 user，不伪造模型已经说过一句话。系统人格由我们提供；没有叠加 Pi 自己的编程工作人格。

Token 截取是字符串裁切，动态 JSON 被截后未必是有效 JSON；它在这里作为模型参考文本，不是再次被程序解析。基础 prompt/人格过长也可能被截，调整文件时要查看 trace。

### 预算保护

初始容量阈值 = main.contextWindow - main.maxOutput - context.safetyTokens。system + history + dynamic 超过后，才向第二层请求 forcedTarget 压缩；仍过大报错。本轮图像额外按每图 4096 token 预留。不是第三层每次召回变长就让第二层重压缩。

context.trace=true 时写 `.runtime/traces/<run_id>.json`，包含初始 system、messages 和候选 memoryIds，图片内容用类型/大小替代。它保存初始编排；逐次主请求上下文另外保存在 .runtime/requests/<run_id>/<序号>.json，管理页可查看。图片像素仍省略，辅助 API 未逐次抓包。

### 辅助 Prompt 默认内容

| 用途              | 默认规则与返回格式                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| query             | 根据当前消息和近文生成最多三条查找旧事的查询，保留未知，不编造；`{"queries":["…"]}`                                    |
| searchDescription | 根据原记忆生成简短检索句，保留人物、事件和可能唤起的表达，不编造；`{"search_text":"…"}`                                |
| rerank            | 按直接相关性排列已有记忆编号，不增添编号；`{"ids":["…"]}`                                                              |
| emotion           | 判断本轮实际经历的变化，内部提醒不是用户原话，未完成不算成功，允许零变化，仅背景带入不算重温；返回增量与当前念头等字段 |

对应代码使用 `cfg.prompts.<键> ?? 默认模板`。queryDirections 只截返回数量，默认 query 文字仍写“最多三条”；需要更多方向时还要修改 prompts.query。emotion 的实际完整格式见配置指南。基础 system 的完整原文以 prompts/system.md 为准，不在文档复制两份易过期的人格规则。

## 第四层执行与工具

代码：[pi.ts](../src/layer4/pi.ts)、[tools.ts](../src/layer4/tools.ts)、[mcp.ts](../src/layer4/mcp.ts)、[chunker.ts](../src/layer4/chunker.ts)。

### 一次执行

每次 Executor.run 新建 Agent，systemPrompt 用第三层给定字符串，messages 用第三层给定历史和背景。主模型通过 Pi 的 openai-completions 适配器流式调用，工具执行设置 sequential。这个临时 Agent 在一轮内部保存工具来回，下一轮不复用；“stateless”指跨轮无 Pi 私有长期历史，不是每调一次工具都忘掉本轮。

开始前连接已配置 MCP、汇总工具并检查重名。toolsEnabled=false 时注册表为空。每个工具都收到取消信号和超时；是否迅速停下取决于具体工具是否响应。bash 默认用 toolTimeoutMs，允许 args.timeout 秒申请更长，但不超过 shellMaxTimeoutMs。

每次主模型请求受 runtime.timeoutMs，整轮含上下文构建受 runTimeoutMs。Pi finishTurn 计数达到 maxRounds 或 silent 就结束。返回 complete/silent/cancelled/error/limit；limit 代表限制结束，不表示工作已交付。

### 工具记录

tool_execution_start 立即写 tool_call（工具名/参数）。afterToolCall 将返回值、参数和错误标记写到 history/tools/<run>/<call>.json，再追加 tool_result。若异常路径没有 afterToolCall 记录，tool_execution_end 补写结果事件。

bash 原始输出字节持续追加到相应 .stdout。官方工具本身可能已有截断；JSON 文件保存的是 SDK 返回值，原始 Shell 输出另在 stdout。

同轮返回给模型的每个文本结果最多 maxToolChars 字符，超出时保留前部和完整文件路径。第二层以后自动回顾该结果时使用 toolTailTokens 的尾部片段；这两个限制属于不同阶段，不应混为一谈。

### 流式文字如何变成消息

只接收 assistant text_delta，不把 thinking 或工具参数发给用户。中文句末标点/换行、英文句末后空白可结束一个文字块；代码围栏内暂存，assistant 消息结束时补交剩余文字。单个 delta 可能包含多句话，因此并非严格“一句一个包”。

message_start 分配 response_id；每次 chunk 交第二层就入队，不等待整轮。模型可以先说“我看看”，调工具，再给结果。取消后新 chunk 不再提交，错误/取消的未完成缓冲丢弃；此前已入队继续发送。finish_without_reply 不撤回之前已提交的内容。

### 工具清单与参数

| 工具                                    | 主要参数                                 | 行为                                                                                   |
| --------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| read/write/edit/bash/grep/find/ls       | Pi 官方参数                              | 以 workspace 为工作目录；实际权限是进程账户权限                                        |
| history_search                          | query?、after_seq?、limit?               | 对本 agent 原始事件做大小写无关字符串匹配；返回匹配中的最近 limit 条、保持时间顺序     |
| history_read                            | event_id                                 | 返回本 agent 单条原始事件；长结果可结合 result_file 读完整文件                         |
| memory_search                           | query、offset?、limit?                   | 主动检索并分页，受 toolPageTokens/toolPageItems 和 candidates 限制                     |
| memory_read                             | id、offset?、version?                    | 条目 JSON 按字符偏移读取，按 token 预算截页                                            |
| send_message                            | text、target?                            | target 为发送别名；省略为当前轮来源；返回 queued，不等于送达                           |
| send_attachment                         | path、kind:image/file、caption?、target? | 校验本地文件，复制到稳定附件路径，保存清单再入队；建议绝对路径                         |
| react_to_message                        | message_id、emoji、target?               | 提交表情动作；可再调用沉默结束                                                         |
| finish_without_reply                    | reason?                                  | 标记本轮静默，停止后续正常工具循环                                                     |
| restart_scheduler                       | 无                                       | 停旧调度进程、重新启动脚本                                                             |
| web_read                                | url                                      | HTTP(S) 获取，最多读约 2MB，简单剥离标签、脚本样式，结果最多 80000 字符；不执行网页 JS |
| web_search                              | query                                    | 用主端点 Responses web_search，返回文字和源结果                                        |
| mcp_<服务>_<工具>                       | 服务给定 schema                          | 每轮动态发现工具，支持文本和图像返回                                                   |
| mcp_<服务>_list_resources/read_resource | cursor?/uri                              | MCP 资源接口；二进制资源当前转成文字描述，不自动成为附件                               |

MCP 服务每轮重新建立和关闭，单个服务建连失败导致本轮 error。外部 agent 目前通过 bash 调已安装 CLI，没有专门的 subagent session 管理层。skillsEnabled 只暴露技能目录，不自动执行所有 Skill。

### 工具循环内的紧急压缩

transformContext 在每次请求前估计消息体 token；超过窗口减输出/安全余量时，用我们自己的摘要接口分片压缩工作记录，再保留首条消息并附摘要和本轮请求。

这是应急路径，不是完整大窗口验收结论：当前检查没有把 system、全部工具 schema 和图片真实 token 精确合算，压缩后保留首条消息也可能保留很大的历史；需要进一步的大上下文边界测试。它不会写回第二层累计摘要检查点。

## 反向流程：排队、发送、确认

代码：[outbox.ts](../src/layer2/outbox.ts)、[channels.ts](../src/layer1/channels.ts)。

1. queue 接到 Delivery 后，较长附件 caption 先转为独立文字；文本按 split 再拆，所有渠道目前使用每部分最多 3800 字符的保守限制。
2. 先把包含完整 delivery 的 agent_reply/outbound_action 追加到真实历史，再 enqueue。若其间进程退出，恢复时可以发现有记录而缺少队列状态的动作。
3. 全局单队列每 200ms 取最早 queued/retry；一条的 parts 顺序发送。最早 retry 尚未到时间时会等待，不会跳到后面的新消息。
4. 请求前标 sending，平台成功后推进 part_index，再写 delivery_result。发送确认含平台 message_id。全部部分完成标 sent。
5. 确定失败按 attempts 重试，等待至少 `1000 × 2^attempts` 毫秒或平台 retry_after；超次数标 failed。网络不确定/服务端错误标 uncertain，人工确认后才重新排队。

Telegram 开启 typing 时每 4 秒更新状态，发送完成停止；第一段在实际发送前才显示 typing，不是在模型刚开始思考时。send_attachment 复制稳定文件后再上传，原 workspace 文件之后改变不影响队列中副本。

Webhook 出站 POST 自有协议，带 Idempotency-Key=<delivery.id>:<part_index> 和可选 Bearer。接收方应自行去重；系统不能保证跨网络 exactly-once。发送返回 queued、模型 run complete、delivery sent 是三种不同阶段。

### 同群 agent

因为平台 bot 未必收到其他 bot 消息，程序在确认群投递成功后向同一 group Target 的其他 agent 写 incoming_message，标注 sender.kind=agent。附件复制到接收 agent 自己的目录。这是实际获取信息，不共享对方 memory.json。当前无接话次数上限，可能持续互聊。

## 定时脚本、内部事件与重启

代码：[scheduler.ts](../src/scheduler.ts)、[脚本模板](../scripts/schedule.ts)。

每个启用的 agent 运行自己的 schedule.ts 子进程，cwd 为其根目录。注入自己的环境、HINENI_AGENT_ID、HINENI_ROOT 和公共接口连接令牌。输出日志带 agent 标识；退出后 5 秒重启自己的脚本。restart_scheduler 工具绑定当前 agent，管理接口可指定 agent_id 或省略以重启全部。

默认脚本读取自己的 config.yaml。按 memory.sleepCron 整理，按自己的 dreamCron 与随机间隔触发，时间区间也各自配置。事件仍通过 POST /v1/events 写入第二层，带 agent_id。脚本重启从头计时，不补跑、不记录下次触发时间；主程序重启仍会重启所有脚本。

## 存储恢复、隔离与运维边界

JSONL 补索引发生在每次启动；重建的所有旧触发标已处理。数据库丢失时可以恢复经历和附件清单，但 runs/logs/摘要检查点等不保证恢复；有出站记录而无可靠队列进度的全部标 uncertain，不盲目重发。因为 seq 重建可能变化，Skill 保存的 through_seq 阅读游标也需要检查，必要时按原事件/时间重新建立。

默认无自动历史/trace/日志清理。备份先正常停服务，把 config、.env、agents、data、prompts、scripts、自定义技能和锁文件一起保存；不能只备份 memory.json。路径迁移后更新 SYSTEM.md 和外部工具路径。

应用只做逻辑上的 per-agent 目录/查询隔离，同一进程账户的 bash/read 仍可访问其他允许文件。管理 API 的一个令牌可以管理所有 agent，不是多用户租户权限系统。默认监听本机；部署说明见 operations.md。

## 当前需继续完善的实现边界

这里列的是阅读代码确认的事实，不在本次文档工作中偷偷改变行为：

| 边界                            | 当前影响                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| daily 索引在记忆整理之前        | 新记忆向量可能延迟一天；可以 debounced 或手动维护                                        |
| 做梦固定周触发                  | 尚未实现随机梦、次日主动分享的完整策略                                                   |
| state.enabled 与强化共用        | 关心情也关这部分记忆强化                                                                 |
| activationEnabled 不是总开关    | afterRun 仍可能写激活并参与评分                                                          |
| 共享设施 | 数据库和出站队列共用；参数、模型环境和定时脚本按 agent 区分 |
| 短查询/召回超时                 | 常触发降级时可能只有词法和旧排名                                                         |
| 索引失效键有限                  | 改描述策略/分片配置不自动清空已有向量                                                    |
| prompt 字符串直接截取           | 人格规则或动态 JSON 可能截断；需看 trace                                                 |
| 紧急大上下文保护不精确          | 真实超大请求需独立测试，不能声称一定不会超限                                             |
| 配置表的一些项是软指导          | style、回顾条数、意外/重复刺激政策不是硬算法保证                                         |
| 文件与 DB 非一个事务            | 崩溃恢复采用保守策略，不承诺所有操作状态无损                                             |
| 首次生成的 SYSTEM.md 不自动同步 | 改路径、回顾预算或迁移后，手册可能仍写旧值，要明确更新                                   |
| 管理 UI 边界                    | 新版提供凭据、文件、Skills 和逐次上下文管理；文本安装不自动安装外部依赖；详见 console.md |

## 代码地图与修改规则

| 模块        | 代码入口                                       | 修改时需要连带检查                                       |
| ----------- | ---------------------------------------------- | -------------------------------------------------------- |
| 进程/初始化 | main.ts、init.ts、scheduler.ts                 | operations、默认文件和迁移                               |
| 自有协议    | contracts/index.ts                             | protocol、event.schema、所有适配器和测试                 |
| 配置        | config/schema.ts、help.ts、store.ts            | config.example、config.schema、参数表、UI 帮助、配置指南 |
| 第一层      | layer1/channels.ts                             | 入站归一化、附件事件、send 结果和平台错误                |
| 第二层      | layer2/runtime/store/journal/history/outbox.ts | 事件幂等、打断、恢复、发送序号、原始文件                 |
| 第三层      | layer3/context/memory.ts、shared/models.ts     | Prompt 输入输出、索引签名、预算、fallback、状态公式      |
| 第四层      | layer4/pi/tools/mcp/chunker.ts                 | 不泄漏 Pi 类型到协议、取消、完整记录、输出不重发         |
| 管理页/API  | admin/ui.ts、server.ts                         | 文件允许列表、认证、revision、重启边界                   |
| 默认行为    | prompts/、templates/、scripts/schedule.ts      | 现有 agent 文件不一定自动更新；需明确迁移                |
| 验证        | tests/core.test.ts、tests/fixtures/            | 真实 SDK/本地模拟不等于真实渠道全验收                    |

替换 Executor 通过 Runtime 的 ExecutorFactory 注入，实现 RunRequest/RunResult 和 record/send 回调。新增渠道实现 Channel，同时在 ChannelRegistry 加入接收与归一化；当前不是动态插件安装器，schema 中渠道类型和 backend 也需相应修改。换向量后端可保持 memory.json 与公开 memory 工具稳定，在 MemoryService 内改索引读写。

新增配置必须做到 schema → 默认值/帮助 → 消费代码 → 文档 → 有意义的验证闭环；不能只添一个页面开关。运行 `npm run docs` 会生成 config.example.yaml、两份机器 schema 和 config.md，不生成本文和配置指南；修改后这几份说明也要人工同步。

开发检查顺序：npm run check → npm test → npm run build。27 项自动测试及此前真实 API 检查范围见 validation.md；新增渠道、模型或能力要补对应验证。不要把聊天能回复当成整个系统全部验收完成。

## 管理界面的检查视图

`History.inspect()` 从与执行流程相同的 checkpoint 和事件渲染读取材料，不调用 summarize、不改变检查点。管理接口按运行配置 agentConfig 计算，磁盘已保存但未重启时标记差异。预览文本与 token 估计按 agent 缓存，事件序号、检查点或有效历史配置变化时重建，避免每次网页刷新重复处理长历史。当前间隔通过 Store.gap() 只读计算；初始 trace 新增 layer2 字段，保存最终历史、回复目标、触发 ID、当轮 conversation_context 和压缩 through。逐次模型请求文件保持原规则。

Telegram 收到 message 后，在入站允许列表检查之前更新 `telegram-chats:<channel>` kv，最多 50 个 chat/thread 组合；无匹配 agent 时只保留聊天位置元信息。管理页用它辅助绑定，不抢占 Bot 的 getUpdates。

`src/config/guide.ts` 是网页与 `docs/configuration-reference.md` 的解释来源，`scripts/generate-guide.ts` 从 schema 取默认值。`src/admin/file-guide.ts` 仅分类和解释文件；权限仍由 AdminFiles 校验。改算法/参数时同步解释并运行 npm run docs。

配置说明分为三份展示资料：guide.ts 保留逐项实现约束，learning.ts 用具体例子解释含义与调整结果，processing-guide.ts 解释消费函数、处理顺序、读写位置和下一轮影响。管理 API 与生成文档共用这些资料，不把它们注入 agent prompt。字段与文件的绝对路径由当前 ConfigStore 动态返回。

表达风格文本移到 config/style-prompt.ts 的 buildStylePrompt，ContextBuilder 与管理页预览使用同一个函数；仅提取原逻辑，不改变生成文本或模型行为。操作说明改为默认收起的问号，不更改保存/重启语义。
