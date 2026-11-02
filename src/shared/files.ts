import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function atomicWrite(file: string, data: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export const jsonWrite = (f: string, v: unknown) =>
  atomicWrite(f, JSON.stringify(v, null, 2) + "\n");
export const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));
export const id = () => randomUUID();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
export function safePath(root: string, relative: string) {
  const p = path.resolve(root, relative);
  if (p !== path.resolve(root) && !p.startsWith(path.resolve(root) + path.sep))
    throw Error("path outside root");
  return p;
}
