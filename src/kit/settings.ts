/**
 * Element settings (hosted MCP): compact read, typed write with diff, safe append to an embed.
 * Read via all_raw_settings: query_settings does not find the `attributes` key (quirks.md).
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResult, hostedResults } from "./hosted-util.js";
import { invalidateTree, type ElementId, type PageRef } from "./elements.js";
import { KitError, assertWriteAllowed, cap, short } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma reads or writes element settings requested by the user and returns a compact diff.";
type El = string | ElementId;
const eid = (p: PageRef, el: El): ElementId => (typeof el === "string" ? { component: p.scopeComponentId ?? p.pageId, element: el } : el);
const scope = (p: PageRef) => (p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {});

/** Raw settings of an element: key → (full) value. For internal or filtered use, never to display as is. */
export async function readSettings(p: PageRef, el: El): Promise<Record<string, unknown>> {
  const r = await h.dataElementSettingsTool.getSettings(
    { siteId: p.siteId, pageId: p.pageId },
    { type: "all_raw_settings", element_id: eid(p, el), ...scope(p) },
    CTX,
  );
  const d = hostedResult<any>(r, "get_settings");
  return Object.fromEntries((d?.matches ?? []).map((m: any) => [m.key, m.value]));
}

const readable = (v: unknown) => (v && typeof v === "object" && "innerText" in v ? (v as any).innerText : v);

/** Settings of an element in compact form (values cut at maxValue). `keys` to keep only a few of them. */
export async function getSettings(p: PageRef, el: El, opts: { keys?: string[]; maxValue?: number } = {}) {
  const all = await readSettings(p, el);
  const keys = opts.keys ?? Object.keys(all);
  const missing = keys.filter((k) => !(k in all));
  return {
    element: typeof el === "string" ? el : el.element,
    settings: Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, short(readable(all[k]), opts.maxValue ?? 120)])),
    ...(missing.length ? { missing, available: Object.keys(all) } : {}),
  };
}

/**
 * Value → set_settings write. String → static_text (embed code included); number; boolean;
 * { mode, to, … } → static_link; null or "" → clear; "attributes" key: { name: value } or [{ name, value }]
 * (replaces the whole list; only data-* are reliable, see the Webflow MCP lessons file); any other object → static_json.
 * Raw form accepted: an object that already contains clear / binding / static_* / attributes.
 */
function toSetting(key: string, v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => k === "clear" || k === "binding" || k.startsWith("static_") || (k === "attributes" && key !== "attributes"))) {
    return { key, ...(v as object) };
  }
  // "" → clear: an empty string as static_text is rejected (domId, quirks.md); clear restores the default
  // (empty) value.
  if (v === null || v === "") return { key, clear: true };
  if (key === "attributes") {
    const list = Array.isArray(v) ? v.map((a: any) => [a.name, a.value]) : Object.entries(v as object);
    return { key, attributes: list.map(([name, value]) => ({ name_static: String(name), value_static: String(value ?? "") })) };
  }
  switch (typeof v) {
    case "string": return { key, static_text: { value: v } };
    case "number": return { key, static_number: { value: v } };
    case "boolean": return { key, static_boolean: { value: v } };
  }
  if (v && typeof v === "object" && "mode" in v && "to" in v) return { key, static_link: v };
  return { key, static_json: { value: JSON.stringify(v) } };
}

/** Whether the current value matches the requested value. */
function sameValue(key: string, cur: unknown, next: unknown): boolean {
  if (key === "attributes") {
    const norm = (x: unknown) => JSON.stringify(
      (Array.isArray(x) ? x.map((a: any) => [String(a.name), String(a.value ?? "")]) : Object.entries((x as object) ?? {}).map(([n, v]) => [n, String(v)])).sort(),
    );
    return norm(cur ?? []) === norm(next ?? []);
  }
  return JSON.stringify(readable(cur) ?? null) === JSON.stringify(next ?? null);
}

export interface SettingsUpdate { element: El; settings: Record<string, unknown> }

/** Writes settings on one or more elements. dryRun by default: returns the diff. Writes only what changes. */
export async function setSettings(p: PageRef, updates: SettingsUpdate[], opts: { dryRun?: boolean; maxDiff?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  const ops: any[] = [];
  const diff: unknown[] = [];
  let unchanged = 0;
  for (const u of updates) {
    const cur = await readSettings(p, u.element);
    const settings: any[] = [];
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [k, v] of Object.entries(u.settings)) {
      if (sameValue(k, cur[k], v)) continue;
      settings.push(toSetting(k, v));
      changes[k] = [short(readable(cur[k]) ?? null, 60), short(v, 60)];
    }
    const id = eid(p, u.element);
    if (!settings.length) { unchanged++; continue; }
    ops.push({ label: id.element, element_id: id, settings, ...scope(p) });
    diff.push({ element: id.element, changes });
  }
  const d = cap(diff, opts.maxDiff ?? 30);
  const summary: Record<string, unknown> = { dryRun, elements: ops.length, unchanged, diff: d.items, ...(d.truncated ? { diffTruncated: d.truncated } : {}) };
  if (dryRun || !ops.length) return summary;
  assertWriteAllowed(p.siteId);
  const errors: unknown[] = [];
  for (let i = 0; i < ops.length; i += 10) {
    const r = await h.dataElementSettingsTool.setSettings({ siteId: p.siteId, pageId: p.pageId }, { operations: ops.slice(i, i + 10) } as any, CTX);
    const res = hostedResults(r)[0];
    if (!res?.ok) errors.push({ batch: i / 10, error: res?.error });
  }
  // Check by re-read: a batch can be partly applied, or fail with a partial "success"
  // (MPS conflict on domId, quirks.md). Each written key is compared with its requested value.
  const notApplied: unknown[] = [];
  let written = 0;
  for (const u of updates) {
    const id = eid(p, u.element);
    if (!ops.some((o) => o.element_id.element === id.element)) continue;
    const now = await readSettings(p, u.element);
    const applied = (k: string, v: unknown) => (v === "" || v === null ? (readable(now[k]) ?? "") === "" : sameValue(k, now[k], v));
    const bad = Object.entries(u.settings).filter(([k, v]) => !applied(k, v)).map(([k]) => k);
    if (bad.length) notApplied.push({ element: id.element, keys: bad });
    else written++;
  }
  invalidateTree(p);
  return { ...summary, written, ...(notApplied.length ? { notApplied } : {}), ...(errors.length ? { errors } : {}) };
}

/**
 * Appends code to the end of an embed (HtmlEmbed) without copying it by hand: read, append, rewrite, re-read
 * and exact comparison. Does nothing if the code is already there. dryRun by default.
 */
export async function appendToEmbed(p: PageRef, el: El, code: string, opts: { dryRun?: boolean; separator?: string } = {}) {
  const dryRun = opts.dryRun ?? true;
  const cur = await readSettings(p, el);
  if (!("code" in cur)) throw new KitError(`L'élément ${typeof el === "string" ? el : el.element} n'a pas de réglage « code » (pas un embed ?). Clés : ${Object.keys(cur).join(", ")}.`);
  const before = String(cur.code ?? "");
  if (before.includes(code)) return { dryRun, unchanged: true, chars: before.length };
  const after = before ? `${before}${opts.separator ?? "\n"}${code}` : code;
  const summary = { dryRun, before: before.length, after: after.length, added: short(code, 120) };
  if (dryRun) return summary;
  assertWriteAllowed(p.siteId);
  const w = await h.dataElementSettingsTool.setSettings(
    { siteId: p.siteId, pageId: p.pageId },
    { operations: [{ label: "code", element_id: eid(p, el), settings: [{ key: "code", static_text: { value: after } }], ...scope(p) }] } as any,
    CTX,
  );
  hostedResult(w, "set_settings code");
  const check = String((await readSettings(p, el)).code ?? "");
  if (check !== after) throw new KitError(`Relecture de l'embed : ${check.length} caractères au lieu de ${after.length}. Vérifier dans le Designer.`);
  return { ...summary, verified: true };
}

/**
 * Replaces all the code of an embed. `var(--dt:Variable/name)` is resolved to the variable's Webflow CSS name
 * (the CSS then follows the variable, color mode included). Re-read and exact comparison. dryRun by default.
 */
export async function setEmbed(p: PageRef, el: El, code: string, opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const { loadDesignSystem } = await import("./design-system.js");
  const ds = await loadDesignSystem(p.siteId, { parts: ["variables"] });
  const missing: string[] = [];
  const out = code.replace(/var\(--dt:([^)]+)\)/g, (_m, name: string) => {
    const v = ds.variables.find((x) => x.name === name.trim());
    if (!v?.cssName) { missing.push(name); return _m; }
    return `var(${v.cssName})`;
  });
  if (missing.length) throw new KitError(`Variables introuvables dans le code : ${[...new Set(missing)].join(", ")}`);
  const cur = await readSettings(p, el);
  if (!("code" in cur)) throw new KitError(`L'élément n'a pas de réglage « code » (pas un embed ?).`);
  const before = String(cur.code ?? "");
  if (before === out) return { dryRun, unchanged: true, chars: out.length };
  if (dryRun) return { dryRun, before: before.length, after: out.length };
  assertWriteAllowed(p.siteId);
  hostedResult(await h.dataElementSettingsTool.setSettings({ siteId: p.siteId, pageId: p.pageId }, { operations: [{ label: "code", element_id: eid(p, el), settings: [{ key: "code", static_text: { value: out } }], ...scope(p) }] } as any, CTX), "set_settings code");
  const check = String((await readSettings(p, el)).code ?? "");
  if (check !== out) throw new KitError(`Relecture de l'embed : ${check.length} caractères au lieu de ${out.length} (limite de taille ?).`);
  return { dryRun: false, before: before.length, after: out.length, verified: true };
}
