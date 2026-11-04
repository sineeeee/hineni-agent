# 运行与迁移

[完整手册](manual.md) · [配置指南](configuration-guide.md) · [内部流程](internals.md)

## 环境

Node.js 22.19+，推荐 24/26；npm；Bash。Python 脚本使用系统 python3 或 agent workspace 内的虚拟环境；JavaScript 使用 Node。安装 git / ripgrep / curl 可覆盖常见 Skills。第三方 Skill 自身依赖按其文档安装，不能保证任意 Skill 在未安装依赖时可运行。

`npm ci` 使用锁文件；`npm run build` 编译；`npm start` 运行编译产物。调度脚本保持可编辑 TypeScript，运行依赖 tsx（作为生产依赖安装）。首次 `npm run init` 生成 .env 随机令牌和 agent 文件，不覆盖现有人格与 Skill。

主程序默认只监听本机。VPS 访问管理页面可使用 SSH 转发 `ssh -L 8788:127.0.0.1:8788 user@host`。公开部署应在自己的 HTTPS 反向代理之后，保留 Bearer 认证。应用不是多租户安全隔离服务，工具拥有运行账户权限；使用专门账户运行。

文件布局和每项归属见 [Agent 独立配置](agent-layout.md)。

## 配置与重启

网页的“保存并重启”会重读配置并重建运行组件，不会重新导入已经缓存的代码。更新源码后先 `npm run build`，再完整停止旧 Node 进程并执行 `npm start`。检查监听端口对应的新进程，不能把配置重载当成代码更新已生效。人格和提示词仍按下一轮读取规则生效。

模型与运行参数写自己的 agents/<id>/config.yaml；公共渠道写根 config.yaml，保存后重启主程序。只改个人 scheduler 参数或脚本时，保存后单独重启该 agent 的定时脚本即可。各 agent 的人格、记忆、prompts/system.md、Skills：下一轮读取。各 agent 的调度脚本：保存后点“重启定时脚本”或使用工具。脚本失败会记录日志，5秒后重新启动；重启清零随机计时，不补跑过去的任务。

网页新增 agent 后保存，会生成自己的 config.yaml、空 .env、schedule.ts 与提示词；重启补齐其他初始文件。共享 Skills 用 agents[].skills 路径；放入某 agent 的 skills/ 只给它使用。MCP stdio 使用 command/args/env，HTTP 使用 url/headersEnv；headersEnv 指向 JSON 请求头环境变量。

## 常见问题

- 未配置模型：状态页显示 configured=false；填该 agent 的 agents/<id>/.env 并重启。
- Telegram 不收消息：检查 bot token、聊天 ID、routes、allowedChats 和群聊权限。启动日志会报告认证或连接问题。
- 向量或快模型失败：保留记忆文件，召回退回词法；心情失败保留现状。日志区分 query / rerank / index / mood。
- 消息发送 uncertain：平台可能收到了，但本程序没拿到确认。检查平台后再手动重试。队列不会自动猜测。
- 工具失败：history/tools/<run_id>/ 有结果 JSON，Shell 有完整 stdout。中断不代表已经发生的外部动作被撤回。
- 网页搜索失败：兼容端点可能只实现 Chat Completions；换支持 Responses web_search 的主端点或 MCP 搜索工具。
- memory.json 无效：记录警告，在当前进程沿用上一份有效内容；修复 JSON 后恢复。避免非原子编辑。

## 备份

先正常停止服务，然后备份整个项目中的 config.yaml、.env、agents/、data/、prompts/、scripts/、自定义 Skills；代码与 package-lock.json 一并保存。备份含私人数据和密钥，按私人文件保管。

迁移到新机器后 `npm ci && npm run build`，检查 SYSTEM.md 中的机器路径以及自定义 MCP/Skill 路径。修改 HINENI_ROOT 可指定项目位置；更新每个 agent 的 SYSTEM.md 路径说明。重启不会自动重新执行之前被打断的工作。

SQLite 丢失时，真实 JSONL、附件清单和检索索引文件仍在：新建库会重建经历，旧触发不重放；无法恢复准确状态的出站动作标为 uncertain。正常备份仍应包含 data/，不要把“可重建”理解为发送状态可无损丢弃。

历史日期文件名按 UTC，事件同时保留平台时间；定时器使用配置时区。schema 版本固定为1，未来破坏性变更需显式迁移。

## Telegram 代理

需要代理的机器，在 `.env` 设置 `TELEGRAM_PROXY_URL=http://127.0.0.1:7890`（地址替换为实际 HTTP 代理），重启主程序后生效。此设置只影响 Telegram 的收消息、发消息和附件下载，不改变模型或其他渠道。留空时直连；程序不会自动读取 macOS 的系统代理。目前此项在 `.env` 编辑，尚未提供网页输入框。迁移到 VPS 时应删除或更换本机代理地址。

## Git 与本机数据

Git 跟踪源码、锁文件、模板、配置样例和文档。实际 config.yaml、.env、agents/、data/、日志和构建产物不进入仓库。初次检出后按 README 执行 npm ci、npm run init、填写凭据、npm run build、npm start；init 生成根默认配置和独立的 main 目录，个人缺省项继承默认。Git 不是个人配置和记忆的备份，迁移时仍需备份上一节所列文件。

程序诊断日志位于实际 dataDir/runtime.sqlite 的 logs 表；控制台“程序日志”支持按天数或全部手动清理（全局）。启动时重定向的标准输出是启动器管理的另一份文件，不由该按钮清理。执行工具文件和上下文快照分别在对应Tab清理，具体删除范围见 docs/console.md。

## 摸鱼与随机聊天共用计时器

可选模板在templates/activities/moyu，复制到agents/<id>/workspace/moyu后，该agent的schedule.ts会使用它；没有此目录仍用原来的纯聊天逻辑。已有个人schedule.ts需同步模板中的leisureEvent接线，初始化不会覆盖旧脚本。不添加Skill，不另起调度服务，也不改四层协议：定时到点→dice.py抽签→moyu_browse或random_chat内部事件→/v1/events→第二层→完整上下文和主agent执行。quiet不提交事件。抓取由主agent通过Bash运行fetch.py，工具结果正常进入第二层。

本次main设为当地8–22点，每100–200分钟一次机会；最多5次机会/天，相对权重摸鱼65、纯聊20、安静15。真正发送次数可更少。每次机会才投骰子，每次摸鱼抽2–3站、每站最多4条候选，最终建议只分享1–2件。原有纯聊天文案保留，记忆整理、做梦、一次性提醒互不改变。

时间窗口/间隔/总开关：个人config.yaml的scheduler，保存后重启该agent的定时脚本。来源、配额、权重：workspace/moyu/config.json，保存后下一次机会生效，文件编辑器可直接修改。SOP.md解释行为及全部参数；dice.py、fetch.py、connect.py是可执行脚本。state.json只记当天额度和最近来源，跨天重置、重启不清当天额度；不保存下一次时间。抓取日志最近200行，last-edition.json每次替换，均不代表已发给用户。实际去重参考第二层已发送聊天，不预登记已分享。

手动触发一次完整摸鱼：项目目录执行`node --import tsx agents/main/schedule.ts --once moyu --agent main`，会向真实agent提交事件；不占自动机会额度。仅试读来源、不发消息：`python3 agents/main/workspace/moyu/connect.py probe d`。`connect.py status`看状态，`enable a`验证并启用，`disable a`停用指定来源；骰子preview/show只看不写，next只抽站不发消息。关闭整个随机聊天与摸鱼用scheduler.randomChat=false并重启定时脚本。

公开API/RSS直接读。需登录的X、Instagram、小红书、Reddit共用OpenCLI，安装`npm install -g @jackwener/opencli@2.0.2`。运行`python3 agents/main/workspace/moyu/browser.py`打开专用浏览器窗口，手动登录网站；不需要日常Chrome或扩展。`browser.py --check`只检查路径；`browser.py --headless`用于服务器后台读取，进程由自己的终端或systemd等进程管理器保持。浏览器不是本应用默认启动的进程；未接账号时无需运行。Ctrl+C关闭，不新增另一套计时器。

浏览器资料在workspace/moyu/browser/.profile，端口在摸鱼config.json的browser.port，默认19222；executable为空自动找本系统浏览器，也可填写自备程序路径。fetch.py明确连该端口，不依赖OpenCLI全局默认profile。多agent应各用自己的目录和不同端口。资料目录随agent备份，但跨macOS/Linux的Cookie可能受系统加密或平台校验影响需要重新登录；浏览器可执行程序须安装目标系统版本，不能复制macOS程序到Linux。调试端口只用于本机，不直接公开。账号未实测读到内容前来源保持关闭；Threads仍是待选接入。

当前DeepSeek Flash的Responses原生web_search被供应商忽略，runtime.webEnabled=true只证明工具被注册，不证明真有联网搜索。Pi的find/grep是文件工具；公开抓取与OpenCLI不依赖模型自带搜索。供应商文档：https://api-docs.deepseek.com/guides/responses_api.md 。OpenCLI安装与平台清单：https://github.com/jackwener/OpenCLI 。
