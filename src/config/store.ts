import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { parseConfig, agentConfig, type Config } from "./schema.js";
import { atomicWrite } from "../shared/files.js";

/** Disk is split; the runtime/API continue to consume one validated assembled Config. */
export const agentSections = [
  "models",
  "history",
  "context",
  "memory",
  "state",
  "style",
  "runtime",
  "delivery",
  "prompts",
  "drives",
  "scheduler",
  "mcp",
] as const;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class ConfigStore {
  current!: Config;
  revision = "";
  private writer: Promise<unknown> = Promise.resolve();
  private versions = new Map<string, string>();
  private environments = new Map<string, NodeJS.ProcessEnv>();
  constructor(public file: string) {}
  load() {
    return this.serialize(() => this.read());
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.writer.then(fn);
    this.writer = job.catch(() => {});
    return job;
  }
  private async read() {
    const source = await fs.readFile(this.file, "utf8");
    const raw = YAML.parse(source);
    if (raw.layoutVersion !== 2) {
      this.current = parseConfig(raw);
      await this.persist(this.current, true);
    }
    const root = YAML.parse(await fs.readFile(this.file, "utf8"));
    delete root.layoutVersion;
    const agents = [];
    for (const ref of root.agents) {
      if (!/^[a-zA-Z0-9_-]+$/.test(ref.id)) throw Error("Invalid agent id");
      const dir = path.resolve(this.root(), root.agentsDir, ref.id);
      const local = YAML.parse(
        await fs.readFile(path.join(dir, "config.yaml"), "utf8"),
      );
      if (local.id !== ref.id)
        throw Error("Agent configuration id mismatch: " + ref.id);
      const overrides: Record<string, unknown> = {};
      for (const key of agentSections) {
        if (local[key] !== undefined) overrides[key] = local[key];
        delete local[key];
      }
      agents.push({ ...local, overrides });
    }
    const next = parseConfig({ ...root, agents });
    for (const a of next.agents) agentConfig(next, a);
    this.current = next;
    this.environments.clear();
    for (const a of this.current.agents)
      this.environments.set(a.id, await this.readAgentEnv(a.id));
    await this.capture();
    this.revision = digest(JSON.stringify([...this.versions]));
    return this.current;
  }
  private async capture() {
    this.versions.clear();
    for (const file of [
      this.file,
      ...this.current.agents.map((a) =>
        path.join(this.agentRoot(a.id), "config.yaml"),
      ),
    ])
      this.versions.set(file, digest(await fs.readFile(file, "utf8")));
  }
  async readAgentEnv(id: string): Promise<NodeJS.ProcessEnv> {
    const local = dotenv.parse(
      await fs.readFile(path.join(this.agentRoot(id), ".env")).catch((e) => {
        if (e.code === "ENOENT") return Buffer.from("");
        throw e;
      }),
    );
    // Environment is injected per call/subprocess, never assigned to process.env.
    const base = { ...process.env };
    const shared = dotenv.parse(
      await fs.readFile(this.resolve(".env")).catch(() => Buffer.from("")),
    );
    const privateNames = new Set(
      this.current.agents.flatMap((a) => {
        const effective = agentConfig(this.current, a);
        return [
          ...Object.values(effective.models).flatMap((m) =>
            m?.apiKeyEnv ? [m.apiKeyEnv] : [],
          ),
          ...effective.mcp.flatMap((m) => (m.headersEnv ? [m.headersEnv] : [])),
        ];
      }),
    );
    for (const key of Object.keys(base))
      if (
        key in shared ||
        privateNames.has(key) ||
        /KEY|TOKEN|SECRET|PASSWORD/.test(key)
      )
        delete base[key];
    return { ...base, ...local };
  }
  useEnvironments(env: Map<string, NodeJS.ProcessEnv>) {
    this.environments = new Map(
      [...env].map(([id, value]) => [id, { ...value }]),
    );
  }
  agentEnv(id: string): NodeJS.ProcessEnv {
    return { ...(this.environments.get(id) ?? {}) };
  }
  private async persist(c: Config, migrate = false) {
    const root: any = {
      ...c,
      layoutVersion: 2,
      agents: c.agents.map((a) => ({ id: a.id })),
    };
    root.scheduler = {
      ...c.scheduler,
      script:
        c.scheduler.script === "scripts/schedule.ts"
          ? "schedule.ts"
          : c.scheduler.script,
    };
    const writes: Array<[string, string]> = [];
    for (const a of c.agents) {
      const dir = path.resolve(this.root(), c.agentsDir, a.id);
      const effective = agentConfig(c, a);
      const local: any = { ...a };
      delete local.overrides;
      delete local.main;
      // Persist only explicit settings. Resolving defaults must never pin them to disk.
      for (const key of agentSections) {
        if (migrate) local[key] = effective[key];
        else if (a.overrides[key] !== undefined)
          local[key] = structuredClone(a.overrides[key]);
      }
      if (a.main)
        local.models = {
          ...local.models,
          main: { ...local.models?.main, ...a.main },
        };
      const script =
        effective.scheduler.script === "scripts/schedule.ts"
          ? "schedule.ts"
          : effective.scheduler.script;
      if (local.scheduler?.script === "scripts/schedule.ts")
        local.scheduler.script = script;
      if (path.isAbsolute(script) || script.split(/[\\/]/).includes(".."))
        throw Error("Scheduler script must be inside agent directory");
      writes.push([path.join(dir, "config.yaml"), YAML.stringify(local)]);
      await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
      const copyOnce = async (from: string, to: string) => {
        try {
          await fs.access(to);
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
          await fs.mkdir(path.dirname(to), { recursive: true });
          await atomicWrite(to, await fs.readFile(from, "utf8"));
        }
      };
      await copyOnce(
        this.resolve("prompts/system.md"),
        path.join(dir, "prompts/system.md"),
      );
      await copyOnce(
        this.resolve("prompts/auxiliary.yaml"),
        path.join(dir, "prompts/auxiliary.yaml"),
      );
      await copyOnce(
        this.resolve("prompts/prompt-mapping.yaml"),
        path.join(dir, "prompts/prompt-mapping.yaml"),
      );
      try {
        await fs.writeFile(
          path.join(dir, "schedule.once.json"),
          '{"tasks":[]}\n',
          { flag: "wx", mode: 0o600 },
        );
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
      await copyOnce(
        this.resolve("scripts/schedule.ts"),
        path.join(dir, script),
      );
      const envFile = path.join(dir, ".env");
      try {
        await fs.access(envFile);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        const names = new Set(
          Object.values(effective.models).flatMap((m) =>
            m?.apiKeyEnv ? [m.apiKeyEnv] : [],
          ),
        );
        for (const m of effective.mcp)
          if (m.headersEnv) names.add(m.headersEnv);
        const old = migrate
          ? dotenv.parse(
              await fs
                .readFile(this.resolve(".env"))
                .catch(() => Buffer.from("")),
            )
          : {};
        await atomicWrite(
          envFile,
          [...names]
            .map((n) => n + "=" + JSON.stringify(old[n] ?? ""))
            .join("\n") + "\n",
        );
      }
    }
    writes.push([this.file, YAML.stringify(root)]);
    // Roll back ordinary write failures. Each file is atomically replaced; root registry is last.
    const previous = new Map<string, string | undefined>();
    try {
      for (const [file, text] of writes) {
        previous.set(
          file,
          await fs.readFile(file, "utf8").catch((e) => {
            if (e.code === "ENOENT") return undefined;
            throw e;
          }),
        );
        await atomicWrite(file, text);
      }
    } catch (e) {
      for (const [file, text] of previous) {
        if (text === undefined) await fs.rm(file, { force: true });
        else await atomicWrite(file, text);
      }
      throw e;
    }
    if (migrate) {
      const sharedFile = this.resolve(".env");
      let env = await fs.readFile(sharedFile, "utf8").catch(() => "");
      const protectedNames = new Set([
        c.server.tokenEnv,
        ...c.channels.flatMap((x) => [x.tokenEnv, x.secretEnv].filter(Boolean)),
      ]);
      const names = new Set(
        c.agents.flatMap((a) =>
          Object.values(agentConfig(c, a).models).flatMap((m) =>
            m?.apiKeyEnv ? [m.apiKeyEnv] : [],
          ),
        ),
      );
      env = env
        .split(/\r?\n/)
        .filter(
          (line) =>
            !names.has(line.split("=")[0]) ||
            protectedNames.has(line.split("=")[0]),
        )
        .join("\n");
      await atomicWrite(sharedFile, env);
    }
  }
  refreshFromDisk() {
    return this.serialize(async () => {
      for (const [file, hash] of this.versions)
        if (digest(await fs.readFile(file, "utf8")) !== hash) {
          await this.read();
          return;
        }
    });
  }
  save(raw: unknown, expectedRevision?: string) {
    const c = parseConfig(structuredClone(raw));
    for (const a of c.agents) agentConfig(c, a);
    return this.serialize(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.revision)
        throw Error(
          "配置已被其他页面或文件修改，请先暂存草稿，再重新读取并核对。",
        );
      for (const [file, hash] of this.versions)
        if (digest(await fs.readFile(file, "utf8")) !== hash)
          throw Error("配置文件已在外部修改，请先暂存草稿，再重新读取并核对。");
      await this.persist(c);
      await this.read();
      return this.current;
    });
  }
  root() {
    return path.dirname(this.file);
  }
  resolve(p: string) {
    return path.resolve(this.root(), p);
  }
  agentRoot(id: string) {
    return path.join(this.resolve(this.current.agentsDir), id);
  }
}
