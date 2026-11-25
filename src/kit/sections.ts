/**
 * HTML + CSS insertion (hosted MCP, data_whtml_builder) with the guards from the Webflow MCP lessons file:
 * - CSS: single-class or combo class selectors (.a.is-b) only; a descendant selector makes the whole section fail
 *   (§3.5), so it is rejected before the call;
 * - images: src rewritten to the S3 format (the only format that links the image to the asset, §3.4); local files
 *   or external URLs are uploaded first with uploadAssets;
 * - attributes: the builder drops those that do not start with data- (§3.3); flagged before, checked after;
 * - classes: the builder only creates those that have a CSS rule; an empty rule is added for new classes
 *   (those that already exist on the site are kept without a rule).
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { loadTree, invalidateTree, refreshBranch, parentOf, patchTree, labelOf, type ElementId, type PageRef, type RawNode } from "./elements.js";
import { hostedResults } from "./hosted-util.js";
import { uploadAssets } from "./assets.js";
import { KitError, assertWriteAllowed, short } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma inserts a section from HTML and CSS after local checks and reports dropped classes or attributes.";
const KEPT_ATTRS = new Set(["class", "href", "src", "alt", "target", "rel", "type", "name", "value", "title", "width", "height", "loading", "for", "action", "method", "role", "srcset", "sizes", "colspan", "rowspan"]);

/** Selectors rejected by the builder: anything that is not a chain of classes (descendant, child, tag, id…). */
export function checkCss(css: string): { rules: number; invalid: string[] } {
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter(Boolean);
  const invalid = selectors.filter((s) => !/^(\.[\w-]+)+(:{1,2}[\w-]+(\([^)]*\))?)?$/.test(s) && !/^@/.test(s));
  return { rules: selectors.length, invalid };
}

export interface InsertSectionOptions {
  /** Where to insert: element id (or exact class) and position. append / prepend = inside the element; before / after = next to it. */
  target: string | ElementId;
  position?: "append" | "prepend" | "before" | "after";
  html: string;
  css?: string;
  /** Images to upload before insertion: HTML src → alt text. Otherwise local / external srcs are left as is (flagged). */
  uploadImages?: Record<string, string>;
  /** Fix hrefs left behind as attributes (default: yes). */
  fixLinks?: boolean;
  dryRun?: boolean;
}

const VOID = new Set(["img", "br", "hr", "input", "meta", "link", "source", "area", "base", "col", "embed", "track", "wbr"]);
/** Splits an HTML fragment into top-level elements (the builder accepts only one per call). */
export function splitRoots(html: string): string[] {
  const out: string[] = [];
  const re = /<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
  let depth = 0, start = -1, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [tag, name, selfClose] = m, closing = tag.startsWith("</"), isVoid = VOID.has(name.toLowerCase()) || selfClose === "/";
    if (!closing && depth === 0) start = m.index;
    if (closing) depth--; else if (!isVoid) depth++;
    if (depth === 0 && start >= 0) { out.push(html.slice(start, m.index + tag.length)); start = -1; }
  }
  return out.length ? out : [html];
}

const classesIn = (html: string) => [...new Set([...html.matchAll(/class\s*=\s*"([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)))];
const attrsIn = (html: string) => [...new Set([...html.matchAll(/<[a-z][\w-]*\s([^>]*)>/gi)].flatMap((m) => [...m[1].matchAll(/([:\w-]+)\s*=/g)].map((a) => a[1].toLowerCase())))];
const flat = (n: RawNode): RawNode[] => [n, ...(n.children ?? []).flatMap(flat)];

export async function insertSection(p: PageRef, o: InsertSectionOptions) {
  const dryRun = o.dryRun ?? true;
  if (/<style[\s>]/i.test(o.html) || /<style[\s>]/i.test(o.css ?? "")) throw new KitError("Pas de <style> : passer le CSS dans `css`.");
  const css = o.css ? checkCss(o.css) : { rules: 0, invalid: [] };
  if (css.invalid.length) {
    throw new KitError(`Sélecteurs refusés par le builder (une seule classe ou un combo .a.is-b) : ${css.invalid.slice(0, 8).join(" | ")}. Donner une classe à chaque élément ciblé.`);
  }

  // Target: id, or exact class (first element that has it).
  let target: ElementId;
  if (typeof o.target === "object") target = o.target;
  else {
    const root = await loadTree(p);
    const n = flat(root).find((x) => x.id.element === o.target) ?? flat(root).find((x) => x.styleNames?.includes(o.target as string));
    if (!n) throw new KitError(`Cible « ${o.target} » introuvable sur la page (ni id, ni classe exacte).`);
    if (n.type === "ComponentInstance" && (o.position === "before" || o.position === "after")) {
      throw new KitError("Insertion à côté d'une instance de composant refusée par Webflow : viser un élément voisin ou le parent (fichier de leçons).");
    }
    target = { component: n.id.component, element: n.id.element };
  }

  // Images: cdn.prod… → S3; other srcs (local, external) uploaded if requested.
  const siteId = p.siteId;
  let html = o.html;
  const rewrites: string[] = [];
  html = html.replace(/https:\/\/cdn\.prod\.website-files\.com\/([0-9a-f]{24})\/([0-9a-f]{24}_[^"'\s)]+)/g, (_m, site, rest) => {
    rewrites.push(rest);
    return `https://s3.amazonaws.com/webflow-prod-assets/${site}/${rest}`;
  });
  const srcs = [...html.matchAll(/<img[^>]*\ssrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  const foreign = srcs.filter((s) => !s.startsWith(`https://s3.amazonaws.com/webflow-prod-assets/${siteId}/`));
  const toUpload = Object.keys(o.uploadImages ?? {});
  const missing = toUpload.filter((s) => !srcs.includes(s));
  if (missing.length) throw new KitError(`uploadImages : src absents du HTML : ${missing.join(", ")}`);
  // HTML classes with no CSS rule: the builder only creates classes that have a rule (an empty rule is enough).
  // A class already on the site is kept without a rule: nothing is added to it (no risk of overwriting its styles).
  const ruled = new Set([...(o.css ?? "").matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
  const noRule = classesIn(html).filter((c) => !ruled.has(c));
  let emptyRules: string[] = [];
  if (noRule.length) {
    const q = await h.dataStyleTool.queryStyles(
      { siteId: p.siteId, pageId: p.pageId },
      { queries: noRule.map((c) => ({ label: c, name_path: [c], limit: 200 })) },
      CTX,
    );
    const found = hostedResult<any[]>(q, "query_styles");
    const exists = new Set(found.flatMap((f) => (f.matches ?? []).filter((m: any) => m.name === f.label).map((m: any) => m.name)));
    emptyRules = noRule.filter((c) => !exists.has(c));
  }
  const cssOut = [o.css ?? "", ...emptyRules.map((c) => `.${c} {}`)].filter(Boolean).join("\n");
  const dropped = attrsIn(html).filter((a) => !a.startsWith("data-") && !a.startsWith("aria-") && !KEPT_ATTRS.has(a));
  const warnings = [
    ...(dropped.length ? [`attributs probablement jetés (pas data-*) : ${dropped.join(", ")}`] : []),
    ...foreign.filter((s) => !toUpload.includes(s)).map((s) => `image non reliée à un asset : ${short(s, 80)} (passer uploadImages)`),
    ...(/\sid\s*=/.test(html) ? ["attribut id réservé : poser l'id avec setSettings(domId) après insertion"] : []),
  ];
  const plan = {
    dryRun, target: target.element, position: o.position ?? "append", htmlChars: html.length, cssRules: css.rules,
    classes: classesIn(html).length, ...(emptyRules.length ? { emptyRulesAdded: emptyRules } : {}), images: srcs.length, ...(rewrites.length ? { rewrittenToS3: rewrites.length } : {}),
    ...(toUpload.length ? { upload: toUpload.length } : {}), ...(warnings.length ? { warnings } : {}),
  };
  if (dryRun) return plan;

  assertWriteAllowed(siteId);
  if (toUpload.length) {
    const up = await uploadAssets(siteId, toUpload.map((src) => ({ file: src, alt: o.uploadImages![src] })), { dryRun: false });
    toUpload.forEach((src, i) => { html = html.split(`"${src}"`).join(`"${up.items[i].url}"`); });
  }
  const tree0 = await loadTree(p);
  const before = new Set(flat(tree0).map((n) => n.id.element));
  // Targeted re-read: only the branch receiving the roots is re-read after each insertion.
  const pos0 = o.position ?? "append";
  const container = pos0 === "append" || pos0 === "prepend" ? target.element : parentOf(tree0, target.element)?.id.element;
  const reread = () => (container ? refreshBranch(p, container) : loadTree(p, { refresh: true }));
  // The builder requires a single root per insertion: several roots are inserted one after another, in order
  // (the first at the requested position, the next ones right after the previous one). The CSS goes with the first.
  const roots = splitRoots(html);
  let anchor = target, position = o.position ?? "append";
  let r: any, res: any;
  for (const [i, frag] of roots.entries()) {
    const known = new Set(flat(await loadTree(p)).map((n) => n.id.element));
    r = await h.dataWhtmlBuilder(
      { siteId, pageId: p.pageId, actions: [{ build_label: `section-${i}`, parent_element_id: anchor, creation_position: position, html: frag, ...(i === 0 && cssOut ? { css: cssOut } : {}), ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) }] } as any,
      CTX,
    );
    res = hostedResult<any>(r, "whtml_builder");
    if (roots.length > 1) {
      const now = flat(await reread());
      const newRoot = now.find((n) => !known.has(n.id.element) && n.type !== "String" && !now.some((m) => !known.has(m.id.element) && (m.children ?? []).some((c) => c.id.element === n.id.element)));
      if (!newRoot) break;
      anchor = { component: newRoot.id.component, element: newRoot.id.element };
      position = "after";
    }
  }
  const status = res?.status ?? (Array.isArray(res) ? res[0]?.status : undefined);
  const builderWarnings = JSON.stringify(res ?? "").match(/"(image_warnings|warnings|missing_font)"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)?.map((w) => short(w, 200)) ?? [];

  // Re-read: new elements, classes and data-* attributes actually set.
  const after = flat(roots.length > 1 ? await loadTree(p) : await reread());
  const created = after.filter((n) => !before.has(n.id.element) && n.type !== "String");
  if (!created.length) {
    // Nothing was inserted: surface the builder's message rather than a list of "lost" classes.
    const msg = JSON.stringify(res ?? r.text).replace(/\s+/g, " ").slice(0, 400);
    throw new KitError(`whtml_builder n'a rien inséré (${status ?? "statut inconnu"}) : ${msg}`);
  }
  const gotClasses = new Set(created.flatMap((n) => n.styleNames ?? []));
  const gotAttrs = new Set(created.flatMap((n) => Object.keys(n.attributes ?? {}).map((a) => a.toLowerCase())));
  const lostClasses = classesIn(html).filter((c) => !gotClasses.has(c));
  const lostData = attrsIn(html).filter((a) => a.startsWith("data-") && !gotAttrs.has(a));
  const images = created.filter((n) => n.type === "Image");
  const unlinked = images.filter((n) => !(n.settings as any)?.assetId).length;
  const top = created.filter((n) => !created.some((c) => (c.children ?? []).some((k) => k.id.element === n.id.element)));
  // Links: real link setting + removal of the duplicate href attribute (fixLinks option, default yes).
  let links: unknown;
  if (o.fixLinks !== false && created.some((n) => n.attributes && "href" in n.attributes)) {
    links = {};
    for (const t of top) Object.assign(links as object, { [t.id.element]: await fixLinkAttributes(p, t.id.element, { dryRun: false }) });
  }
  return {
    ...plan, dryRun: false, ...(status ? { status } : {}), ...(links ? { links } : {}),
    inserted: top.map((n) => ({ id: n.id.element, el: labelOf(n) })), elements: created.length,
    ...(lostClasses.length ? { lostClasses } : {}), ...(lostData.length ? { lostDataAttributes: lostData } : {}),
    ...(images.length ? { images: images.length, unlinkedImages: unlinked } : {}),
    ...(builderWarnings.length ? { builderWarnings } : {}),
  };
}

/** Removes elements (by id). dryRun by default. Mostly used to undo an insertion. */
export async function removeElements(p: PageRef, ids: string[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const root = await loadTree(p);
  const nodes = ids.map((id) => flat(root).find((n) => n.id.element === id));
  const missing = ids.filter((_, i) => !nodes[i]);
  if (missing.length) throw new KitError(`Éléments introuvables : ${missing.join(", ")}`);
  const plan = { dryRun, remove: nodes.map((n) => ({ id: n!.id.element, el: labelOf(n!), descendants: flat(n!).length - 1 })) };
  if (dryRun) return plan;
  assertWriteAllowed(p.siteId);
  const r = await h.dataElementTool.call(
    { siteId: p.siteId, pageId: p.pageId, actions: nodes.map((n) => ({ label: n!.id.element, remove_element: { id: { component: n!.id.component, element: n!.id.element }, ...(p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {}) } })) } as any,
    CTX,
  );
  for (let i = 0; i < nodes.length; i++) hostedResult(r, `remove_element ${nodes[i]!.id.element}`, i);
  patchTree.remove(p, nodes.map((n) => n!.id.element));
  return { ...plan, dryRun: false, removed: nodes.length };
}


/**
 * Links inserted by WHTML: the `href` also stays as a custom attribute (Webflow MCP lessons file, webflow-mcp.md §4).
 * Sets the real link setting (url, tel:, mailto:) then removes the attribute, for every link under `root`.
 * "#…" anchors become url links "#…". dryRun by default.
 */
export async function fixLinkAttributes(p: PageRef, root: string, opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const all = flat(await loadTree(p));
  const r0 = all.find((n) => n.id.element === root);
  if (!r0) throw new KitError(`Racine introuvable : ${root}`);
  const links = flat(r0).filter((n) => n.attributes && "href" in n.attributes);
  if (dryRun || !links.length) return { dryRun, links: links.length };
  assertWriteAllowed(p.siteId);
  const sc = p.scopeComponentId ? { scope_component_id: p.scopeComponentId } : {};
  const errors: unknown[] = [];
  for (let i = 0; i < links.length; i += 10) {
    const batch = links.slice(i, i + 10);
    const ops = batch.map((n) => {
      const href = String(n.attributes!.href);
      const link = href.startsWith("tel:") ? { mode: "phone", to: href.slice(4) } : href.startsWith("mailto:") ? { mode: "email", to: href.slice(7) } : { mode: "url", to: href };
      return { label: n.id.element, element_id: { component: n.id.component, element: n.id.element }, settings: [{ key: "link", static_link: link }], ...sc };
    });
    const s = await h.dataElementSettingsTool.setSettings({ siteId: p.siteId, pageId: p.pageId }, { operations: ops } as any, CTX);
    if (!hostedResults(s)[0]?.ok) errors.push({ batch: i / 10, error: hostedResults(s)[0]?.error });
    const rm = await h.dataElementTool.call({ siteId: p.siteId, pageId: p.pageId, actions: batch.map((n) => ({ label: n.id.element, remove_attribute: { id: { component: n.id.component, element: n.id.element }, attribute_names: ["href"], ...sc } })) } as any, CTX);
    for (const x of hostedResults(rm)) if (!x.ok) errors.push({ element: x.label, error: x.error });
  }
  const left = flat(flat(await refreshBranch(p, root)).find((n) => n.id.element === root)!).filter((n) => n.attributes && "href" in n.attributes).length;
  return { dryRun: false, links: links.length, attributesLeft: left, ...(errors.length ? { errors: errors.slice(0, 5) } : {}) };
}
