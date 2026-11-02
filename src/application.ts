import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { initialize } from "./init.js";
import { ConfigStore } from "./config/store.js";
import { parseConfig, type Config } from "./config/schema.js";
import YAML from "yaml";
import { Store } from "./layer2/store.js";
import { Journal } from "./layer2/journal.js";
import { Runtime } from "./layer2/runtime.js";
import { Scheduler } from "./scheduler.js";
import { servers } from "./admin/server.js";
import type { AdminLifecycle } from "./admin/control.js";

export async function application(
  root: string,
  lifecycle: AdminLifecycle,
  fallback?: Config,
  fallbackEnvironments?: Map<string, NodeJS.ProcessEnv>,
) {
  if (!fallback) await initialize(root);
  const config = new ConfigStore(path.join(root, "config.yaml"));
  if (fallback) {
    config.current = fallback;
    config.revision = "fallback";
    if (fallbackEnvironments) config.useEnvironments(fallbackEnvironments);
  } else await config.load();
  const db = new Store(
    config.resolve(path.join(config.current.dataDir, "runtime.sqlite")),
    new Journal(config.resolve(config.current.agentsDir)),
  );
  for (const a of config.current.agents) {
    const dir = path.join(config.agentRoot(a.id), "attachments");
    for (const file of await fs.readdir(dir))
      if (file.endsWith(".json"))
        try {
          db.attachment(
            JSON.parse(await fs.readFile(path.join(dir, file), "utf8")),
          );
        } catch (e) {
          db.log("warn", "attachments", String(e), { file });
        }
  }
  const scheduler = new Scheduler(config, db);
  const runtime = new Runtime(config, db, (id) => scheduler.restart(id));
  let server: Awaited<ReturnType<typeof servers>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await scheduler.stop();
    await runtime.stop();
    await server?.close();
    db.close();
  };
  try {
    server = await servers(config, runtime, scheduler, lifecycle);
    await runtime.start();
    await server.listen();
    await scheduler.start();
    if (fallback)
      try {
        await config.load();
      } catch {} // UI shows the saved config separately from the fallback runtime.
    return { config, runtime, close };
  } catch (e) {
    await close();
    throw e;
  }
}
export async function startManaged(root: string) {
  await initialize(root);
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  let app: Awaited<ReturnType<typeof application>>;
  let restarting = false,
    stopping = false,
    lastError: string | null = null;
  let restartJob: Promise<void> | undefined;
  const lifecycle: AdminLifecycle = {
    status: () => ({ restarting, last_restart_error: lastError }),
    restart: async () => {
      if (restarting || stopping) throw Error("Service is already restarting");
      const nextStore = new ConfigStore(path.join(root, "config.yaml"));
      const next = await nextStore.load();
      const env = dotenv.parse(await fs.readFile(path.join(root, ".env")));
      if (
        (env[next.server.tokenEnv] ?? process.env[next.server.tokenEnv] ?? "")
          .length < 24
      )
        throw Error("Management token needs at least 24 characters");
      restarting = true;
      lastError = null;
      restartJob = new Promise((resolve) => setTimeout(resolve, 250)).then(
        async () => {
          if (stopping) return;
          const previous = app.runtime.cfg,
            previousEnvironments = app.runtime.environments,
            oldEnv = { ...process.env };
          try {
            await app.close();
            Object.assign(process.env, env);
            app = await application(root, lifecycle);
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            for (const key of Object.keys(process.env))
              if (!(key in oldEnv)) delete process.env[key];
            Object.assign(process.env, oldEnv);
            try {
              app = await application(
                root,
                lifecycle,
                previous,
                previousEnvironments,
              );
              app.runtime.db.log("error", "restart", lastError);
            } catch (fatal) {
              console.error(
                "Service restart and recovery failed:",
                String(fatal),
              );
              process.exitCode = 1;
            }
          } finally {
            restarting = false;
          }
        },
      );
    },
  };
  app = await application(root, lifecycle);
  return {
    get app() {
      return app;
    },
    close: async () => {
      stopping = true;
      await restartJob;
      await app.close();
    },
    lifecycle,
  };
}
