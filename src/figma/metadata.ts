/**
 * Reads the XML output of get_metadata (Figma MCP) without printing it: a lightweight tree (id, type, name, position,
 * size), then a compact outline where purely graphic subtrees (patterns, illustrations made of thousands of vectors)
 * are collapsed into one line. Measured on Client E, "Le constat": 13,428 vectors, 1.17 M raw characters.
 */
export interface FNode {
  id: string; type: string; name: string;
  x: number; y: number; w: number; h: number;
  hidden?: boolean;
  children: FNode[];
}

const ATTR = /([\w-]+)="([^"]*)"/g;
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Parses the get_metadata XML (nested or self-closing tags). Returns the roots. */
export function parseMetadata(xml: string): FNode[] {
  const roots: FNode[] = [];
  const stack: FNode[] = [];
  const TAG = /<(\/?)([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g;
  for (let m; (m = TAG.exec(xml)); ) {
    const [, close, type, attrs, self] = m;
    if (close) { stack.pop(); continue; }
    const a: Record<string, string> = {};
    for (let x; (x = ATTR.exec(attrs)); ) a[x[1]] = unesc(x[2]);
    ATTR.lastIndex = 0;
    if (!a.id) continue;
    const n: FNode = { id: a.id, type, name: a.name ?? "", x: +a.x || 0, y: +a.y || 0, w: +a.width || 0, h: +a.height || 0, children: [] };
    if (a.hidden === "true") n.hidden = true;
    (stack.length ? stack[stack.length - 1].children : roots).push(n);
    if (!self) stack.push(n);
  }
  return roots;
}

export const walk = (n: FNode): FNode[] => [n, ...n.children.flatMap(walk)];
const VECTORISH = new Set(["vector", "boolean-operation", "star", "line", "ellipse", "polygon", "regular-polygon"]);

/** A subtree is "graphic" if it contains at least `min` shapes and no text: it is treated as an asset. */
export function isGraphic(n: FNode, min = 12): boolean {
  if (VECTORISH.has(n.type) && !n.children.length) return false;
  let shapes = 0;
  for (const x of walk(n)) { if (x.type === "text") return false; if (VECTORISH.has(x.type)) shapes++; }
  return shapes >= min;
}

export interface OutlineOptions { depth?: number; graphicMin?: number; maxLines?: number }

/**
 * Compact outline: one indented line per useful node. Graphic subtrees are collapsed
 * ("graphic 13 428 formes"), hidden nodes are flagged, depth is capped.
 */
export function outline(root: FNode, o: OutlineOptions = {}): { lines: string[]; graphics: { id: string; name: string; shapes: number; w: number; h: number }[]; texts: number; truncated: number } {
  const lines: string[] = [];
  const graphics: { id: string; name: string; shapes: number; w: number; h: number }[] = [];
  let texts = 0, truncated = 0;
  const max = o.maxLines ?? 150;
  const rec = (n: FNode, d: number) => {
    const size = `${Math.round(n.w)}×${Math.round(n.h)}`;
    if (n.type === "text") texts++;
    if (isGraphic(n, o.graphicMin)) {
      const shapes = walk(n).filter((x) => VECTORISH.has(x.type)).length;
      graphics.push({ id: n.id, name: n.name, shapes, w: Math.round(n.w), h: Math.round(n.h) });
      if (lines.length < max) lines.push(`${"  ".repeat(d)}${n.name} [${n.id}] ${size} · graphique, ${shapes} formes`);
      else truncated++;
      return;
    }
    if (lines.length < max) lines.push(`${"  ".repeat(d)}${n.type === "frame" ? "" : n.type + " "}${n.name} [${n.id}] ${size}${n.hidden ? " · masqué" : ""}`);
    else truncated++;
    if (d + 1 > (o.depth ?? 6)) { if (n.children.length) lines.push(`${"  ".repeat(d + 1)}… ${walk(n).length - 1} nœuds`); return; }
    for (const c of n.children) rec(c, d + 1);
  };
  rec(root, 0);
  return { lines, graphics, texts, truncated };
}
