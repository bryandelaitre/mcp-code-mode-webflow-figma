/**
 * Classes (hosted MCP): ensureStyles reads, creates if missing, updates only what differs; variables resolved
 * by name (no more hand-built ids, the cause of the "internal error" in Webflow MCP lessons file §3.1).
 * Responses from create_style / update_style (up to 12,000 characters per batch) stay inside the process.
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResult, hostedResults } from "./hosted-util.js";
import { anyPageId, invalidateDesignSystem, loadDesignSystem, type DesignSystem } from "./design-system.js";
import { KitError, assertWriteAllowed, cap, short } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma ensures CSS classes match the requested properties and returns only a compact diff.";
type Breakpoint = "main" | "small" | "medium" | "large" | "xl" | "xxl" | "tiny";
type Pseudo = "hover" | "active" | "focus" | "focus-visible" | "focus-within" | "visited" | "first-child" | "last-child" | "nth-child(odd)" | "nth-child(even)" | "placeholder" | "empty" | "before" | "after";

/** Value: "2rem", { var: "Variable/name" } or "var(--css-name)", null to remove the property. */
export type StyleValue = string | { var: string } | null;
export type StyleProps = Record<string, StyleValue>;
export interface StyleSpec {
  name: string;
  /** Parent classes for a combo class ("button" for "button is-submit"). */
  parent?: string[];
  /** Main breakpoint (desktop). */
  props?: StyleProps;
  breakpoints?: Partial<Record<Exclude<Breakpoint, "main">, StyleProps>>;
  /** States at the main breakpoint. */
  pseudos?: Partial<Record<Pseudo, StyleProps>>;
  /** Variable modes: { "Color modes": "Dark" }. */
  modes?: Record<string, string>;
}

function resolveVar(ds: DesignSystem, ref: string): string {
  const css = ref.match(/^var\(\s*(--[\w-]+)\s*\)$/)?.[1];
  const v = css ? ds.variables.find((x) => x.cssName === css) : ds.variables.find((x) => x.name === ref) ?? ds.variables.find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!v) {
    const near = ds.variables.filter((x) => x.name.toLowerCase().includes(ref.replace(/^var\(--|\)$/g, "").split(/[/-]/).pop()!.toLowerCase())).slice(0, 5).map((x) => x.name);
    throw new KitError(`Variable introuvable : ${ref}.${near.length ? ` Proches : ${near.join(", ")}.` : ""} (findVariables pour chercher)`);
  }
  return v.id;
}

/** Wanted value → { value } or { varId }. In dryRun, a variable not yet created does not block the diff. */
let lenient = false;
function want(ds: DesignSystem, v: StyleValue): { value?: string; varId?: string } | null {
  if (v === null) return null;
  const ref = typeof v === "object" ? v.var : /^var\(\s*--[\w-]+\s*\)$/.test(v) ? v : null;
  if (ref === null) return { value: v as string };
  try { return { varId: resolveVar(ds, ref) }; }
  catch (e) { if (lenient) return { varId: `à créer : ${ref}` }; throw e; }
}
const same = (cur: unknown, w: { value?: string; varId?: string } | null) =>
  w === null ? cur === undefined : w.varId ? (cur as any)?.id === w.varId : cur === w.value;
const shown = (ds: DesignSystem, cur: unknown) =>
  cur && typeof cur === "object" && "id" in (cur as object) ? `var(${ds.variables.find((x) => x.id === (cur as any).id)?.name ?? (cur as any).id})` : cur;
const toProps = (entries: [string, { value?: string; varId?: string }][]) =>
  entries.map(([property_name, w]) => (w.varId ? { property_name, variable_as_value: w.varId } : { property_name, property_value: w.value! }));

/**
 * Ensures classes have the wanted properties. dryRun by default: returns, per class, what would be created or
 * changed (by breakpoint, state and variable mode).
 */
export async function ensureStyles(siteId: string, specs: StyleSpec[], opts: { dryRun?: boolean; maxDiff?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  lenient = dryRun;
  const ds = await loadDesignSystem(siteId, { parts: ["variables"] });
  const pageId = ds.pageId ?? (await anyPageId(siteId));
  const base = { siteId, pageId };

  // Read: one query per class, then filtered on the exact name (name_path matches a substring).
  const bps = [...new Set(["main", ...specs.flatMap((s) => Object.keys(s.breakpoints ?? {}))])] as Breakpoint[];
  const pseudos = [...new Set(["noPseudo", ...specs.flatMap((s) => Object.keys(s.pseudos ?? {}))])] as any[];
  const q = await h.dataStyleTool.queryStyles(base, {
    queries: specs.map((s, i) => ({ label: String(i), name_path: [...(s.parent ?? []), s.name], include_properties: true, include_breakpoints: bps, include_base_pseudos: pseudos, limit: 200 })),
  }, CTX);
  const found = hostedResult<any[]>(q, "query_styles");

  // Current variable modes (collection → mode), for classes that request them and already exist.
  const withModes = specs.map((s, i) => ({ s, i })).filter(({ s }) => s.modes && Object.keys(s.modes).length);
  const curModes = new Map<number, Record<string, string>>();
  if (withModes.length) {
    const r = await h.dataStyleTool.call({
      ...base,
      actions: withModes.map(({ s, i }) => ({ label: String(i), get_style_variable_modes: { style_name: s.name, ...(s.parent?.length ? { parent_style_names: s.parent } : {}) } })),
    } as any, CTX);
    for (const res of hostedResults(r)) if (res.ok) curModes.set(Number(res.label), (res.data as any)?.modes ?? {});
  }

  const actions: any[] = [];
  const diff: unknown[] = [];
  for (const [i, s] of specs.entries()) {
    const selector = "." + [...(s.parent ?? []), s.name].join(".");
    const m = (found.find((x) => x.label === String(i))?.matches ?? []).find((x: any) => x.name === s.name && (s.parent?.length ? x.selector === selector : !x.isComboClass));
    const parent = s.parent?.length ? { parent_style_names: s.parent } : {};
    const changes: Record<string, Record<string, [unknown, unknown]>> = {};
    const blocks: { where: string; bp?: Breakpoint; pseudo?: Pseudo; props: StyleProps; current: Record<string, unknown> }[] = [
      { where: "main", props: s.props ?? {}, current: m?.properties?.breakpoints?.main?.properties ?? m?.properties?.base?.properties ?? {} },
      ...Object.entries(s.breakpoints ?? {}).map(([bp, props]) => ({ where: bp, bp: bp as Breakpoint, props: props!, current: m?.properties?.breakpoints?.[bp]?.properties ?? {} })),
      ...Object.entries(s.pseudos ?? {}).map(([ps, props]) => ({ where: `:${ps}`, pseudo: ps as Pseudo, props: props!, current: m?.properties?.base?.pseudos?.[ps] ?? {} })),
    ];
    for (const b of blocks) {
      const set: [string, { value?: string; varId?: string }][] = [];
      const remove: string[] = [];
      for (const [prop, v] of Object.entries(b.props)) {
        const w = want(ds, v);
        if (same(b.current[prop], w)) continue;
        (changes[b.where] ??= {})[prop] = [short(shown(ds, b.current[prop]) ?? null, 40), short(v === null ? null : typeof v === "object" ? `var(${v.var})` : v, 40)];
        w === null ? remove.push(prop) : set.push([prop, w]);
      }
      if (!m && b.where === "main") {
        actions.push({ label: `${s.name}:create`, create_style: { name: s.name, properties: toProps(set), ...parent } });
        continue;
      }
      if (!set.length && !remove.length) continue;
      actions.push({
        label: `${s.name}:${b.where}`,
        update_style: { style_name: s.name, ...parent, ...(b.bp ? { breakpoint_id: b.bp } : {}), ...(b.pseudo ? { pseudo: b.pseudo } : {}), ...(set.length ? { properties: toProps(set) } : {}), ...(remove.length ? { remove_properties: remove } : {}) },
      });
    }
    for (const [collection, mode] of Object.entries(s.modes ?? {})) {
      const c = ds.collections.find((x) => x.name === collection);
      const md = c?.modes.find((x) => x.name === mode || x.id === mode);
      if (!c || !md) throw new KitError(`Mode introuvable : ${collection} / ${mode}. Collections : ${ds.collections.map((x) => `${x.name} (${x.modes.map((y) => y.name).join(", ")})`).join(" ; ")}.`);
      const cur = curModes.get(i)?.[c.id];
      if (cur === md.id) continue;
      actions.push({ label: `${s.name}:mode`, set_style_variable_mode: { style_name: s.name, ...parent, variable_collection_id: c.id, mode_id: md.id } });
      (changes.modes ??= {})[collection] = [cur ? c.modes.find((x) => x.id === cur)?.name ?? cur : null, mode];
    }
    if (!m || Object.keys(changes).length) diff.push({ style: [...(s.parent ?? []), s.name].join(" "), action: m ? "update" : "create", changes });
  }

  const d = cap(diff, opts.maxDiff ?? 30);
  const summary: Record<string, unknown> = { dryRun, styles: diff.length, unchanged: specs.length - diff.length, diff: d.items, ...(d.truncated ? { diffTruncated: d.truncated } : {}) };
  if (dryRun || !actions.length) return summary;
  assertWriteAllowed(siteId);
  const errors: unknown[] = [];
  let ok = 0;
  for (let i = 0; i < actions.length; i += 10) {
    const r = await h.dataStyleTool.call({ ...base, actions: actions.slice(i, i + 10) } as any, CTX);
    for (const res of hostedResults(r)) res.ok ? ok++ : errors.push({ action: res.label, error: res.error });
  }
  invalidateDesignSystem(siteId, ["classes"]);
  return { ...summary, actions: ok, ...(errors.length ? { errors } : {}) };
}

/** Shortcut for a single class. */
export const ensureStyle = (siteId: string, spec: StyleSpec, opts?: { dryRun?: boolean }) => ensureStyles(siteId, [spec], opts);

/**
 * Class properties in compact form (variables shown by name), for the requested breakpoints and states.
 * `names`: "name" for a global class, "parent name" for a combo class.
 */
export async function readStyles(siteId: string, names: string[], opts: { breakpoints?: Breakpoint[]; pseudos?: Pseudo[] } = {}) {
  const ds = await loadDesignSystem(siteId, { parts: ["variables"] });
  const bps = opts.breakpoints ?? ["main", "medium", "small", "tiny"];
  const q = await h.dataStyleTool.queryStyles({ siteId, pageId: ds.pageId }, {
    queries: names.map((n, i) => ({ label: String(i), name_path: n.split(/\s+/), include_properties: true, include_breakpoints: bps, ...(opts.pseudos ? { include_base_pseudos: ["noPseudo", ...opts.pseudos] } : {}), limit: 200 })),
  } as any, CTX);
  const found = hostedResult<any[]>(q, "query_styles");
  const nameOf = (val: unknown) => (val && typeof val === "object" && "id" in (val as object) ? `var(${ds.variables.find((x) => x.id === (val as any).id)?.name ?? (val as any).id})` : val);
  const compact = (o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, nameOf(v)]));
  return Object.fromEntries(names.map((n, i) => {
    const parts = n.split(/\s+/), name = parts[parts.length - 1], selector = "." + parts.join(".");
    const m = (found.find((x) => x.label === String(i))?.matches ?? []).find((x: any) => x.name === name && (parts.length > 1 ? x.selector === selector : !x.isComboClass));
    if (!m) return [n, null];
    const out: Record<string, unknown> = {};
    for (const bp of bps) { const p = m.properties?.breakpoints?.[bp]?.properties; if (p && Object.keys(p).length) out[bp] = compact(p); }
    if (!bps.length || !out.main) { const p = m.properties?.base?.properties; if (p && Object.keys(p).length) out.main = compact(p); }
    for (const ps of opts.pseudos ?? []) { const p = m.properties?.base?.pseudos?.[ps]; if (p && Object.keys(p).length) out[`:${ps}`] = compact(p); }
    return [n, out];
  }));
}

/** Renames classes (combo classes: "parent name" in `from`). Combo classes of a renamed class do not follow (Webflow MCP lessons file). dryRun by default. */
export async function renameStyles(siteId: string, renames: { from: string; to: string }[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const ds = await loadDesignSystem(siteId, { refresh: true, parts: ["classes"] });
  // In-order simulation: a chain (a → b then c → a) replays without renaming twice, and a target that
  // already exists is never overwritten.
  const key = (parents: string[], name: string) => (parents.length ? "." + [...parents, name].join(".") : name);
  const names = new Set(ds.classes.map((c) => (c.type === "combo" ? c.selector ?? c.name : c.name)));
  const plan = renames.map((r) => {
    const parts = r.from.split(/\s+/), name = parts[parts.length - 1], parents = parts.slice(0, -1);
    const from = key(parents, name), to = key(parents, r.to);
    let status: string;
    if (names.has(to)) status = names.has(from) ? "cible déjà existante" : "déjà fait";
    else if (!names.has(from)) status = "introuvable";
    else { status = "à renommer"; names.delete(from); names.add(to); }
    return { ...r, name, parents, status };
  });
  if (dryRun) return { dryRun, items: plan.map((p) => `${p.from} → ${p.to} : ${p.status}`) };
  assertWriteAllowed(siteId);
  const actions = plan.filter((p) => p.status === "à renommer").map((p) => ({ label: p.from, rename_style: { style_name: p.name, new_name: p.to, ...(p.parents.length ? { parent_style_names: p.parents } : {}) } }));
  const errors: unknown[] = [];
  // Sequential: a chain a → b then c → a must keep its order.
  for (const a of actions) {
    const r = await h.dataStyleTool.call({ siteId, pageId: ds.pageId, actions: [a] } as any, CTX);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ style: res.label, error: res.error });
  }
  invalidateDesignSystem(siteId, ["classes"]);
  return { dryRun: false, renamed: actions.length - errors.length, skipped: plan.filter((p) => p.status !== "à renommer").map((p) => `${p.from} (${p.status})`), ...(errors.length ? { errors } : {}) };
}

/** Removes classes (combo classes: "parent name"). Webflow refuses if an element still uses them. dryRun by default. */
export async function removeStyles(siteId: string, names: string[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  if (dryRun) return { dryRun, remove: names };
  assertWriteAllowed(siteId);
  const ds = await loadDesignSystem(siteId, { parts: [] });
  // Combo classes first: a combo class keeps its parent class alive.
  const ordered = [...names].sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);
  const r = await h.dataStyleTool.call({
    siteId, pageId: ds.pageId,
    actions: ordered.map((n) => { const p = n.split(/\s+/); return { label: n, remove_style: { style_name: p[p.length - 1], ...(p.length > 1 ? { parent_style_names: p.slice(0, -1) } : {}) } }; }),
  } as any, CTX);
  const res = hostedResults(r);
  invalidateDesignSystem(siteId, ["classes"]);
  return { dryRun: false, removed: res.filter((x) => x.ok).length, ...(res.some((x) => !x.ok) ? { errors: res.filter((x) => !x.ok).map((x) => ({ style: x.label, error: x.error })) } : {}) };
}

export interface VariantStyleSpec {
  /** Component name ("Button") and variant name ("Secondary"). */
  component: string;
  variant: string;
  /** Targeted standalone class (set_variant_styles cannot target a combo class, Webflow MCP lessons file). */
  style: string;
  props: StyleProps;
  breakpoint?: Breakpoint;
  pseudo?: Pseudo;
}

/**
 * Styles carried by a component variant (set_variant_styles), with a diff against get_variant_styles.
 * Reminder: a variant must redeclare its value at every breakpoint where the base class changes it.
 */
export async function ensureVariantStyles(siteId: string, specs: VariantStyleSpec[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const ds = await loadDesignSystem(siteId, { parts: ["components", "variables"] });
  const base = { siteId, pageId: ds.pageId };
  const variantIds = new Map<string, string>();
  for (const name of new Set(specs.map((s) => s.component))) {
    const c = ds.components.find((x) => x.name === name);
    if (!c) throw new KitError(`Composant introuvable : ${name}`);
    const r = hostedResult<any>(await h.dataComponentTool.getComponent(base, { component_id: c.id, options: { includeVariants: true } } as any, CTX), "get_component");
    for (const v of (Array.isArray(r) ? r[0] : r).variants ?? []) variantIds.set(`${name}/${v.name}`, v.id);
  }
  const actions: any[] = [];
  const diff: unknown[] = [];
  for (const s of specs) {
    const vid = variantIds.get(`${s.component}/${s.variant}`);
    if (!vid) throw new KitError(`Variante introuvable : ${s.component} / ${s.variant} (${[...variantIds.keys()].join(", ")})`);
    const scopeArgs = { variant_id: vid, style_name: s.style, ...(s.breakpoint ? { breakpoint_id: s.breakpoint } : {}), ...(s.pseudo ? { pseudo: s.pseudo } : {}) };
    let props: Record<string, unknown> = {};
    try {
      const cur = hostedResult<any>(await h.dataComponentVariantsTool.getVariantStyles(base, scopeArgs as any, CTX), "get_variant_styles");
      props = (Array.isArray(cur) ? cur[0] : cur)?.properties ?? {};
    } catch (e) {
      // Class not created yet (dryRun before ensureStyles): nothing set for this variant.
      if (!/not found/i.test((e as Error).message)) throw e;
    }
    const set: [string, { value?: string; varId?: string }][] = [], remove: string[] = [];
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [prop, v] of Object.entries(s.props)) {
      const w = want(ds, v);
      if (same(props[prop], w)) continue;
      changes[prop] = [short(shown(ds, props[prop]) ?? null, 40), short(v === null ? null : typeof v === "object" ? `var(${v.var})` : v, 40)];
      w === null ? remove.push(prop) : set.push([prop, w]);
    }
    if (!set.length && !remove.length) continue;
    actions.push({ label: `${s.variant}:${s.style}${s.pseudo ? ":" + s.pseudo : ""}${s.breakpoint ? "@" + s.breakpoint : ""}`, set_variant_styles: { ...scopeArgs, ...(set.length ? { properties: toProps(set) } : {}), ...(remove.length ? { remove_properties: remove } : {}) } });
    diff.push({ variant: `${s.component}/${s.variant}`, style: s.style, where: `${s.breakpoint ?? "main"}${s.pseudo ? ":" + s.pseudo : ""}`, changes });
  }
  const summary: Record<string, unknown> = { dryRun, blocks: diff.length, unchanged: specs.length - diff.length, diff };
  if (dryRun || !actions.length) return summary;
  assertWriteAllowed(siteId);
  const errors: unknown[] = [];
  for (let i = 0; i < actions.length; i += 10) {
    const r = await h.dataComponentVariantsTool.call({ ...base, actions: actions.slice(i, i + 10) } as any, CTX);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ action: res.label, error: res.error });
  }
  return { ...summary, written: actions.length - errors.length, ...(errors.length ? { errors } : {}) };
}
