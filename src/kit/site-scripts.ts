/**
 * Site scripts (hosted MCP): registration (hosted with a computed SRI hash, or inline ≤ 2,000 characters)
 * then application in order, in the page header or footer. Idempotent: name + version.
 */
import { createHash } from "node:crypto";
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { KitError, assertWriteAllowed } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma registers and applies site-wide scripts in a given order and reports a compact summary.";

export interface SiteScriptSpec {
  /** Display name, 1 to 50 alphanumeric characters. */
  name: string;
  version: string;
  location: "header" | "footer";
  /** Hosted script (https URL pinned to a version) or… */
  url?: string;
  /** …inline code, without a <script> tag, 2,000 characters at most. */
  code?: string;
  attributes?: Record<string, string>;
}

export async function ensureSiteScripts(siteId: string, specs: SiteScriptSpec[], opts: { dryRun?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  for (const s of specs) {
    if (!/^[A-Za-z0-9]{1,50}$/.test(s.name)) throw new KitError(`Nom de script invalide « ${s.name} » : 1 à 50 caractères alphanumériques.`);
    if (!s.url === !s.code) throw new KitError(`${s.name} : donner soit url, soit code.`);
    if (s.code && s.code.length > 2000) throw new KitError(`${s.name} : ${s.code.length} caractères, 2 000 au plus pour un script en ligne.`);
  }
  const registered = hostedResult<any>(await h.dataScriptsTool.getRegisteredScripts({ site_id: siteId }, CTX), "get_registered_scripts");
  let applied: any = [];
  try { applied = hostedResult<any>(await h.dataScriptsTool.getSiteScripts({ site_id: siteId }, CTX), "get_site_scripts"); }
  catch (e) { if (!/404|not found/i.test((e as Error).message)) throw e; } // no code block: 404 (quirks.md)
  const reg: any[] = registered?.registeredScripts ?? registered?.scripts ?? (Array.isArray(registered) ? registered : []);
  const app: any[] = applied?.scripts ?? (Array.isArray(applied) ? applied : []);
  const plan = specs.map((s) => {
    const r = reg.find((x) => (x.displayName ?? x.display_name) === s.name && x.version === s.version);
    const a = r && app.find((x) => x.id === r.id);
    return { s, regId: r?.id as string | undefined, applied: Boolean(a) };
  });
  const summary = plan.map((p) => `${p.s.name}@${p.s.version} ${p.s.location}: ${p.applied ? "en place" : p.regId ? "à appliquer" : "à enregistrer et appliquer"}`);
  if (dryRun || plan.every((p) => p.applied)) return { dryRun, items: summary };
  assertWriteAllowed(siteId);
  for (const p of plan) {
    if (p.applied) continue;
    if (!p.regId) {
      let res: any;
      if (p.s.url) {
        const body = Buffer.from(await (await fetch(p.s.url)).arrayBuffer());
        const sri = "sha384-" + createHash("sha384").update(body).digest("base64");
        res = hostedResult<any>(await h.dataScriptsTool.registerHostedScript({ site_id: siteId, hosted_location: p.s.url, integrity_hash: sri, version: p.s.version, display_name: p.s.name } as any, CTX), "register_hosted_script");
      } else {
        res = hostedResult<any>(await h.dataScriptsTool.registerInlineScript({ site_id: siteId, source_code: p.s.code!, version: p.s.version, display_name: p.s.name } as any, CTX), "register_inline_script");
      }
      p.regId = res?.id;
      if (!p.regId) throw new KitError(`${p.s.name} : enregistré sans id dans la réponse.`);
    }
  }
  // Apply via set_site_scripts (full list): add_site_script returns 404 "Custom code block not found"
  // as long as the site has no applied script (quirks.md). Keep the scripts already applied, then add.
  // A new version of a script replaces the old one (same display name), it is not added alongside it.
  const names = new Set(plan.map((p) => p.s.name));
  const keep = app.filter((x) => !plan.some((p) => p.regId === x.id) && !names.has(x.displayName ?? x.display_name)).map((x) => ({ id: x.id, location: x.location, version: x.version, ...(x.attributes && Object.keys(x.attributes).length ? { attributes: x.attributes } : {}) }));
  const scripts = [...keep, ...plan.map((p) => ({ id: p.regId!, location: p.s.location, version: p.s.version, ...(p.s.attributes ? { attributes: p.s.attributes } : {}) }))];
  hostedResult(await h.dataScriptsTool.setSiteScripts({ site_id: siteId, scripts } as any, CTX), "set_site_scripts");
  return { dryRun: false, items: plan.map((p) => `${p.s.name}@${p.s.version} ${p.s.location}: en place`) };
}
