/**
 * Custom fonts (hosted MCP): create_font + S3 upload (same form as assets), without duplicates.
 * The create_font response (~9,000 characters, S3 policy) stays in the process.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { postToS3 } from "./assets.js";
import { KitError, assertWriteAllowed } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma registers custom font files for the site design system and returns only a compact summary.";

export interface FontInfo { id: string; family: string; weight: number; italic: boolean; file?: string }

/** The site's custom fonts, compact. */
export async function listFonts(siteId: string): Promise<FontInfo[]> {
  const out: FontInfo[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = hostedResult<any>(await h.dataFontsTool.listFonts({ site_id: siteId, limit: 100, offset } as any, CTX), "list_fonts");
    for (const f of r.customFonts ?? []) out.push({ id: f.id, family: f.fontFamily ?? f.font_family ?? f.family, weight: f.weight, italic: Boolean(f.italic), file: f.fileName ?? f.file_name });
    if ((r.customFonts ?? []).length < 100) break;
  }
  return out;
}

export interface FontSpec { file: string; family: string; weight: number; italic?: boolean; display?: "auto" | "block" | "swap" | "fallback" | "optional" }

/** Uploads font files (woff2 preferably). Same family + weight + style already present: skipped. dryRun by default. */
export async function uploadFonts(siteId: string, specs: FontSpec[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const existing = await listFonts(siteId);
  const plan = specs.map((s) => ({
    s,
    same: existing.find((f) => f.family === s.family && f.weight === s.weight && f.italic === Boolean(s.italic)),
  }));
  const summary = plan.map((p) => `${p.s.family} ${p.s.weight}${p.s.italic ? " italic" : ""}: ${p.same ? "déjà présente" : "à envoyer"}`);
  if (dryRun) return { dryRun, upload: plan.filter((p) => !p.same).length, items: summary };
  assertWriteAllowed(siteId);
  for (const p of plan) {
    if (p.same) continue;
    const bytes = readFileSync(p.s.file);
    const name = basename(p.s.file);
    const created = hostedResult<any>(
      await h.dataFontsTool.createFont({
        site_id: siteId, file_name: name, file_hash: createHash("md5").update(bytes).digest("hex"),
        font_family: p.s.family, weight: p.s.weight, italic: Boolean(p.s.italic), font_display: p.s.display ?? "swap",
      } as any, CTX),
      "create_font",
    );
    const upload = created.upload ?? created;
    const url = upload.url ?? upload.uploadUrl;
    const fields = upload.fields ?? upload.uploadDetails ?? {};
    if (!url) throw new KitError(`create_font ${name} : réponse sans URL d'envoi (${Object.keys(created).join(", ")})`);
    await postToS3(url, fields, bytes, name, "font/woff2");
  }
  // create_font does not return the id at the top level (quirks.md): re-read the list.
  const after = await listFonts(siteId);
  const items = specs.map((s) => after.find((f) => f.family === s.family && f.weight === s.weight && f.italic === Boolean(s.italic)));
  return { dryRun, uploaded: plan.filter((p) => !p.same).length, items: items.map((f, i) => (f ? `${f.family} ${f.weight} ${f.id}` : `${specs[i].family} ${specs[i].weight} : absente après envoi`)) };
}
