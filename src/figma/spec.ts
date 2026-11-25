/**
 * Compact spec of a Figma node built from get_design_context's reference code (JSX + Tailwind): one line per useful
 * element, Figma variables by name (`espace/20`, not `var(--espace\/20,20px)`), texts in plain form, assets listed
 * separately. The instruction blocks repeated in every response are dropped; only the list of text styles is kept.
 */

export interface SpecAsset { name: string; url: string; ext: string; usedBy: string[]; /** Figma nodes that display the asset (closest identified ancestor): their size gives the target size. */ owners: string[]; /** Size read from the code (closest ancestor with px dimensions), when metadata is missing. */ cssSize?: string }
export interface Spec { lines: string[]; texts: string[]; assets: SpecAsset[]; styles: string[]; tokens: string[] }

/** Tailwind utilities that are irrelevant for reproducing the rendering in Webflow. */
const DROP = new Set([
  "content-stretch", "relative", "shrink-0", "block", "max-w-none", "min-w-px", "mb-0", "not-italic", "leading-[0]",
  "w-[min-content]", "min-w-full", "flex-row", "self-stretch", "inset-0",
]);
const DROP_PREFIX = ["[text-box-", "[word-break:", "font-normal"];

/** `var(--espace\/20,20px)` → `espace/20`; keeps the raw value if there is no variable. */
const unvar = (s: string) => s.replace(/var\(--([^,)]+)(?:,[^)]*(?:\([^)]*\))?[^)]*)?\)/g, (_, n: string) => n.replace(/\\\//g, "/"));

export function compactClasses(cls: string): string {
  const out: string[] = [];
  for (const raw of cls.split(/\s+/).filter(Boolean)) {
    if (DROP.has(raw) || DROP_PREFIX.some((p) => raw.startsWith(p))) continue;
    let t = unvar(raw)
      .replace(/^text-\[color:(.+)\]$/, "color:$1")
      .replace(/^text-\[length:(.+)\]$/, "size:$1")
      .replace(/^font-\[family-name:([^,\]]+).*\]$/, "font:$1")
      .replace(/^font-\['([^':]+)(?::[^']*)?'\]$/, (_, f: string) => `font:${f.replace(/_/g, " ")}`)
      .replace(/^font-\[(.+)\]$/, "weight:$1")
      .replace(/^bg-\[color:(.+)\]$/, "bg:$1")
      .replace(/^rounded-\[(.+)\]$/, "radius:$1")
      .replace(/^gap-\[(.+)\]$/, "gap:$1")
      .replace(/^(p[xytrbl]?)-\[(.+)\]$/, "$1:$2")
      .replace(/^([wh])-\[(.+)\]$/, "$1:$2")
      .replace(/^leading-\[(.+)\]$/, "lh:$1")
      .replace(/^tracking-\[(.+)\]$/, "ls:$1");
    out.push(t.replace(/(\d+\.\d{2})\d+/g, "$1"));
  }
  return out.join(" ");
}

interface El { tag: string; name?: string; id?: string; rawId?: string; cls: string; src?: string; props?: string; text: string[]; children: El[] }

/** Parses the returned JSX (tags, className, data-*, src={const}, texts). Lenient: skips what it cannot parse. */
function parseJsx(code: string): El[] {
  const body = code.slice(code.search(/return \(/) >= 0 ? code.search(/return \(/) + 8 : 0);
  const roots: El[] = [];
  const stack: El[] = [];
  const TOK = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w-]+(?:=(?:"[^"]*"|\{\{[\s\S]*?\}\}|\{[^}]*\}))?)*)\s*(\/?)>|([^<]+)/g;
  for (let m; (m = TOK.exec(body)); ) {
    const [, close, tag, attrs, self, text] = m;
    if (text !== undefined) {
      const t = text.replace(/\s+/g, " ").trim().replace(/^\{["'`](.*)["'`]\}$/, "$1");
      if (t && /[\p{L}\p{N}]/u.test(t) && !/^[);{}]+$/.test(t) && stack.length) stack[stack.length - 1].text.push(t.replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " "));
      continue;
    }
    if (close) { stack.pop(); continue; }
    const a = (k: string) => attrs.match(new RegExp(`\\s${k}="([^"]*)"`))?.[1];
    const el: El = { tag, cls: compactClasses(a("className") ?? ""), name: a("data-name"), rawId: a("data-node-id"), id: a("data-node-id")?.startsWith("I") ? undefined : a("data-node-id"), text: [], children: [] };
    const src = attrs.match(/\ssrc=\{(\w+)\}/)?.[1];
    if (src) el.src = src;
    if (/^[A-Z]/.test(tag)) el.props = attrs.replace(/\s+className="[^"]*"/, "").replace(/\s+data-[\w-]+="[^"]*"/g, "").trim();
    (stack.length ? stack[stack.length - 1].children : roots).push(el);
    if (!self) stack.push(el);
  }
  return roots;
}

/** Wrapper with no name and no useful style (instance wrapper): skip it. */
const transparent = (e: El) => !e.name && !e.text.length && e.children.length === 1 && /^(flex( items-center)?)?$/.test(e.cls.trim());

export function buildSpec(texts: string[]): Spec {
  const code = texts.find((t) => /export default function|return \(/.test(t)) ?? "";
  const consts = new Map<string, string>();
  for (const m of code.matchAll(/const (\w+) = "(http:\/\/localhost:\d+\/assets\/[^"]+)"/g)) consts.set(m[1], m[2]);
  const styleBlock = texts.find((t) => t.startsWith("These styles are contained in the design:"));
  const styles = styleBlock ? styleBlock.replace(/^These styles are contained in the design:\s*/, "").replace(/\.$/, "").split(/,\s(?=[\w/ -]+: (?:Font|Effect)\()/).map((s) => unvar(s).replace(/\s+/g, " ").replace(/(\d+\.\d{2})\d+/g, "$1")) : [];

  const lines: string[] = [], allTexts: string[] = [];
  const assets = new Map<string, SpecAsset>();
  const tokens = new Set<string>();
  const pxSize = (cls: string) => {
    const sz = cls.match(/(?:^|\s)size-\[(\d+(?:\.\d+)?)px\]/)?.[1];
    const w = sz ?? cls.match(/(?:^|\s)w:(\d+(?:\.\d+)?)px/)?.[1], h = sz ?? cls.match(/(?:^|\s)h:(\d+(?:\.\d+)?)px/)?.[1];
    return w && h ? `${Math.round(+w)}×${Math.round(+h)}` : undefined;
  };
  const rec = (e: El, d: number, ctx = "", owner = "", sized = ""): void => {
    if (transparent(e)) return rec(e.children[0], d, ctx, e.rawId ?? owner, pxSize(e.cls) ?? sized);
    const box = pxSize(e.cls) ?? sized;
    const here = e.name ?? ctx;
    const own = e.rawId ?? owner;
    // Multiple paragraphs under the same text block: a single line (Figma line breaks marked ⏎).
    const onlyP = e.children.length > 0 && e.children.every((c) => c.tag === "p" && !c.children.length && c.text.length);
    const txt = onlyP ? e.children.map((c) => c.text.join(" ")).join(" ⏎ ") : e.text.join(" ");
    if (txt) allTexts.push(txt.replace(/ ⏎ /g, " "));
    for (const m of e.cls.matchAll(/[:\[]([a-z][\w-]*(?:\/[\w.-]+)+)/g)) tokens.add(m[1]);
    let line = `${"  ".repeat(d)}${e.tag}${e.name ? " " + e.name : ""}${e.id ? ` #${e.id}` : ""}`;
    if (e.props) line += ` {${e.props.slice(0, 160)}}`;
    if (e.cls) line += ` | ${e.cls}`;
    if (e.src) {
      const url = consts.get(e.src) ?? e.src;
      const a = assets.get(url) ?? { name: e.src, url, ext: url.split(".").pop() ?? "", usedBy: [], owners: [] };
      a.usedBy.push(here || e.id || e.tag);
      if (own && !a.owners.includes(own)) a.owners.push(own);
      if (box && !a.cssSize) a.cssSize = box;
      assets.set(url, a);
      line += ` | img ${e.src}`;
    }
    if (txt) line += ` | « ${txt} »`;
    lines.push(line);
    if (!onlyP) for (const c of e.children) rec(c, d + 1, here, own, box);
  };
  for (const r of parseJsx(code)) rec(r, 0);
  return { lines, texts: allTexts, assets: [...assets.values()], styles, tokens: [...tokens].sort() };
}
