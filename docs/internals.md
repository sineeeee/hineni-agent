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

新触发在 ingress 去重落盘后立即向当前 AbortController 发取消，并清理该 agent 在触发目标（无目标用 defaultTarget）尚未交接的旧回复。已知回声和重复事件不清理。若还在执行，等它真正结束并释放 active 后，再由轮询从尚未接手事件启动新轮。它不是一到新消息就同时开第二个工具进程。进入新轮时保留已交接的文字和实际工具记录；被取消的未交接文字不进入新上下文。

第二层只保证记录与调度，不保证模型一定正确续接所有未完任务。被接手的事件不会因为 run 失败自动重新执行；用户或脚本可以发新事件要求继续。

### 哪些输出不触发推理

tool_call、tool_result、agent_reply、outbound_action、delivery_result、run_finished 只记录。来自平台的已知本 agent 消息回声会按已保存的平台消息 ID/渠道/会话识别为 delivery_result。其他 agent 的群消息则属于新的明确输入，见发送流程。

### 交流间隔

Store.gap 按当前 Target 的 channel/conversation/thread 找最近一条有文字的 agent_reply，返回 last_response_id、last_response_at、as_of 和 seconds_since_last_response。没有历史回复时为 null。

时间从第二层接到最后一个文字块起算，不从第四层完成、Telegram 送达或已读起算。response_id 被保留，但当前算法并不先把一个 response 的全部句块合并后另算开始时间。第三层接收这个结果写入 state.conversation_context，不向第一层查询。

## 第二层历史压缩

工作台的删除原始记录独立于压缩摘要。选中删除按 event_id 精确删除；删除一条尚在队列的回复会取消该条发送，并重算同轮 run_finished 的文字副本。清空全部原始记录按 agent_id 删除 events、runs、deliveries、attachments 的对应行与该 agent 的 history 明文；不影响其他 agent。未再被保留事件引用的附件副本也清除。删除意图先记入数据库，明文重写后再提交数据库删除；异常退出后启动时先完成删除，再从明文恢复索引。正在执行或发送的 agent 拒绝此操作。历史修订号使工作台丢弃旧页面缓存。

压缩摘要保存在 `kv.history:<agent>`，删除原文不自动清空。单独清空摘要时也重置 through；之后剩余原文会重新参与历史视图。管理删除保留 `.runtime/requests` 和 `.runtime/traces` 的上下文文件，也不对第四层运行中的上下文做增量修改。现有上下文页面按 runs 表列出文件；清空执行记录后可能不再显示旧文件，但文件仍在磁盘。平台已收到的消息不会撤回。

代码：[history.ts](../src/layer2/history.ts)、[models.ts](../src/shared/models.ts)。

历史视图是“累计旧摘要 + 检查点之后的事件原文”。渲染每条事件时带时间、类型、来源、发言人、消息编号、目标、正文和附件清单；工具结果正文只带末尾 toolTailTokens。delivery_result/run_finished 不进入自动历史视图，仍可主动查询原始记录。

当视图超过 triggerTokens：从最新往前保留原文，目标近期原文约 `targetTokens - summaryTokens`；较早部分连同旧摘要分批交给 main，总结为不超过 summaryTokens 的摘要。每批上限最多 100k，并考虑主模型预算。摘要与 through_seq 保存在 SQLite kv 的 history:<agent>。

摘要默认提示词：

> 压缩较早聊天经历以便继续交流。保留重要事件、用户修正、未完成事项、工具已取得结果及不确定性。合并旧摘要，不虚构完成情况。只输出摘要。

模型返回空摘要或因长度截断时，压缩失败，不推进检查点；这轮会进入错误处理。超大单事件和真实请求开销可能让目标值不能精确命中。极限容量检查可传 forcedTarget 强制更小历史；原 JSONL 始终保留。

当前不是“24 小时原文加昨日摘要”，也没有按自然日清空原文。日期只用于存档，压缩按容量发生。

### 聊天记录的模型视图

原始数据库与 JSONL 保留完整字段；History.modelText / modelRows 单独生成给模型的简洁历史。普通对话按 user / assistant 数组排列，不再把 event、source、空 speaker、投递目标 JSON 等日志头放进正文。首次、跨日或间隔至少一小时才标时间（scheduler.timezone）；首次或聊天位置变化才标渠道位置。群聊保留发言人，引用消息保留引用编号，附件保留名称、类型、状态和路径。内部事件与历史工具仍明确标注，避免误当用户发言。

同一 response_id、run_id、目标的相邻 assistant 片段合并；遇到用户输入、工具或其他事件即停止合并。历史压缩与容量估算使用同一套简洁内容（压缩输入额外带角色），原始记录检查页仍显示完整字段。第三层参考背景统一提供当前时间、时区和默认回复位置，最新触发仍只出现一次。已有压缩摘要不自动重写。

上下文页是 Pi 适配器转换前快照。assistant.content 是模型可见内容；usage、cost、provider、stopReason 等是 SDK 内部字段，不作为正文发送。最终 Responses / Chat Completions 的协议结构由 Pi 转换，不能把快照 JSON 整体当作模型读到的文字。

### 自动触发与历史角色边界

内部事件不重置历史的上一个已知聊天位置。否则每次定时触发后的回复都会被加一次渠道标签，模型可能模仿它。新加入的 assistant 消息时间/位置提示独立放为参考消息，assistant 正文只放回复。旧版本已输出的、与这条回复目标完全相同的开头 `[位置：…]` 行，仅在模型视图去除；数据库/JSONL 不变，正文中间的标签不删。

召回查询中的“此前用户输入”只取 incoming_message。本轮触发仍完整带入，历史中的 internal_event 仍保留身份标记；不会把旧自动招呼作为用户说的话反复带进检索。对应代码 History.modelParts/messages 与 ContextBuilder.build。

Pi 的服务商兼容默认在 layer4/model-compat.ts；DeepSeek 官方端点保持 system 角色，其他供应商和用户显式覆盖保持原行为。不要只看转换前快照判断 wire role；回归测试直接检查 HTTP 请求中的 input 角色和推理参数。

### 压缩模型不能继续旧聊天

OpenAIModels.summarize 把资料包装为 JSON 的 conversation_to_summarize 字段，要求 json_object 输出 {"summary":"…"}，应用只保存其中的非空文本。两种协议都校验字段；空值、格式错误或截断均不推进 History 检查点。格式校验保证结构，摘要语义仍需抽查。

规则读取 cfg.prompts.summary → agents/<id>/prompts/auxiliary.yaml 的 summary → 内置默认。每次压缩重新读取文件，现有个人文件缺该键会使用内置值。默认保留事实、修正、时间范围、未完成任务与实际工具结果；省略旧助手重复客套，猜测不升级为用户事实。摘要仍保存在第二层，不改变长期记忆或原始记录。

### 连续未获回应的输入

ContextBuilder先向History取得本轮输入组：当前批次有真人incoming_message时，从它之前最后一条文字投递成功的delivery_result开始，将之后的真人输入全部作为本轮输入，按原顺序放在记忆、状态之后。成功结果必须能关联到agent_reply的文字part；工具、内部事件、表情、单独附件和失败/未确定投递不截断。纯内部触发不重新提升旧真人消息。原数据库/JSONL不变，不重复在原文历史中放同一输入。

压缩排除这组输入，检查点不越过其中最早的一条，避免后续把它从历史里丢掉；预算另外计入完整输入。已存在摘要可能仍概述较早经历。情绪维护的request仍只含真正新触发的输入，旧未答消息只供主模型理解，不重复计分。保存快照分开记录trigger_ids（新触发）与input_ids（实际输入组）。

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
2. 本轮输入优先，近期 incoming/internal 仅补充指代，截到 queryInputTokens。query 开启时快模型生成 queries，查询句追加到原材料；空数组仍用原材料召回。按完整输入缓存 queryCacheSeconds。
3. search 先 sync(false)，然后向量化查询前 1000 token。向量 API 失败或超时用空向量继续词法检索。向量与后面的重排分别使用 recallTimeoutMs。
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

### 记忆检查与隔离试算

src/admin/memory.ts提供检查与试算接口，src/admin/memory-client.ts提供独立tab。MemoryService.inspectMemories读取真实条目与数据库优先的索引；列表省略向量矩阵，按id读取详情才返回矩阵。stored_index是实际存储，index_current表示其内容hash与向量模型是否仍有效；factors是当前运行参数和时间下计算值，不写回。

memory-ranking.ts集中实现强度、重要性、激活、熟悉、情绪联系及各项贡献，正式检索和检查共用；synchronizeMemoryIndex也共用，试算只在副本里处理失效索引。simulateRecall新建私有MemoryService快照，复用正式recall/search、重排、邻居、联想和预算逻辑；捕获query/embedding/rerank输入输出和检索观察点，不另写一套排名器。预览实例禁止持久化状态、索引和轮数/冷却，不共享真实queryCache。只允许每agent一份同时进行的HTTP试算。

记忆emotion是自由内容；当前情绪由state.emotionLabels约束。现算法用当前情绪名称是否包含在记忆emotion序列化文本中匹配，不做同义词归一或向量情绪匹配。记忆emotion对象中的valence/intensity也不直接参与此项分数；该项强度来自当前state.emotions。匹配项及贡献可在检查页查看，未因此修改现有标签或参数。

## 第三层状态与回合后更新

state.json 只保存当前快照：updated_at、可选 assessed_at（回合评分时间）、mood、emotions、drives、cause、thoughts、focus、focus_updated_at、activation、可选 conversation_context。没有独立的状态历史文件，但原始对话、工具和 run 记录仍在。

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

### 情绪评估的最近交流与人格

第四层整轮结束后更新状态，不等待消息送达。运行开始前固定最近交流快照：从最近 500 条输入/内部事件/回复中，连续输入及后续回复分段算一轮，最多取五轮，保留时间、来源位置与说话者。最多 2000 token，且不超过 state.inputTokens 的三分之一；当前输入、结果与工具使用剩余预算。没有新建状态参数，界面可在现有 state.inputTokens 调总预算，在文件编辑器调整 auxiliary.yaml 的 emotion 规则。
旧交流只帮助理解，不重复计分。自己的道歉不证明用户受惊；猜测保留不确定性，明确拒绝必须尊重。cause 写自己的感受和具体经历，thoughts/focus 允许为空，不从一次误会生成永久禁令。数值、敏感度与回归算法保持不变。
system.md 管日常/工作行为、工具与事实边界，persona.md 管身份关系与个性。日常主动接话，工作及时交代过程并充分交付。个人提示词下一轮读取；历史快照不改写。代码更新需重启应用。

## 第三层上下文与提示词

代码：[context.ts](../src/layer3/context.ts)、[默认 system](../prompts/system.md)、[models.ts](../src/shared/models.ts)。

### 实际拼接顺序

1. 第二层历史视图先准备好，必要时压缩。
2. 召回记忆，更新交流间隔到 state。
3. system：基础规则（prompts.system 覆盖或文件）+ persona，合并先截至 4000 token。
4. system 继续添加 Project：agent 根目录、workspace、memory 路径、targets 别名、Skills 名称/简介/路径，最多 5000 token。
5. system 继续添加 Style：日常句数/字数与全部表达偏好，再按 layer3Tokens/stateTokens 预留截取。
6. messages 先排列较早摘要和剩余历史原文，保留user/assistant角色；连续未答输入从历史移出，统一放在动态背景之后。
7. 历史之后加入一条 system 角色、标注为系统参考资料的本轮召回记忆、角色自身状态和时间背景，再放本轮触发批次，仅出现一次。历史工具保留为标注的参考观察，不伪造缺少配对的原生工具消息。状态按 stateTokens 截取，整体背景仍受 layer3Tokens 预算限制。
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

读取顺序为 `cfg.prompts.<键>` → 个人 `prompts/auxiliary.yaml` → 内置默认。queryDirections 只截返回数量，默认 query 文字仍写“最多三条”；需要更多方向时还要修改 prompts.query。emotion 的实际完整格式见配置指南。基础 system 的完整原文以 prompts/system.md 为准，不在文档复制两份易过期的人格规则。

### 上下文的对话顺序与状态投影（当前实现）

ContextBuilder 仍先调用 History.view 完成必要压缩，随后 History.messages 使用同一摘要检查点组织数组：较早摘要 → 剩余 user/assistant 原文 → 本轮记忆与状态参考背景 → 本轮触发（只出现一次）→ 本轮附件。图片预算导致再次压缩时重建近期消息。layer2.history 快照保存用于压缩与估算的简洁历史文本；完整元数据从原始记录检查。

历史工具调用、结果和内部事件保留必要类型标记，时间与渠道只在边界提示，作为 user 角色的参考材料，不伪造缺少配对的原生工具调用。PiExecutor 为历史 assistant 文本生成 SDK 所需的消息结构，本轮实时工具循环不变。

state-context.ts 只映射可读心情、情绪、驱动力、上轮原因、此前念头/关注和本渠道交流间隔；状态文件仍保留 activation 及内部时间、编号供程序使用。风格数字改为软上限，不要求凑句数或主动讲旧事。

查询优先本轮输入，参考近期用户输入，不再被助手分句占满；生成的查询句追加到原材料，空查询仍用原材料自动召回。查询默认等 8 秒，向量查询与重排分别默认等 8 秒，失败仍回退。不会凭关键词另建闲聊/工作分类器。

手动向量化复用 MemoryService.sync(true)，进度保存在该 agent 的 MemoryService 中；单条错误计数后继续，已有有效向量跳过。API 可选择后台运行，运行关闭时先取消并等待该后台任务结束再关闭数据库。

### 动态背景的身份（当前实现）

ContextBundle.messages 支持 system/user/assistant。第三层生成的动态背景用 system，明确状态属于 agent 自己，引用的记忆文字仅是过去资料，不作为新指令；本轮用户原话单独以 user 传入。初始顺序保持“稳定人格 → 历史 → 动态背景 → 最新输入”。后台生成的提醒仍是明确标记的内部事件，不伪装用户原话。

DeepSeek 官方端点默认 supportsMidConvoSystemMessages=true，让 Pi 在实际请求中保留这条中途 system。其他端点沿用 Pi 兼容默认：不支持中途 system 时由 Pi 合并到开头，语义身份保留，但历史前缀缓存可能因此减少。用户明确 compat 配置优先。请求快照中的生效 compat 和协议回归用于验证实际传输，背景不写入第二层原始经历。

### 基础规则与人格的职责

`prompts/system.md`承载Hineni运行、上下文、实际工作、工具、发送和权限规则；`persona.md`承载身份形象、关系、性格、兴趣、交流习惯和用户特定约定。`SYSTEM.md`是按需读取的环境索引，auxiliary/prompt-mapping负责辅助判断与动态状态表达。

ContextBuilder按[Operating rules]→[Persona]明确分段，仍作为同一system字符串，与[Project]/[Style]一起组成稳定前缀。API角色、四层协议、动态背景和最新输入位置不变；没有额外模型调用。合计4000token限制保持。更新这段文字会影响首次缓存前缀，之后仍能复用稳定前缀。

### 本轮临时想象灵感

ContextBuilder显式接收Intelligence；开启context.spark时，和原有记忆召回并行调用spark.ts。输入只有persona和本轮触发文字（包含尚未收到成功回复的连续真人输入），不带旧聊天、召回、状态或自动时钟。spark用途模型覆盖fast，规则读取个人auxiliary.yaml的spark。模型返回spark字符串，可为空；有效文字按sparkTokens截取，标为可忽略的想象资料后进入本轮动态背景，继续受第三层总预算约束。它不是新记忆、用户请求或真实执行结果。

不写state.json、memory.json或原始对话；只有请求快照可能保留当轮材料。下一轮重新生成，不沿用旧值。无文字不调用；异常、无效字段或超时记context警告并回退原编排；父信号取消仍传播，避免旧灵感进入新运行。没有程序硬编码的闲聊/工作分类器，提示词要求工作、事实问答或拒绝互动返回空，主模型仍负责最终取舍与权限。

## 第四层执行与工具

代码：[pi.ts](../src/layer4/pi.ts)、[tools.ts](../src/layer4/tools.ts)、[mcp.ts](../src/layer4/mcp.ts)、[chunker.ts](../src/layer4/chunker.ts)。

### 一次执行

每次 Executor.run 新建 Agent，systemPrompt 用第三层给定字符串，messages 用第三层给定历史和背景。主模型按 protocol 通过 Pi 的 openai-responses（默认）或 openai-completions 适配器流式调用，工具执行设置 sequential。这个临时 Agent 在一轮内部保存工具来回，下一轮不复用；“stateless”指跨轮无 Pi 私有长期历史，不是每调一次工具都忘掉本轮。

开始前连接已配置 MCP、汇总工具并检查重名。toolsEnabled=false 时注册表为空。每个工具都收到取消信号和超时；是否迅速停下取决于具体工具是否响应。bash 默认用 toolTimeoutMs，允许 args.timeout 秒申请更长，但不超过 shellMaxTimeoutMs。

每次主模型请求受 runtime.timeoutMs，整轮含上下文构建受 runTimeoutMs。Pi finishTurn 计数达到 maxRounds 或 silent 就结束。返回 complete/silent/cancelled/error/limit；limit 代表限制结束，不表示工作已交付。

### 工具记录

tool_execution_start 立即写 tool_call（工具名/参数）。afterToolCall 将返回值、参数和错误标记写到 history/tools/<run>/<call>.json，再追加 tool_result。若异常路径没有 afterToolCall 记录，tool_execution_end 补写结果事件。

bash 原始输出字节持续追加到相应 .stdout。官方工具本身可能已有截断；JSON 文件保存的是 SDK 返回值，原始 Shell 输出另在 stdout。

同轮返回给模型的每个文本结果最多 maxToolChars 字符，超出时保留前部和完整文件路径。第二层以后自动回顾该结果时使用 toolTailTokens 的尾部片段；这两个限制属于不同阶段，不应混为一谈。

### 流式文字如何变成消息

只接收 assistant text_delta，不把 thinking 或工具参数发给用户。中文句末标点/换行、英文句末后空白可结束一个文字块；句末标点若在流的末端，暂等后续字符以把右引号/右括号留在同一块，assistant 消息结束也会立即补交。代码围栏内暂存。单个 delta 可能包含多句话，因此并非严格“一句一个包”。

message_start 分配 response_id；每次 chunk 交第二层就入队，不等待整轮。模型可以先说“我看看”，调工具，再给结果。取消后新 chunk 不再提交，错误/取消的未完成缓冲丢弃；新输入会删除同一聊天位置尚未交接的旧输出；已交接任务继续。列表编号如 `1.` 不单独提交，等待正文组成句块。finish_without_reply、超时和手动停止不额外清理队列。

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

### 模型请求协议与快照删除

模型 protocol 默认 responses。PiExecutor 选择 Pi 的 openai-responses 或 openai-completions 适配器，继续使用相同的工具回调、断句和取消信号；请求快照记录 protocol。OpenAIModels 的辅助 JSON 和摘要也按槽位选择接口，向量保持 embeddings。Responses 显式 store:false，由本地传入完整上下文，跨轮仍是全新执行。协议错误不会自动降级或重试为另一种协议，避免静默改变推理能力。

上下文删除走独立管理接口，仅 unlink 指定请求文件或本轮快照，检查 agent/run 归属、文件名、符号链接及运行状态。它不调用 eraseHistory 或 clearHistorySummary；历史删除也不调用此接口。

### Hineni 身份与Pi工具说明

基础提示词说明运行于Hineni，Project段提供自己的SYSTEM.md、应用功能手册和AGENTS.md开发导航的实际位置。PiExecutor使用pi-agent-core的Agent并显式设置自有systemPrompt；没有加载pi-coding-agent CLI的“编程助手”默认人格。工具仍发送原始description和参数schema；另外将所选工具自带的通用promptGuidelines加入[Tool usage]，排除Pi会话环境等不适用规则。文件读写、精确edit和Bash可用性不依赖CLI人格；实际请求快照可检查补充后的说明。Skills仍先发现再读SKILL.md。

历史摘要的保留上限为history.summaryTokens；请求总输出额度取它与models.main.maxOutput较大值，允许模型先完成推理。完整JSON的summary文字若超保留预算或响应未完成则拒绝，不推进检查点、不覆盖旧摘要。

## 反向流程：排队、发送、确认

代码：[outbox.ts](../src/layer2/outbox.ts)、[channels.ts](../src/layer1/channels.ts)。

1. queue 接到 Delivery 后，较长附件 caption 先转为独立文字；文本按 split 再拆，所有渠道目前使用每部分最多 3800 字符的保守限制。
2. 先把包含完整 delivery 的 agent_reply/outbound_action 追加到真实历史，再 enqueue。若其间进程退出，恢复时可以发现有记录而缺少队列状态的动作。
3. 全局单队列每 200ms 取最早 queued/retry；一条的 parts 顺序发送。最早 retry 尚未到时间时会等待，不会跳到后面的新消息。
4. 调用 Channel.send 前标 sending 和 handed_off=1，这是整条发送任务的交接边界；后续 part 继续发送。平台成功后推进 part_index，再写 delivery_result。发送确认含平台 message_id。全部部分完成标 sent。
5. 确定失败按 attempts 重试，等待至少 `1000 × 2^attempts` 毫秒或平台 retry_after；超次数标 failed。网络不确定/服务端错误标 uncertain，人工确认后才重新排队。

新输入清理：Store.purgeUnsent 只处理同一 agent 与目标的 handed_off=0 任务，删除队列及事件索引，并重写对应 JSONL，清掉运行结果中的正文副本和相关请求/编排快照。已交接的失败或重试任务不删除；工具记录及其文件保留。若摘要覆盖了被删记录，则清空摘要检查点，下一轮从剩余原文重新构建。临时 prune-outbox ID 清单保证退出中断的删除可在启动时完成，完成即清除。管理时间线的 history_revision 变化会丢弃旧页面缓存，避免把删除内容重新拼回来。

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
| 共享设施                        | 数据库和出站队列共用；参数、模型环境和定时脚本按 agent 区分                              |
| 短查询/召回超时                 | 常触发降级时可能只有词法和旧排名                                                         |
| 索引失效键有限                  | 改描述策略/分片配置不自动清空已有向量                                                    |
| prompt 字符串直接截取           | 人格规则或动态 JSON 可能截断；需看 trace                                                 |
| 紧急大上下文保护不精确          | 真实超大请求需独立测试，不能声称一定不会超限                                             |
| 配置表的一些项是软指导          | style、回顾条数、意外/重复刺激政策不是硬算法保证                                         |
| 文件与 DB 非一个事务            | 崩溃恢复采用保守策略，不承诺所有操作状态无损                                             |
| 首次生成的 SYSTEM.md 不自动同步 | 改路径、回顾预算或迁移后，手册可能仍写旧值，要明确更新                                   |
| 管理 UI 边界                    | 新版提供凭据、文件、Skills 和逐次上下文管理；文本安装不自动安装外部依赖；详见 console.md |

## 代码地图与修改规则

按功能查文档、实现文件、测试与联动修改范围，统一见 [AGENTS.md](../AGENTS.md)。各节上方保留本流程的局部代码入口。

替换 Executor 通过 Runtime 的 ExecutorFactory 注入，实现 RunRequest/RunResult 和 record/send 回调。新增渠道实现 Channel，同时在 ChannelRegistry 加入接收与归一化；当前不是动态插件安装器，schema 中渠道类型和 backend 也需相应修改。换向量后端可保持 memory.json 与公开 memory 工具稳定，在 MemoryService 内改索引读写。

新增配置必须做到 schema → 默认值/帮助 → 消费代码 → 文档 → 有意义的验证闭环；不能只添一个页面开关。自动生成产物及其源文件见 AGENTS.md；运行 `npm run docs` 后，按改动同步本文、配置指南等手写说明。

开发检查顺序：npm run check → npm test → npm run build。测试条目以 tests/ 为准，此前验证范围见 validation.md；新增渠道、模型或能力要补对应验证。不要把聊天能回复当成整个系统全部验收完成。

## 管理界面的检查视图

`History.inspect()` 从与执行流程相同的 checkpoint 和事件渲染读取材料，不调用 summarize、不改变检查点。管理接口按运行配置 agentConfig 计算，磁盘已保存但未重启时标记差异。预览文本与 token 估计按 agent 缓存，事件序号、检查点或有效历史配置变化时重建，避免每次网页刷新重复处理长历史。当前间隔通过 Store.gap() 只读计算；初始 trace 新增 layer2 字段，保存最终历史、回复目标、触发 ID、当轮 conversation_context 和压缩 through。逐次模型请求文件保持原规则。

Telegram 收到 message 后，在入站允许列表检查之前更新 `telegram-chats:<channel>` kv，最多 50 个 chat/thread 组合；无匹配 agent 时只保留聊天位置元信息。管理页用它辅助绑定，不抢占 Bot 的 getUpdates。

`src/config/guide.ts` 是网页与 `docs/configuration-reference.md` 的解释来源，`scripts/generate-guide.ts` 从 schema 取默认值。`src/admin/file-guide.ts` 仅分类和解释文件；权限仍由 AdminFiles 校验。改算法/参数时同步解释并运行 npm run docs。

配置说明分为三份展示资料：guide.ts 保留逐项实现约束，learning.ts 用具体例子解释含义与调整结果，processing-guide.ts 解释消费函数、处理顺序、读写位置和下一轮影响。管理 API 与生成文档共用这些资料，不把它们注入 agent prompt。字段与文件的绝对路径由当前 ConfigStore 动态返回。

表达风格文本移到 config/style-prompt.ts 的 buildStylePrompt，ContextBuilder 与管理页预览使用同一个函数；仅提取原逻辑，不改变生成文本或模型行为。操作说明改为默认收起的问号，不更改保存/重启语义。
