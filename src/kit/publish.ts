import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as api from "./api.js";
import { KitError, assertWriteAllowed, sleep } from "./util.js";

const CACHE = new URL("../../.cache/", import.meta.url);
const MIN_INTERVAL_MS = 61_000; // Webflow: one publish per minute per site.

function lastPublish(siteId: string): number {
  const f = new URL(`publish-${siteId}.json`, CACHE);
  if (!existsSync(f)) return 0;
  try { return JSON.parse(readFileSync(f, "utf8")).at ?? 0; } catch { return 0; }
}

export interface PublishOptions {
  /** Default: true. Does not publish, says what would be published. */
  dryRun?: boolean;
  /** Custom domains: refused unless allowCustomDomains is true (the client's decision). */
  customDomains?: string[];
  allowCustomDomains?: boolean;
}

/**
 * Publishes to the webflow.io subdomain. Waits if the library's last publish of this site was less than a minute ago.
 * Custom domains require allowCustomDomains: true.
 */
export async function publish(siteId: string, o: PublishOptions = {}) {
  const dryRun = o.dryRun ?? true;
  const domains = o.customDomains ?? [];
  if (domains.length && !o.allowCustomDomains) {
    throw new KitError("Publication sur domaine personnalisé refusée : passez allowCustomDomains: true si le client l'a décidé.");
  }
  const site = await api.sitesGet(siteId);
  const target = { site: site.displayName ?? siteId, webflowSubdomain: `${site.shortName}.webflow.io`, customDomains: domains };
  if (dryRun) return { dryRun, ...target };
  assertWriteAllowed(siteId);
  const wait = lastPublish(siteId) + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  await api.sitesPublish(siteId, domains);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(new URL(`publish-${siteId}.json`, CACHE), JSON.stringify({ at: Date.now() }));
  return { dryRun, published: true, waitedMs: Math.max(0, wait), ...target };
}
