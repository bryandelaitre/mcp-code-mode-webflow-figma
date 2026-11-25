/**
 * Fetches the Webflow MCP server's tool list and their input schemas,
 * and writes them to schemas/tools.json (source of truth for the low-level layer).
 *
 * Usage: npm run dump-schemas
 * The token is not needed to list the tools; if present, it is passed along.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { getClient, close } from "../src/lib/client.js";

const client = await getClient({ allowNoToken: true });
const server = client.getServerVersion();
const tools: unknown[] = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await close();

const sorted = (tools as Array<{ name: string }>).sort((a, b) => a.name.localeCompare(b.name));
mkdirSync("schemas", { recursive: true });
writeFileSync(
  "schemas/tools.json",
  JSON.stringify({ server, dumpedAt: new Date().toISOString(), tools: sorted }, null, 2) + "\n",
);
console.log(`${sorted.length} outils écrits dans schemas/tools.json (serveur ${server?.name} ${server?.version})`);
