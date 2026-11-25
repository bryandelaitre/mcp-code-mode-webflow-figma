/** Sites the current project's authorization (bin/kit sites) can reach. */
import * as h from "../src/generated/hosted/tools.js";
import { closeHosted, getHostedProfile } from "../src/lib/hosted.js";
import { hostedResult } from "../src/kit/hosted-util.js";

export async function authorizedSites() {
  const r = await h.dataSitesTool.listSites({} as any, "Library mcp-code-mode-webflow-figma lists the sites this project authorization can reach.");
  const sites = (hostedResult<any>(r, "list_sites") as any);
  const arr: any[] = Array.isArray(sites) ? sites : sites?.sites ?? [];
  return arr.map((s) => `${s.displayName ?? s.name} · ${s.id} · ${s.shortName ?? ""}.webflow.io`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { profile, project } = getHostedProfile();
    console.log(JSON.stringify({ project: project?.dir ?? null, profile, sites: await authorizedSites() }));
  } finally { await closeHosted(); }
}
