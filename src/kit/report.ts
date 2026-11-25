import { getCallCount, close } from "../lib/client.js";
import { getHostedCallCount, getHostedRawChars, getHostedRawByTool, closeHosted } from "../lib/hosted.js";
import { getFigmaCallCount, getFigmaRawChars, getFigmaRawByTool, closeFigma } from "../lib/figma.js";
import { getFigmaRestStats } from "../figma/rest.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_MAX = 4000;

/**
 * Prints a result as compact JSON (one line), capped at `max` characters, with the number of MCP calls.
 * It is the only output a scratch/ script should produce.
 */
export function report(data: unknown, { max = DEFAULT_MAX }: { max?: number } = {}): void {
  let s = JSON.stringify(data);
  if (s.length > max) s = s.slice(0, max) + `… [tronqué : ${s.length} caractères au total, plafond ${max}]`;
  console.log(s);
  const rest = getFigmaRestStats();
  const local = getCallCount(), hosted = getHostedCallCount(), fig = getFigmaCallCount() + rest.calls;
  const raw = getHostedRawChars() + getFigmaRawChars() + rest.chars;
  const byTool = { ...getHostedRawByTool(), ...Object.fromEntries(Object.entries(getFigmaRawByTool()).map(([k, v]) => [`figma:${k}`, v])), ...(rest.calls ? { "figma:rest": rest } : {}) };
  // Metrics log: one object per run in .cache/metrics.jsonl (not versioned).
  try {
    mkdirSync(".cache", { recursive: true });
    appendFileSync(".cache/metrics.jsonl", JSON.stringify({ at: new Date().toISOString(), script: basename(process.argv[1] ?? "?"), args: process.argv.slice(2).join(" "), calls: local + hosted + fig, rawChars: raw, shownChars: s.length, byTool }) + "\n");
  } catch { /* metrics are optional */ }
  const parts = [local && `${local} local`, hosted && `${hosted} Webflow`, fig && `${fig} Figma`].filter(Boolean);
  console.log(`[mcp] ${local + hosted + fig} appel(s)${parts.length ? ` (${parts.join(", ")})` : ""}${raw ? `, ${raw} car. bruts → ${s.length} affichés` : ""}`);
}

/** Runs a script, prints the result or a one-line error, closes the MCP connection. */
export async function run(fn: () => Promise<unknown>, opts?: { max?: number }): Promise<void> {
  try {
    report(await fn(), opts);
  } catch (e) {
    const err = e as Error;
    console.log(JSON.stringify({ error: err.name, message: err.message }));
    process.exitCode = 1;
  } finally {
    await Promise.all([close(), closeHosted(), closeFigma()]);
  }
}
