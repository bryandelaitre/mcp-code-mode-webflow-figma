/**
 * Edits to existing elements (hosted MCP): texts and classes, in batches, with a diff.
 * set_text targets the right node on its own: the element if it carries the text (Heading, Paragraph, Link…), otherwise
 * its single String node (Div Block with text: "This element doesn't support text" on the block, Webflow MCP lessons file).
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResults } from "./hosted-util.js";
import { loadTree, invalidateTree, refreshBranch, parentOf, patchTree, textOf, labelOf, type PageRef, type RawNode } from "./elements.js";
import { KitError, assertWriteAllowed, cap, short } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma edits texts or classes of existing elements after a reviewed dry run diff.";
const TEXT_TYPES = new Set(["Heading", "Paragraph", "Link", "Span", "TextLink", "Blockquote", "ListItem", "FormBlockLabel", "FormButton", "Strong", "Emphasized"]);
const flat = (n: RawNode): RawNode[] => [n, ...(n.children ?? []).flatMap(flat)];
const scope = (p: PageRef) => (p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {});

function textTarget(n: RawNode): RawNode {
  if (n.type === "String") return n;
  const strings = flat(n).filter((x) => x.type === "String");
  if (TEXT_TYPES.has(n.type) && strings.length <= 1) return n;
  if (strings.length === 1) return strings[0];
  if (TEXT_TYPES.has(n.type)) return n;
  throw new KitError(`${labelOf(n)} ${n.id.element} contient ${strings.length} nœuds texte : viser l'un d'eux (findElements type "String").`);
}

/** Replaces texts. Writes only what changes. dryRun by default. */
export async function setTexts(p: PageRef, updates: { element: string; text: string }[], opts: { dryRun?: boolean; maxDiff?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  const nodes = flat(await loadTree(p));
  const plan: { label: string; set_text: any }[] = [];
  const diff: unknown[] = [];
  for (const u of updates) {
    const n = nodes.find((x) => x.id.element === u.element);
    if (!n) throw new KitError(`Élément introuvable : ${u.element}`);
    const cur = textOf(n);
    if (cur === u.text) continue;
    const t = textTarget(n);
    plan.push({ label: u.element, set_text: { id: { component: t.id.component, element: t.id.element }, text: u.text, ...scope(p) } });
    diff.push({ element: u.element, el: labelOf(n), text: [short(cur, 50), short(u.text, 50)] });
  }
  const d = cap(diff, opts.maxDiff ?? 30);
  const summary: Record<string, unknown> = { dryRun, texts: plan.length, unchanged: updates.length - plan.length, diff: d.items, ...(d.truncated ? { diffTruncated: d.truncated } : {}) };
  if (dryRun || !plan.length) return summary;
  assertWriteAllowed(p.siteId);
  const errors: unknown[] = [];
  for (let i = 0; i < plan.length; i += 10) {
    const r = await h.dataElementTool.call({ siteId: p.siteId, pageId: p.pageId, actions: plan.slice(i, i + 10) } as any, CTX);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ element: res.label, error: res.error });
  }
  const failed = new Set(errors.map((e: any) => e.element));
  for (const x of plan) if (!failed.has(x.label)) patchTree.text(p, x.set_text.id.element, x.set_text.text);
  return { ...summary, written: plan.length - errors.length, ...(errors.length ? { errors } : {}) };
}

/**
 * Replaces the class list of elements (order: base class then combo classes). The combo class must exist: create it
 * first with ensureStyles (parent). Writes only what changes. dryRun by default.
 */
export async function setClasses(p: PageRef, updates: { element: string; classes: string[] }[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const nodes = flat(await loadTree(p));
  const plan: any[] = [];
  const diff: unknown[] = [];
  for (const u of updates) {
    const n = nodes.find((x) => x.id.element === u.element);
    if (!n) throw new KitError(`Élément introuvable : ${u.element}`);
    if (JSON.stringify(n.styleNames ?? []) === JSON.stringify(u.classes)) continue;
    plan.push({ label: u.element, set_style: { id: { component: n.id.component, element: n.id.element }, style_names: u.classes, ...scope(p) } });
    diff.push({ element: u.element, classes: [(n.styleNames ?? []).join(" "), u.classes.join(" ")] });
  }
  const summary: Record<string, unknown> = { dryRun, elements: plan.length, unchanged: updates.length - plan.length, diff };
  if (dryRun || !plan.length) return summary;
  assertWriteAllowed(p.siteId);
  // Base class missing from the site: set_style fails ("styles not found"); create it empty first.
  const bases = [...new Set(updates.map((u) => u.classes[0]).filter(Boolean))];
  if (bases.length) { const { ensureStyles } = await import("./styles.js"); await ensureStyles(p.siteId, bases.map((name) => ({ name })), { dryRun: false }); }
  const errors: unknown[] = [];
  for (let i = 0; i < plan.length; i += 10) {
    const r = await h.dataElementTool.call({ siteId: p.siteId, pageId: p.pageId, actions: plan.slice(i, i + 10) } as any, CTX);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ element: res.label, error: res.error });
  }
  const failed = new Set(errors.map((e: any) => e.element));
  for (const x of plan) if (!failed.has(x.label)) patchTree.classes(p, x.label, x.set_style.style_names);
  return { ...summary, written: plan.length - errors.length, ...(errors.length ? { errors } : {}) };
}

/** Simplified schema of an element to build: builder type, classes, text, settings, children. */
export interface BuildSchema {
  type: string;
  classes?: string[];
  text?: string;
  attributes?: Record<string, string>;
  /** Settings in set_settings format (e.g. [{ key: "code", static_text: { value: "<svg…>" } }]). */
  settings?: Record<string, unknown>[];
  headingLevel?: number;
  /** Image: asset id and alt text (set_image_asset at creation). */
  image?: { assetId: string; alt?: string };
  children?: BuildSchema[];
}

function toBuilder(s: BuildSchema): Record<string, unknown> {
  return {
    type: s.type,
    ...(s.classes?.length ? { set_style: { style_names: s.classes } } : {}),
    ...(s.text !== undefined ? { set_text: { text: s.text } } : {}),
    ...(s.headingLevel ? { set_heading_level: { heading_level: s.headingLevel } } : {}),
    ...(s.image ? { set_image_asset: { image_asset_id: s.image.assetId, ...(s.image.alt !== undefined ? { alt_text: s.image.alt } : {}) } } : {}),
    ...(s.attributes ? { set_attributes: { attributes: Object.entries(s.attributes).map(([name, value]) => ({ name, value })) } } : {}),
    ...(s.settings ? { settings: s.settings } : {}),
    ...(s.children?.length ? { children: s.children.map(toBuilder) } : {}),
  };
}

/**
 * Builds an element tree (data_element_builder), including inside a component definition (p.scopeComponentId).
 * Afterwards: re-reads the tree, re-applies the classes the builder ignored (Webflow MCP lessons file: `styles` / `set_style`
 * sometimes have no effect) and reports missing texts. dryRun by default.
 */
export async function buildElements(p: PageRef, o: { parent: string; position?: "append" | "prepend" | "before" | "after"; schema: BuildSchema; dryRun?: boolean }) {
  const dryRun = o.dryRun ?? true;
  const count = (s: BuildSchema): number => 1 + (s.children ?? []).reduce((a, c) => a + count(c), 0);
  if (dryRun) return { dryRun, parent: o.parent, position: o.position ?? "append", elements: count(o.schema) };
  assertWriteAllowed(p.siteId);
  // The builder silently ignores a class that does not exist (code-css missing from the site: reports/dogfood.md).
  // Create the missing base classes (empty) first.
  const wantedClasses = [...new Set(((function all(s: BuildSchema): string[] { return [...(s.classes?.slice(0, 1) ?? []), ...(s.children ?? []).flatMap(all)]; })(o.schema)))];
  if (wantedClasses.length) {
    const { ensureStyles } = await import("./styles.js");
    await ensureStyles(p.siteId, wantedClasses.map((name) => ({ name })), { dryRun: false });
  }
  const tree0 = await loadTree(p);
  const before = flat(tree0);
  const parentNode = before.find((x) => x.id.element === o.parent);
  if (!parentNode) throw new KitError(`Parent introuvable : ${o.parent}`);
  const known = new Set(before.map((x) => x.id.element));
  const r = await h.dataElementBuilder({
    siteId: p.siteId, pageId: p.pageId,
    actions: [{ build_label: "build", parent_element_id: { component: parentNode.id.component, element: parentNode.id.element }, creation_position: o.position ?? "append", element_schema: toBuilder(o.schema), ...scope(p) }],
  } as any, CTX);
  const res = hostedResults(r)[0];
  const pos = o.position ?? "append";
  const container = pos === "append" || pos === "prepend" ? o.parent : parentOf(tree0, o.parent)?.id.element;
  const after = flat(container ? await refreshBranch(p, container) : await loadTree(p, { refresh: true }));
  const created = after.filter((x) => !known.has(x.id.element) && x.type !== "String");
  if (!res?.ok && !created.length) throw new KitError(`element_builder : ${res?.error ?? "échec sans détail"}`);
  // Pair schema and created elements in traversal order (the builder keeps the children order).
  const order = (s: BuildSchema): BuildSchema[] => [s, ...(s.children ?? []).flatMap(order)];
  const wanted = order(o.schema);
  const fixes: any[] = [];
  const pairs = wanted.map((s, i) => ({ s, n: created[i] }));
  for (const { s, n } of pairs) {
    if (!n || !s.classes?.length) continue;
    if (JSON.stringify(n.styleNames ?? []) !== JSON.stringify(s.classes)) {
      fixes.push({ label: n.id.element, set_style: { id: { component: n.id.component, element: n.id.element }, style_names: s.classes, ...scope(p) } });
    }
  }
  const errors: unknown[] = res?.ok ? [] : [{ build: res?.error }];
  if (fixes.length) {
    const fr = await h.dataElementTool.call({ siteId: p.siteId, pageId: p.pageId, actions: fixes } as any, CTX);
    const res2 = hostedResults(fr);
    for (const x of res2) if (!x.ok) errors.push({ element: x.label, error: x.error });
    for (const f of fixes) if (!res2.some((x) => x.label === f.label && !x.ok)) patchTree.classes(p, f.label, f.set_style.style_names);
  }
  return {
    dryRun: false, created: created.length, expected: wanted.length,
    ids: pairs.map(({ s, n }) => `${s.type}${s.classes?.length ? "." + s.classes.join(".") : ""} ${n ? n.id.element : "MANQUANT"}`),
    ...(fixes.length ? { classesReposees: fixes.length } : {}), ...(errors.length ? { errors } : {}),
  };
}
