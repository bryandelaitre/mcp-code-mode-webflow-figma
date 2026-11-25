/**
 * Analyzes Claude Code transcripts (~/.claude/projects/**.jsonl) to measure the actual usage of the Webflow MCPs.
 *
 * Usage: npm run usage [-- <projects folder>]
 * Writes the data tables to reports/usage.md between the <!-- data:start --> and <!-- data:end --> markers
 * (the rest of the file, written by hand, is kept) and the details to reports/usage.json (ignored by git).
 *
 * Sizes in characters; tokens estimated as characters / 4 (an approximation, flagged as such in the report).
 * No content data is extracted: only tool names, actions, sizes, statuses.
 */
import { createReadStream, readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";

const ROOT = process.argv[2] ?? join(homedir(), ".claude", "projects");
const TOOL_RE = /^mcp__(.*webflow.*)__(.+)$/i;

interface Call {
  project: string;
  file: string;
  server: string;
  tool: string;
  key: string; // tool:action
  inChars: number;
  outChars: number; // actual size of the server's response
  ctxChars: number; // what entered the agent's context (offload notice if the response was saved to disk)
  error: boolean;
  offloaded: boolean; // response too large, saved to disk by Claude Code
}

function listJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listJsonl(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** The actions of a multi-action call: keys of the `actions` items, excluding label / build_label. */
function actionNames(input: any): string[] {
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input.actions)) {
    const names = new Set<string>();
    for (const a of input.actions) {
      if (!a || typeof a !== "object") continue;
      if (typeof a.action_type === "string") names.add(a.action_type);
      else if ("html" in a) names.add("whtml");
      else if ("element_schema" in a) names.add("build");
      else for (const k of Object.keys(a)) if (k !== "label" && k !== "build_label") names.add(k);
    }
    return [...names].sort();
  }
  return [];
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("")
    : typeof content === "string" ? content : "";

async function scanFile(path: string): Promise<Call[]> {
  const project = relative(ROOT, path).split(sep)[0];
  const pending = new Map<string, Call>();
  const calls: Call[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const maybeUse = line.includes('"name":"mcp__') && /webflow/i.test(line);
    const maybeResult = pending.size > 0 && line.includes("tool_result");
    if (!maybeUse && !maybeResult) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use") {
        const m = TOOL_RE.exec(b.name ?? "");
        if (!m) continue;
        const acts = actionNames(b.input);
        const c: Call = {
          project, file: relative(ROOT, path), server: m[1], tool: m[2],
          key: acts.length ? `${m[2]}:${acts.join("+")}` : m[2],
          inChars: JSON.stringify(b.input ?? {}).length, outChars: 0, ctxChars: 0, error: false, offloaded: false,
        };
        pending.set(b.id, c);
        calls.push(c);
      } else if (b?.type === "tool_result" && pending.has(b.tool_use_id)) {
        const c = pending.get(b.tool_use_id)!;
        pending.delete(b.tool_use_id);
        const t = textOf(b.content);
        const big = /result \(([\d,]+) characters/.exec(t);
        c.offloaded = Boolean(big);
        c.outChars = big ? Number(big[1].replace(/,/g, "")) : t.length;
        c.ctxChars = t.length;
        c.error = Boolean(b.is_error) || /"status":\s*"error"|"error":\s*\{|Error:|status code: 4\d\d/i.test(t.slice(0, 2000));
      }
    }
  }
  return calls;
}

const files = listJsonl(ROOT);
const all: Call[] = [];
for (const f of files) {
  all.push(...(await scanFile(f)));
}

// ---- Aggregates
const tok = (chars: number) => Math.round(chars / 4);
const fmt = (n: number) => n.toLocaleString("fr-FR");
type Agg = { n: number; out: number; ctx: number; inp: number; max: number; err: number; off: number };
function aggregate(keyFn: (c: Call) => string) {
  const m = new Map<string, Agg>();
  for (const c of all) {
    const k = keyFn(c);
    const a = m.get(k) ?? { n: 0, out: 0, ctx: 0, inp: 0, max: 0, err: 0, off: 0 };
    a.n++; a.out += c.outChars; a.ctx += c.ctxChars; a.inp += c.inChars; a.max = Math.max(a.max, c.outChars);
    if (c.error) a.err++; if (c.offloaded) a.off++;
    m.set(k, a);
  }
  return [...m.entries()].sort((x, y) => y[1].n - x[1].n);
}
// Public repo: project and server names anonymized ("projet-1", "webflow-1") unless USAGE_REAL_NAMES=1.
const alias = (prefix: string) => { const m = new Map<string, string>(); return (k: string) => (process.env.USAGE_REAL_NAMES === "1" || !k.startsWith(prefix === "projet" ? "" : "webflow") ? k : (m.get(k) ?? (m.set(k, `${prefix}-${m.size + 1}`), m.get(k)!))); };
const projectAlias = alias("projet"), serverAlias = alias("webflow");
const byProject = aggregate((c) => projectAlias(c.project.replace(/^-Users-[^-]+-/, "")));
const byServer = aggregate((c) => serverAlias(c.server));
const byTool = aggregate((c) => c.tool);
const byKey = aggregate((c) => c.key);
const byVolume = [...byKey].sort((x, y) => y[1].ctx - x[1].ctx);

// Sequences: n-grams of consecutive keys per file, immediate repeats merged.
function ngrams(n: number) {
  const m = new Map<string, number>();
  const perFile = new Map<string, string[]>();
  for (const c of all) (perFile.get(c.file) ?? perFile.set(c.file, []).get(c.file)!).push(c.key);
  for (const seq0 of perFile.values()) {
    const seq = seq0.filter((k, i) => i === 0 || k !== seq0[i - 1]);
    for (let i = 0; i + n <= seq.length; i++) {
      const g = seq.slice(i, i + n).join("  →  ");
      m.set(g, (m.get(g) ?? 0) + 1);
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const totalOut = all.reduce((s, c) => s + c.outChars, 0);
const totalCtx = all.reduce((s, c) => s + c.ctxChars, 0);
const totalIn = all.reduce((s, c) => s + c.inChars, 0);
const row = (k: string, a: Agg) =>
  `| \`${k}\` | ${a.n} | ${fmt(Math.round(a.out / a.n))} | ${fmt(a.max)} | ${fmt(tok(a.ctx))} | ${fmt(tok(a.out))} | ${fmt(Math.round(a.inp / a.n))} | ${a.err} | ${a.off} |`;
const head = "| Clé | Appels | Réponse moy. (car.) | Réponse max | Tokens entrés en contexte (≈) | Tokens bruts (≈) | Entrée moy. (car.) | Erreurs | Déportées |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|";

const md = [
  `_Généré par \`npm run usage\` le ${new Date().toISOString().slice(0, 10)} sur ${files.length} transcripts ; ${new Set(all.map((c) => c.file)).size} utilisent un MCP Webflow._`,
  "",
  `**Total** : ${fmt(all.length)} appels. Réponses entrées en contexte : ≈ ${fmt(tok(totalCtx))} tokens ; taille brute des réponses : ≈ ${fmt(tok(totalOut))} tokens ; arguments écrits par l'agent : ≈ ${fmt(tok(totalIn))} tokens.`,
  "Tokens estimés à caractères / 4. « Déportées » : réponses trop lourdes que Claude Code a sauvées sur disque (taille réelle relevée dans le message).",
  "",
  "### Par projet",
  "| Projet | Appels | Tokens entrés en contexte (≈) | Tokens bruts (≈) |\n|---|---:|---:|---:|",
  ...byProject.map(([k, a]) => `| ${k} | ${a.n} | ${fmt(tok(a.ctx))} | ${fmt(tok(a.out))} |`),
  "",
  "### Par serveur MCP",
  "| Serveur | Appels | Tokens entrés en contexte (≈) |\n|---|---:|---:|",
  ...byServer.map(([k, a]) => `| \`${k}\` | ${a.n} | ${fmt(tok(a.ctx))} |`),
  "",
  "### Par outil",
  head.replace("Clé", "Outil"),
  ...byTool.map(([k, a]) => row(k, a)),
  "",
  "### Par outil et action (30 premiers, par nombre d'appels)",
  head,
  ...byKey.slice(0, 30).map(([k, a]) => row(k, a)),
  "",
  "### Par volume entré en contexte (20 premiers)",
  head,
  ...byVolume.slice(0, 20).map(([k, a]) => row(k, a)),
  "",
  "### Enchaînements les plus fréquents",
  "Paires (bigrammes) :",
  "",
  ...ngrams(2).slice(0, 20).map(([g, n]) => `- ${n} × ${g}`),
  "",
  "Triplets :",
  "",
  ...ngrams(3).slice(0, 15).map(([g, n]) => `- ${n} × ${g}`),
].join("\n");

mkdirSync("reports", { recursive: true });
const target = "reports/usage.md";
const start = "<!-- data:start -->", end = "<!-- data:end -->";
let doc = existsSync(target) ? readFileSync(target, "utf8") : `# Usage réel des MCP Webflow\n\n${start}\n${end}\n`;
if (!doc.includes(start)) doc += `\n${start}\n${end}\n`;
doc = doc.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n${md}\n${end}`);
writeFileSync(target, doc);
writeFileSync("reports/usage.json", JSON.stringify({ byProject, byServer, byTool, byKey, bigrams: ngrams(2).slice(0, 100), trigrams: ngrams(3).slice(0, 100) }, null, 1));
console.log(`${all.length} appels analysés ; rapport : ${target}`);
