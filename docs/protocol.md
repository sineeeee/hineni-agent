# 协议 v1

[完整手册](manual.md) · [配置指南](configuration-guide.md) · [内部流程](internals.md)

代码定义：`src/contracts/index.ts`。机器定义：`docs/event.schema.json`。所有 HTTP 请求（管理页面壳除外）使用 `Authorization: Bearer <HINENI_TOKEN>`。

## 入站

`POST /v1/events` → `202 {event_id, seq}`。相同 agent_id + event_id 重试返回同一记录；event_id 内容不能拿来表示另一个新事件。

```json
{
  "protocol_version": 1,
  "event_id": "你的稳定唯一编号",
  "agent_id": "main",
  "type": "incoming_message",
  "source": "telegram",
  "occurred_at": "2026-11-01T10:00:00Z",
  "text": "看看这张图",
  "sender": { "id": "123", "name": "你", "kind": "user" },
  "source_message_id": "456",
  "reply_target": {
    "channel": "telegram",
    "conversation": "123",
    "kind": "private"
  },
  "attachments": [],
  "data": {}
}
```

必填：event_id、agent_id、type、source。版本默认 1，正文、附件、data 默认空。时间统一 ISO 8601，系统另记接收时间。Target 含 channel / conversation，可选 thread / kind（private 或 group）。

外部只提交 `incoming_message` 或 `internal_event`。内部事件不必带回复目标，使用 agent 默认目标；模型看到的 user 消息会标注“内部事件，并非用户发言”。附加材料可放 text / data，但需要模型阅读的内容应写进 text 或附件。

## 事件与方向

| 类型                                 | 推理 | 作用                               |
| ------------------------------------ | ---- | ---------------------------------- |
| incoming_message / internal_event    | 是   | 输入与主动触发                     |
| attachment_ready / attachment_failed | 是   | 第一层补交附件结果，继承原消息位置 |
| tool_call / tool_result              | 否   | 输入参数、输出、错误与完整文件引用 |
| agent_reply / outbound_action        | 否   | 保存并加入串行发送队列             |
| delivery_result                      | 否   | 平台已确认送达的结果               |
| run_finished                         | 否   | 完整执行的结束原因和触发编号       |

新触发去重后立即取消旧生成，并删除同 agent、同 channel/conversation/thread 尚未交接的旧发送任务；缺省目标为 agent.defaultTarget。该规则同样适用于统一入口的内部触发和附件结果。原始聊天正文同步物理删除，工具记录保留。

内部附件事件继承 parent_event_id。工具结果关联 run_id / call_id。所有数据可读于 history 文件；运行库不额外伪造用户发言。

## 附件

外部 `POST /v1/agents/:agent/attachments`，JSON 为 `{name,mime,data_base64}`，最大 20 MiB。返回 id 和稳定路径。然后将 id 写入消息 attachments，提交事件。下载使用 `GET /v1/agents/:agent/attachments/:id`，需要令牌。

Telegram 接入先登记 pending 清单并接收文字；下载完成后提交 ready 或 failed 事件。就绪图片才转成模型视觉输入。生成文件用 `send_attachment(path,kind,caption?,target?)`，普通正文中的路径仅是文字。

## 出站

```ts
Delivery = {
  id, agent_id, run_id, response_id, chunk_index,
  target: Target,
  action: 'send' | 'react',
  parts: [{type:'text',text} | {type:'image'|'file',attachment_id,caption?}],
  message_id?, emoji?
}
```

第二层在首次调用 Channel.send 前设置持久化 handed_off 标记；从这一刻起整条 Delivery 不因新输入被取消，包括后续 parts 和重试。标记只属于队列存储，不增加协议字段。

第一层实现 `Channel.send(delivery, part)`，返回可选平台 message_id。它负责平台长度限制、分句、typing、延迟、上传。每个 part 成功后才推进队列位置。

Webhook 出站向配置 URL POST `{protocol_version:1,delivery,part}`，带 `Idempotency-Key: delivery.id:part_index`；若配置 secretEnv，带对应 Bearer token。接收方应按该键去重。省略 URL 的 webhook channel 是本地收件箱，可在控制台查看。网络超时 / 平台服务端错误视为 uncertain；通过控制台确认后再重试。

## 执行接口

`Executor.run({agentId,runId,context,signal}) → RunResult`。Context 含 system、messages、memories、target、inputText。Result reason 为 complete / silent / cancelled / error / limit，另有产生的 text、调用的 tools、候选 memoryIds、可选 error。

执行中的输出通过注入的 send / record 回调交给第二层。新执行器必须响应 AbortSignal，并在取消后停止提交新的聊天输出；已经完成或晚到的工具结果继续记录。

内置工具：Pi 的 read / write / edit / bash / grep / find / ls；history_search / history_read；memory_search / memory_read；send_message / send_attachment / react_to_message / finish_without_reply；web_read / web_search；restart_scheduler；配置的 mcp_* 工具。

`target` 参数使用 agent.targets 里的别名。省略时为当前触发来源。主动记忆搜索带 offset 分页；读取带 offset + version，条目变化后重新读取。主模型不用输出状态 JSON。

新增工作台接口（文件、Skill、模型、凭据、逐次上下文、主服务重启）详见[工作台说明](console.md#管理接口增补)。静态 /admin.js、/admin.css 与页面壳一样公开，所有数据和变更接口仍鉴权。

## 管理接口

| 方法与地址                                     | 内容                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| GET /v1/status                                 | 模型凭据存在性、渠道、活动 run、调度、需重启状态                        |
| GET /v1/agents/:agent/events?after=0&limit=100 | 按 seq 增量读原始记录，最多500条                                        |
| POST /v1/agents/:agent/cancel                  | 请求取消当前执行                                                        |
| GET /v1/agents/:agent/state                    | 当前状态快照                                                            |
| POST /v1/agents/:agent/memory/search           | `{query,limit?}` 主动查询                                               |
| POST /v1/agents/:agent/memory/reindex          | 维护检索描述与向量，可能较慢                                            |
| GET /v1/runs、/v1/deliveries、/v1/logs         | 最近运行、发送、日志                                                    |
| POST /v1/deliveries/:id/retry                  | 确认后重试 failed / uncertain 投递                                      |
| GET /v1/config、/v1/config/schema              | 当前配置及 schema                                                       |
| PUT /v1/config                                 | `{revision,config}` 验证并保存；重启生效                                |
| GET /v1/files、/v1/file?path=...               | 可编辑文件清单、文件内容                                                |
| PUT /v1/file                                   | `{path,content}` 保存允许编辑的真实文件                                 |
| POST /v1/scheduler/restart                     | `{agent_id?}`，先重读并校验磁盘配置；指定则只重启该 agent，省略重启全部 |

错误返回 `{error}`；认证错误 401，格式或配置错误 400。协议字段采用 snake_case；配置字段采用 camelCase，二者分别验证。

## 管理只读视图与配置解释

新增 `GET /v1/admin/guide` 返回字段说明、分组范围和默认值；`GET /v1/telegram/chats` 返回当前运行渠道的已见聊天位置元信息。两者使用现有管理认证。

`GET /v1/agents/:agent/timeline` 额外返回 history_revision；历史重写时递增，客户端应丢弃旧的累积缓存后重新读取。

`DELETE /v1/agents/:agent/history` 仅管理员口令可用。body 为 `{mode:"selected",event_ids:["..."]}`（1–500 条、事件 ID 必须属于该 agent）或 `{mode:"all"}`。返回 `{deleted_events,deleted_attachments}`。删除原始事件同时更新 JSONL、数据库索引、关联发送队列、附件副本和工具结果文件；上下文请求与轨迹文件保留；运行中或该 agent 正在发送时返回 409。压缩摘要独立保留。`DELETE /v1/agents/:agent/history-summary` 单独清空压缩摘要和 through 检查点，不删除原始事件；两类操作均递增 history_revision。普通回复已经送达外部平台时，不向平台请求撤回。

`GET /v1/agents/:agent/history-view?offset=&limit=` 返回累计 summary、through、remaining 分页、token 估计与运行阈值、当前 target/conversation_context，不触发压缩。`GET /v1/agents/:agent/layer2-snapshot?offset=&limit=` 返回最近保存的 layer2 交接快照；旧 trace 标 legacy，无快照返回 unavailable。分页是字符偏移，默认 200000、上限 1000000。

文件清单补充 category/title/purpose/effect/advanced。`POST /v1/models/discover` 支持 `{baseUrl,apiKeyEnv,apiKey?}`：可选 apiKey 优先于已保存凭据，仅本请求使用，不持久化、不回显。

管理说明扩展：GET /v1/admin/guide 另返回 lessons（含义、调整效果和更新时机）、processes（读取到写回的步骤和代码位置）、locations（当前 root/config/env/agents/data 绝对路径）。文件清单另含 absolutePath、steps、fields、code。这些是管理页展示信息，不改变四层执行协议。

配置 API 继续返回合并视图；磁盘布局见 [Agent 独立配置](agent-layout.md)。GET /v1/credentials?agent=<id> 与 PUT 的 agent_id 指向个人凭据；未指定使用公共连接凭据。POST /v1/models/discover 可传 agent_id 选择其 Key，同名变量不会混用。

配置接口的 `revision` 是不透明字符串：客户端读取后原样交回，不能递增或自行生成。它由根配置和全部个人配置的文件内容计算，进程重启不会重置；旧页面提交不同版本会被拒绝。保存前还检查外部文件修改，普通写入失败回滚；跨多个文件的突然断电不保证事务原子性。配置草稿与运行中的配置分别展示，保存不等于运行组件已重建。

### 删除上下文快照

`DELETE /v1/agents/:agent/runs/:run/context`，使用管理认证。请求 `{ "mode": "selected", "request": "0.json" }` 删除一份请求；request 为 null 删除初始编排快照；`{ "mode": "all" }` 删除本轮全部快照。返回 deleted_snapshots。运行中返回 409；不存在的请求返回 404。只删除 .runtime 内指定快照文件，保留数据库轮次、聊天记录和摘要。

### 记忆向量化进度

`POST /v1/agents/:agent/memory/reindex` 默认继续等待维护完成；`{"background":true}` 返回 202 并后台执行。重复启动共用已有维护。`GET /v1/agents/:agent/memory/index-status` 返回 status（idle/running/completed/failed）、total、processed、ready、pending、failed、current_id、error、started_at、finished_at。进度为当前进程状态，ready/pending 由实际索引核对。两个接口均要求管理认证并限定 agent。

第三到第四层的 ContextBundle.messages 使用 system/user/assistant：system 可携带本轮系统参考背景（记忆、agent自身状态、时间），user 是新输入或已标明身份的内部事件，assistant 是历史回复。独立的 context.system 保存稳定人格与执行约定。供应商格式转换留在第四层；第一、二层的事件协议不变。

### 独立清理执行、上下文与日志

- `DELETE /v1/agents/:agent/execution-records`：`{"mode":"selected","run_ids":["..."]}` 或 `{"mode":"all"}`。删除指定运行元数据、tool_call/tool_result/run_finished 的数据库与 JSONL 记录，以及 `history/tools/<run>/` 全目录（含 `.stdout`）。聊天输入/回复、投递记录、摘要、记忆、工作文件、上下文快照保留。
- `DELETE /v1/agents/:agent/context-records`：相同选择格式，删除 `.runtime/requests/<run>/` 与 `.runtime/traces/<run>.json`；不删聊天、摘要或执行工具记录。全部模式也清理失去运行元数据的旧快照。上下文目录没有额外数据库正文副本。
- 两个接口都按 agent 隔离；执行或发送中返回409，先结束再清理。选择列表不接受跨 agent 或路径片段。仍保留的快照可用文件目录恢复上下文列表，不依赖已删除的执行元数据。
- `GET /v1/runs?agent=<id>&scope=execution|context`：执行列表只列仍有执行记录的轮次（最多100）；上下文列表按实际快照目录列出，支持独立清理后的旧快照；列表最多100轮，全部清理不受此限制。
- `GET /v1/logs/storage` 返回数据库位置、logs表条数和时间范围。`DELETE /v1/logs` 接受 `{"mode":"before","before":"2026-01-01T00:00:00Z"}` 或 `{"mode":"all"}`；影响所有 agent 的程序日志，不影响工具、聊天或上下文。标准输出由启动器管理，不在此接口范围内。

### 记忆检查与试算

以下接口同样需要管理Bearer令牌，按agent隔离，使用运行组件的有效配置：

- GET /v1/agents/:agent/memory/inspect：返回原文、实际索引（省略向量矩阵）、计算因素、来源位置和参数；无模型调用。
- GET /v1/agents/:agent/memory/inspect?id=<memory_id>：返回该条原文及包含vectors的完整实际索引；不存在的编号报错。
- POST /v1/agents/:agent/memory/simulate：正文为{"query":"检索材料","mode":"recall"}；mode可为recall或search，默认recall。query去空白后1～20000字符，未知字段拒绝。同agent正在试算时返回409。

返回query原材料和扩展、实际辅助调用记录、所有条目的相关性/状态贡献/候选和选中排名、后续联想/预算结果及output。仅显式POST可能产生模型费用；不创建事件、不调用主模型、不写真实记忆/索引/状态或召回计数。日志可以记录诊断信息。检索材料不自动附最近对话，随机分支按本次独立抽签。
