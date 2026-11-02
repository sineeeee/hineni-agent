# Hineni

**AI 开发入口：[AGENTS.md](AGENTS.md)**：按功能查文档、代码入口与修改后同步范围，无需通读全部文档。

**完整文档入口：[Hineni 完整手册](docs/manual.md)**。先读它了解整体，再按需要看 [配置指南](docs/configuration-guide.md)、[内部流程与算法](docs/internals.md)、[全部参数](docs/config.md)。

当前这台机器的安装摘要见 [开始使用.md](开始使用.md)。

自主管理经历、记忆和人格的个人 agent。一个程序，四个可替换组件；Telegram / Webhook 是前端，Pi 是执行器。

管理界面操作：[工作台使用与调试](docs/console.md)。工具记录在“执行与工具”，逐次请求在“上下文”。

## 启动

需要 Node.js **22.19+**（推荐 24 或 26）、npm、Bash。Python Skills 需要 `python3`，搜索工具建议安装 `rg`。

```sh
npm ci
npm run init
# 编辑 agents/main/.env：OPENAI_API_KEY
# 编辑主目录 .env：TELEGRAM_BOT_TOKEN（使用 Telegram 时）
# 编辑 agents/main/config.yaml：模型、记忆、定时、聊天绑定
# 主目录 config.yaml：公共渠道、端口与公共默认值
npm run build
npm start
```

管理页面：`http://127.0.0.1:8788`。粘贴 `.env` 里的 `HINENI_TOKEN` 连接；统一 API 在 `8787`。本地收件箱可直接试聊。没有模型密钥时显示未配置，调用会明确失败。

初始主模型 `gpt-4.1`，快速模型 `gpt-4.1-mini`，向量模型 `text-embedding-3-small`，均使用 OpenAI 协议，可分别改地址和环境变量名。功能默认启用；外部渠道、MCP 和第三方 Skill 仍需要各自凭据、服务与依赖。

## 连接 Telegram

在主目录 `.env` 填 Bot Token。用网页绑定聊天，或在 `agents/main/config.yaml` 设置以下字段（保留其他配置）：

```yaml
id: main
name: Hineni
defaultTarget:
  channel: telegram
  conversation: "你的聊天 ID"
  kind: private
targets:
  tg_private:
    channel: telegram
    conversation: "你的聊天 ID"
    kind: private
routes: []
```

`defaultTarget` 同时接收该位置的消息；更多位置放进 `routes`。群聊加 `kind: group`，Bot 必须拥有接收群消息权限。`channels[].allowedChats` 可以再限制聊天 ID。配置修改后重启主程序。

## 文件与能力

每个 `agents/<id>/` 有 `persona.md`、`memory.json`、`state.json`、`SYSTEM.md`、`skills/`、`workspace/`、`history/`、`attachments/`。

原始事件实时追加到 `history/YYYY-MM-DD.jsonl`，完整工具结果和终端原始输出在 `history/tools/`。AI 可以直接读这些文件。SQLite 保存可重建索引、运行信息和可靠发送队列。历史压缩不会删除原始文件。

已经接通：连续聊天与工具循环、新事件打断、文字/图片/文件、表情与沉默、跨渠道别名发送、多 agent 独立记录、群聊发言转发、记忆索引/召回/衰减/强化、回合后心情更新、cron 与随机脚本、Skills、MCP、管理页面。

网页读取直接请求 HTTP；网页搜索使用主端点的 OpenAI Responses `web_search`。不支持此扩展的兼容服务可换一个 MCP 搜索工具。工具的主机权限与运行账户相同，workspace 是工作目录和数据边界，不是操作系统沙箱。

## 开发与文档

```sh
npm run dev       # 直接运行 TypeScript
npm run check     # 类型检查
npm test          # 含本地模拟 OpenAI、真实 Pi/MCP 的集成测试
npm run build
npm run docs      # 更新机器协议与配置说明
```

- [架构与数据流](docs/architecture.md)：层的职责、替换位置、停止与恢复。
- [协议](docs/protocol.md)：事件、发送、附件、工具和 HTTP 接口。
- [配置](docs/config.md)：实际支持的配置、默认值和单位。
- [运行与备份](docs/operations.md)：VPS、依赖、排错和迁移。
- [实现范围与验证](docs/validation.md)：已验证范围、需凭据的检查、与草案的边界。
- [设计来源](docs/design-reference.md)：此前总需求，保留供核对；实现接口以本项目协议和 schema 为准。

配置、凭据和定时脚本的归属详见 [Agent 独立配置](docs/agent-layout.md)。
