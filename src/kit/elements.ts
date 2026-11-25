/**
 * Page elements (hosted MCP): a single get_all_elements per page and per process, filtered in the script.
 * Replaces the query_elements / get_all_elements calls whose raw responses (up to 190,000 characters for one page)
 * used to enter the agent's context. query_elements is not used here: it fails on some pages (quirks.md).
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { KitError, short } from "./util.js";

export interface ElementId { component: string; element: string; slot?: string }
export interface RawNode {
  id: ElementId;
  type: string;
  styleNames?: string[];
  settings?: { tag?: string; headingLevel?: number; visibility?: boolean; [k: string]: unknown };
  textContent?: string;
  attributes?: Record<string, string>;
  instanceDetails?: { id: string; name: string; props?: { propId: string; name: string; value: unknown; hasOverride?: boolean }[]; slots?: unknown[] };
  name?: string;
  children?: RawNode[];
}
export interface PageRef { siteId: string; pageId: string; scopeComponentId?: string }

const cache = new Map<string, { at: number; root: RawNode }>();
const key = (p: PageRef) => `${p.siteId}:${p.pageId}:${p.scopeComponentId ?? ""}`;
/** Max age of the cached tree: past it, re-read (in case a change was made in the Designer meanwhile). */
const TREE_TTL_MS = 60_000;
let fullLoads = 0, branchLoads = 0;
export const treeLoadStats = () => ({ fullLoads, branchLoads });

/**
 * Raw page tree, cached for the process (60 s). Meant to be filtered, never displayed. The kit's writes keep the
 * cache up to date (local patch or re-read of the touched branch only): no need for `refresh` after them.
 */
export async function loadTree(p: PageRef, opts: { refresh?: boolean } = {}): Promise<RawNode> {
  const c = cache.get(key(p));
  if (!opts.refresh && c && Date.now() - c.at < TREE_TTL_MS) return c.root;
  const r = await h.dataElementTool.getAllElements(
    { siteId: p.siteId, pageId: p.pageId },
    { depth: -1, ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) },
    "Library mcp-code-mode-webflow-figma loads the page element tree once to filter it locally and return compact matches.",
  );
  fullLoads++;
  const root = hostedResult<RawNode>(r, "get_all_elements");
  if (!root?.id) throw new KitError("get_all_elements : arbre vide ou inattendu");
  cache.set(key(p), { at: Date.now(), root });
  return root;
}
/** Drops the cached tree (after a write the kit cannot apply locally). */
export const invalidateTree = (p?: PageRef) => (p ? cache.delete(key(p)) : cache.clear());

/** Parent of an element in the cached tree (undefined for the root or an unknown id). */
export function parentOf(root: RawNode, elementId: string): RawNode | undefined {
  const st = [root];
  while (st.length) {
    const n = st.pop()!;
    for (const ch of n.children ?? []) { if (ch.id.element === elementId) return n; st.push(ch); }
  }
}
const findIn = (root: RawNode, id: string): RawNode | undefined => {
  const st = [root];
  while (st.length) { const n = st.pop()!; if (n.id.element === id) return n; st.push(...(n.children ?? [])); }
};

/**
 * Re-reads only the `elementId` branch (query_elements, full depth) and replaces it in the cache.
 * Fallback: full re-read if the branch is not cached or if query_elements fails (quirks.md).
 * Returns the updated tree. Measured on the sandbox home page: branch ≈ 4,300 chars vs ≈ 5,900 for the page;
 * the gap grows with the page (up to 190,000 chars for a full tree).
 */
export async function refreshBranch(p: PageRef, elementId: string): Promise<RawNode> {
  const c = cache.get(key(p));
  const old = c && findIn(c.root, elementId);
  if (!c || !old) return loadTree(p, { refresh: true });
  try {
    const r = await h.dataElementTool.queryElements(
      { siteId: p.siteId, pageId: p.pageId },
      { queries: [{ label: "branch", element_id: { component: old.id.component, element: old.id.element }, children_depth: -1, ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) }] } as any,
      "Library mcp-code-mode-webflow-figma re-reads only the branch it just changed to keep its local tree cache current.",
    );
    const fresh = (hostedResult<any>(r, "query_elements") as any)?.[0]?.matches?.[0] as RawNode | undefined;
    if (!fresh?.id || fresh.id.element !== elementId) throw new Error("branche absente");
    branchLoads++;
    Object.keys(old).forEach((k) => delete (old as any)[k]);
    Object.assign(old, fresh);
    c.at = Date.now();
    return c.root;
  } catch {
    return loadTree(p, { refresh: true });
  }
}

/** Local cache patches after a write whose result is known (no re-read). */
export const patchTree = {
  remove(p: PageRef, ids: string[]) {
    const c = cache.get(key(p)); if (!c) return;
    for (const id of ids) { const par = parentOf(c.root, id); if (par) par.children = par.children!.filter((x) => x.id.element !== id); }
  },
  classes(p: PageRef, id: string, styleNames: string[]) {
    const n = cache.get(key(p)) && findIn(cache.get(key(p))!.root, id); if (n) n.styleNames = styleNames;
  },
  text(p: PageRef, id: string, text: string) {
    const c = cache.get(key(p)); const n = c && findIn(c.root, id); if (!n) return;
    if (n.type === "String") { n.textContent = text; return; }
    const strings = (function all(x: RawNode): RawNode[] { return x.type === "String" ? [x] : (x.children ?? []).flatMap(all); })(n);
    if (strings.length === 1) strings[0].textContent = text; else invalidateTree(p);
  },
};

const tagOf = (n: RawNode) =>
  n.type === "Heading" ? `h${n.settings?.headingLevel ?? ""}` : n.settings?.tag && n.settings.tag !== "div" ? n.settings.tag : undefined;

/** Short label of a node: "h1.heading-style-h1", "div.section_hero", "«Navbar»", "slot:vflex". */
export function labelOf(n: RawNode): string {
  if (n.type === "ComponentInstance") return `«${n.instanceDetails?.name ?? "?"}»`;
  if (n.type === "Slot") return `slot:${n.name ?? "?"}`;
  const base = tagOf(n) ?? (n.type === "Block" ? "div" : n.type);
  const cls = n.styleNames?.length ? "." + n.styleNames.join(".") : "";
  return base + cls;
}

/** Visible text of a node (concatenation of descendant Strings, without entering instances). */
export function textOf(n: RawNode): string {
  if (n.type === "String") return n.textContent ?? "";
  if (n.type === "ComponentInstance") return "";
  return (n.children ?? []).map(textOf).join(n.type === "RichText" || n.type === "List" ? " " : "").replace(/\s+/g, " ").trim();
}

interface Flat { node: RawNode; path: string[]; depth: number }
function flatten(root: RawNode): Flat[] {
  const out: Flat[] = [];
  const walk = (n: RawNode, path: string[], depth: number) => {
    out.push({ node: n, path, depth });
    for (const c of n.children ?? []) walk(c, [...path, labelOf(n)], depth + 1);
  };
  walk(root, [], 0);
  return out;
}

export interface ElementFilter {
  /** Exact type (Heading, Block, Image, Link, ComponentInstance, Slot, String…). Strings excluded unless set here. */
  type?: string;
  /** Substring of the visible text, case-insensitive. */
  text?: string;
  /** Substring of a class name, case-insensitive; `classExact` for an exact match. */
  class?: string;
  classExact?: string;
  /** Tag: h1…h6, section, main, a… */
  tag?: string;
  /** Custom attribute: exact name, value as a substring if given. */
  attribute?: { name: string; value?: string };
  /** Component instance name, as a substring. */
  component?: string;
  /** Substring of the path ("section_hero" finds everything inside the hero section). */
  within?: string;
  /** Free-form filter on the raw node. */
  where?: (n: RawNode) => boolean;
}

/** Readable value of a prop: rich text → innerText. */
const propValue = (v: unknown) => (v && typeof v === "object" && "innerText" in v ? (v as any).innerText : v);

/** Compact summary of a node. `id` = element; `component` / `slot` only if they differ from the root. */
function compact(f: Flat, rootComponent: string, o: { maxText: number; pathDepth: number }) {
  const n = f.node;
  const props = n.instanceDetails?.props?.length
    ? Object.fromEntries(n.instanceDetails.props.map((p) => [p.name, short(propValue(p.value), 40)]))
    : undefined;
  const text = textOf(n);
  return {
    id: n.id.element,
    ...(n.id.component !== rootComponent ? { component: n.id.component } : {}),
    ...(n.id.slot ? { slot: n.id.slot } : {}),
    el: labelOf(n),
    ...(text ? { text: short(text, o.maxText) } : {}),
    ...(n.attributes && Object.keys(n.attributes).length ? { attrs: n.attributes } : {}),
    ...(props ? { props } : {}),
    ...(n.children?.length ? { children: n.children.length } : {}),
    path: f.path.slice(-o.pathDepth).join(" > "),
  };
}

/**
 * Finds elements on a page and returns only the essentials: id, label (tag.classes or «Component»), short text,
 * instance props, path. To reuse an id in another tool: elementId(result, item).
 */
export async function findElements(
  p: PageRef,
  filter: ElementFilter = {},
  opts: { max?: number; maxText?: number; pathDepth?: number; refresh?: boolean; withAncestors?: boolean } = {},
) {
  const root = await loadTree(p, { refresh: opts.refresh });
  const lc = (s?: string) => (s ?? "").toLowerCase();
  const all = flatten(root);
  const matches = all.filter(({ node: n, path }) => {
    if (filter.type ? n.type !== filter.type : n.type === "String") return false;
    if (filter.tag && lc(tagOf(n)) !== lc(filter.tag)) return false;
    if (filter.class && !(n.styleNames ?? []).some((c) => lc(c).includes(lc(filter.class)))) return false;
    if (filter.classExact && !(n.styleNames ?? []).includes(filter.classExact)) return false;
    if (filter.component && !(n.type === "ComponentInstance" && lc(n.instanceDetails?.name).includes(lc(filter.component)))) return false;
    if (filter.attribute) {
      const v = n.attributes?.[filter.attribute.name];
      if (v === undefined || (filter.attribute.value !== undefined && !lc(v).includes(lc(filter.attribute.value)))) return false;
    }
    if (filter.text && !lc(textOf(n)).includes(lc(filter.text))) return false;
    if (filter.within && !lc(path.join(" > ")).includes(lc(filter.within))) return false;
    if (filter.where && !filter.where(n)) return false;
    return true;
  });
  // Text filter: an ancestor always contains its children's text. Keep only the deepest elements (no descendant
  // also matches), otherwise Body, page-wrapper… come before the real target.
  if (filter.text && !opts.withAncestors) {
    const ids = new Set(matches.map((m) => m.node.id.element));
    const hasMatchingChild = (n: RawNode): boolean => (n.children ?? []).some((c) => ids.has(c.id.element) || hasMatchingChild(c));
    for (let i = matches.length - 1; i >= 0; i--) if (hasMatchingChild(matches[i].node)) matches.splice(i, 1);
  }
  const max = opts.max ?? 30;
  const o = { maxText: opts.maxText ?? 80, pathDepth: opts.pathDepth ?? 4 };
  return {
    page: p.pageId,
    component: root.id.component,
    nodes: all.length,
    matched: matches.length,
    items: matches.slice(0, max).map((f) => compact(f, root.id.component, o)),
    ...(matches.length > max ? { truncated: `${matches.length - max} de plus : affiner le filtre ou augmenter max` } : {}),
  };
}

/** Composite id to pass to hosted MCP tools, built from a findElements item. */
export function elementId(res: { component: string }, item: { id: string; component?: string; slot?: string }): ElementId {
  return { component: item.component ?? res.component, element: item.id, ...(item.slot ? { slot: item.slot } : {}) };
}

/**
 * Page outline as indented lines (`h2.heading-style-h2 "Title…" #id`), up to a limited depth.
 * `from`: element id (or exact class) to use as the root.
 */
export async function tree(p: PageRef, opts: { depth?: number; from?: string; maxLines?: number; ids?: boolean; maxText?: number; refresh?: boolean } = {}) {
  let root = await loadTree(p, { refresh: opts.refresh });
  if (opts.from) {
    const f = flatten(root).find(({ node }) => node.id.element === opts.from || node.styleNames?.includes(opts.from!));
    if (!f) throw new KitError(`tree : « ${opts.from} » introuvable sur la page (ni id, ni classe exacte).`);
    root = f.node;
  }
  const depth = opts.depth ?? 4, maxLines = opts.maxLines ?? 150, ids = opts.ids ?? true, maxText = opts.maxText ?? 40;
  const lines: string[] = [];
  let hidden = 0;
  const walk = (n: RawNode, d: number) => {
    if (n.type === "String") return;
    if (lines.length >= maxLines) { hidden++; return; }
    const t = n.type === "Block" && (n.children?.length ?? 0) > 1 ? "" : textOf(n);
    const kids = (n.children ?? []).filter((c) => c.type !== "String");
    const more = d === depth && kids.length ? ` (+${kids.length})` : "";
    lines.push(`${"  ".repeat(d)}${labelOf(n)}${t ? ` "${short(t, maxText)}"` : ""}${ids ? ` #${n.id.element}` : ""}${more}`);
    if (d < depth) for (const c of kids) walk(c, d + 1);
  };
  walk(root, 0);
  return { page: p.pageId, component: root.id.component, lines, ...(hidden ? { truncated: `${hidden} nœud(s) non affiché(s) : réduire depth ou partir de from` } : {}) };
}
