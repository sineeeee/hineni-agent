import fs from "node:fs/promises";
import sync from "node:fs";
import path from "node:path";
import type { Runtime } from "../layer2/runtime.js";
import { AdminFiles } from "./files.js";
export function runFor(runtime: Runtime, agent: string, id: string) {
  const run = runtime.db.db
    .prepare("SELECT * FROM runs WHERE agent_id=? AND id=?")
    .get(agent, id);
  if (run) return run;
  if (!/^[a-zA-Z0-9:_-]+$/.test(id)) throw Error("Invalid run");
  const base = path.join(runtime.agentRoot(agent), ".runtime");
  for (const p of [
    path.join(base, "traces", id + ".json"),
    path.join(base, "requests", id),
  ]) {
    try {
      const stat = sync.lstatSync(p);
      if (!stat.isSymbolicLink())
        return {
          id,
          agent_id: agent,
          status: "archived",
          started_at: stat.mtime.toISOString(),
          ended_at: null,
        };
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  throw Error("Unknown run for this agent");
}
export async function requests(runtime: Runtime, agent: string, run: string) {
  runFor(runtime, agent, run);
  const dir = path.join(runtime.agentRoot(agent), ".runtime", "requests", run);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  return files
    .filter((x) => /^\d+\.json$/.test(x))
    .sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
}
export async function toolFiles(
  runtime: Runtime,
  files: AdminFiles,
  agent: string,
  run: string,
) {
  runFor(runtime, agent, run);
  const dir = path.join(runtime.agentRoot(agent), "history", "tools", run);
  const out = [];
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const name of names) {
    const p = path.relative(runtime.config.root(), path.join(dir, name));
    await files.resolve(p);
    const s = await fs.stat(path.join(dir, name));
    out.push({ path: p, name, size: s.size });
  }
  return out;
}

/** Snapshot catalog survives independent deletion of execution metadata. */
export function artifactRunIds(
  runtime: Runtime,
  agent: string,
  area: "context" | "tools",
) {
  const root = runtime.agentRoot(agent),
    ids = new Set<string>();
  const dirs =
    area === "context"
      ? ([
          [".runtime/requests", false],
          [".runtime/traces", true],
        ] as const)
      : ([["history/tools", false]] as const);
  for (const [dir, trace] of dirs) {
    let entries: sync.Dirent[];
    try {
      entries = sync.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const e of entries) {
      const id =
        trace && e.name.endsWith(".json") ? e.name.slice(0, -5) : e.name;
      if (
        (trace ? e.isFile() && e.name.endsWith(".json") : e.isDirectory()) &&
        /^[a-zA-Z0-9:_-]+$/.test(id)
      )
        ids.add(id);
    }
  }
  return [...ids];
}
export function runCatalog(
  runtime: Runtime,
  agent: string,
  scope: string = "all",
) {
  let rows = runtime.db.db
    .prepare("SELECT * FROM runs WHERE agent_id=? ORDER BY started_at DESC")
    .all(agent) as any[];
  if (scope === "context")
    return artifactRunIds(runtime, agent, "context")
      .filter((id) => {
        const base = path.join(runtime.agentRoot(agent), ".runtime");
        try {
          if (sync.lstatSync(path.join(base, "traces", id + ".json")).isFile())
            return true;
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
        try {
          return sync
            .readdirSync(path.join(base, "requests", id), {
              withFileTypes: true,
            })
            .some((e) => e.isFile() && /^\d+\.json$/.test(e.name));
        } catch (e: any) {
          if (e.code === "ENOENT") return false;
          throw e;
        }
      })
      .map((id) => runFor(runtime, agent, id))
      .sort((a: any, b: any) => b.started_at.localeCompare(a.started_at))
      .slice(0, 100);
  if (scope === "execution")
    rows = rows.filter(
      (r) =>
        r.status === "running" ||
        runtime.db
          .runEvents(agent, r.id)
          .some((e) =>
            ["tool_call", "tool_result", "run_finished"].includes(e.type),
          ),
    );
  return rows.slice(0, 100);
}
