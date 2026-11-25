/**
 * Figma module: read a design without bringing the Figma MCP's raw responses into the agent's context.
 *
 * - figmaOutline : outline of the page or section (vector patterns collapsed into one line).
 * - figmaSpec    : compact spec (structure, reduced Tailwind classes, variables by name, texts, assets); splits an
 *                  overly heavy node into its useful children on its own.
 * - figmaTokens  : Figma variables used by a node, matched to Webflow variables (same value).
 * - figmaAssets  : downloads the images and SVGs of a spec, deduplicated, with file size and dimensions.
 * - figmaScreenshot : screenshot saved to disk (only the path is returned).
 *
 * All raw responses are cached on disk (.cache/figma/<file>/, 24 h by default): reading the same node a second time
 * costs no call. Server: the Figma desktop app's local MCP (see lib/figma.ts), which reads the file open in the
 * active tab: `fileKey` is used to file the cache and to check it.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callFigma } from "../lib/figma.js";
import { writeAtomic } from "../lib/fsutil.js";
import { KitError } from "../kit/util.js";
import { parseMetadata, outline, isGraphic, walk, type FNode, type OutlineOptions } from "./metadata.js";
import { buildSpec, type Spec, type SpecAsset } from "./spec.js";
import { hasFigmaToken, figmaSections } from "./rest.js";
export { figmaSections, figmaComments, figmaOrphanComments, figmaExport, hasFigmaToken } from "./rest.js";

export interface FigmaRef { fileKey: string; nodeId: string }
export { parseMetadata, outline, buildSpec };

/** "https://www.figma.com/design/<key>/<name>?node-id=12-345" → { fileKey, nodeId: "12:345" }. */
export function figmaRef(url: string): FigmaRef {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => p === "design" || p === "file");
  const branch = parts.indexOf("branch");
  const fileKey = branch > 0 ? parts[branch + 1] : parts[i + 1];
  const nodeId = (u.searchParams.get("node-id") ?? "").replace("-", ":");
  if (!fileKey || !nodeId) throw new KitError(`Lien Figma incomplet (fichier ou node-id manquant) : ${url}`);
  return { fileKey, nodeId };
}

const TTL_MS = 24 * 3600_000;
const ARGS = { clientLanguages: "html,css", clientFrameworks: "webflow" };
const dir = (r: FigmaRef) => join(".cache", "figma", r.fileKey.replace(/\W/g, ""));
const cacheFile = (r: FigmaRef, tool: string, nodeId = r.nodeId) => join(dir(r), `${tool}-${nodeId.replace(/[^\w-]/g, "_")}.json`);
let fromCache = 0;
export const figmaCacheHits = () => fromCache;

/** Call with disk cache. Throws a readable error if the node is not in Figma's active tab. */
async function cached(r: FigmaRef, tool: string, nodeId: string, args: Record<string, unknown>, opts: { refresh?: boolean } = {}): Promise<string[]> {
  const f = cacheFile(r, tool, nodeId);
  if (!opts.refresh && existsSync(f) && Date.now() - statSync(f).mtimeMs < TTL_MS) { fromCache++; return JSON.parse(readFileSync(f, "utf8")); }
  const res = await callFigma(tool, { nodeId, ...args });
  if (res.isError || /No node could be found/.test(res.texts[0] ?? "")) {
    throw new KitError(`Figma : nœud ${nodeId} introuvable. Ouvrir le fichier ${r.fileKey} dans l'application Figma (onglet actif). ${(res.texts[0] ?? "").slice(0, 120)}`);
  }
  writeAtomic(f, JSON.stringify(res.texts));
  return res.texts;
}

async function tree(r: FigmaRef, nodeId: string, opts: { refresh?: boolean } = {}): Promise<FNode> {
  const t = await cached(r, "get_metadata", nodeId, ARGS, opts);
  const xml = t.find((x) => x.includes("<") && x.includes(`id="${nodeId}"`)) ?? t.join("\n");
  const root = parseMetadata(xml).flatMap(walk).find((n) => n.id === nodeId);
  if (!root) throw new KitError(`Figma : get_metadata n'a pas renvoyé le nœud ${nodeId}.`);
  return root;
}

/** Compact outline of a node (page or section). */
export async function figmaOutline(r: FigmaRef, opts: OutlineOptions & { refresh?: boolean } = {}) {
  const root = await tree(r, r.nodeId, opts);
  // Page frame returned without children by the local server: get the sections from the REST API (FIGMA_TOKEN token).
  if (!root.children.length && root.h > 2000) {
    if (!hasFigmaToken()) throw new KitError(`Figma : ${root.name} revient sans ses sections (serveur local). Passer les sections une par une, ou ajouter FIGMA_TOKEN dans .env.`);
    const s = await figmaSections(r.fileKey, r.nodeId);
    return { node: s.page, outline: s.sections.map((x) => `${x.name} [${x.id}] y ${x.y}, h ${x.h}${x.hidden ? " · masqué" : ""}`), sections: s.sections, graphics: [], texts: 0 };
  }
  const o = outline(root, opts);
  return { node: `${root.name} [${root.id}] ${Math.round(root.w)}×${Math.round(root.h)}`, outline: o.lines, graphics: o.graphics, texts: o.texts, ...(o.truncated ? { truncated: o.truncated } : {}) };
}

export interface FigmaSpecOptions {
  refresh?: boolean;
  /** Above this number of nodes in the subtree, split into children (default 400). */
  maxNodes?: number;
  /** Maximum number of spec lines (default 220). */
  maxLines?: number;
}

/**
 * Compact spec of a section. An overly heavy node (pattern of thousands of vectors, whole page) is split:
 * graphic subtrees become assets "to export", the other children are read one by one.
 */
export async function figmaSpec(r: FigmaRef, opts: FigmaSpecOptions = {}) {
  const root = await tree(r, r.nodeId, opts);
  const maxNodes = opts.maxNodes ?? 400;
  const lines: string[] = [], texts: string[] = [], styles = new Set<string>(), tokens = new Set<string>();
  const assets = new Map<string, SpecAsset>();
  const graphics: { id: string; name: string; shapes: number; w: number; h: number }[] = [];
  const add = (s: Spec, indent: number) => {
    lines.push(...s.lines.map((l) => "  ".repeat(indent) + l));
    texts.push(...s.texts); s.styles.forEach((x) => styles.add(x)); s.tokens.forEach((x) => tokens.add(x));
    for (const a of s.assets) { const e = assets.get(a.url); if (e) { e.usedBy.push(...a.usedBy); e.owners.push(...a.owners); e.cssSize ??= a.cssSize; } else assets.set(a.url, { ...a, owners: [...a.owners] }); }
  };
  // Whole page returned without children: read its sections (REST API), then each one.
  if (!root.children.length && root.h > 2000 && hasFigmaToken()) {
    const s = await figmaSections(r.fileKey, r.nodeId);
    root.children = [];
    for (const x of s.sections.filter((x) => !x.hidden)) root.children.push(await tree(r, x.id, opts));
  }
  const rec = async (n: FNode, indent: number) => {
    if (n.hidden) { lines.push(`${"  ".repeat(indent)}${n.name} [${n.id}] · masqué, ignoré`); return; }
    if (isGraphic(n)) {
      const shapes = walk(n).length - 1;
      graphics.push({ id: n.id, name: n.name, shapes, w: Math.round(n.w), h: Math.round(n.h) });
      lines.push(`${"  ".repeat(indent)}${n.name} [${n.id}] ${Math.round(n.w)}×${Math.round(n.h)} · graphique (${shapes} formes) : à exporter en SVG ou image`);
      return;
    }
    if (walk(n).length > maxNodes && n.children.length) {
      lines.push(`${"  ".repeat(indent)}${n.type} ${n.name} [${n.id}] ${Math.round(n.w)}×${Math.round(n.h)} · découpé (${walk(n).length} nœuds)`);
      for (const c of n.children) await rec(c, indent + 1);
      return;
    }
    const t = await cached(r, "get_design_context", n.id, { ...ARGS, excludeScreenshot: true }, opts);
    if (t.some((x) => x.startsWith("<frame") || x.startsWith("<"))) {
      // The server returned metadata instead of code (node too big for it): go down one level.
      lines.push(`${"  ".repeat(indent)}${n.type} ${n.name} [${n.id}] · trop gros pour Figma, découpé`);
      for (const c of n.children) await rec(c, indent + 1);
      return;
    }
    add(buildSpec(t), indent);
  };
  await rec(root, 0);
  // Display size of each asset: the largest of the nodes that display it (section metadata).
  const byId = new Map(walk(root).map((n) => [n.id, n]));
  const display = (a: SpecAsset) => {
    const ns = a.owners.map((id) => byId.get(id)).filter(Boolean) as FNode[];
    if (!ns.length) return a.cssSize;
    return `${Math.round(Math.max(...ns.map((n) => n.w)))}×${Math.round(Math.max(...ns.map((n) => n.h)))}`;
  };
  const max = opts.maxLines ?? 220;
  return {
    node: `${root.name} [${root.id}] ${Math.round(root.w)}×${Math.round(root.h)}`,
    spec: lines.slice(0, max), ...(lines.length > max ? { specTruncated: lines.length - max } : {}),
    texts, styles: [...styles], tokens: [...tokens],
    assets: [...assets.values()].map((a) => ({ name: a.name, ext: a.ext, usedBy: [...new Set(a.usedBy)].slice(0, 4), display: display(a), url: a.url })),
    ...(graphics.length ? { graphics } : {}),
  };
}

/** A node's Figma variables, matched to Webflow variables with the same value (colors, sizes, fonts). */
export async function figmaTokens(r: FigmaRef, opts: { siteId?: string; refresh?: boolean } = {}) {
  const t = await cached(r, "get_variable_defs", r.nodeId, ARGS, opts);
  const defs: Record<string, string> = JSON.parse(t.find((x) => x.trim().startsWith("{")) ?? "{}");
  const vars = Object.entries(defs).filter(([, v]) => !/^(Font|Effect)\(/.test(v));
  const styles = Object.entries(defs).filter(([, v]) => /^(Font|Effect)\(/.test(v)).map(([k, v]) => `${k}: ${v.replace(/(\d+\.\d{2})\d+/g, "$1")}`);
  if (!opts.siteId) return { variables: Object.fromEntries(vars), styles };
  const { loadDesignSystem } = await import("../kit/design-system.js");
  const ds = await loadDesignSystem(opts.siteId, { parts: ["variables"] });
  const norm = (v: string) => {
    const s = v.trim().toLowerCase();
    if (/^#[0-9a-f]{3,8}$/.test(s)) return s.length === 4 ? "#" + [...s.slice(1)].map((c) => c + c).join("") : s.slice(0, 7) + (s.length === 9 && s.endsWith("ff") ? "" : s.slice(7));
    if (/^-?\d+(\.\d+)?$/.test(s)) return `${+s}px`;
    if (/^-?\d+(\.\d+)?rem$/.test(s)) return `${+s.slice(0, -3) * 16}px`;
    if (/^-?\d+(\.\d+)?px$/.test(s)) return `${+s.slice(0, -2)}px`;
    return s;
  };
  const byValue = new Map<string, string[]>();
  for (const v of ds.variables) {
    if (v.value.startsWith("var(")) continue;
    const k = norm(v.value);
    byValue.set(k, [...(byValue.get(k) ?? []), v.name]);
  }
  const matched: Record<string, string> = {}, unmatched: Record<string, string> = {};
  // A spacing is never matched to a font size (same value, different meaning), and vice versa.
  const TYPO = /font|typo|text|heading|line-height|letter|leading|tracking/i;
  for (const [k, v] of vars) {
    const hits = byValue.get(norm(v))?.filter((w) => v.trim().startsWith("#") || TYPO.test(k) === TYPO.test(w));
    if (hits?.length) matched[`${k} (${v})`] = hits.slice(0, 3).join(" | ");
    else unmatched[k] = v;
  }
  return { matched, unmatched, styles };
}

export interface FigmaAssetsOptions {
  dir: string;
  prefix?: string;
  /** Resize and convert (default true). false: raw files from Figma. */
  optimize?: boolean;
  /** Factor applied to the display size (default 3, agency rule). */
  scale?: number;
  /** Full-width images (display ≥ fullWidthFrom px, default 1200): reduced factor (default 1.5, agency rule). */
  fullWidthScale?: number;
  fullWidthFrom?: number;
  /** Output format for raster images (default avif; jpeg if a universal format is needed). */
  format?: "avif" | "jpeg" | "webp";
  /** Quality 0-100 (default 80). */
  quality?: number;
}

const dims = (file: string) => {
  try {
    const s = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", file], { encoding: "utf8" });
    return { w: +(s.match(/pixelWidth: (\d+)/)?.[1] ?? 0), h: +(s.match(/pixelHeight: (\d+)/)?.[1] ?? 0), alpha: /hasAlpha: yes/.test(s) };
  } catch { return { w: 0, h: 0, alpha: false }; }
};
/** Expected end of file (truncated download = half the image as a flat fill). */
const complete = (buf: Buffer, ext: string) =>
  ext === "png" ? buf.subarray(-12).includes(Buffer.from("IEND")) : ext === "jpg" || ext === "jpeg" ? buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9 : true;
/** Figma SVG: attributes that distort the icon inside a container (images.md). */
const cleanSvg = (svg: string) => svg.replace(/ preserveAspectRatio="none"/g, "").replace(/ overflow="visible"/g, "").replace(/ style="display: block;"/g, "");

/**
 * Downloads a spec's assets (images and SVGs served by the Figma app) into `dir`, named after the layer,
 * deduplicated by content, integrity checked. With `optimize` (default):
 * - raster image: resized to cover its Figma display size × 3 (× 1.5 at full width), never upscaled, then
 *   converted to AVIF (sips, alpha kept);
 * - SVG: cleaned (preserveAspectRatio="none", overflow, style).
 * Returns file, size before / after, final dimensions and display size. Open the images with Read before uploading.
 */
export async function figmaAssets(assets: { name: string; ext: string; url: string; usedBy?: string[]; display?: string }[], opts: FigmaAssetsOptions) {
  mkdirSync(opts.dir, { recursive: true });
  const optimize = opts.optimize ?? true, fmt = opts.format ?? "avif";
  const out: { file: string; kB: number; rawKB?: number; size?: string; display?: string; usedBy?: string[]; note?: string }[] = [];
  const seen = new Set<string>();
  for (const a of assets) {
    const res = await fetch(a.url);
    if (!res.ok) { out.push({ file: `ÉCHEC ${res.status} ${a.name}`, kB: 0 }); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const h = createHash("sha1").update(buf).digest("hex").slice(0, 8);
    if (seen.has(h)) continue;
    seen.add(h);
    const ct = res.headers.get("content-type") ?? "";
    const ext = ct.includes("svg") ? "svg" : ct.includes("jpeg") ? "jpg" : ct.includes("png") ? "png" : a.ext || "bin";
    const base = join(opts.dir, `${opts.prefix ?? (a.usedBy?.[0] ?? a.name).replace(/[^\w-]+/g, "-").toLowerCase()}-${h}`);
    const meta = { ...(a.display ? { display: a.display } : {}), ...(a.usedBy ? { usedBy: a.usedBy } : {}) };
    if (!complete(buf, ext)) { out.push({ file: `${base}.${ext}`, kB: Math.round(buf.length / 1024), note: "fichier tronqué : relancer", ...meta }); continue; }
    if (ext === "svg") {
      const svg = optimize ? cleanSvg(buf.toString("utf8")) : buf.toString("utf8");
      writeFileSync(`${base}.svg`, svg);
      out.push({ file: `${base}.svg`, kB: Math.round(svg.length / 102.4) / 10, size: svg.match(/viewBox="([^"]+)"/)?.[1], ...meta });
      continue;
    }
    const raw = `${base}.${ext}`;
    writeFileSync(raw, buf);
    if (!optimize) { const d = dims(raw); out.push({ file: raw, kB: Math.round(buf.length / 1024), size: `${d.w}×${d.h}`, ...meta }); continue; }
    const src = dims(raw);
    const [dw, dh] = (a.display ?? "").split("×").map(Number);
    let note: string | undefined;
    let args: string[] = [];
    if (dw && dh && src.w && src.h) {
      const k = dw >= (opts.fullWidthFrom ?? 1200) ? (opts.fullWidthScale ?? 1.5) : (opts.scale ?? 3);
      const f = Math.max((dw * k) / src.w, (dh * k) / src.h); // cover the frame (object-fit: cover)
      if (f < 1) args = ["-z", String(Math.round(src.h * f)), String(Math.round(src.w * f))];
      else note = `source plus petite que l'affichage × ${k} (${src.w}×${src.h})`;
    } else note = "taille d'affichage inconnue : non redimensionnée";
    const outExt = fmt === "jpeg" ? "jpg" : fmt;
    const fin = `${base}.${outExt}`;
    try {
      execFileSync("sips", [...args, "-s", "format", fmt, "-s", "formatOptions", String(opts.quality ?? 80), raw, "--out", fin], { stdio: "ignore" });
    } catch {
      out.push({ file: raw, kB: Math.round(buf.length / 1024), note: `conversion ${fmt} impossible`, ...meta });
      continue;
    }
    const d = dims(fin);
    if (fmt === "jpeg" && src.alpha) note = [note, "transparence perdue (jpeg)"].filter(Boolean).join(" ; ");
    rmSync(raw);
    out.push({ file: fin, kB: Math.round(statSync(fin).size / 1024), rawKB: Math.round(buf.length / 1024), size: `${d.w}×${d.h}`, ...meta, ...(note ? { note } : {}) });
  }
  return { files: out.length, totalKB: out.reduce((n, f) => n + f.kB, 0), rawKB: out.reduce((n, f) => n + (f.rawKB ?? f.kB), 0), items: out };
}

/** Screenshot of a node saved as PNG; only the path is returned (open it with Read if needed). */
export async function figmaScreenshot(r: FigmaRef, file?: string) {
  const res = await callFigma("get_screenshot", { nodeId: r.nodeId });
  const img = res.images[0];
  if (!img) throw new KitError(`Figma : pas de capture pour ${r.nodeId}. ${(res.texts[0] ?? "").slice(0, 120)}`);
  const path = file ?? join(dir(r), `shot-${r.nodeId.replace(/\W/g, "_")}.png`);
  mkdirSync(dir(r), { recursive: true });
  writeFileSync(path, Buffer.from(img.data, "base64"));
  return { file: path, kB: Math.round(statSync(path).size / 1024) };
}
