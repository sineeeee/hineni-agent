# Working on Hineni

Read docs/manual.md first, then docs/configuration-guide.md for configuration work or docs/internals.md for implementation flows. Read docs/protocol.md before changing boundaries. Inspect only relevant sections; docs/design-reference.md is design background, not proof of implementation. Keep these guides synchronized when behavior changes.

- Keep vendor Pi/model types inside layer4. Public boundaries live in src/contracts.
- JSONL history is the append-only experience source; never delete it during compaction. SQLite is an index and operational queue.
- One active run per agent. New trigger batches cancel old work. Tool/reply/delivery events never trigger self-inference.
- Already queued outputs keep sending. Preserve response/chunk/part IDs and uncertain delivery outcomes.
- State update happens after layer4 run settlement, independently of sending. Memory and state are per agent.
- No automatic memory sharing between agents. Shared-group messages are explicit new experiences.
- Configuration must validate; every exposed control must affect behavior or be clearly identified as a prompt preference.
- New adapters implement Channel / Executor without changing the event protocol.
- Keep docs short, test behavioral boundaries, run npm run check, npm test and npm run build.
- Do not commit .env, agents/, data/ or actual user memories. Keep credentials out of logs and examples.

- Layout v2: root config.yaml stores shared facilities/defaults and ID registry. agents/<id>/config.yaml, .env, schedule.ts, prompts/system.md are private. Use ConfigStore to assemble/save; never parse root config as a full runtime Config. Pass scoped env explicitly; never merge agent credentials into process.env. restart_scheduler is scoped to the caller. See docs/agent-layout.md.

- Agent configuration inherits by field. Persist only explicit overrides, including false, zero and empty arrays; resolve defaults only for execution. Scheduler restart reloads and validates disk configuration before stopping the selected process.
