import fs from "node:fs/promises";
import path from "node:path";
import type { Runtime } from "../layer2/runtime.js";
import { AdminFiles } from "./files.js";
export function runFor(runtime: Runtime, agent: string, id: string) {
  const run = runtime.db.db
    .prepare("SELECT * FROM runs WHERE agent_id=? AND id=?")
    .get(agent, id);
  if (!run) throw Error("Unknown run for this agent");
  return run;
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
