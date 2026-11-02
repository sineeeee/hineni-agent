import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "../shared/files.js";
import type { ConfigStore } from "../config/store.js";

const writers = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const job = (writers.get(key) ?? Promise.resolve()).then(fn);
  const tail = job.catch(() => {});
  writers.set(key, tail);
  void tail.finally(() => {
    if (writers.get(key) === tail) writers.delete(key);
  });
  return job;
}
export class AdminFiles {
  constructor(private config: ConfigStore) {}
  roots() {
    return [
      this.config.resolve("docs"),
      this.config.resolve("prompts"),
      this.config.resolve("scripts"),
      this.config.resolve(this.config.current.agentsDir),
    ];
  }
  async resolve(relative: string, write = false) {
    if (!relative || path.isAbsolute(relative))
      throw Error("Use a project-relative path");
    const root = await fs.realpath(this.config.root());
    const file = path.resolve(root, relative);
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (
      rel.startsWith("../") ||
      rel === ".." ||
      rel.split("/").some((x) => x.startsWith(".") && x !== ".runtime")
    )
      throw Error("Path not allowed");
    const roots = this.roots().map((r) =>
      path.resolve(root, path.relative(this.config.root(), r)),
    );
    const top = ["README.md", "开始使用.md", "AGENTS.md"].map((x) =>
      path.join(root, x),
    );
    if (
      !top.includes(file) &&
      !roots.some((r) => file.startsWith(r + path.sep))
    )
      throw Error("Path not allowed");
    // Reject links at every existing segment, including directory links.
    let cursor = root;
    for (const part of path.relative(root, file).split(path.sep)) {
      cursor = path.join(cursor, part);
      try {
        if ((await fs.lstat(cursor)).isSymbolicLink())
          throw Error("Symbolic links are not editable here");
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    if (
      write &&
      (rel.includes("/history/") ||
        rel.includes("/attachments/") ||
        rel.includes("/.runtime/") ||
        rel.endsWith("/state.json") ||
        rel.endsWith("/config.yaml"))
    )
      throw Error("Runtime records are read-only");
    return file;
  }
  async list(agent?: string) {
    const out: Array<{
      path: string;
      size: number;
      modified: string;
      editable: boolean;
    }> = [];
    const walk = async (dir: string, depth = 0) => {
      if (depth > 8 || out.length >= 4000) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (
          e.isSymbolicLink() ||
          e.name.startsWith(".") ||
          ["node_modules", "__pycache__"].includes(e.name)
        )
          continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (["history", "attachments"].includes(e.name)) continue;
          await walk(p, depth + 1);
        } else {
          const s = await fs.stat(p);
          const relative = path.relative(this.config.root(), p);
          out.push({
            path: relative,
            size: s.size,
            modified: s.mtime.toISOString(),
            editable:
              !relative.endsWith("/state.json") &&
              !relative.endsWith("/config.yaml"),
          });
        }
      }
    };
    for (const dir of ["docs", "prompts", "scripts"])
      await walk(this.config.resolve(dir));
    const agents = this.config.current.agents.filter(
      (a) => !agent || a.id === agent,
    );
    for (const a of agents) await walk(this.config.agentRoot(a.id));
    for (const name of ["README.md", "开始使用.md", "AGENTS.md"]) {
      try {
        const s = await fs.stat(this.config.resolve(name));
        out.push({
          path: name,
          size: s.size,
          modified: s.mtime.toISOString(),
          editable: true,
        });
      } catch {}
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(relative: string, offset = 0, limit = 200000) {
    const file = await this.resolve(relative);
    const data = await fs.readFile(file);
    if (data.includes(0)) throw Error("Binary file: download it instead");
    const text = data.toString("utf8");
    return {
      path: relative,
      content: text.slice(offset, offset + limit),
      version: createHash("sha256").update(data).digest("hex"),
      total: text.length,
      next_offset: offset + limit < text.length ? offset + limit : null,
    };
  }
  async write(relative: string, content: string, version?: string) {
    const file = await this.resolve(relative, true);
    return serialize(file, async () => {
      let old: Buffer | undefined;
      try {
        old = await fs.readFile(file);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
      if (old && createHash("sha256").update(old).digest("hex") !== version)
        throw Error("File changed; reload before saving");
      if (relative.endsWith("memory.json")) {
        const data = JSON.parse(content);
        if (!Array.isArray(data.memory)) throw Error("memory array required");
        for (const m of data.memory)
          if (
            typeof m.summary !== "string" ||
            !Number.isFinite(Date.parse(m.occurred_at))
          )
            throw Error("Each memory needs summary and valid occurred_at");
      }
      await atomicWrite(file, content);
      return this.read(relative);
    });
  }
  async install(
    agent: string,
    name: string,
    files: Array<{ path: string; content: string }>,
  ) {
    if (!this.config.current.agents.some((a) => a.id === agent))
      throw Error("Unknown agent");
    if (!/^[a-zA-Z0-9_-]+$/.test(name))
      throw Error("Skill name must use letters, numbers, - or _");
    if (new Set(files.map((f) => f.path)).size !== files.length)
      throw Error("Duplicate Skill file path");
    if (!files.some((f) => f.path === "SKILL.md"))
      throw Error("Package needs SKILL.md");
    const dir = path.join(this.config.agentRoot(agent), "skills", name);
    try {
      await fs.access(dir);
      throw Error("Skill already exists; edit it instead");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const checked = files.map((f) => {
      if (
        path.isAbsolute(f.path) ||
        f.path.split(/[\\/]/).some((x) => x === ".." || x.startsWith(".")) ||
        !f.path
      )
        throw Error("Invalid Skill file path");
      return f;
    });
    for (const f of checked)
      await this.resolve(
        path.relative(this.config.root(), path.join(dir, f.path)),
        true,
      );
    await fs.mkdir(dir, { recursive: true });
    try {
      for (const f of checked)
        await atomicWrite(path.join(dir, f.path), f.content);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true });
      throw e;
    }
    const tombstone = path.join(
      this.config.agentRoot(agent),
      ".runtime",
      "removed-skills.json",
    );
    await serialize(tombstone, async () => {
      let names: string[] = [];
      try {
        names = JSON.parse(await fs.readFile(tombstone, "utf8"));
      } catch {}
      await atomicWrite(
        tombstone,
        JSON.stringify(names.filter((n) => n !== name)),
      );
    });
    return { installed: name };
  }
  async removeSkill(agent: string, name: string) {
    if (
      !this.config.current.agents.some((a) => a.id === agent) ||
      !/^[\w-]+$/.test(name)
    )
      throw Error("Unknown skill");
    const relative = path.join(
      this.config.current.agentsDir,
      agent,
      "skills",
      name,
    );
    const dir = await this.resolve(relative, true);
    await fs.mkdir(
      path.join(this.config.agentRoot(agent), ".runtime", "removed-skills"),
      { recursive: true },
    );
    await fs.rename(
      dir,
      path.join(
        this.config.agentRoot(agent),
        ".runtime",
        "removed-skills",
        name + "-" + Date.now(),
      ),
    );
    const tombstone = path.join(
      this.config.agentRoot(agent),
      ".runtime",
      "removed-skills.json",
    );
    await serialize(tombstone, async () => {
      let names: string[] = [];
      try {
        names = JSON.parse(await fs.readFile(tombstone, "utf8"));
      } catch {}
      await atomicWrite(
        tombstone,
        JSON.stringify([...new Set([...names, name])]),
      );
    });
    return { removed: true, archived: true };
  }
}
