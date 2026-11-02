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

第一层实现 `Channel.send(delivery, part)`，返回可选平台 message_id。它负责平台长度限制、分句、typing、延迟、上传。每个 part 成功后才推进队列位置。

Webhook 出站向配置 URL POST `{protocol_version:1,delivery,part}`，带 `Idempotency-Key: delivery.id:part_index`；若配置 secretEnv，带对应 Bearer token。接收方应按该键去重。省略 URL 的 webhook channel 是本地收件箱，可在控制台查看。网络超时 / 平台服务端错误视为 uncertain；通过控制台确认后再重试。

## 执行接口

`Executor.run({agentId,runId,context,signal}) → RunResult`。Context 含 system、messages、memories、target、inputText。Result reason 为 complete / silent / cancelled / error / limit，另有产生的 text、调用的 tools、候选 memoryIds、可选 error。

执行中的输出通过注入的 send / record 回调交给第二层。新执行器必须响应 AbortSignal，并在取消后停止提交新的聊天输出；已经完成或晚到的工具结果继续记录。

内置工具：Pi 的 read / write / edit / bash / grep / find / ls；history_search / history_read；memory_search / memory_read；send_message / send_attachment / react_to_message / finish_without_reply；web_read / web_search；restart_scheduler；配置的 mcp_* 工具。

`target` 参数使用 agent.targets 里的别名。省略时为当前触发来源。主动记忆搜索带 offset 分页；读取带 offset + version，条目变化后重新读取。主模型不用输出状态 JSON。

新增工作台接口（文件、Skill、模型、凭据、逐次上下文、主服务重启）详见[工作台说明](console.md#管理接口增补)。静态 /admin.js、/admin.css 与页面壳一样公开，所有数据和变更接口仍鉴权。

## 管理接口

| 方法与地址                                     | 内容                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| GET /v1/status                                 | 模型凭据存在性、渠道、活动 run、调度、需重启状态 |
| GET /v1/agents/:agent/events?after=0&limit=100 | 按 seq 增量读原始记录，最多500条                 |
| POST /v1/agents/:agent/cancel                  | 请求取消当前执行                                 |
| GET /v1/agents/:agent/state                    | 当前状态快照                                     |
| POST /v1/agents/:agent/memory/search           | `{query,limit?}` 主动查询                        |
| POST /v1/agents/:agent/memory/reindex          | 维护检索描述与向量，可能较慢                     |
| GET /v1/runs、/v1/deliveries、/v1/logs         | 最近运行、发送、日志                             |
| POST /v1/deliveries/:id/retry                  | 确认后重试 failed / uncertain 投递               |
| GET /v1/config、/v1/config/schema              | 当前配置及 schema                                |
| PUT /v1/config                                 | `{revision,config}` 验证并保存；重启生效         |
| GET /v1/files、/v1/file?path=...               | 可编辑文件清单、文件内容                         |
| PUT /v1/file                                   | `{path,content}` 保存允许编辑的真实文件          |
| POST /v1/scheduler/restart                     | `{agent_id?}`，先重读并校验磁盘配置；指定则只重启该 agent，省略重启全部                               |

错误返回 `{error}`；认证错误 401，格式或配置错误 400。协议字段采用 snake_case；配置字段采用 camelCase，二者分别验证。

## 管理只读视图与配置解释

新增 `GET /v1/admin/guide` 返回字段说明、分组范围和默认值；`GET /v1/telegram/chats` 返回当前运行渠道的已见聊天位置元信息。两者使用现有管理认证。

`GET /v1/agents/:agent/history-view?offset=&limit=` 返回累计 summary、through、remaining 分页、token 估计与运行阈值、当前 target/conversation_context，不触发压缩。`GET /v1/agents/:agent/layer2-snapshot?offset=&limit=` 返回最近保存的 layer2 交接快照；旧 trace 标 legacy，无快照返回 unavailable。分页是字符偏移，默认 200000、上限 1000000。

文件清单补充 category/title/purpose/effect/advanced。`POST /v1/models/discover` 支持 `{baseUrl,apiKeyEnv,apiKey?}`：可选 apiKey 优先于已保存凭据，仅本请求使用，不持久化、不回显。

管理说明扩展：GET /v1/admin/guide 另返回 lessons（含义、调整效果和更新时机）、processes（读取到写回的步骤和代码位置）、locations（当前 root/config/env/agents/data 绝对路径）。文件清单另含 absolutePath、steps、fields、code。这些是管理页展示信息，不改变四层执行协议。

配置 API 继续返回合并视图；磁盘布局见 [Agent 独立配置](agent-layout.md)。GET /v1/credentials?agent=<id> 与 PUT 的 agent_id 指向个人凭据；未指定使用公共连接凭据。POST /v1/models/discover 可传 agent_id 选择其 Key，同名变量不会混用。
