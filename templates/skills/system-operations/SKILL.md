---
name: system-operations
description: 管理自己的定时与随机任务、调整触发间隔和提醒文字、设置指定日期的一次性提醒、立即触发一次招呼、重启自己的定时脚本，或查看配置与执行日志。用户要求设置提醒、主动联系或修改定时行为时使用。
---

先读自己根目录的 `SYSTEM.md` 确认 agent_id、项目根目录和个人目录。文件归属、继承规则见项目 `docs/agent-layout.md`；事件格式见 `docs/protocol.md`。下面路径均相对项目根目录，`<id>` 替换为自己的 ID。

## 改在哪里

| 要改什么 | 实际修改位置 |
| --- | --- |
| 随机招呼开关、间隔、活跃时段 | `agents/<id>/config.yaml` 的 `scheduler.randomChat/randomMinMinutes/randomMaxMinutes/activeStart/activeEnd/timezone` |
| 整个定时进程的开关、脚本路径 | 同文件的 `scheduler.enabled/script`；script 相对自己的根目录 |
| 招呼提示文字 | 自己实际运行脚本里的 `randomGreeting` |
| 指定日期只执行一次的提醒 | 自己的 `schedule.once.json`，见下文；不改 config 或脚本 |
| 新增 cron、随机或自定义任务 | 自己实际运行的脚本，默认 `agents/<id>/schedule.ts` |
| 每日记忆整理时间、做梦开关与时间 | 自己 config 的 `memory.sleepCron/reviewEnabled`、`scheduler.dreamEnabled/dreamCron`；由自带脚本读取 |

个人 config 有字段就用自己的，缺项继承根 `config.yaml`。改个人任务时只写自己的字段；`false`、`0`、空数组表示明确值。主目录 `scripts/schedule.ts` 是新建模板，已有 agent 运行自己的副本。

新增自定义任务可以直接在脚本内写时间和逻辑，不必同时修改 config。任意新 YAML 字段并不会自动变成有效配置或 UI 控件；需要程序支持和脚本读取。保留脚本里已有任务，除非用户要求调整。

## 运行与重启

主程序为每个启用的 agent 保持一个独立定时进程。修改自己的脚本或 scheduler 参数后，保存并调用 `restart_scheduler`；它重读校验配置，只重启自己的进程。设置 `scheduler.enabled=false` 后调用这个工具，会停止自己的定时进程。

只修改自带脚本使用的记忆整理时间/开关时，脚本重启可更新触发行为；让第三层等运行组件使用其他新配置仍需重启主程序。人格、基础提示词和 Skill 文件保存后下一轮读取。

重启从头抽取随机等待时间，不保存下一次触发点、不补跑离线任务。自带随机招呼到期后才检查活跃时段，时段外跳过并重新抽取。模型收到提醒后可以选择沉默；任务是否完成要查经历，不把“已提交事件”当成“已执行完成”。

## 统一事件入口

定时脚本向 `POST /v1/events` 提交 `internal_event`：`protocol_version: 1`、唯一 `event_id`、自己的 `agent_id`、`source: "scheduler"`、提醒 `text`，可加 `data.kind`。优先复用实际脚本的 `event()` 帮助函数。提醒进入第二层普通记录和轮询，再经过第三、第四层；可以打断当前执行，并删除该聊天位置尚未交给第一层的旧回复及原始正文。已交接消息继续、实际工具记录保留，默认回复到自己的 defaultTarget。

宿主启动脚本时提供 `HINENI_ROOT`、`HINENI_AGENT_ID`、`HINENI_API` 和管理连接令牌；使用现有认证逻辑，不把凭据写进事件、日志或回复。模型 Key 在个人 `.env`，公共 Bot Token 和管理口令在根 `.env`。

## 手动立即触发一次招呼

仅在用户要求立即触发时，在项目根目录执行（替换 `<id>`）：

```sh
node --env-file=.env --import tsx agents/<id>/schedule.ts --once random_chat --agent <id>
```

如果 scheduler.script 改过，执行真实路径，并先确认自定义脚本仍支持 `--once`。此参数是自带脚本的能力，不是通用任务管理接口。它只提交一次事件，不启动新常驻进程、不重置现有倒计时；绕过 randomChat 开关和活跃时段，要求主服务正在运行且 agent 启用。

排错先看自己的 `history/tools/` 和管理页日志。已有外部动作不会因打断而撤回，重试前核对结果。已安装并授权的 Codex、Claude 等 CLI 可通过 bash 作为工具使用，输出作为工作资料。

## 未来某时刻只执行一次

支持。编辑自己的 `schedule.once.json`，保留已有任务，向 `tasks` 数组加一项：

```json
{"id":"morning-wakeup","enabled":true,"at":"2030-01-02T08:00:00+08:00","text":"现在到了约定时间，请提醒用户起床。这是用户此前委托的一次性提醒，并非新用户发言。"}
```

示例日期只是格式，必须换成用户要求的真实未来日期。明确时区；凌晨说“明天/早上”有歧义时确认具体日期，不默默改成今天。用户明确要求给本人设置提醒已构成该提醒的授权，不再另行要求审批普通提醒文案；第三方发送仍按人格权限规则处理。

保存后调用 `restart_scheduler`，它先校验文件再重启当前 agent 的调度。核对工具返回 status.running=true 及文件里的 id/at/enabled，才说已设置；不要把已设置说成已发送或已完成。无需修改 config 或 schedule.ts。若 scheduler.enabled 关闭，需要用户要启用时打开个人配置并重启调度。删除或 enabled=false 后同样重启，才取消未触发任务。

任务由宿主 Scheduler 计时，不依赖自定义脚本是否读取该文件；scheduler.enabled 和启用的脚本进程共同控制生命周期。重启时未来任务继续等同一个绝对时间，已经过期则跳过，不补跑。不保存执行进度；同一个 id+时刻生成稳定事件编号，第二层去重。到期提交仍可能被新输入打断；最终发送取默认渠道。这不是手机系统闹钟，不能保证用户醒来。

`--once random_chat` 是立即提交一次招呼，不是预约提醒。 它给自己一次找话题的机会，角色可以带来新内容，也可以选择沉默；不保证一定发出一句固定问候。复杂周期/随机策略仍写自己的 schedule.ts。UI 的“配置 → 主动行为与定时 → 当前 Agent 一次性任务”编辑的是同一个 JSON 文件。
