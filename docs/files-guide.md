# 文件如何参与运行

网页会显示当前安装位置的绝对路径。本文以默认 agents/<agent_id>/ 为例；每个 agent 都有自己的文件。配置是固定规则，下面文件是人格文字、当前数据或可执行脚本。

## Agent 独立配置

路径：`agents/<agent_id>/config.yaml`。

当前 agent 的模型、记忆、情绪、定时、工具和聊天绑定。主目录只保存公共连接与公共默认值。

**谁更新、何时生效。** 这里可查看；请在配置表单修改，保存并重启后应用。模型密钥在同目录 .env，使用专用凭据页编辑。

1. 读取公共默认后加载此文件。保存只写当前 agent 的明确设置，缺省项保持缺省；新增字段未填写时使用公共默认。
2. 表单保存验证所有字段；外部编辑后点重新读取，再重启应用。修改自己的 schedule.ts 后可仅重启自己的定时进程。

实现位置：`src/config/store.ts`；`src/config/schema.ts`。

## 定时与随机事件脚本

路径：`agents/<agent_id>/schedule.ts`。

常驻运行的定时程序。它只在合适时刻发内部事件，是否回复、怎样干活仍由正常四层流程决定。

**谁更新、何时生效。** 你或 agent 改脚本后，点“重启定时脚本”。脚本启动时重新读配置并重新抽随机等待；不补跑错过事件，不保存任务进度。

1. 每日时间按 memory.sleepCron 计算：先调 memory/reindex，再按 reviewEnabled 发送要求读 personal-memory Skill 的整理提醒。提醒里填入批次大小、建议条数和小细节选项。
2. 随机聊天抽取 min 到 max 分钟的等待，到期检查 activeStart/activeEnd；在时段内才把“此刻有一段空闲……”发到 /v1/events。做梦按 dreamCron 发 dream-diary 提醒。
3. 收到的新事件存入第二层并触发同一套取消/编排/执行逻辑；没有后台小人格。自定义脚本只有读取某个配置字段，该字段才对它生效。

实现位置：`scripts/schedule.ts`；`src/scheduler.ts`；`src/layer2/runtime.ts · ingress`。

## 基础行为提示词

路径：`agents/<agent_id>/prompts/system.md`。

当前 agent 自己的基础行为要求（主目录同名文件是新建模板），例如如何理解打断、如何用工具、怎样把记忆作为主观经历参考。每个 agent 的 persona 在它后面追加。

**谁更新、何时生效。** 修改个人文件后下一轮读取；修改主目录模板只影响新建。若有效配置里设置了 prompts.system，程序优先使用那段文字，此文件暂时不会被读取。

1. ContextBuilder 先取 cfg.prompts.system；没有该值才读本文件。然后拼 persona，合计先限制到 4000 token。后续还会附上 [Project]、[Style] 和独立的历史/记忆/状态材料。
2. 例如加入“交付文件时用附件工具”，会改变主模型收到的指令，但不会注册原本关闭的工具；runtime.toolsEnabled 等开关仍决定实际工具清单。
3. 这是主对话指令，不直接改变 query、rerank 或 emotion 小模型的规则；那些指令分别由 prompts 下的对应配置覆盖。

实现位置：`src/layer3/context.ts · build`；`src/config/schema.ts · prompts`。

## 人格与交流习惯

路径：`agents/<agent_id>/persona.md`。

这个 agent 的身份、性格、对你的态度和相处方式。它直接参与每轮回复，不只是供人查阅的介绍。

**谁更新、何时生效。** 你或 agent 编辑；保存后下一轮读取。已经开始的那一轮仍用开始时读取的文字。

1. ContextBuilder.build 每轮读这份 persona，拼在基础 system prompt 后面。两份文字合计先取前 4000 token，再附上环境目录和表达偏好；过长时后面的内容可能被截去。
2. 例如增加“闲聊直接接话，不必每次追问”，会进入主模型的 system；不会给程序增加一个禁止问号的判断。style 也会一起影响表达，应避免两处互相冲突。
3. 回合后判断心情时，afterRun 也读 persona，最多取前 1000 token，帮助小模型按这个人格理解经历。系统不会因为改了显示名而自动重写此文件。

实现位置：`src/layer3/context.ts · build`；`src/layer3/memory.ts · afterRun`。

## 长期记忆

路径：`agents/<agent_id>/memory.json`。

长期记忆的原文。主 agent 按 Skill 或你的要求写入；程序另外维护查找所需的描述、向量和评分。它不是每轮全部塞给模型的聊天历史。

**谁更新、何时生效。** 编辑后，下次搜索先同步文字内容。语义搜索所需的向量按每日或文件静置后的维护更新；单纯保存文件不代表向量已经完成。

1. MemoryService.items 校验 memory 数组。已有合法条目保持独立；缺少 id 时生成编号。当前进程碰到错误 JSON 会保留上一份有效内容供搜索，但不会把错误文件擅自改好。
2. sync 比较条目内容摘要和向量模型标识。变化的条目更新文字副本并清空旧描述/向量；搜索用副本在同一 agent 的 .runtime/search-index.json，记忆原文仍是这里。
3. 每轮 recall 用查询线索挑选条目，按摘要、详情和总 token 空间裁取后，放进 user 背景中的 [Recalled memories: subjective past experiences]。不是每轮把整份 JSON 给主模型。
4. 真正重温后更新的是搜索副本里的 strength、strengthAt、familiarity，以及 state.json 的激活时间；不会自动改原条目的 importance 或删除忘得久的原文。

|字段|用途与影响|
|---|---|
|`memory`|最外层的记忆数组，每项是一条独立经历。|
|`id`|稳定编号，用于索引、工具查阅和回合后确认重温；新增条目用不同编号。|
|`occurred_at`|事情发生时间，使用有效 ISO 时间；影响时间邻居、联想及情绪关联衰减，不是记下它的时间。|
|`summary`|简短摘要，文字匹配会使用；自动回忆主要向模型展示它。|
|`details`|具体经过与理解；参与搜索，但只有排名靠前且预算够的条目自动附带详情。|
|`people`|相关人物，参与文字搜索，也用于额外联想寻找共同人物。|
|`emotion`|事件当时的主观情绪；搜索时与当前情绪名称匹配，影响关联加分。|
|`importance`|1–5，由写记忆的模型或你设置；同时影响遗忘半衰期和排序加分，程序不会自动改它。|
|`type`|默认 event，标明记忆类型；不是决定回复场景的开关。|
|`其他字段`|会保留；默认文字搜索只用 summary/details/people，维护模型生成检索描述时可以看完整条目。|

实现位置：`src/layer3/memory.ts · items / sync / recall / afterRun`；`templates/skills/personal-memory/SKILL.md`。

## 当前心情与状态

路径：`agents/<agent_id>/state.json`。

此刻的心情、感受和正在想着的事情。它是一份会被程序更新的当前状态；config.yaml 中的 state/drives 才是控制变化的固定规则。

**谁更新、何时生效。** 程序经 updateState 串行写回，网页只读。准备上下文时、回合后处理时等会更新；单纯查看状态的 API 会补算时间消退，但不保证立即写文件。

1. state() 从 updated_at 算过去多久，把 mood 和各项 drives 向平常值恢复，把 emotions 向 0 消退，并移除过期念头、关注点和激活标记。恢复公式见对应配置旁的完整步骤。
2. 第四层结束且有文字、工具或主动沉默时，后台 afterRun 调 emotion 模型，输入人格、当前状态、这轮经历和候选回忆；不等 Telegram 送达。结果经过倍率和上下限处理，再写这里。
3. 下一轮 ContextBuilder 只取前 thoughtContextItems 条念头，每条限制 thoughtContextTokens；状态整体限制 stateTokens，放到 [Current state]。主模型参考这些感受，不需要逐项念出来。

|字段|用途与影响|
|---|---|
|`mood`|整体心情，0–100。baseline 是它逐渐恢复到的平常值，不是这个字段的镜像。|
|`emotions`|具体情绪名称与分数，按 emotionLabels 接受新变化，随时间向 0 消退。|
|`drives`|好奇、思念、疲惫等分数，每项有独立常态、恢复速度和敏感度。|
|`cause`|最近一次小模型给出的变化原因；不是所有历史原因的列表。|
|`thoughts`|当前念头，每条有 text 和 at；新列表会替换旧列表，过期会移除。|
|`focus`|当前关注点；focus_updated_at 决定它何时过期。|
|`activation`|记忆编号到激活时刻的映射。自动召回只给没有标记的条目补时间，真正重温会刷新时间。|
|`conversation_context`|第二层提供的同一回复目标交流间隔、上一段回复时间和 response_id；不是平台送达时间。|
|`updated_at`|上次状态补算/保存的时间基准，后续按它计算自然消退。|

实现位置：`src/layer3/memory.ts · state / updateState / afterRun`；`src/layer3/context.ts · build`；`src/layer2/store.ts · gap`。

## Agent 环境手册

路径：`agents/<agent_id>/SYSTEM.md`。

给 agent 自己查阅的环境手册，解释自己的目录、历史、记忆和管理方法。文件名叫 SYSTEM，但它不等于每轮发送的 system prompt。

**谁更新、何时生效。** 初始化时生成；以后由你或 agent 编辑。改配置不会自动重写已有内容；模型下一次主动读文件时才能看到修改。

1. 每轮 [Project] 会提供 agent 根目录、workspace、memory 路径和 Skills 清单；主模型根据需要用 read 打开这份手册，不自动把全文加入 context。
2. 例如修改“记忆放在哪”只是改变模型读到的说明，并不会让程序迁移 memory.json。目录变更必须让实际配置、文件位置和这里的说明一致。
3. 手册可能包含初始化时的整理建议。修改 reviewBatchTokens 等参数后，应检查这里和 Skill 的文字，避免旧建议与定时提醒不同。

实现位置：`src/init.ts`；`src/layer3/context.ts · build`。

## 基础行为提示词

路径：`prompts/system.md`。

当前 agent 自己的基础行为要求（主目录同名文件是新建模板），例如如何理解打断、如何用工具、怎样把记忆作为主观经历参考。每个 agent 的 persona 在它后面追加。

**谁更新、何时生效。** 修改个人文件后下一轮读取；修改主目录模板只影响新建。若有效配置里设置了 prompts.system，程序优先使用那段文字，此文件暂时不会被读取。

1. ContextBuilder 先取 cfg.prompts.system；没有该值才读本文件。然后拼 persona，合计先限制到 4000 token。后续还会附上 [Project]、[Style] 和独立的历史/记忆/状态材料。
2. 例如加入“交付文件时用附件工具”，会改变主模型收到的指令，但不会注册原本关闭的工具；runtime.toolsEnabled 等开关仍决定实际工具清单。
3. 这是主对话指令，不直接改变 query、rerank 或 emotion 小模型的规则；那些指令分别由 prompts 下的对应配置覆盖。

实现位置：`src/layer3/context.ts · build`；`src/config/schema.ts · prompts`。

## 定时与随机事件脚本

路径：`scripts/schedule.ts`。

常驻运行的定时程序。它只在合适时刻发内部事件，是否回复、怎样干活仍由正常四层流程决定。

**谁更新、何时生效。** 你或 agent 改脚本后，点“重启定时脚本”。脚本启动时重新读配置并重新抽随机等待；不补跑错过事件，不保存任务进度。

1. 每日时间按 memory.sleepCron 计算：先调 memory/reindex，再按 reviewEnabled 发送要求读 personal-memory Skill 的整理提醒。提醒里填入批次大小、建议条数和小细节选项。
2. 随机聊天抽取 min 到 max 分钟的等待，到期检查 activeStart/activeEnd；在时段内才把“此刻有一段空闲……”发到 /v1/events。做梦按 dreamCron 发 dream-diary 提醒。
3. 收到的新事件存入第二层并触发同一套取消/编排/执行逻辑；没有后台小人格。自定义脚本只有读取某个配置字段，该字段才对它生效。

实现位置：`scripts/schedule.ts`；`src/scheduler.ts`；`src/layer2/runtime.ts · ingress`。

## 技能说明

路径：`agents/<agent_id>/skills/personal-memory/SKILL.md`。

指导主 agent 怎样从原始聊天整理长期记忆，包括条目格式、读取进度和如何保留旧记忆。

**谁更新、何时生效。** 你或 agent 编辑；目录和说明下一轮重新发现。脚本在下一次被执行时读取新内容；安装 Skill 不会自动安装依赖。

1. ContextBuilder 只在 [Project] 放技能名称、简介、SKILL.md 路径。模型要用它时再 read 全文；改 Skill 正文不会让每次聊天的 system 自动变长。
2. personal-memory 要求先读 SYSTEM.md、memory.json 和 history，按 .runtime/memory-review.json 记下已处理范围，再追加值得保留的经历并原子替换 memory.json。系统之后才维护搜索描述和向量。
3. 默认调度提醒可能指定这个 Skill；你也可以在普通聊天要求使用。已有运行已经读过的说明不会被追溯替换。

实现位置：`src/layer3/context.ts · skillsList / build`；`src/layer4/pi.ts · tool registration`。

## 技能说明

路径：`agents/<agent_id>/skills/dream-diary/SKILL.md`。

指导主 agent 根据近期经历写一段梦或想象，并区分虚构与真实。

**谁更新、何时生效。** 你或 agent 编辑；目录和说明下一轮重新发现。脚本在下一次被执行时读取新内容；安装 Skill 不会自动安装依赖。

1. ContextBuilder 只在 [Project] 放技能名称、简介、SKILL.md 路径。模型要用它时再 read 全文；改 Skill 正文不会让每次聊天的 system 自动变长。
2. dream-diary 让模型读少量近期经历，在 workspace/dreams/ 写梦境文件。分享梦境后，经普通聊天记录进入未来记忆整理；不直接把虚构情节写成真实记忆。
3. 默认调度提醒可能指定这个 Skill；你也可以在普通聊天要求使用。已有运行已经读过的说明不会被追溯替换。

实现位置：`src/layer3/context.ts · skillsList / build`；`src/layer4/pi.ts · tool registration`。

## 工作文件

路径：`agents/<agent_id>/workspace/工作文件`。

这个 agent 的工作文件，可以是笔记、代码、下载材料或生成的交付物。文件存在不代表已经进入模型上下文。

**谁更新、何时生效。** 你或 agent 通过工具修改；保存即写入真实文件。模型下一次 read 时得到新内容；以前工具返回里的旧内容仍保留。

1. 主模型在 [Project] 看见 workspace 位置，按任务使用 read/write/edit/bash。工具调用和结果回第二层保存。
2. 要把文件发给你，需要调用 send_attachment 等发送工具，单写出路径不会自动发送。图片作为附件和模型输入也是独立步骤。
3. 普通工作文件不会自动变成长期记忆；需要主模型按照记忆 Skill 整理到 memory.json，之后才参与记忆搜索。

实现位置：`src/layer4/pi.ts`；`src/layer4/tools.ts`。

## 完整手册

路径：`docs/manual.md`。

四层职责、模型分工、数据位置与阅读入口。

**谁更新、何时生效。** 说明文档，编辑不会改变运行算法或自动注入聊天上下文。

1. 这是一份说明文档，人和维护程序的 AI 主动打开时阅读。应用不会自动执行其中的步骤，也不会每轮把它加入模型 context。
2. 修改文档不会自动修改程序算法；需要同步对应代码或配置。实际行为以实现和验证记录为准。

## 逐项配置说明

路径：`docs/configuration-reference.md`。

按实际代码列出各字段作用、默认值、生效时间和限制，与网页帮助共用来源。

**谁更新、何时生效。** 说明文档，编辑不会改变运行算法或自动注入聊天上下文。

1. 这是一份说明文档，人和维护程序的 AI 主动打开时阅读。应用不会自动执行其中的步骤，也不会每轮把它加入模型 context。
2. 此页由 npm run docs 生成，来源是 config/guide.ts、learning.ts、processing-guide.ts 和 schema 默认值。维护者应修改来源再生成，直接修改这份生成稿会在下次生成时被覆盖。

## 内部流程与算法

路径：`docs/internals.md`。

消息流、压缩、召回、状态计算、取消和恢复的实现说明。

**谁更新、何时生效。** 说明文档，编辑不会改变运行算法或自动注入聊天上下文。

1. 这是一份说明文档，人和维护程序的 AI 主动打开时阅读。应用不会自动执行其中的步骤，也不会每轮把它加入模型 context。
2. 修改文档不会自动修改程序算法；需要同步对应代码或配置。实际行为以实现和验证记录为准。

## 四层协议与 API

路径：`docs/protocol.md`。

事件、目标、执行、发送和外部调用的协议。

**谁更新、何时生效。** 说明文档，编辑不会改变运行算法或自动注入聊天上下文。

1. 这是一份说明文档，人和维护程序的 AI 主动打开时阅读。应用不会自动执行其中的步骤，也不会每轮把它加入模型 context。
2. 修改文档不会自动修改程序算法；需要同步对应代码或配置。实际行为以实现和验证记录为准。
