/**
 * Authorizes the library with the hosted Webflow MCP (browser, once per profile), then writes its tool contract to
 * schemas/hosted-tools.json. Usage: npm run hosted-login   (profile: WEBFLOW_HOSTED_PROFILE, default "default")
 */
import { writeFileSync } from "node:fs";
import { getHostedClient, closeHosted, getHostedProfile } from "../src/lib/hosted.js";
import { authorizedSites } from "./project-sites.js";

try {
  const c = await getHostedClient({ interactive: true });
  const tools: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await c.listTools(cursor ? { cursor } : {});
    tools.push(...r.tools);
    cursor = r.nextCursor;
  } while (cursor);
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const server = c.getServerVersion();
  const { profile, project } = getHostedProfile();
  // The tool contract is only rewritten outside a project (library development).
  if (!project) writeFileSync("schemas/hosted-tools.json", JSON.stringify({ server, dumpedAt: new Date().toISOString(), tools }, null, 2) + "\n");
  console.log(JSON.stringify({ connected: true, project: project?.dir ?? null, profile, server: server?.version, tools: tools.length, sites: await authorizedSites() }));
} finally {
  await closeHosted();
}
