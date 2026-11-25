/**
 * Authorizes the library with the Figma MCP (browser, once), then writes its tool contract to
 * schemas/figma-tools.json. Usage: npm run figma-login
 */
import { writeFileSync } from "node:fs";
import { getFigmaClient, closeFigma } from "../src/lib/figma.js";

try {
  const c = await getFigmaClient({ interactive: true });
  const tools: any[] = [];
  let cursor: string | undefined;
  do { const r = await c.listTools(cursor ? { cursor } : {}); tools.push(...r.tools); cursor = r.nextCursor; } while (cursor);
  tools.sort((a, b) => a.name.localeCompare(b.name));
  const server = c.getServerVersion();
  writeFileSync("schemas/figma-tools.json", JSON.stringify({ server, dumpedAt: new Date().toISOString(), tools }, null, 2) + "\n");
  console.log(JSON.stringify({ connected: true, server, tools: tools.length, names: tools.map((t) => t.name) }));
} finally {
  await closeFigma();
}
