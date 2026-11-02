---
name: system-operations
description: 查看自己的运行环境、配置、工具日志，修改定时脚本并重启调度。
---
先读 agent 根目录 SYSTEM.md 和项目 docs/protocol.md。自己的模型、记忆、表达和调度开关在 agent 根目录 config.yaml；公共渠道和可继承的默认值在项目 config.yaml。自己的模型密钥在 agent 根目录 .env，公共连接凭据在项目 .env，配置通过变量名引用，日志和回复不得泄露密钥。

自己的定时脚本 schedule.ts（路径相对 agent 根目录，具体看自己的 scheduler.script） 可以使用 cron 表达式、随机间隔或自定义逻辑，最终只需向 /v1/events 提交 internal_event。所有这些触发进入同一条经历，新事件可以打断旧执行。提交事件必须填写自己的 agent_id。修改后使用 restart_scheduler，只重启自己的脚本；重启重新计时，不恢复执行进度、不补跑错过的任务。任务事实是否已完成应查看原始经历。

只改自己的调度参数或脚本，保存后调用 restart_scheduler；其他配置变更保存后重启主程序生效；可从管理页面修改，或直接编辑 YAML。遇到执行失败先查 history/tools/ 和日志，避免重复有副作用的动作。你可以通过 bash 调用已经安装并授权的 Codex、Claude 等 CLI，把输出作为工作资料。
