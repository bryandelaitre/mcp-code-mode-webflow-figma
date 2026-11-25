/**
 * Component instance props (hosted MCP), set by prop name, with the type inferred from the component definition.
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResult, hostedResults } from "./hosted-util.js";
import { loadTree, invalidateTree, refreshBranch, parentOf, textOf, type PageRef, type RawNode, type ElementId } from "./elements.js";
import { KitError, assertWriteAllowed, cap, short } from "./util.js";
import { loadDesignSystem } from "./design-system.js";

interface PropDef { id: string; type: string; name: string; group?: string }
interface ComponentDef { id: string; name: string; props: PropDef[] }

/** Definitions (typed props) of several components, in one call. */
export async function getComponentDefs(p: PageRef, componentIds: string[]): Promise<Map<string, ComponentDef>> {
  const ids = [...new Set(componentIds)];
  const out = new Map<string, ComponentDef>();
  if (!ids.length) return out;
  const r = await h.dataComponentTool.call(
    { siteId: p.siteId, pageId: p.pageId, actions: ids.map((id) => ({ label: id, get_component: { component_id: id, options: { includeProps: true } } })) },
    "Library mcp-code-mode-webflow-figma reads component prop definitions to type instance prop values set by name.",
  );
  for (const [i, id] of ids.entries()) {
    const d = hostedResult<any>(r, `get_component ${id}`, i);
    const def = Array.isArray(d) ? d[0] : d;
    out.set(id, { id, name: def.name, props: def.props ?? [] });
  }
  return out;
}

const flat = (root: RawNode): RawNode[] => [root, ...(root.children ?? []).flatMap(flat)];
const shown = (v: unknown) => (v && typeof v === "object" && "innerText" in v ? (v as any).innerText : v);

/** Prop value in the set_component_instance_prop_values format, based on the definition's type. */
function toValue(def: PropDef, v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && "type" in (v as object)) return { ...(v as object), prop_id: def.id }; // raw form
  if (v === null) return { prop_id: def.id, type: "null" };
  const s = String(v);
  switch (def.type) {
    case "textContent": case "string": case "altText": case "id": case "headingTag":
    case "variant": // variant id, as a string (Webflow MCP lessons file)
      return { prop_id: def.id, type: "string", string_value: s };
    case "richText":
      return { prop_id: def.id, type: "richText", rich_text_inner_text: s };
    case "number":
      if (typeof v !== "number") throw new KitError(`Prop « ${def.name} » : nombre attendu, reçu ${JSON.stringify(v)}.`);
      return { prop_id: def.id, type: "number", number_value: v };
    case "boolean": case "visibility":
      if (typeof v !== "boolean") throw new KitError(`Prop « ${def.name} » : booléen attendu, reçu ${JSON.stringify(v)}.`);
      return { prop_id: def.id, type: "boolean", boolean_value: v };
    case "link": {
      const mode = s.startsWith("mailto:") ? "email" : s.startsWith("tel:") ? "phone" : "url";
      return { prop_id: def.id, type: "link", link_mode: mode, link_to: s.replace(/^(mailto|tel):/, "") };
    }
    case "video":
      return { prop_id: def.id, type: "video", video_src: s };
    default:
      throw new KitError(`Prop « ${def.name} » de type ${def.type} : passer la valeur brute ({type, …} de set_component_instance_prop_values).`);
  }
}

export interface InstanceUpdate { instance: string | ElementId; props: Record<string, unknown> }

/**
 * Sets instance props by name ("Question", "Padding Top"…). dryRun by default: returns the diff.
 * Link: URL string, "mailto:" or "tel:"; a link to a Webflow page is not possible through the MCP.
 */
export async function setInstanceProps(p: PageRef, updates: InstanceUpdate[], opts: { dryRun?: boolean; maxDiff?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  const root = await loadTree(p);
  const nodes = flat(root);
  const resolved = updates.map((u) => {
    const el = typeof u.instance === "string" ? u.instance : u.instance.element;
    const n = nodes.find((x) => x.id.element === el && x.type === "ComponentInstance");
    if (!n) throw new KitError(`Instance ${el} introuvable sur la page ${p.pageId} (ou ce n'est pas une instance de composant).`);
    return { u, n };
  });
  const defs = await getComponentDefs(p, resolved.map(({ n }) => n.instanceDetails!.id));

  const diff: unknown[] = [];
  const actions: { label: string; set_component_instance_prop_values: { element_id: ElementId; values: any[] } }[] = [];
  let unchanged = 0;
  for (const { u, n } of resolved) {
    const def = defs.get(n.instanceDetails!.id)!;
    const current = new Map((n.instanceDetails!.props ?? []).map((x) => [x.propId, x.value]));
    const values: any[] = [];
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [name, v] of Object.entries(u.props)) {
      const pd = def.props.find((x) => x.name === name) ?? def.props.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!pd) throw new KitError(`« ${def.name} » n'a pas de prop « ${name} ». Props : ${def.props.map((x) => `${x.name} (${x.type})`).join(", ")}.`);
      const value = toValue(pd, v);
      const before = shown(current.get(pd.id));
      if (JSON.stringify(before) === JSON.stringify(v)) continue;
      values.push(value);
      changes[pd.name] = [short(before, 50), short(v, 50)];
    }
    if (!values.length) { unchanged++; continue; }
    const element_id: ElementId = { component: n.id.component, element: n.id.element };
    actions.push({ label: n.id.element, set_component_instance_prop_values: { element_id, values, ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) } });
    diff.push({ instance: n.id.element, component: def.name, changes });
  }

  const d = cap(diff, opts.maxDiff ?? 30);
  const summary: Record<string, unknown> = { dryRun, instances: actions.length, unchanged, diff: d.items, ...(d.truncated ? { diffTruncated: d.truncated } : {}) };
  if (dryRun || !actions.length) return summary;

  assertWriteAllowed(p.siteId);
  const errors: unknown[] = [];
  let written = 0;
  for (let i = 0; i < actions.length; i += 10) {
    const r = await h.dataComponentPropsTool.call(
      { siteId: p.siteId, pageId: p.pageId, actions: actions.slice(i, i + 10) as any },
      "Library mcp-code-mode-webflow-figma sets component instance prop values by prop name after a reviewed dry run diff.",
    );
    for (const res of hostedResults(r)) res.ok ? written++ : errors.push({ instance: res.label, error: res.error });
  }
  // Few instances: re-read only their branches; otherwise a full re-read the next time it is needed.
  if (actions.length <= 3) for (const a of actions) await refreshBranch(p, a.label);
  else invalidateTree(p);
  return { ...summary, written, ...(errors.length ? { errors } : {}) };
}

/**
 * Places component instances (by name), then sets their props by name (setInstanceProps). Instances are placed
 * one at a time, in order (several insertions in a single call can land out of order, Webflow MCP lessons file).
 * Neither anchor nor target: an instance cannot serve as an insertion point (target a sibling instead).
 * dryRun by default. Returns the ids of the created instances.
 */
export async function insertComponents(
  p: PageRef,
  items: { component: string; parent: string; position?: "append" | "prepend" | "before" | "after"; props?: Record<string, unknown> }[],
  opts: { dryRun?: boolean } = {},
) {
  const dryRun = opts.dryRun ?? true;
  const ds = await loadDesignSystem(p.siteId, { parts: ["components"] });
  const resolved = items.map((it) => {
    const c = ds.components.find((x) => x.name === it.component);
    if (!c) throw new KitError(`Composant introuvable : ${it.component}`);
    return { it, c };
  });
  if (dryRun) return { dryRun, insert: resolved.map(({ it }) => `${it.component} → ${it.position ?? "append"} ${it.parent}${it.props ? " " + JSON.stringify(it.props) : ""}`) };
  assertWriteAllowed(p.siteId);
  const created: string[] = [];
  for (const { it, c } of resolved) {
    const tree0 = await loadTree(p);
    const before = new Set(flat(tree0).map((n) => n.id.element));
    const parent = flat(tree0).find((n) => n.id.element === it.parent);
    if (!parent) throw new KitError(`Parent introuvable : ${it.parent}`);
    if (parent.type === "ComponentInstance" && (it.position === "before" || it.position === "after")) throw new KitError("Une instance ne sert pas d'ancre : viser un élément voisin.");
    const r = await h.dataComponentTool.insertComponentInstance(
      { siteId: p.siteId, pageId: p.pageId },
      { parent_element_id: { component: parent.id.component, element: parent.id.element }, component_id: c.id, creation_position: it.position ?? "append", ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) } as any,
      "Library mcp-code-mode-webflow-figma places a component instance and then sets its props by name.",
    );
    hostedResult(r, "insert_component_instance");
    const pos = it.position ?? "append";
    const container = pos === "append" || pos === "prepend" ? it.parent : parentOf(tree0, it.parent)?.id.element;
    const id = flat(container ? await refreshBranch(p, container) : await loadTree(p, { refresh: true })).find((n) => !before.has(n.id.element) && n.type === "ComponentInstance")?.id.element;
    if (!id) throw new KitError(`Instance ${it.component} non retrouvée après insertion : relire la page avant de relancer.`);
    created.push(id);
    if (it.props) await setInstanceProps(p, [{ instance: id, props: it.props }], { dryRun: false });
  }
  return { dryRun: false, created };
}

/** Detaches instances (unlink): their elements become editable. dryRun by default. */
export async function detachInstances(p: PageRef, instanceIds: string[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const nodes = flat(await loadTree(p));
  const targets = instanceIds.map((id) => {
    const n = nodes.find((x) => x.id.element === id && x.type === "ComponentInstance");
    if (!n) throw new KitError(`Instance introuvable : ${id}`);
    return n;
  });
  if (dryRun) return { dryRun, detach: targets.map((n) => `${n.instanceDetails?.name} ${n.id.element}`) };
  assertWriteAllowed(p.siteId);
  const r = await h.dataComponentTool.call({
    siteId: p.siteId, pageId: p.pageId,
    actions: targets.map((n) => ({ label: n.id.element, unlink_component_instance: { component_instance_id: { component: n.id.component, element: n.id.element }, ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) } })),
  } as any, "Library mcp-code-mode-webflow-figma detaches a section template instance to build a new section from it.");
  const res = hostedResults(r);
  invalidateTree(p);
  // Does the root element keep the instance's id? Re-read to find out.
  const after = flat(await loadTree(p));
  return { dryRun: false, detached: res.filter((x) => x.ok).length, roots: targets.map((n) => after.find((x) => x.id.element === n.id.element) ? n.id.element : "id changé : relire le parent"), ...(res.some((x) => !x.ok) ? { errors: res.filter((x) => !x.ok).map((x) => x.error) } : {}) };
}

/** Creates variants of a component if they do not exist. Returns name → id. dryRun by default. */
export async function createVariants(siteId: string, component: string, names: string[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const ds = await loadDesignSystem(siteId, { parts: ["components"] });
  const c = ds.components.find((x) => x.name === component);
  if (!c) throw new KitError(`Composant introuvable : ${component}`);
  const base = { siteId, pageId: ds.pageId };
  const read = async () => {
    const r = hostedResult<any>(await h.dataComponentTool.getComponent(base, { component_id: c.id, options: { includeVariants: true } } as any), "get_component");
    return new Map<string, string>(((Array.isArray(r) ? r[0] : r).variants ?? []).map((v: any) => [v.name, v.id]));
  };
  const cur = await read();
  const missing = names.filter((n) => !cur.has(n));
  if (dryRun || !missing.length) return { dryRun, create: missing, variants: Object.fromEntries(cur) };
  assertWriteAllowed(siteId);
  const r = await h.dataComponentVariantsTool.call({ ...base, actions: missing.map((name) => ({ label: name, create_variant: { component_id: c.id, name } })) } as any);
  const errs = hostedResults(r).filter((x) => !x.ok);
  return { dryRun: false, created: missing.length - errs.length, variants: Object.fromEntries(await read()), ...(errs.length ? { errors: errs.map((x) => x.error) } : {}) };
}

export interface PropSpec {
  name: string;
  type: "textContent" | "string" | "richText" | "image" | "link" | "video" | "number" | "boolean" | "id" | "altText";
  tooltip?: string;
  group?: string;
  default?: string;
  /**
   * Where to bind the prop in the definition: an element found by its exact class (first match) or by its text,
   * plus the setting key (`text`, `altText`, `src`…); or a prop of a nested instance (`instanceProp`).
   */
  bind?: { class?: string; text?: string; key?: string; instanceProp?: string; component?: string; nth?: number };
}

/**
 * Turns a page element into a component (instance left in place), creates its props and binds them.
 * Ids change on transformation (Webflow MCP lessons file): everything is re-read from the definition before binding.
 */
export async function componentize(p: PageRef, o: { element: string; name: string; group?: string; description?: string; props?: PropSpec[]; dryRun?: boolean }) {
  const dryRun = o.dryRun ?? true;
  const ds0 = await loadDesignSystem(p.siteId, { refresh: true, parts: ["components"] });
  if (ds0.components.some((c) => c.name === o.name)) throw new KitError(`Un composant « ${o.name} » existe déjà : le réutiliser ou choisir un autre nom.`);
  const nodes = flat(await loadTree(p));
  const el = nodes.find((x) => x.id.element === o.element);
  if (!el) throw new KitError(`Élément introuvable : ${o.element}`);
  if (dryRun) return { dryRun, element: `${el.type}${el.styleNames?.length ? "." + el.styleNames.join(".") : ""}`, name: o.name, props: (o.props ?? []).map((x) => `${x.name} (${x.type})${x.bind ? " → " + JSON.stringify(x.bind) : ""}`) };
  assertWriteAllowed(p.siteId);
  const base = { siteId: p.siteId, pageId: p.pageId };
  hostedResult(await h.dataComponentTool.transformElementToComponent(base, { id: { component: el.id.component, element: el.id.element }, name: o.name, ...(o.group ? { group: o.group } : {}), ...(o.description ? { description: o.description } : {}), replace: true } as any), "transform_element_to_component");
  invalidateTree(p);
  const ds = await loadDesignSystem(p.siteId, { refresh: true, parts: ["components"] });
  const comp = ds.components.find((c) => c.name === o.name);
  if (!comp) throw new KitError(`Composant « ${o.name} » non retrouvé après transformation.`);
  const out: Record<string, unknown> = { dryRun: false, componentId: comp.id };
  if (!o.props?.length) return out;
  hostedResult(await h.dataComponentPropsTool.createProp(base, {
    component_id: comp.id,
    props: o.props.map((x) => ({ type: x.type, name: x.name, ...(x.tooltip ? { tooltip: x.tooltip } : {}), ...(x.group ? { group: x.group } : {}), ...(x.default !== undefined && ["textContent", "string", "richText"].includes(x.type) ? { default_text: x.type === "richText" ? { rich_text_inner_text: x.default } : { value: x.default } } : {}), ...(x.default !== undefined && x.type === "link" ? { default_link: linkDefault(x.default) } : {}) })),
  } as any), "create_prop");
  // Image and alt text: the default value goes through update_prop / default_text (Webflow MCP lessons file).
  const later = Object.fromEntries(o.props.filter((x) => x.default !== undefined && (x.type === "image" || x.type === "altText")).map((x) => [x.name, x.default!]));
  if (Object.keys(later).length) await setPropDefaults(p.siteId, o.name, later, { dryRun: false });
  const defs = (await getComponentDefs(p, [comp.id])).get(comp.id)!;
  const def = flat(await loadTree({ ...p, scopeComponentId: comp.id }, { refresh: true }));
  const ops: any[] = [], nested: any[] = [], errors: unknown[] = [];
  for (const x of o.props) {
    if (!x.bind) continue;
    const pd = defs.props.find((d) => d.name === x.name);
    if (!pd) { errors.push({ prop: x.name, error: "prop non créée" }); continue; }
    const candidates = def.filter((n) =>
      (x.bind!.class ? n.styleNames?.includes(x.bind!.class) : true) &&
      (x.bind!.text ? textOf(n) === x.bind!.text : true) &&
      (x.bind!.instanceProp ? n.type === "ComponentInstance" && (!x.bind!.component || n.instanceDetails?.name === x.bind!.component) : n.type !== "ComponentInstance"));
    // By text: a container has the same text as its child (reports/dogfood.md) → keep the deepest ones.
    const pool = x.bind.text ? candidates.filter((n) => !flat(n).slice(1).some((d) => candidates.includes(d))) : candidates;
    const target = pool[x.bind.nth ?? 0];
    if (!target) { errors.push({ prop: x.name, error: `cible introuvable ${JSON.stringify(x.bind)}` }); continue; }
    if (x.bind.instanceProp) {
      const childDef = (await getComponentDefs(p, [target.instanceDetails!.id])).get(target.instanceDetails!.id)!;
      const cp = childDef.props.find((d) => d.name === x.bind!.instanceProp);
      if (!cp) { errors.push({ prop: x.name, error: `prop « ${x.bind.instanceProp} » absente de ${childDef.name}` }); continue; }
      nested.push({ label: x.name, set_component_instance_prop_values: { element_id: { component: target.id.component, element: target.id.element }, values: [{ prop_id: cp.id, type: "bindable", binding_source_type: "prop", binding_prop_id: pd.id }], scope_component_id: comp.id } });
    } else {
      ops.push({ label: x.name, element_id: { component: target.id.component, element: target.id.element }, settings: [{ key: x.bind.key ?? "text", binding: { source_type: "prop", prop_id: pd.id } }], scope_component_id: comp.id });
    }
  }
  if (ops.length) {
    const r = await h.dataElementSettingsTool.setSettings(base, { operations: ops } as any);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ bind: res.label, error: res.error });
  }
  if (nested.length) {
    const r = await h.dataComponentPropsTool.call({ ...base, actions: nested } as any);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ bind: res.label, error: res.error });
  }
  return { ...out, props: defs.props.map((d) => `${d.name} (${d.type})`), bound: ops.length + nested.length - errors.length, ...(errors.length ? { errors } : {}) };
}


const linkDefault = (v: string) => (v.startsWith("mailto:") ? { mode: "email", to: v.slice(7) } : v.startsWith("tel:") ? { mode: "phone", to: v.slice(4) } : { mode: "url", to: v });

/**
 * Default values of existing props, by name: text, link (URL, mailto:, tel:), image (asset id) or alt text.
 * This is what instances that do not override the prop display. dryRun by default.
 */
export async function setPropDefaults(siteId: string, component: string, values: Record<string, string>, opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const ds = await loadDesignSystem(siteId, { parts: ["components"] });
  const c = ds.components.find((x) => x.name === component) ?? (await loadDesignSystem(siteId, { refresh: true, parts: ["components"] })).components.find((x) => x.name === component);
  if (!c) throw new KitError(`Composant introuvable : ${component}`);
  const base = { siteId, pageId: ds.pageId };
  const r = hostedResult<any>(await h.dataComponentTool.getComponent(base, { component_id: c.id, options: { includeProps: true } } as any), "get_component");
  const defs: any[] = (Array.isArray(r) ? r[0] : r).props ?? [];
  const props: any[] = [], diff: unknown[] = [];
  for (const [name, v] of Object.entries(values)) {
    const d = defs.find((x) => x.name === name);
    if (!d) throw new KitError(`« ${component} » n'a pas de prop « ${name} ». Props : ${defs.map((x) => x.name).join(", ")}.`);
    const cur = d.defaultValue && typeof d.defaultValue === "object" ? (d.defaultValue.to ?? d.defaultValue.innerText ?? JSON.stringify(d.defaultValue)) : d.defaultValue;
    if (cur === v) continue;
    props.push({ prop_id: d.id, ...(d.type === "link" ? { default_link: linkDefault(v) } : d.type === "richText" ? { default_text: { rich_text_inner_text: v } } : { default_text: { value: v } }) });
    diff.push({ prop: name, type: d.type, default: [short(cur ?? null, 40), short(v, 40)] });
  }
  if (dryRun || !props.length) return { dryRun, props: props.length, diff };
  assertWriteAllowed(siteId);
  hostedResult(await h.dataComponentPropsTool.updateProp(base, { component_id: c.id, props } as any), "update_prop");
  return { dryRun: false, props: props.length, diff };
}
