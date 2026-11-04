/** Catalog is presentation metadata only; AdminFiles still enforces file permissions. */
function baseDescription(p: string) {
  const make = (
    category: string,
    title: string,
    purpose: string,
    effect: string,
    advanced = false,
  ) => ({ category, title, purpose, effect, advanced });
  const name = p.split("/").at(-1)!;
  if (p.includes("/skills/"))
    return make(
      "skills",
      name === "SKILL.md" ? "技能说明" : name,
      "该 Skill 的说明或配套脚本。主模型先读取说明，再决定使用工具执行。",
      "保存后下一轮发现；脚本依赖需自行准备。Skills 页面统一管理。",
    );
  if (p.includes("/workspace/moyu/"))
    return make(
      "workspace",
      name === "config.json" ? "摸鱼来源与概率" : name,
      "摸鱼目录：config.json 控制来源开关、摸鱼/纯聊/安静权重、日上限和抽站数量；SOP.md 解释参数与行为；dice.py 抽签，fetch.py 读取公开源或OpenCLI，connect.py 检查并启停来源。state.json只保存当天额度和最近抽站，last-edition.json/fetch-log.jsonl是抓取结果，不代表已发送。",
      "config.json 和 SOP.md 保存后下次机会读取；间隔、活跃时段和总开关在个人config.yaml的scheduler，需重启定时脚本。社交源启用前先用connect.py probe验证登录；登录资料保存在摸鱼目录browser/.profile，不存进此配置。完整操作见运行与迁移文档的摸鱼章节。",
      /\.(pyc|log|lock)$/.test(p) ||
        ["last-edition.json", "fetch-log.jsonl", "state.json"].includes(name),
    );
  if (p.includes("/workspace/"))
    return make(
      "workspace",
      name,
      "这个 agent 的工作文件或生成产物；只在模型通过工具读取时进入上下文。",
      "保存即修改真实文件，不必重启；已被模型读过的旧内容不会被追溯替换。",
      /\.(pyc|log|lock)$/.test(p),
    );
  if (name === "prompt-mapping.yaml")
    return make(
      "prompts",
      "状态与时间的提示词映射",
      "把心情、情绪、驱动力和时间间隔变成自然文字。可修改阈值、展示数量、名称和句子模板；只改表达，不改情绪评分。",
      "保存后下一轮读取，无需重启。缺少字段用内置默认；数组整组替换。主目录同名文件只用于新建模板，不覆盖个人文件。",
      p.startsWith("prompts/"),
    );
  if (name === "auxiliary.yaml")
    return make(
      "prompts",
      "辅助规则、历史整理与状态表达",
      "summary 让主模型整理历史摘要、query 提炼查询、searchDescription 生成检索句、rerank 重排、emotion 评分、spark 生成本轮想象灵感、stateExpression 指导主模型表达。每个键是一段可编辑提示词；保留规定的 JSON 返回字段。",
      "个人文件保存后下次调用读取。config 的 prompts 同名覆盖优先；缺项用内置默认。数值范围与超时仍在配置表单。",
      p.startsWith("prompts/"),
    );
  if (name === "schedule.once.json")
    return make(
      "scheduler",
      "一次性任务",
      "tasks 数组：id 为唯一编号，at 为带时区的绝对时间，text 为内部提醒，enabled 控制启用。UI 配置→主动行为与定时可增删启停；也可直接编辑。",
      "保存后重启当前 agent 调度。未来时间继续等待，过期跳过；无补跑、无完成状态。定时到期只表示提交第二层，并不保证模型完成或渠道送达。",
    );
  if (name === "config.yaml")
    return make(
      "agent",
      "Agent 独立配置",
      "当前 agent 的模型、记忆、情绪、定时、工具和聊天绑定。主目录只保存公共连接与公共默认值。",
      "这里可查看；请在配置表单修改，保存并重启后应用。模型密钥在同目录 .env，使用专用凭据页编辑。",
    );
  if (name === "persona.md")
    return make(
      "agent",
      "人格与交流习惯",
      "定义身份、性格、关系、兴趣、表达习惯和个人约定；通用执行、工具和发送规则放在 prompts/system.md。两份仍拼入同一 system，合计先受4000 token截取。",
      "保存后下一轮读取，不需要重启。",
    );
  if (name === "memory.json")
    return make(
      "agent",
      "长期记忆",
      "主 agent 按 Skill 写入的经历、摘要和详情。第三层检索并选择部分条目，不会每轮全部发给模型。",
      "保存后下次召回读取原内容；向量按 daily/debounced 维护，或手动维护索引。",
    );
  if (name === "state.json")
    return make(
      "agent",
      "当前心情与状态",
      "程序维护心情、情绪、驱动力、念头、激活、交流间隔。第四层整轮结束后更新，下一轮作为背景。",
      "只读。改变回稳规则请改配置 state/drives，不能用编辑器覆盖正在更新的状态。",
    );
  if (name === "SYSTEM.md")
    return make(
      "agent",
      "Agent 环境手册",
      "告诉模型自己的目录、记录、记忆和工具位置。模型按需读，不会整篇自动变成 system prompt。",
      "保存后模型下次主动读取才看到。首次生成后不随配置自动重写，迁移路径时需检查。",
    );
  if (p.startsWith("prompts/") || p.includes("/prompts/"))
    return make(
      "prompts",
      name === "system.md" ? "基础行为提示词" : name,
      "agent/prompts/system.md 管运行、上下文、工作、工具、发送和权限，不放专属人物设定；主目录同名文件是新建模板。persona.md 管身份、性格、关系、表达与个人约定。第三层分段拼入同一system，再附环境和风格。auxiliary.yaml 管理辅助模型规则及状态表达。其他文件只有代码或配置实际引用才会使用。",
      "个人 system.md 保存后下一轮读取；根目录模板只影响新建。若 prompts.system 有覆盖，则文件暂不生效。",
      p.startsWith("prompts/"),
    );
  if (p.startsWith("scripts/") || name === "schedule.ts")
    return make(
      "scheduler",
      name === "schedule.ts" ? "定时与随机事件脚本" : name,
      "agent/schedule.ts 只为自己触发随机聊天、每日记忆整理和做梦机会；主目录 scripts/schedule.ts 是新建模板。其他脚本需要被实际调用才会运行。",
      "保存 schedule.ts 后点“重启定时脚本”；只重置当前 agent 的随机时间，其他 agent 不受影响，不补发错过的任务。",
      name !== "schedule.ts" || p.startsWith("scripts/"),
    );
  const docs: Record<string, [string, string]> = {
    "README.md": ["项目入口", "项目简介、启动方式和文档链接。"],
    "开始使用.md": ["开始使用", "首次启动与连接的操作步骤。"],
    "manual.md": ["完整手册", "四层职责、模型分工、数据位置与阅读入口。"],
    "console.md": [
      "网页操作指南",
      "每个页面怎样操作，暂存、保存、重启与排查步骤。",
    ],
    "configuration-guide.md": [
      "按需求调参",
      "从想改变的体验出发，说明配置组合和生效边界。",
    ],
    "configuration-reference.md": [
      "逐项配置说明",
      "按实际代码列出各字段作用、默认值、生效时间和限制，与网页帮助共用来源。",
    ],
    "files-guide.md": [
      "文件如何参与运行",
      "每份文件由谁维护、何时读取、进入哪段上下文，以及内部字段的用途。",
    ],
    "internals.md": [
      "内部流程与算法",
      "消息流、压缩、召回、状态计算、取消和恢复的实现说明。",
    ],
    "protocol.md": [
      "四层协议与 API",
      "事件、目标、执行、发送和外部调用的协议。",
    ],
    "operations.md": [
      "部署、备份与迁移",
      "运行环境、服务器部署和数据恢复流程。",
    ],
    "validation.md": [
      "验证记录",
      "哪些能力有自动测试或真实模型验证，以及测试边界。",
    ],
    "config.md": ["简要默认参数表", "由 schema 生成的默认参数速查。"],
    "design-reference.md": [
      "早期设计讨论",
      "设计背景，不作为已实现功能的保证。",
    ],
    "AGENTS.md": [
      "开发协作规则",
      "供维护项目的 AI 阅读，规定代码边界、测试和文档要求。",
    ],
  };
  if (docs[name])
    return make(
      "docs",
      ...docs[name],
      "说明文档，编辑不会改变运行算法或自动注入聊天上下文。",
      [
        "design-reference.md",
        "config.md",
        "AGENTS.md",
        "README.md",
        "开始使用.md",
      ].includes(name),
    );
  return make(
    "advanced",
    name,
    "辅助文件、机器 schema 或其他资料；不会仅因存在就自动参与编排。",
    "按对应代码引用方式使用；日常无需修改。",
    true,
  );
}

export function describeFile(p: string) {
  const base = baseDescription(p),
    name = p.split("/").at(-1)!;
  const detail = (
    purpose: string,
    effect: string,
    steps: string[],
    fields: Record<string, string> = {},
    code: string[] = [],
  ) => ({ ...base, purpose, effect, steps, fields, code });
  if (name === "prompt-mapping.yaml")
    return detail(
      base.purpose,
      base.effect,
      [
        "ContextBuilder每轮读取当前agent的个人文件，缺字段补内置默认，再交stateContext渲染。此映射渲染不会调用小模型、改变state.json分数或覆盖config；text.spark控制已生成灵感的包装，text.thought和text.focus控制旧念头与关注点措辞。出现概率在个人config的context.sparkProbability、state.thoughtContextProbability、state.focusContextProbability；心情、念头和关注受stateTokens限制，灵感受sparkTokens限制，合并后再受第三层总预算限制。",
        "bands按min从小到大写，第一档必须从0开始；达到min就进入该档，使用最高符合档。心情/情绪单位是分数，gap/cause单位是秒。数组修改时写完整列表。",
        "网页保存校验结构、阈值顺序和占位符。未知字段、负数、重复或倒序阈值、错拼占位符会拒绝；直接写文件导致格式错误则下一轮明确报错，不悄悄使用错误规则。填{}恢复内置默认；删除某个字段恢复该字段默认。",
      ],
      {
        mood: "bands指定分数→说法；template用{label}。心情先四舍五入。",
        emotions:
          "min最低展示分数；maxItems最多展示几项，0隐藏；bands强度分档；item用{name}/{label}，template用{items}，separator连接各项。",
        drives:
          "minDeviation与自身baseline相差多少才展示；maxItems最多几项；names中文名称；stronger/weaker比较词；item用{name}/{direction}，template用{items}，separator连接。",
        gap: "bands以秒分档，text可用{duration}（自动显示分钟/小时/天）；unknown是无历史时的说法。state.gap仍是总开关。",
        cause:
          "enabled开关旧缘由；bands按距assessed_at的秒数分档；unknown为无评分时间的旧记录；dated用{label}/{time}；template用{when}/{cause}。",
        text: "now当前时间用{time}；thought念头和spark本轮灵感用{text}；focus关注用{items}，focusSeparator连接关注。念头数量和长度仍由原有state配置控制。",
      },
      [
        "src/config/prompt-mapping.ts",
        "src/layer3/state-context.ts",
        "src/layer3/context.ts",
      ],
    );
  if (name === "auxiliary.yaml")
    return detail(
      base.purpose,
      base.effect,
      [
        "auxiliaryPrompt 按配置覆盖 → 个人文件对应键 → 内置默认的顺序读取。文件为 YAML 映射，每项是一段提示词；UI 保存校验键名、类型与非空内容。",
        "summary 输出非空 summary 字符串，历史资料放在 conversation_to_summarize 中，不继续旧聊天；query 输出 queries 数组；searchDescription 输出 search_text；rerank 输出 ids；emotion 输出 mood/emotions/drives/cause/thoughts/focus/memory_mentions；spark 输出spark字符串，空字符串表示不提供联想，不写记忆或状态。stateExpression 是直接给主模型的背景指导，不调用辅助模型。",
        "emotion 在整轮结束后读取本轮输入/结果，以及开跑前截取的最近最多五轮交流（连续输入与回复分段合为一轮，最多 2000 token 且不超过 state.inputTokens 的三分之一）；旧交流只帮助理解，不重复计分。cause 区分自己的感受与对用户的猜测，thoughts/focus 可为空。emotion 的 policy 自动包含允许名称、启用驱动力和数值限幅。评分先按分数给增量，程序再乘敏感度并限幅一次。模型与超时仍从 models/state/memory 配置读取；查询缓存到期才重算相同输入。",
      ],
      {},
      [
        "src/config/auxiliary.ts",
        "src/layer3/memory.ts",
        "src/layer3/context.ts",
      ],
    );
  if (name === "schedule.once.json")
    return detail(
      base.purpose,
      base.effect,
      [
        "Scheduler 启动或重启时先校验 tasks；每项包含唯一 id、带时区的 at、任务说明 text、enabled。未来任务按绝对时间等待，过去时间跳过。",
        "到期生成稳定事件编号，通过现有 POST /v1/events 进入第二层。关闭或删除后重启才取消尚未触发计时；已入第二层事件不会撤回。失败记日志，不自动重试；没有任务完成状态。",
        "只要 scheduler.enabled 开启且自己的脚本在运行，宿主就管理此文件，不要求自定义脚本自行读取。更换脚本仍保留一次性任务。",
      ],
      {},
      ["src/once-tasks.ts", "src/scheduler.ts", "src/admin/files.ts"],
    );
  if (name === "config.yaml")
    return detail(
      base.purpose,
      base.effect,
      [
        "读取公共默认后加载此文件。保存只写当前 agent 的明确设置，缺省项保持缺省；新增字段未填写时使用公共默认。",
        "表单保存验证所有字段；外部编辑后点重新读取，再重启应用。修改自己的 schedule.ts 后可仅重启自己的定时进程。",
      ],
      {},
      ["src/config/store.ts", "src/config/schema.ts"],
    );
  if (name === "persona.md")
    return detail(
      "这个 agent 的身份、性格、关系、兴趣、表达习惯，以及用户特定偏好和信息边界。它直接参与每轮回复；通用工具与执行规则放在 prompts/system.md。",
      "你或 agent 编辑；保存后下一轮读取。已经开始的那一轮仍用开始时读取的文字。",
      [
        "ContextBuilder.build 每轮读取，以[Persona]标记拼在[Operating rules]基础规则后；仍是同一API system角色。两份文字合计先取前4000 token，再附上环境目录和表达偏好；过长时后面的内容可能被截去。",
        "例如增加“闲聊直接接话，不必每次追问”，会进入主模型的 system；不会给程序增加一个禁止问号的判断。style 也会一起影响表达，应避免两处互相冲突。",
        "回合后判断心情时，afterRun 也读 persona，最多取前 1000 token，帮助小模型按这个人格理解经历。系统不会因为改了显示名而自动重写此文件。",
      ],
      {},
      ["src/layer3/context.ts · build", "src/layer3/memory.ts · afterRun"],
    );
  if (name === "memory.json")
    return detail(
      "长期记忆的原文。主 agent 按 Skill 或你的要求写入；程序另外维护查找所需的描述、向量和评分。它不是每轮全部塞给模型的聊天历史。",
      "编辑后，下次搜索先同步文字内容。语义搜索所需的向量按每日或文件静置后的维护更新；单纯保存文件不代表向量已经完成。",
      [
        "MemoryService.items 校验 memory 数组。已有合法条目保持独立；缺少 id 时生成编号。当前进程碰到错误 JSON 会保留上一份有效内容供搜索，但不会把错误文件擅自改好。",
        "sync 比较条目内容摘要和向量模型标识。变化的条目更新文字副本并清空旧描述/向量；搜索用副本在同一 agent 的 .runtime/search-index.json，记忆原文仍是这里。",
        "每轮 recall 用查询线索挑选条目，按摘要、详情和总 token 空间裁取后，放进 system 参考背景中的 [Recalled memories: subjective past experiences]。不是每轮把整份 JSON 给主模型。",
        "真正重温后更新的是搜索副本里的 strength、strengthAt、familiarity，以及 state.json 的激活时间；不会自动改原条目的 importance 或删除忘得久的原文。",
      ],
      {
        memory: "最外层的记忆数组，每项是一条独立经历。",
        id: "稳定编号，用于索引、工具查阅和回合后确认重温；新增条目用不同编号。",
        occurred_at:
          "事情发生时间，使用有效 ISO 时间；影响时间邻居、联想及情绪关联衰减，不是记下它的时间。",
        summary: "简短摘要，文字匹配会使用；自动回忆主要向模型展示它。",
        details:
          "具体经过与理解；参与搜索，但只有排名靠前且预算够的条目自动附带详情。",
        people: "相关人物，参与文字搜索，也用于额外联想寻找共同人物。",
        emotion: "事件当时的主观情绪；搜索时与当前情绪名称匹配，影响关联加分。",
        importance:
          "1–5，由写记忆的模型或你设置；同时影响遗忘半衰期和排序加分，程序不会自动改它。",
        type: "默认 event，标明记忆类型；不是决定回复场景的开关。",
        其他字段:
          "会保留；默认文字搜索只用 summary/details/people，维护模型生成检索描述时可以看完整条目。",
      },
      [
        "src/layer3/memory.ts · items / sync / recall / afterRun",
        "templates/skills/personal-memory/SKILL.md",
      ],
    );
  if (name === "state.json")
    return detail(
      "此刻的心情、感受和正在想着的事情。它是一份会被程序更新的当前状态；config.yaml 中的 state/drives 才是控制变化的固定规则。",
      "程序经 updateState 串行写回，网页只读。准备上下文时、回合后处理时等会更新；单纯查看状态的 API 会补算时间消退，但不保证立即写文件。",
      [
        "state() 从 updated_at 算过去多久，把 mood 和各项 drives 向平常值恢复，把 emotions 向 0 消退，并移除过期念头、关注点和激活标记。恢复公式见对应配置旁的完整步骤。",
        "第四层结束且有文字、工具或主动沉默时，后台 afterRun 调 emotion 模型，输入人格、当前状态、这轮经历和候选回忆；不等 Telegram 送达。结果经过倍率和上下限处理，再写这里。",
        "下一轮 ContextBuilder 只取前 thoughtContextItems 条念头，每条限制 thoughtContextTokens；状态整体限制 stateTokens，放到 [Current state]。默认主模型看到心情底色、最强两项情绪、偏离常态的两项驱动力以及旧缘由；阈值、数量和措辞由个人prompt-mapping.yaml控制；完整数字不直接拼入。阈值与间隔映射见配置页“小模型行为与状态表达”。",
      ],
      {
        mood: "整体心情，0–100。baseline 是它逐渐恢复到的平常值，不是这个字段的镜像。",
        emotions:
          "具体情绪名称与分数，按 emotionLabels 接受新变化，随时间向 0 消退。",
        drives: "好奇、思念、疲惫等分数，每项有独立常态、恢复速度和敏感度。",
        cause: "最近一次小模型给出的变化原因；不是所有历史原因的列表。",
        thoughts:
          "当前念头，每条有 text 和 at；新列表会替换旧列表，过期会移除。",
        focus: "当前关注点；focus_updated_at 决定它何时过期。",
        activation:
          "记忆编号到激活时刻的映射。自动召回只给没有标记的条目补时间，真正重温会刷新时间。",
        conversation_context:
          "第二层提供的同一回复目标交流间隔、上一段回复时间和 response_id；不是平台送达时间。",
        assessed_at:
          "最近一次回合后评分的时间，标记缘由属于何时；读取和自然衰减不会刷新它。旧文件可无此项。",
        updated_at: "上次状态补算/保存的时间基准，后续按它计算自然消退。",
      },
      [
        "src/layer3/memory.ts · state / updateState / afterRun",
        "src/layer3/context.ts · build",
        "src/layer2/store.ts · gap",
      ],
    );
  if (name === "SYSTEM.md")
    return detail(
      "给 agent 自己查阅的环境手册，解释自己的目录、历史、记忆和管理方法。文件名叫 SYSTEM，但它不等于每轮发送的 system prompt。",
      "初始化时生成；以后由你或 agent 编辑。改配置不会自动重写已有内容；模型下一次主动读文件时才能看到修改。",
      [
        "每轮 [Project] 会提供 agent 根目录、workspace、memory 路径和 Skills 清单；主模型根据需要用 read 打开这份手册，不自动把全文加入 context。",
        "例如修改“记忆放在哪”只是改变模型读到的说明，并不会让程序迁移 memory.json。目录变更必须让实际配置、文件位置和这里的说明一致。",
        "手册可能包含初始化时的整理建议。修改 reviewBatchTokens 等参数后，应检查这里和 Skill 的文字，避免旧建议与定时提醒不同。",
      ],
      {},
      ["src/init.ts", "src/layer3/context.ts · build"],
    );
  if (p.endsWith("prompts/system.md"))
    return detail(
      "当前 agent 的通用运行规则（主目录同名文件是新建模板）：上下文、打断、工具、工作交付、发送和权限。身份名字、性格、亲密关系、兴趣及个别约定放persona.md，在[Persona]段追加。",
      "修改个人文件后下一轮读取；修改主目录模板只影响新建。若有效配置里设置了 prompts.system，程序优先使用那段文字，此文件暂时不会被读取。",
      [
        "ContextBuilder 先取 cfg.prompts.system；没有该值才读本文件。然后以[Operating rules]和[Persona]分别标记并拼接，合计先限制到4000 token，不新增模型调用。后续还会附上 [Project]、[Style] 和独立的历史/记忆/状态材料。",
        "例如加入“交付文件时用附件工具”，会改变主模型收到的指令，但不会注册原本关闭的工具；runtime.toolsEnabled 等开关仍决定实际工具清单。",
        "这是主对话指令，不直接改变 query、rerank 或 emotion 小模型的规则；那些指令读同目录 auxiliary.yaml，也可由 prompts 同名配置覆盖。",
      ],
      {},
      ["src/layer3/context.ts · build", "src/config/schema.ts · prompts"],
    );
  if (name === "schedule.ts")
    return detail(
      "常驻运行的定时程序。它只在合适时刻发内部事件，是否回复、怎样干活仍由正常四层流程决定。",
      "你或 agent 改脚本后，点“重启定时脚本”。脚本启动时重新读配置并重新抽随机等待；不补跑错过事件，不保存任务进度。",
      [
        "每日时间按 memory.sleepCron 计算：先调 memory/reindex，再按 reviewEnabled 发送要求读 personal-memory Skill 的整理提醒。提醒里填入批次大小、建议条数和小细节选项。",
        "随机聊天抽取 min 到 max 分钟的等待，到期检查 activeStart/activeEnd；在时段内才把“此刻有一段空闲……”发到 /v1/events。做梦按 dreamCron 发 dream-diary 提醒。",
        "收到的新事件存入第二层并触发同一套取消/编排/执行逻辑；没有后台小人格。自定义脚本只有读取某个配置字段，该字段才对它生效。",
      ],
      {},
      [
        "scripts/schedule.ts",
        "src/scheduler.ts",
        "src/layer2/runtime.ts · ingress",
      ],
    );
  if (p.includes("/skills/")) {
    const memory = p.includes("/personal-memory/"),
      dream = p.includes("/dream-diary/");
    return detail(
      memory
        ? "指导主 agent 怎样从原始聊天整理长期记忆，包括条目格式、读取进度和如何保留旧记忆。"
        : dream
          ? "指导主 agent 根据近期经历写一段梦或想象，并区分虚构与真实。"
          : "这个技能的使用说明或配套文件。模型知道有这个技能后，主动读取说明，再决定调用哪些工具执行。",
      "你或 agent 编辑；目录和说明下一轮重新发现。脚本在下一次被执行时读取新内容；安装 Skill 不会自动安装依赖。",
      [
        "ContextBuilder 只在 [Project] 放技能名称、简介、SKILL.md 路径。模型要用它时再 read 全文；改 Skill 正文不会让每次聊天的 system 自动变长。",
        memory
          ? "personal-memory 要求先读 SYSTEM.md、memory.json 和 history，按 .runtime/memory-review.json 记下已处理范围，再追加值得保留的经历并原子替换 memory.json。系统之后才维护搜索描述和向量。"
          : dream
            ? "dream-diary 让模型读少量近期经历，在 workspace/dreams/ 写梦境文件。分享梦境后，经普通聊天记录进入未来记忆整理；不直接把虚构情节写成真实记忆。"
            : "配套 Python、Shell 等脚本需要模型用工具调用。改说明影响它的选择，改脚本影响实际执行结果；工具关闭或依赖缺失时，只有说明也不能完成任务。",
        "默认调度提醒可能指定这个 Skill；你也可以在普通聊天要求使用。已有运行已经读过的说明不会被追溯替换。",
      ],
      {},
      [
        "src/layer3/context.ts · skillsList / build",
        "src/layer4/pi.ts · tool registration",
      ],
    );
  }
  if (p.includes("/workspace/moyu/"))
    return detail(
      base.purpose,
      base.effect,
      [
        "个人schedule.ts每次随机机会调用dice.py，选择moyu/chat/quiet。quiet不提交事件；其他选择只向同一个第二层接口提交内部事件。",
        "摸鱼事件提示主agent读SOP.md并通过Bash执行fetch.py；读取结果进入普通工具记录，不新增Skill或独立聊天。",
        "connect.py enable 来源代码先验证非空内容再改开关；disable停用。config.json每次重新读取，专用浏览器由browser.py启动，读取端口在browser.port。",
      ],
      {
        dailyOpportunities:
          "当天自动机会总上限，包含静默抽签；手动触发不占额度。",
        weights:
          "moyu/chat/quiet相对权重；分别是出去逛、原有纯聊天、不提交事件。",
        sourceCountMin: "一次摸鱼最少抽几个来源。",
        sourceCountMax: "一次摸鱼最多抽几个来源，最多8个。",
        avoidRecentRolls: "优先避开最近几次抽过的来源，来源不足才复用。",
        itemsPerSource: "每站最多读取多少候选，不是发给用户的条数。",
        requestTimeoutSeconds: "公开API/RSS每次请求的秒数上限。",
        browser:
          "port为专用浏览器的本机端口，executable为空自动找当前系统Chrome；资料在browser/.profile。换端口后重启浏览器。",
        sources:
          "每站name/ enabled/ kind，公开源url；OpenCLI源platform/command/timeoutSeconds。未验证的账号源保持关闭。",
      },
      ["scripts/schedule.ts · leisureEvent", "templates/activities/moyu"],
    );
  if (p.includes("/workspace/"))
    return detail(
      "这个 agent 的工作文件，可以是笔记、代码、下载材料或生成的交付物。文件存在不代表已经进入模型上下文。",
      "你或 agent 通过工具修改；保存即写入真实文件。模型下一次 read 时得到新内容；以前工具返回里的旧内容仍保留。",
      [
        "主模型在 [Project] 看见 workspace 位置，按任务使用 read/write/edit/bash。工具调用和结果回第二层保存。",
        "要把文件发给你，需要调用 send_attachment 等发送工具，单写出路径不会自动发送。图片作为附件和模型输入也是独立步骤。",
        "普通工作文件不会自动变成长期记忆；需要主模型按照记忆 Skill 整理到 memory.json，之后才参与记忆搜索。",
      ],
      {},
      ["src/layer4/pi.ts", "src/layer4/tools.ts"],
    );
  return detail(base.purpose, base.effect, [
    base.category === "docs"
      ? "这是一份说明文档，人和维护程序的 AI 主动打开时阅读。应用不会自动执行其中的步骤，也不会每轮把它加入模型 context。"
      : "这份文件只有被相应代码或工具读取时才会起作用；仅放在目录中不会自动参与编排。",
    name === "configuration-reference.md"
      ? "此页由 npm run docs 生成，来源是 config/guide.ts、learning.ts、processing-guide.ts 和 schema 默认值。维护者应修改来源再生成，直接修改这份生成稿会在下次生成时被覆盖。"
      : "修改文档不会自动修改程序算法；需要同步对应代码或配置。实际行为以实现和验证记录为准。",
  ]);
}
