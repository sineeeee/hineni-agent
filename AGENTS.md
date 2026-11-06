# Hineni：AI 开发导航

这是修改本项目的入口。先按下表定位相关文档和代码，按章节读取，不必通读全部手册。运行在 Hineni 里的个人 agent 使用自己的 `SYSTEM.md` 和 Skills；本文件面向维护应用的开发者 AI。

## 先确认任务范围

- 理解整体：读 [架构](docs/architecture.md)；面向用户的说明在 [完整手册](docs/manual.md)。
- 改文件位置、配置、密钥或定时任务：先读 [Agent 文件归属与继承](docs/agent-layout.md)。
- 改层间对象、事件方向或外部接口：先读 [协议](docs/protocol.md) 和 [类型定义](src/contracts/index.ts)。
- 排错：先确定 agent_id、run_id、目标渠道及实际配置，再按功能定位。实现和测试用于确认当前行为；[设计背景](docs/design-reference.md) 是历史讨论，[开始使用](开始使用.md) 是本机安装说明，不能当作所有安装的状态。

## 按功能找文档和代码

下表代码路径均相对项目根目录；在文件中搜索给出的类或方法即可，无需依赖容易失效的行号。

| 要处理的功能                          | 先读文档                                                                                                                 | 主要代码入口                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启动、初始化、整机重启                | [运行与迁移](docs/operations.md)；[启动流程](docs/internals.md#启动配置和运行组件)                                       | `src/main.ts` → `src/application.ts`；`src/init.ts` 生成个人文件                                                                                                                                                                                                                                                                   |
| 配置归属、继承、保存、私有凭据        | [文件与配置](docs/agent-layout.md)；[配置指南](docs/configuration-guide.md)                                              | `src/config/store.ts`：ConfigStore；`src/config/schema.ts`：parseConfig / agentConfig                                                                                                                                                                                                                                              |
| 模型选择、API Key、模型列表           | [模型配置](docs/configuration-guide.md#模型地址和密钥)                                                                   | `src/shared/models.ts` 辅助请求；`src/layer4/pi.ts` 主模型；`src/admin/control.ts` 凭据与模型列表                                                                                                                                                                                                                                  |
| 第一层：Telegram、Webhook、聊天绑定   | [入站协议](docs/protocol.md#入站)；[接入流程](docs/internals.md#第一层接入附件与路由)                                    | `src/layer1/channels.ts`：ChannelRegistry；`src/admin/server.ts`：/v1/events                                                                                                                                                                                                                                                       |
| 图片、附件、生成文件                  | [附件协议](docs/protocol.md#附件)                                                                                        | `src/layer1/channels.ts` 下载；`src/layer4/tools.ts` 发送工具；`src/layer2/store.ts` 附件状态                                                                                                                                                                                                                                      |
| 第二层：记录、轮询、批次、打断        | [记录与打断](docs/internals.md#第二层记录触发与打断)                                                                     | `src/layer2/runtime.ts`：ingress / tick / execute；`store.ts` 索引；`journal.ts` JSONL                                                                                                                                                                                                                                             |
| 第二层：删除选中记录、清空原文或摘要  | [工作台删除说明](docs/console.md#工作台的三个视图)；[删除协议](docs/protocol.md#管理接口)                                | `src/layer2/store.ts`：eraseEvents / clearSummary；`journal.ts` 明文与副本；`src/admin/control.ts` 管理接口                                                                                                                                                                                                                        |
| 历史压缩、查原文、交流间隔            | [历史压缩](docs/internals.md#第二层历史压缩)；[交流间隔](docs/internals.md#交流间隔)                                     | `src/layer2/history.ts`；`src/layer2/store.ts`：gap；`src/layer4/tools.ts`：history_*                                                                                                                                                                                                                                              |
| 第三层：上下文拼接、预算、Skills 发现 | [上下文与提示词](docs/internals.md#第三层上下文与提示词)                                                                 | `src/layer3/context.ts`：ContextBuilder.build；`state-context.ts`：模型可读状态；`spark.ts`：只看人格与本轮输入的临时想象灵感；`layer2/history.ts`：messages；`src/shared/tokens.ts`                                                                                                                                               |
| 记忆写入、索引、查询、召回、遗忘      | [记忆流程](docs/internals.md#第三层长期记忆与索引)；[记忆配置](docs/configuration-guide.md#记忆分别调写入索引召回和遗忘) | `src/layer3/memory.ts`：items / sync / search / recall / inspectMemories / simulateRecall；`memory-ranking.ts`共享评分；`prompt-assembly.ts`共享拼接；`src/admin/context-preview.ts`完整只读编排；`src/admin/memory.ts` / `memory-client.ts`检查页与试算；startIndexing / indexStatus；`templates/skills/personal-memory/SKILL.md` |
| 心情、驱动力、短期激活、重温          | [状态更新](docs/internals.md#第三层状态与回合后更新)                                                                     | `src/layer3/memory.ts`：state / afterRun；`src/layer2/runtime.ts` 的执行收尾                                                                                                                                                                                                                                                       |
| 回复风格、人格、基础 Prompt           | [人格与篇幅](docs/configuration-guide.md#人格基础提示词和回复篇幅)                                                       | `src/config/style-prompt.ts`；`src/layer3/context.ts`；`prompts/system.md`、`templates/persona.md` 是模板                                                                                                                                                                                                                          |
| 第四层：Pi、工具循环、取消、断句      | [执行与工具](docs/internals.md#第四层执行与工具)                                                                         | `src/layer4/pi.ts`：PiExecutor；`src/layer4/chunker.ts`；`src/layer4/tools.ts`                                                                                                                                                                                                                                                     |
| MCP、网页、文件、终端工具             | [工具配置](docs/configuration-guide.md#工具skills-和-mcp)；[工具清单](docs/internals.md#工具清单与参数)                  | `src/layer4/mcp.ts`；`src/layer4/tools.ts`；`src/layer4/pi.ts` 注册 Pi 工具                                                                                                                                                                                                                                                        |
| 回复排队、重试、表情、沉默、群聊      | [反向流程](docs/internals.md#反向流程排队发送确认)；[出站协议](docs/protocol.md#出站)                                    | `src/layer2/outbox.ts` → `src/layer1/channels.ts`；`src/layer4/tools.ts` 产生动作                                                                                                                                                                                                                                                  |
| 定时、随机聊天、梦境、脚本重启        | [定时文件归属](docs/agent-layout.md#main-的定时任务改哪里)；[定时流程](docs/internals.md#定时脚本内部事件与重启)         | `src/scheduler.ts` 管进程；`scripts/schedule.ts` 是模板；实际运行 `agents/<id>/schedule.ts`                                                                                                                                                                                                                                        |
| 管理 UI、JSON 阅读、文件和 Skill 编辑 | [工作台](docs/console.md)                                                                                                | `src/admin/ui-client.ts` 交互；`ui.ts` 页面；`ui-style.ts` 样式；`json-viewer.ts` 折叠；`control.ts` / `files.ts` API 与文件操作                                                                                                                                                                                                   |
| 工具日志、实际上下文、历史检查视图    | [如何查一轮](docs/manual.md#8-怎么查一轮到底发生了什么)；[检查视图](docs/internals.md#管理界面的检查视图)                | `src/admin/inspect.ts`、`control.ts`（独立 DELETE context 删除请求/初始快照）；`src/layer4/pi.ts` 请求快照；`src/layer2/history.ts`：inspect                                                                                                                                                                                       |

一次性提醒、小模型行为文件与情绪调参见 [专项说明](docs/configuration-guide.md#给自己设置一次提醒)。代码：`src/once-tasks.ts` / `src/scheduler.ts`；规则读取：`src/config/auxiliary.ts`。个人 `schedule.once.json` 和 `prompts/auxiliary.yaml` 初始化只补缺失文件，不覆盖用户内容。

## 一条消息的路线

```text
ChannelRegistry / POST /v1/events → Runtime.ingress → Store + Journal
Runtime.tick → History → ContextBuilder.build → PiExecutor
工具记录 → Store；文字/附件动作 → Outbox → ChannelRegistry → 投递结果
第四层整轮结束 → MemoryService.afterRun（不等待渠道送达）
定时脚本只向同一个 /v1/events 提交 internal_event
```

四层是同一应用的组件。新增渠道实现 Channel；替换执行器实现 Executor，通过 Runtime 的 ExecutorFactory 注入。Pi 类型留在第四层，自有协议放 `src/contracts/`。

## 改配置或文档时，哪些地方一起更新

| 内容                         | 维护源文件                                                                         | 对应产物/使用者                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 字段、校验、默认值、合并     | `src/config/schema.ts`、`store.ts`                                                 | 运行组件、配置 API、表单                                                                                                 |
| 简短字段说明、分组影响       | `src/config/help.ts`、`guide.ts`                                                   | UI 与配置参考                                                                                                            |
| 人话解释、具体步骤、代码位置 | `src/config/learning.ts`、`processing-guide.ts`                                    | UI 行内说明与逐项参考                                                                                                    |
| 文件用途、何时生效           | `src/admin/file-guide.ts`                                                          | 文件编辑器与文件指南                                                                                                     |
| 自动生成文档                 | `scripts/generate-docs.ts`、`generate-guide.ts`                                    | `config.example.yaml`、`docs/{config.schema.json,event.schema.json,config.md,configuration-reference.md,files-guide.md}` |
| 手写流程与操作说明           | `docs/{agent-layout,configuration-guide,internals,protocol,console,operations}.md` | 按改动范围同步相关章节                                                                                                   |

新增参数要贯通“schema → 实际消费代码 → UI 解释 → 文档 → 验证”；明确它改变算法、Prompt 还是仅提供模型软指导。执行 `npm run docs` 更新生成产物，直接编辑生成文件会被下次覆盖。

**模板与现有个人文件分别检查。** 改 `templates/skills/`、`prompts/system.md`、`scripts/schedule.ts` 或初始化说明后，检查本次涉及的 `agents/<id>/skills/`、`prompts/`、定时脚本和 `SYSTEM.md`。初始化保留已有文件，不会替你更新它们。按差异修正相关说明、保留用户定制，并在交付中说明哪些实际文件已同步；个人文件受 Git 忽略，源码提交不包含这些改动。

## 保持的行为约定

- 根 config 保存公共设施、默认值和 agent ID 清单；个人 config 只保存明确值。缺省逐字段继承，false / 0 / [] 是明确值，数组整体替换。用 ConfigStore 读写完整配置，根文件不能独自当运行配置。
- 每个 agent 使用自己的环境变量、人格、记忆和主经历。通过明确事件或工具获取别人的信息；私有环境显式传递，不合入 process.env。文件权限仍由运行账户决定。
- JSONL 是原始经历，实时追加；SQLite 保存索引和运行队列。压缩保留原文；打断时物理删除未交接的回复是明确例外。完整工具结果仍可追溯。
- 每个 agent 同时一个执行轮次，新触发批次打断旧工作。工具记录、回复和投递确认只记录，不再次触发推理。
- 新触发到达立即停止旧生成，并删除同一 agent + channel/conversation/thread 尚未交给第一层的发送任务、原始聊天正文和重复快照。handed_off 是交接边界，已交接任务继续；工具执行记录保留。保持 run / response / chunk / part 编号和 uncertain 状态。
- 心情跟随第四层整轮结束更新；发送成功不是更新前提。
- restart_scheduler 只重启调用者的脚本，先重读校验配置，再停旧进程。随机计时从头开始。
- 凭据、真实 config.yaml、agents/、data/ 不进 Git；调试时不回显密钥。迁移需另外备份个人数据。

## 验证与交付

`tests/agent-layout.test.ts` 覆盖配置继承、密钥隔离、初始化、个人脚本与重启；`tests/core.test.ts` 覆盖四层行为、工具、MCP、投递、管理页和文档字段覆盖；`tests/admin-form.test.ts` 执行 Agent/配置表单，覆盖保存后继续修改、多配置组、JSON 编辑、失败草稿和列表枚举；`tests/fixtures/mcp-server.mjs` 是本地模拟服务。

代码或行为修改后执行 `npm run check`、`npm test`、`npm run build`；说明源变化运行 `npm run docs` 并检查生成差异。纯文档修改核对链接、路径和描述即可。测试用本地临时数据；真实渠道发送与付费 API 调用需按任务范围决定。验证记录写在 [validation.md](docs/validation.md)，说明实际测了什么，不把历史结果当成本次结果。

交付说明改了什么、哪些个人文件已同步、何时生效和验证范围。用户只让改文档时无需重启服务；人格、基础提示词和 Skill 文件下一轮读取。

## 补充代码入口与约定

- 可选摸鱼：templates/skills/moyu 是模板，实际文件在个人 skills/moyu；scripts/schedule.ts 的 leisureEvent 接到同一内部事件协议。调度参数在个人config.yaml的scheduler，日计数由src/shared/leisure.ts维护；Skill仅通过Python标准库读取公开API/RSS，浏览规则和来源直接随Skill脚本提供，无独立配置文件；配置/迁移见 operations.md 的摸鱼章节。

- 状态映射：src/config/prompt-mapping.ts校验默认值，layer3/state-context.ts渲染；配置方法见configuration-guide.md的“状态与时间映射”。
- 辅助模型：src/config/auxiliary.ts读个人规则；layer3/spark.ts生成临时想象，shared/probability.ts执行每轮抽样。概率只控制注入，不决定任务执行。
- 供应商兼容：layer4/model-compat.ts；测试应检查实际HTTP角色与参数，不能只看转换前快照。跨轮仅恢复可见文本，不沿用SDK私有思考内容。
- 批量清理：admin/cleanup.ts；请求索引：admin/inspect.ts。执行、上下文、聊天、摘要各自独立删除，不重新耦合范围。
- 连续未答输入：History.unansweredBatch，以成功文字投递回执为边界；ContextBuilder后置输入并计预算，压缩检查点不可跨过被排除的输入。评测种子也必须附成功回执。
- 提示词职责：system.md管通用行为与工作工具，persona.md管身份关系与个性，SYSTEM.md管环境索引；提示词文件下一轮读取。
- 对话评测入口：[方法与具体样本](docs/dialogue-evaluation.md)，scripts/evaluate-dialogue.ts；隔离模拟数据、需--paid。失败样本必须保留说明，不能把工程回归当作人格验收。
- 配置保存回归必须覆盖“修改→保存→继续修改→保存重启→刷新”；未解决边界见[验证范围](docs/validation.md)。
- 网页重启只重建配置组件。源码更新需完整重启Node并核对新PID/schema；文档整理无需重启，见operations.md。

文档按功能维护现有手册；修复和配置变化直接更新相应章节，验证范围汇总到validation.md，对话实验汇总到dialogue-evaluation.md。不要每个补丁新增日期报告。生成文档以代码说明为源，不能手改生成产物。

生活日记：摸鱼/记忆Skill维护 `workspace/diary/YYYY-MM-DD.md`，不是核心事件或新数据库；整理范围使用既有 `.runtime/memory-review.json` 的可选 diary_through_date，重读边界日期防止漏掉追加内容。入口：templates/skills/{moyu,personal-memory}/SKILL.md；实际文件位于对应agents目录，初始化只补缺失文件。
