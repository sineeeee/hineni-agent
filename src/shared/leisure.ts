import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/schema.js";

/** One scheduler process per agent. Count opportunities, including silence, before submission. */
export async function takeLeisureOpportunity(
  file: string,
  cfg: Config["scheduler"],
  now = new Date(),
  random = Math.random,
): Promise<"moyu" | "chat" | "quiet"> {
  // Zero means unlimited: no daily counter is read or written.
  if (cfg.leisureDailyLimit > 0) {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: cfg.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    let state = { date, opportunities: 0 };
    try {
      const saved = JSON.parse(await fs.readFile(file, "utf8"));
      if (!Number.isInteger(saved.opportunities) || saved.opportunities < 0)
        throw Error("Invalid leisure-state.json opportunity count");
      if (saved.date === date) state = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (state.opportunities >= cfg.leisureDailyLimit) return "quiet";
    state.opportunities++;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + ".tmp", JSON.stringify(state) + "\n");
    await fs.rename(file + ".tmp", file);
  }
  const total = cfg.moyuWeight + cfg.chatWeight + cfg.quietWeight;
  const pick = random() * total;
  if (pick < cfg.moyuWeight) return "moyu";
  if (pick < cfg.moyuWeight + cfg.chatWeight) return "chat";
  return "quiet";
}
