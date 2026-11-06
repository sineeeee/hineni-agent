# Hineni

**AI 开发入口：[AGENTS.md](AGENTS.md)**：按功能查文档、代码入口与修改后同步范围，无需通读全部文档。

**完整文档入口：[Hineni 完整手册](docs/manual.md)**。先读它了解整体，再按需要看 [配置指南](docs/configuration-guide.md)、[内部流程与算法](docs/internals.md)、[全部参数](docs/config.md)。

每台机器自己的安装摘要可以写在根目录 `开始使用.md`。该文件被忽略，不会进入仓库。

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

## 当前阶段与待办

阶段目标：自然日常交流，加上可靠的轻量工作。功能已接通不等于真实聊天质量已验收；实验和具体样本见 [对话评测](docs/dialogue-evaluation.md)，验证范围见 [验证记录](docs/validation.md)。

### 已实现，继续实际使用观察

- [x] 四层主流程、工具循环、打断、附件、表情/沉默、独立agent、定时与一次性提醒。
- [x] 事实/感受双向量、配额召回、记忆页CRUD与单侧重建、只读编排试算。main目前8条检索名额、两侧各半；时间联系、联想和预算仍在之后处理。
- [x] 独立 `models.summary`、手动压缩、超长/格式错误摘要的有限重写；普通压缩失败保留原文并继续回复。压缩不再继承main或fast；旧安装升级需明确填写summary，否则采用该模型自己的默认值。
- [x] 第四层连续标点、收尾引号、emoji与常见颜文字跟随；完整语义分段及任意分包下完全相同的气泡仍非保证。
- [x] 工具执行时沿用delivery.typing显示TG正在输入，完成/打断停止刷新。
- [x] 摸鱼先写生活日记，区分事实与理解；每日记忆整理先看日记、再核对聊天和工具结果；梦境独立保存。
- [x] 背景顺序对比、短灵感对比。保留当前历史→动态背景→本轮输入；短灵感已按用户反馈回退。人格与system现有措辞继续以实际版本为准。

### 还需要完成的可靠性验收

- [ ] **日常与轻工作验收**：持续检查亲近、接话、话题转换、主动分享、误解修正以及工作过程和结果；记录好坏例子，不按某个例子的关键词硬修。
- [ ] **真实记忆质量**：检查日记是否真的按时写入、整理游标是否前进、是否重复记忆或把猜测写成事实；观察感受侧是否召回过于泛化的“开心/被理解”。
- [ ] **延迟与发送**：跟踪压缩、query/感受query、重排的耗时和回退，以及Telegram疑似漏发。普通失败能继续不代表没有额外等待；用真实日志区分生成、排队、交接与送达，不混改四层协议。
- [ ] **状态说明精简**：评估各块情绪指导是否仍重复；没有明确收益先不继续添加状态项或改变默认映射。
- [ ] **Docker/VPS迁移验收**：镜像、持久化目录、个人配置、Skills依赖、网络与定时重启恢复；目标服务器实测公开信息源。

### 下一批能力：未接入，按需挑一个做

- [x] **博客加入摸鱼骰子**：main抽中后用公开WordPress接口阅读；Skill说明全文读取和旧文浏览。
- [ ] **持续追踪兴趣**：从浏览中挑一位创作者或一个问题，隔几次继续看作品/不同观点，留下自己看法怎么变了；不只轮流转发热榜。
- [ ] **自己的持续小项目**：维护一份兴趣/项目笔记，每次空闲只推进一步，例如短篇连载、文字游戏、小网页或一个小知识专题；有实际作品或新发现再找你聊。
- [ ] **读你给的材料**：从你指定的阅读文件夹分次读文章/笔记，留下疑问和观点，之后联系到日常话题。先支持现有工具能可靠读取的格式。
- [ ] **扩展公开娱乐来源**：百科漫游、xkcd等候选；以前本机可读不代表服务器长期可用。按统一“体验→日记→可选分享”流程接入，不恢复需要登录的来源。
- [ ] **米家MCP**：连接并实际验证空调、电饭锅控制。

暂缓：邮件接入、工具执行时的渠道状态提示、群聊节奏优化、更多聊天渠道和需要登录的信息流。邮箱当前先不投入；上述新玩法尚未自动安装或加入定时器。

## 版本保存

Git保存程序、模板和文档；个人config、`.env`、`agents/`和`data/`不进入Git。保存个人调参需另做本地备份，迁移方法见 [运行与迁移](docs/operations.md)。本地个人快照不是完整数据库备份，恢复前先停止程序，核对范围，不要直接覆盖正在运行的目录。

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
