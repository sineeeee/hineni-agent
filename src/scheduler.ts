import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { agentConfig } from "./config/schema.js";
import type { ConfigStore } from "./config/store.js";
import type { Store } from "./layer2/store.js";
/** One independently restartable process per agent; timer progress is not persisted. */
export class Scheduler {
  private children = new Map<string, ChildProcess>();
  private retries = new Map<string, NodeJS.Timeout>();
  private stopping = false;
  private writers = new Map<string, Promise<void>>();
  constructor(
    private config: ConfigStore,
    private db: Store,
  ) {}
  async start(id?: string) {
    if (this.stopping) return;
    for (const a of this.config.current.agents.filter(
      (a) => a.enabled && (!id || a.id === id),
    )) {
      const cfg = agentConfig(this.config.current, a);
      if (!cfg.scheduler.enabled || this.children.has(a.id)) continue;
      const root = this.config.agentRoot(a.id),
        file = path.resolve(root, cfg.scheduler.script);
      if (!file.startsWith(root + path.sep))
        throw Error("Scheduler path must stay inside agent directory");
      if (!fs.existsSync(file)) {
        this.db.log("error", "scheduler", "Script missing", {
          agent: a.id,
          file,
        });
        continue;
      }
      const child = spawn(
        process.execPath,
        [
          "--import",
          this.config.resolve("node_modules/tsx/dist/loader.mjs"),
          file,
        ],
        {
          cwd: root,
          env: {
            ...this.config.agentEnv(a.id),
            [cfg.server.tokenEnv]: process.env[cfg.server.tokenEnv],
            HINENI_ROOT: this.config.root(),
            HINENI_CONFIG: this.config.file,
            HINENI_AGENT_ID: a.id,
            HINENI_API: `http://127.0.0.1:${cfg.server.port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      this.children.set(a.id, child);
      child.stdout?.on("data", (d) =>
        this.db.log("info", "scheduler", String(d).slice(0, 4000), {
          agent: a.id,
        }),
      );
      child.stderr?.on("data", (d) =>
        this.db.log("warn", "scheduler", String(d).slice(0, 4000), {
          agent: a.id,
        }),
      );
      child.on("error", (e) =>
        this.db.log("error", "scheduler", e.message, { agent: a.id }),
      );
      child.on("exit", (code) => {
        if (this.children.get(a.id) !== child) return;
        this.children.delete(a.id);
        this.db.log("warn", "scheduler", "Script exited", {
          agent: a.id,
          code,
        });
        if (!this.stopping)
          this.retries.set(
            a.id,
            setTimeout(() => {
              this.retries.delete(a.id);
              void this.start(a.id).catch((e) =>
                this.db.log("error", "scheduler", String(e), { agent: a.id }),
              );
            }, 5000),
          );
      });
    }
  }
  private async stopAgent(id: string) {
    clearTimeout(this.retries.get(id));
    this.retries.delete(id);
    const child = this.children.get(id);
    this.children.delete(id);
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        const a = this.config.current.agents.find((a) => a.id === id);
        const timer = setTimeout(
          () => child.kill("SIGKILL"),
          (a ? agentConfig(this.config.current, a) : this.config.current)
            .runtime.cancelGraceMs,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
  }
  async stop() {
    this.stopping = true;
    await Promise.all(
      [...new Set([...this.children.keys(), ...this.retries.keys()])].map(
        (id) => this.stopAgent(id),
      ),
    );
  }
  async restart(id?: string) {
    // A script or the UI may have edited YAML directly; validate before stopping work.
    await this.config.refreshFromDisk();
    if (id && !this.config.current.agents.some((a) => a.id === id))
      throw Error("Unknown agent");
    const ids = id ? [id] : this.config.current.agents.map((a) => a.id);
    await Promise.all(
      ids.map((id) => {
        const job = (this.writers.get(id) ?? Promise.resolve()).then(
          async () => {
            await this.stopAgent(id);
            await this.start(id);
          },
        );
        this.writers.set(
          id,
          job.catch(() => {}),
        );
        return job;
      }),
    );
  }
  status() {
    return {
      running: this.children.size > 0,
      agents: Object.fromEntries(
        this.config.current.agents.map((a) => [
          a.id,
          {
            running: this.children.has(a.id),
            pid: this.children.get(a.id)?.pid,
            script: path.join(
              this.config.agentRoot(a.id),
              agentConfig(this.config.current, a).scheduler.script,
            ),
          },
        ]),
      ),
    };
  }
}
