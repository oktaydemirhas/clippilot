import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ID_RE } from "./ids.js";
import type { JobStore } from "./jobs.js";

/**
 * Deletes job directories (and forgets the jobs) once they are older than `ttlMs`.
 * Works from the directory's modification time so it also removes leftovers of a previous
 * process run, which the in-memory store knows nothing about.
 */
export async function sweep(store: JobStore, dataDir: string, ttlMs: number, now = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch {
    return removed;
  }
  for (const id of entries) {
    if (!ID_RE.test(id)) continue; // never touch what is not a job directory (DATA_DIR may be a shared folder)
    const dir = path.join(dataDir, id);
    const job = store.get(id);
    if (job && !(job.stage === "done" || job.stage === "failed")) continue; // still running
    const { mtimeMs } = await stat(dir).catch(() => ({ mtimeMs: now }));
    if (now - mtimeMs < ttlMs) continue;
    await rm(dir, { recursive: true, force: true });
    store.delete(id);
    removed.push(id);
  }
  return removed;
}

export function startJanitor(store: JobStore, dataDir: string, ttlMs: number, everyMs = 10 * 60_000): () => void {
  const timer = setInterval(() => void sweep(store, dataDir, ttlMs).catch((e) => console.error("janitor:", e)), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
