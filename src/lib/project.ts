/**
 * Current project: the agent's folder (WEBFLOW_PROJECT_DIR, set by bin/kit) that holds a .mcp.json. Each project
 * has its own Webflow authorization (OAuth client, tokens, sites picked on the authorization screen), stored in the
 * library's .cache/projects/<key>/ (never in the project's repo). The key is the name of the Webflow server
 * declared in .mcp.json ("webflow-client-e"), or else the folder name.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Project { dir: string; key: string; mcpServer?: string }

let memo: Project | null | undefined;

export function currentProject(): Project | null {
  if (memo !== undefined) return memo;
  const start = process.env.WEBFLOW_PROJECT_DIR;
  if (!start) return (memo = null);
  // Walks up to the folder holding .mcp.json (the agent may be in a subfolder).
  let dir = start;
  while (!existsSync(join(dir, ".mcp.json")) && dirname(dir) !== dir) dir = dirname(dir);
  if (!existsSync(join(dir, ".mcp.json"))) dir = start;
  let mcpServer: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    mcpServer = Object.entries(cfg.mcpServers ?? {}).find(([, v]: any) => String(v?.url ?? "").includes("mcp.webflow.com"))?.[0];
  } catch { /* no readable .mcp.json: use the folder name */ }
  const key = (mcpServer ?? basename(dir)).toLowerCase().replace(/[^\w-]+/g, "-");
  return (memo = { dir, key, mcpServer });
}
