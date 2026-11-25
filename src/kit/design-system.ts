/**
 * A site's design system (hosted MCP): variables, classes and components, read once then kept in
 * .cache/ds-<siteId>.json (30 min by default). Raw responses (get_styles alone: ~60,000 characters on a
 * small site) stay in the process; the agent only sees the summary or the results of a search.
 */
import { readFileSync } from "node:fs";
import { writeAtomic } from "../lib/fsutil.js";
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { KitError, short } from "./util.js";

export interface DsVariable { id: string; name: string; collection: string; type: string; cssName?: string; value: string; modes?: Record<string, string> }
export interface DsClass { id: string; name: string; type: string; selector?: string; library?: boolean }
export interface DsComponent { id: string; name: string; group?: string; props: string[] }
export interface DesignSystem {
  siteId: string;
  fetchedAt: string;
  pageId: string;
  collections: { id: string; name: string; modes: { id: string; name: string }[] }[];
  variables: DsVariable[];
  classes: DsClass[];
  components: DsComponent[];
}

const file = (siteId: string) => `.cache/ds-${siteId}.json`;
const TTL_MS = 30 * 60_000;

/** Readable value: {unit, value} → "3rem", variable reference → "var(name)", otherwise short text. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, any>;
  if ("unit" in o && "value" in o) return `${o.value}${o.unit}`;
  if (o.type === "variable" || o.variableId || o.id?.startsWith?.("variable-")) return `var(${o.name ?? o.variableId ?? o.id})`;
  return String(short(o, 60));
}

/** A static page of the site: Designer tools require a pageId. */
export async function anyPageId(siteId: string): Promise<string> {
  const r = await h.dataPagesTool.listPages({ site_id: siteId }, "Library mcp-code-mode-webflow-figma picks a static page id required by design system read tools.");
  const pages = hostedResult<any>(r, "list_pages").pages ?? [];
  const p = pages.find((x: any) => !x.collectionId && !x.archived && !x.draft) ?? pages[0];
  if (!p) throw new KitError("list_pages : aucune page sur ce site.");
  return p.id;
}

export type DsPart = "variables" | "classes" | "components";
const ALL: DsPart[] = ["variables", "classes", "components"];
interface DsCache { siteId: string; pageId?: string; parts: Partial<Record<DsPart, { fetchedAt: string; data: any }>> }
const CTX_DS = "Library mcp-code-mode-webflow-figma reads part of the site design system and caches it to answer targeted lookups.";

async function fetchPart(siteId: string, pageId: string, part: DsPart): Promise<any> {
  const b = { siteId, pageId };
  if (part === "variables") {
    const vc = hostedResult<any[]>(await h.dataVariableTool.getVariableCollections(b, { query: "all" }, CTX_DS), "get_variable_collections") ?? [];
    const collections: DesignSystem["collections"] = vc.map((c) => ({ id: c.id, name: c.name, modes: c.modes ?? [] }));
    const variables: DsVariable[] = [];
    if (collections.length) {
      const r = await h.dataVariableTool.call({ ...b, actions: collections.map((c) => ({ label: c.id, get_variables: { variable_collection_id: c.id, include_all_modes: true } })) }, CTX_DS);
      for (const [i, c] of collections.entries()) {
        const vars = hostedResult<any[]>(r, `get_variables ${c.name}`, i) ?? [];
        const modeName = new Map(c.modes.map((m: { id: string; name: string }) => [m.id, m.name]));
        for (const v of vars) {
          const modes = (v.modeValues ?? []).filter((m: any) => m.modeId !== "base");
          variables.push({ id: v.id, name: v.name, collection: c.name, type: v.type, cssName: v.cssName, value: fmt(v.value),
            ...(modes.length ? { modes: Object.fromEntries(modes.map((m: any) => [modeName.get(m.modeId) ?? m.modeId, fmt(m.value)])) } : {}) });
        }
      }
    }
    return { collections, variables };
  }
  if (part === "classes") {
    const styles = hostedResult<any[]>(await h.dataStyleTool.getStyles(b, { query: "all" }, CTX_DS), "get_styles") ?? [];
    return { classes: styles.map((x) => ({ id: x.id, name: x.name, type: x.type, selector: x.selector, ...(x.isFromLibrary ? { library: true } : {}) })) };
  }
  const comps = hostedResult<any[]>(await h.dataComponentTool.getAllComponents(b, { options: { includeProps: true } }, CTX_DS), "get_all_components") ?? [];
  return { components: comps.map((c) => ({ id: c.id, name: c.name, ...(c.group ? { group: c.group } : {}), props: (c.props ?? []).map((p: any) => `${p.name} (${p.type})`) })) };
}

const readCache = (siteId: string): DsCache => {
  try { const c = JSON.parse(readFileSync(file(siteId), "utf8")); if (c.parts) return c; } catch { /* missing or old format */ }
  return { siteId, parts: {} };
};

/**
 * Design system in parts (variables, classes, components), each in a file cache with its date. `parts` says what
 * the caller needs: only those parts are read, if missing, stale or if `refresh`. The other parts are returned
 * from the cache if present, otherwise empty. Default: all (compatibility).
 * Measured: a full reload costs ≈ 130,000 characters (get_styles alone ≈ 80,000).
 */
export async function loadDesignSystem(siteId: string, opts: { refresh?: boolean; ttlMs?: number; parts?: DsPart[] } = {}): Promise<DesignSystem> {
  const cache = readCache(siteId);
  const want = opts.parts ?? ALL;
  const seen = Object.fromEntries(ALL.map((p) => [p, cache.parts[p]?.fetchedAt]));
  if (!cache.pageId) cache.pageId = await anyPageId(siteId);
  let dirty = false;
  for (const part of want) {
    const c = cache.parts[part];
    const fresh = c && Date.now() - Date.parse(c.fetchedAt) < (opts.ttlMs ?? TTL_MS);
    if (opts.refresh || !fresh) { cache.parts[part] = { fetchedAt: new Date().toISOString(), data: await fetchPart(siteId, cache.pageId, part) }; dirty = true; }
  }
  if (dirty) {
    // Parallel agents: re-read just before writing and replace only the parts read here, so as not to overwrite
    // an invalidation or a newer part written by another process in the meantime.
    const disk = readCache(siteId);
    for (const part of want) {
      const mine = cache.parts[part], theirs = disk.parts[part];
      if (!mine) continue;
      const changedMeanwhile = theirs?.fetchedAt !== seen[part];
      // Invalidation written by another process during our read: it wins (we re-read on next need).
      if (changedMeanwhile && theirs?.fetchedAt.startsWith("1970")) continue;
      if (!theirs || !changedMeanwhile || Date.parse(mine.fetchedAt) >= Date.parse(theirs.fetchedAt)) disk.parts[part] = mine;
    }
    disk.pageId ??= cache.pageId;
    writeAtomic(file(siteId), JSON.stringify(disk));
  }
  const v = cache.parts.variables?.data ?? { collections: [], variables: [] };
  return {
    siteId, pageId: cache.pageId!, fetchedAt: [cache.parts.variables?.fetchedAt, cache.parts.classes?.fetchedAt, cache.parts.components?.fetchedAt].filter(Boolean).sort()[0] ?? new Date().toISOString(),
    collections: v.collections, variables: v.variables, classes: cache.parts.classes?.data.classes ?? [], components: cache.parts.components?.data.components ?? [],
  };
}

/** Summary: collections and variable counts, classes by type, components and their props. */
export async function getDesignSystem(siteId: string, opts: { refresh?: boolean; maxComponents?: number } = {}) {
  const ds = await loadDesignSystem(siteId, { refresh: opts.refresh });
  const byType = ds.classes.reduce<Record<string, number>>((a, c) => ((a[c.type] = (a[c.type] ?? 0) + 1), a), {});
  const max = opts.maxComponents ?? 40;
  return {
    fetchedAt: ds.fetchedAt,
    collections: ds.collections.map((c) => ({ name: c.name, modes: c.modes.map((m) => m.name), variables: ds.variables.filter((v) => v.collection === c.name).length })),
    classes: byType,
    components: ds.components.slice(0, max).map((c) => `${c.name}${c.props.length ? ` [${c.props.join(", ")}]` : ""}`),
    ...(ds.components.length > max ? { componentsTruncated: ds.components.length - max } : {}),
  };
}

const match = (q: string | RegExp, ...fields: (string | undefined)[]) =>
  fields.some((f) => f !== undefined && (typeof q === "string" ? f.toLowerCase().includes(q.toLowerCase()) : q.test(f)));

/** Variables whose name, CSS name or collection contains `q` (or matches the regex). */
export async function findVariables(siteId: string, q: string | RegExp, opts: { max?: number; collection?: string; type?: string; refresh?: boolean } = {}) {
  const ds = await loadDesignSystem(siteId, { refresh: opts.refresh, parts: ["variables"] });
  const m = ds.variables.filter((v) => match(q, v.name, v.cssName) && (!opts.collection || v.collection === opts.collection) && (!opts.type || v.type === opts.type));
  const max = opts.max ?? 40;
  return { matched: m.length, items: m.slice(0, max), ...(m.length > max ? { truncated: m.length - max } : {}) };
}

/** Classes whose name or selector contains `q`. type: global, combo, tag. */
export async function findClasses(siteId: string, q: string | RegExp, opts: { max?: number; type?: string; refresh?: boolean } = {}) {
  const ds = await loadDesignSystem(siteId, { refresh: opts.refresh, parts: ["classes"] });
  const m = ds.classes.filter((c) => match(q, c.name, c.selector) && (!opts.type || c.type === opts.type));
  const max = opts.max ?? 60;
  return { matched: m.length, items: m.slice(0, max), ...(m.length > max ? { truncated: m.length - max } : {}) };
}

/** Components whose name or group contains `q`, with their typed props. */
export async function findComponents(siteId: string, q: string | RegExp = "", opts: { max?: number; refresh?: boolean } = {}) {
  const ds = await loadDesignSystem(siteId, { refresh: opts.refresh, parts: ["components"] });
  const m = ds.components.filter((c) => match(q, c.name, c.group));
  const max = opts.max ?? 40;
  return { matched: m.length, items: m.slice(0, max), ...(m.length > max ? { truncated: m.length - max } : {}) };
}

/** Marks one or more cache parts as stale (after a write). Default: all. */
export function invalidateDesignSystem(siteId: string, parts: DsPart[] = ALL) {
  try {
    const c = readCache(siteId);
    for (const p of parts) if (c.parts[p]) c.parts[p]!.fetchedAt = "1970-01-01T00:00:00Z";
    writeAtomic(file(siteId), JSON.stringify(c));
  } catch { /* no cache */ }
}
