import * as api from "./api.js";

/** Site accessible with the current token, compact (a site token only sees that site). */
export async function getSite(siteId?: string) {
  const id = siteId ?? process.env.WEBFLOW_SANDBOX_SITE_ID;
  if (!id) {
    const r = await api.sitesList();
    return (r.sites ?? []).map((s: any) => ({ id: s.id, name: s.displayName, shortName: s.shortName }));
  }
  const s = await api.sitesGet(id);
  return {
    id: s.id, name: s.displayName, shortName: s.shortName,
    customDomains: (s.customDomains ?? []).map((d: any) => d.url),
    lastPublished: s.lastPublished,
  };
}
