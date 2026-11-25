/**
 * Files shared between parallel agents (several processes on the same repo): atomic write (no half-written JSON
 * read by a neighbor) and directory-based lock (mkdir is atomic), released even on error.
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeAtomic(file: string, data: string, mode?: number) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, data, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

/** Runs fn under exclusive lock `name` (waits at most 60 s; a lock older than 2 min is considered abandoned). */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const dir = `.cache/locks/${name}.lock`;
  mkdirSync(".cache/locks", { recursive: true });
  const start = Date.now();
  for (;;) {
    try { mkdirSync(dir); break; } catch {
      try { if (Date.now() - statSync(dir).mtimeMs > 120_000) { rmSync(dir, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - start > 60_000) throw new Error(`Verrou ${name} occupé depuis plus de 60 s (autre agent bloqué ?) : supprimer ${dir} si aucun script ne tourne.`);
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
    }
  }
  try { return await fn(); } finally { rmSync(dir, { recursive: true, force: true }); }
}
