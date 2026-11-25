/**
 * Figma REST API (FIGMA_TOKEN personal token, read-only): what the local MCP server does not provide.
 * - children of a page frame (the local server returns the frame alone above a certain size);
 * - comments of a section (anchored on the section, one of its descendants, or an ancestor at a position that
 *   falls inside the section);
 * - export of a node as SVG or image (vector patterns flagged as "graphic").
 * The token never leaves the script (X-Figma-Token header, never printed nor written to cache).
 */
import { join } from "node:path";
import { KitError } from "../kit/util.js";
import { writeAtomic } from "../lib/fsutil.js";
import { existsSync, readFileSync, statSync } from "node:fs";

const API = "https://api.figma.com/v1";
let restCalls = 0, restChars = 0;
export const getFigmaRestStats = () => ({ calls: restCalls, chars: restChars });

export const hasFigmaToken = () => Boolean(process.env.FIGMA_TOKEN);

async function get(path: string): Promise<any> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new KitError("FIGMA_TOKEN absent de .env (jeton personnel Figma, lecture) : à créer dans Figma → Settings → Security.");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, { headers: { "X-Figma-Token": token } });
    restCalls++;
    const text = await res.text();
    restChars += text.length;
    if (res.status === 429 && attempt < 4) { await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000)); continue; }
    if (!res.ok) throw new KitError(`API Figma ${res.status} sur ${path.split("?")[0]} : ${text.slice(0, 160)}`);
    return JSON.parse(text);
  }
}

export interface RNode { id: string; name: string; type: string; visible?: boolean; absoluteBoundingBox?: { x: number; y: number; width: number; height: number }; children?: RNode[] }

/** Node and its descendants down to `depth` (1 = direct children). */
export async function restNode(fileKey: string, nodeId: string, depth = 1): Promise<RNode> {
  const r = await get(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=${depth}`);
  const doc = r.nodes?.[nodeId]?.document;
  if (!doc) throw new KitError(`API Figma : nœud ${nodeId} introuvable dans ${fileKey}.`);
  return doc;
}

/** Sections of a page: direct children of the frame, with position and size. */
export async function figmaSections(fileKey: string, pageNodeId: string) {
  const n = await restNode(fileKey, pageNodeId, 1);
  const top = n.absoluteBoundingBox?.y ?? 0;
  return {
    page: `${n.name} [${n.id}] ${Math.round(n.absoluteBoundingBox?.width ?? 0)}×${Math.round(n.absoluteBoundingBox?.height ?? 0)}`,
    sections: (n.children ?? []).map((c) => ({
      id: c.id, name: c.name, type: c.type.toLowerCase(),
      y: Math.round((c.absoluteBoundingBox?.y ?? 0) - top), h: Math.round(c.absoluteBoundingBox?.height ?? 0),
      ...(c.visible === false ? { hidden: true } : {}),
    })),
  };
}

interface RComment { id: string; message: string; parent_id?: string; created_at: string; resolved_at?: string | null; user?: { handle?: string }; client_meta?: any }

// Process memo: the comment list and anchor positions, read once for all sections.
const commentsMemo = new Map<string, Promise<{ comments: RComment[]; boxes: Map<string, RNode["absoluteBoundingBox"] | null> }>>();
function fileComments(fileKey: string) {
  if (!commentsMemo.has(fileKey)) commentsMemo.set(fileKey, (async () => {
    const comments: RComment[] = (await get(`/files/${fileKey}/comments`)).comments ?? [];
    const anchors = [...new Set(comments.filter((c) => !c.parent_id).map((c) => c.client_meta?.node_id).filter(Boolean))] as string[];
    const boxes = new Map<string, RNode["absoluteBoundingBox"] | null>();
    for (let i = 0; i < anchors.length; i += 50) {
      const r = await get(`/files/${fileKey}/nodes?ids=${encodeURIComponent(anchors.slice(i, i + 50).join(","))}&depth=0`);
      for (const id of anchors.slice(i, i + 50)) boxes.set(id, r.nodes?.[id]?.document?.absoluteBoundingBox ?? null);
    }
    return { comments, boxes };
  })());
  return commentsMemo.get(fileKey)!;
}

const point = (c: RComment, boxes: Map<string, RNode["absoluteBoundingBox"] | null>) => {
  const m = c.client_meta;
  if (!m) return undefined;
  if (m.node_id) { const b = boxes.get(m.node_id); return b && m.node_offset ? { x: b.x + m.node_offset.x, y: b.y + m.node_offset.y } : undefined; }
  return typeof m.x === "number" ? { x: m.x, y: m.y } : undefined;
};

/**
 * Comments of a section, grouped by thread: those whose pin point falls inside the section's area (pinned on it,
 * on one of its elements, or on the page frame), or whose anchor path contains it.
 * `orphans`: threads of the file pinned on a deleted node (impossible to locate), to read with figmaOrphanComments.
 */
export async function figmaComments(fileKey: string, nodeId: string, opts: { includeResolved?: boolean; maxChars?: number } = {}) {
  const [{ comments, boxes }, section] = await Promise.all([fileComments(fileKey), restNode(fileKey, nodeId, 0)]);
  const box = section.absoluteBoundingBox!;
  const hit = (c: RComment) => {
    if ((c.client_meta?.stable_path ?? []).includes(nodeId)) return true;
    const p = point(c, boxes);
    return !!p && p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
  };
  const roots = comments.filter((c) => !c.parent_id);
  const threads = roots.filter((c) => (opts.includeResolved || !c.resolved_at) && hit(c));
  const orphans = roots.filter((c) => c.client_meta?.node_id && boxes.get(c.client_meta.node_id) === null);
  return {
    section: `${section.name} [${section.id}]`, threads: threads.length, comments: formatThreads(threads, comments, opts.maxChars),
    ...(orphans.length ? { orphans: { open: orphans.filter((c) => !c.resolved_at).length, total: orphans.length } } : {}),
  };
}

/** Threads pinned on a deleted node (often an old version of the page): text only, position unknown. */
export async function figmaOrphanComments(fileKey: string, opts: { includeResolved?: boolean; maxChars?: number } = {}) {
  const { comments, boxes } = await fileComments(fileKey);
  const orphans = comments.filter((c) => !c.parent_id && c.client_meta?.node_id && boxes.get(c.client_meta.node_id) === null && (opts.includeResolved || !c.resolved_at));
  return { threads: orphans.length, comments: formatThreads(orphans, comments, opts.maxChars) };
}

function formatThreads(threads: RComment[], all: RComment[], maxChars = 600) {
  const cut = (s: string) => (s.length > maxChars ? s.slice(0, maxChars) + "…" : s);
  return threads.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((c) => ({
    id: c.id, by: c.user?.handle ?? "?", at: c.created_at.slice(0, 10), ...(c.resolved_at ? { resolved: true } : {}),
    text: cut(c.message),
    replies: all.filter((r) => r.parent_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => `${r.user?.handle ?? "?"} (${r.created_at.slice(0, 10)}) : ${cut(r.message)}`),
  }));
}

/**
 * Export of one or more nodes through Figma's renderer (SVG for a vector pattern, PNG / JPG otherwise),
 * downloaded into `dir`. Integrity checked (announced size).
 */
export async function figmaExport(fileKey: string, nodeIds: string[], opts: { dir: string; format?: "svg" | "png" | "jpg"; scale?: number; prefix?: string }) {
  const fmt = opts.format ?? "svg";
  const r = await get(`/images/${fileKey}?ids=${encodeURIComponent(nodeIds.join(","))}&format=${fmt}${fmt === "svg" ? "&svg_outline_text=false&svg_simplify_stroke=true" : `&scale=${opts.scale ?? 2}`}`);
  const out: { id: string; file: string; kB: number }[] = [];
  for (const id of nodeIds) {
    const url = r.images?.[id];
    if (!url) { out.push({ id, file: "ÉCHEC : rendu vide", kB: 0 }); continue; }
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const len = Number(res.headers.get("content-length") ?? buf.length);
    const file = join(opts.dir, `${opts.prefix ?? "export"}-${id.replace(/\W/g, "-")}.${fmt}`);
    if (!res.ok || buf.length < len) { out.push({ id, file: `ÉCHEC : ${res.status}, ${buf.length}/${len} octets`, kB: 0 }); continue; }
    const data = fmt === "svg" ? Buffer.from(buf.toString("utf8").replace(/ preserveAspectRatio="none"/g, "")) : buf;
    writeAtomic(file, data as unknown as string);
    out.push({ id, file, kB: Math.round(data.length / 1024) });
  }
  return out;
}

/** Short disk cache (10 min) for comments, which change often. */
export function cachedJson<T>(file: string, ttlMs: number): T | undefined {
  try { if (existsSync(file) && Date.now() - statSync(file).mtimeMs < ttlMs) return JSON.parse(readFileSync(file, "utf8")); } catch { /* missing */ }
  return undefined;
}
