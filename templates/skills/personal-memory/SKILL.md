---
name: personal-memory
description: 整理原始经历并更新自己的长期记忆，在每日整理或用户要求记住事情时使用。
---

读取 agent 根目录的 SYSTEM.md、memory.json 和 history/。每条 JSONL 是真实记录，工具长输出在 history/tools/。使用 .runtime/memory-review.json 的 through_seq 或最近整理时间分批阅读，避免整份历史塞入一次上下文。每次建议读约 12000 token、写最多 8 条；实际值见 SYSTEM.md。

把值得保留的事件追加到 memory 数组。每条包含 id（唯一字符串）、occurred_at（事情发生时间）、summary、details、people、emotion、importance（1–5）、type（默认 event）。已有条目结构兼容，可把新的理解写入 details 或已有自定义字段。没有必要时不另建文件。

保留具体细节和主观感受，不把工具跑过当作任务成功。不编造经历，不把做梦当真实事件。新的理解可以成为独立条目，旧记忆不因观点改变被直接覆盖。避免逐条复写流水账，也不为每条记忆添加出处、记录时间或关联编号。

写入前重新读取 memory.json，保留已有条目，使用临时文件+原子替换更新，保证 JSON 有效。只推进已处理范围的整理游标；中断后可以继续。系统负责生成检索描述、向量和衰减，你只维护真实记忆文件。通常整理完保持沉默，使用 finish_without_reply；有值得分享的想法时可以正常回复。
