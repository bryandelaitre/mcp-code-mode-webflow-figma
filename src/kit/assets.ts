/**
 * Assets (hosted MCP): upload of local files (MD5, create_asset, S3 POST, alt text) or public URLs (downloaded,
 * then uploaded the same way), without duplicates. create_asset returns 7,000 to 13,000 characters (S3 policy):
 * they stay here.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { KitError, assertWriteAllowed, cap } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma uploads image assets requested by the user and returns only ids and hosted URLs.";
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp4": "video/mp4", ".ico": "image/x-icon",
};

/** uploadDetails (camelCase) → S3 form fields, in the order used successfully on Client E. */
const S3_NAMES: [string, string][] = [
  ["acl", "acl"], ["bucket", "bucket"], ["xAmzAlgorithm", "X-Amz-Algorithm"], ["xAmzCredential", "X-Amz-Credential"],
  ["xAmzDate", "X-Amz-Date"], ["key", "key"], ["policy", "Policy"], ["xAmzSignature", "X-Amz-Signature"],
  ["successActionStatus", "success_action_status"], ["contentType", "Content-Type"], ["cacheControl", "Cache-Control"],
];
function s3Fields(d: Record<string, unknown>): [string, string][] {
  const known = new Set(S3_NAMES.map(([k]) => k));
  const out = S3_NAMES.filter(([k]) => d[k] !== undefined).map(([k, n]): [string, string] => [n, String(d[k])]);
  for (const [k, v] of Object.entries(d)) if (!known.has(k)) out.push([k, String(v)]);
  return out;
}

const s3Url = (siteId: string, id: string, name: string) => `https://s3.amazonaws.com/webflow-prod-assets/${siteId}/${id}_${name}`;

/** Multipart POST to S3: renamed fields (s3Fields), file last. Throws if S3 does not answer 2xx. */
export async function postToS3(url: string, details: Record<string, unknown>, bytes: Buffer, name: string, fallbackType: string) {
  const form = new FormData();
  for (const [k, v] of s3Fields(details)) form.append(k, v);
  const type = String(details.contentType ?? details["Content-Type"] ?? fallbackType);
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
  const up = await fetch(url, { method: "POST", body: form });
  if (up.status < 200 || up.status >= 300) {
    throw new KitError(`Envoi S3 de ${name} : HTTP ${up.status} ${(await up.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

export interface AssetInfo {
  id: string; name: string; url: string; alt?: string | null; size?: number; folderId?: string | null;
  /** Identical file already in the library (Webflow deduplicates by MD5): existing asset, left unchanged. */
  preexisting?: boolean;
}

/** All assets of a site (paginated by 100), in compact form. */
export async function listAssets(siteId: string, opts: { query?: string; max?: number } = {}) {
  const all: AssetInfo[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = hostedResult<any>(await h.dataAssetsTool.listAssets({ site_id: siteId, limit: 100, offset }, CTX), "list_assets");
    for (const a of r.assets ?? []) all.push({ id: a.id, name: a.displayName, url: a.hostedUrl, alt: a.altText, size: a.size, folderId: a.folderId });
    if ((r.assets ?? []).length < 100) break;
  }
  const m = opts.query ? all.filter((a) => a.name.toLowerCase().includes(opts.query!.toLowerCase())) : all;
  const c = cap(m, opts.max ?? 50);
  return { total: all.length, matched: m.length, items: c.items, ...(c.truncated ? { truncated: c.truncated } : {}), _all: all };
}

export interface UploadSpec {
  /** Path to a local file, or public http(s) URL of an image. */
  file: string;
  /** Alt text (empty string = decorative). */
  alt?: string;
  /** Name shown in the library (default: file name). Extension included, under 100 characters. */
  name?: string;
  /** Asset folder (id). */
  folderId?: string;
}

/**
 * Uploads files or image URLs to the asset library. dryRun by default: reports what would be uploaded and
 * what already exists (same name and same size: reused, alt updated if different).
 * Returns, for each file, the id and the S3 URL (the one to put in a WHTML <img> so the image is linked).
 */
export async function uploadAssets(siteId: string, specs: UploadSpec[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const existing = (await listAssets(siteId, { max: 0 }))._all;
  const plan = specs.map((s) => {
    const remote = /^https?:\/\//i.test(s.file);
    if (remote) return { s, remote, name: s.name ?? basename(new URL(s.file).pathname), size: undefined as number | undefined };
    let size: number;
    try { size = statSync(s.file).size; } catch { throw new KitError(`Fichier introuvable : ${s.file}`); }
    const name = s.name ?? basename(s.file);
    if (name.length >= 100) throw new KitError(`Nom trop long (100 caractères max) : ${name}`);
    return { s, remote, name, size };
  });
  const rows = plan.map((p) => {
    // Size: the API returns 0 for an asset uploaded through S3 (quirks.md); compare only when it is known.
    const same = existing.find((a) => a.name === p.name && (p.size === undefined || !a.size || a.size === p.size));
    return { ...p, same };
  });
  const summary = rows.map((r) => ({
    file: r.remote ? r.s.file : basename(r.s.file),
    name: r.name,
    action: r.same ? (r.s.alt !== undefined && (r.same.alt ?? "") !== r.s.alt ? "reuse+alt" : "reuse") : "upload",
    ...(r.same ? { id: r.same.id, url: r.same.url } : {}),
  }));
  if (dryRun) return { dryRun, upload: summary.filter((x) => x.action === "upload").length, reuse: summary.length - summary.filter((x) => x.action === "upload").length, items: summary };

  assertWriteAllowed(siteId);
  const out: AssetInfo[] = [];
  for (const r of rows) {
    if (r.same) {
      if (r.s.alt !== undefined && (r.same.alt ?? "") !== r.s.alt) {
        hostedResult(await h.dataAssetsTool.updateAsset({ asset_id: r.same.id, alt_text: r.s.alt }, CTX), "update_asset");
      }
      out.push({ id: r.same.id, name: r.same.name, url: r.same.url, alt: r.s.alt ?? r.same.alt });
      continue;
    }
    // Public URL: downloaded in the script, then uploaded like a local file. upload_image_by_url (asset_tool)
    // requires the Designer to be open with the MCP app (quirks.md); this path does not.
    let bytes: Buffer;
    if (r.remote) {
      const res = await fetch(r.s.file);
      if (!res.ok) throw new KitError(`Téléchargement de ${r.s.file} : HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } else bytes = readFileSync(r.s.file);
    const md5 = createHash("md5").update(bytes).digest("hex");
    const created = hostedResult<any>(
      await h.dataAssetsTool.createAsset({ site_id: siteId, file_name: r.name, file_hash: md5, ...(r.s.folderId ? { parent_folder: r.s.folderId } : {}) }, CTX),
      "create_asset",
    );
    // Webflow deduplicates by MD5: an identical file already present (under another name) returns the existing asset.
    // Do not rename it or touch its alt, and flag it: deleting it would delete the original.
    const pre = existing.find((x) => x.id === created.id);
    if (pre) {
      // create_asset renames the existing asset with file_name (quirks.md): restore its original name.
      if (pre.name !== r.name) hostedResult(await h.dataAssetsTool.updateAsset({ asset_id: pre.id, display_name: pre.name }, CTX), "update_asset (nom d'origine)");
      out.push({ id: pre.id, name: pre.name, url: pre.url, alt: pre.alt, preexisting: true });
      continue;
    }
    await postToS3(created.uploadUrl, created.uploadDetails ?? {}, bytes, r.name, TYPES[extname(r.name).toLowerCase()] ?? "application/octet-stream");
    if (r.s.alt !== undefined) hostedResult(await h.dataAssetsTool.updateAsset({ asset_id: created.id, alt_text: r.s.alt }, CTX), "update_asset");
    // S3 URL, not cdn.prod…: it is the one that links the image to the asset in WHTML (Webflow MCP lessons file §3.4).
    out.push({ id: created.id, name: r.name, url: s3Url(siteId, created.id, r.name), alt: r.s.alt });
  }
  const pre = out.filter((x) => x.preexisting).length;
  return { dryRun, uploaded: rows.filter((r) => !r.same).length - pre, reused: rows.filter((r) => r.same).length + pre, ...(pre ? { preexisting: pre } : {}), items: out };
}
