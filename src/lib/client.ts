import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";

// Loads .env from the repo root, with no dependency (process.loadEnvFile, Node ≥ 21.7).
// Variables already set in the environment take precedence.
const envPath = new URL("../../.env", import.meta.url);
if (existsSync(envPath)) {
  const before = { ...process.env };
  process.loadEnvFile(envPath);
  for (const [k, v] of Object.entries(before)) if (v !== undefined && v !== "") process.env[k] = v;
}

/** Single connection to the local Webflow MCP server (stdio), shared by the whole process. */
let clientPromise: Promise<Client> | null = null;
let callCount = 0;

export interface ConnectOptions {
  /** Site API token. Default: process.env.WEBFLOW_TOKEN. */
  token?: string;
  /** npm version of webflow-mcp-server. Default: process.env.WEBFLOW_MCP_VERSION or "latest". */
  version?: string;
  /** Allows starting without a token (reading schemas only). */
  allowNoToken?: boolean;
}

export function getClient(opts: ConnectOptions = {}): Promise<Client> {
  if (!clientPromise) clientPromise = connect(opts);
  return clientPromise;
}

async function connect(opts: ConnectOptions): Promise<Client> {
  const token = opts.token ?? process.env.WEBFLOW_TOKEN ?? "";
  if (!token && !opts.allowNoToken) {
    throw new Error("WEBFLOW_TOKEN manquant : renseignez-le dans .env (voir .env.example).");
  }
  const version = opts.version ?? process.env.WEBFLOW_MCP_VERSION ?? "latest";
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // The server refuses to start without WEBFLOW_TOKEN, even just to list tools (no API call happens at that point).
  // For the schema dump a dummy value is enough; it does not allow any real call.
  env.WEBFLOW_TOKEN = token || "schema-dump-only";
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", `webflow-mcp-server@${version}`],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-code-mode-webflow-figma", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

export interface RawResult {
  isError: boolean;
  /** Concatenated text of the response's `text` blocks. */
  text: string;
  /** Raw response size, in characters (used for token measurements). */
  size: number;
}

/** Raw tool call. Never print `text` as-is in an agent script: filter it. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<RawResult> {
  const client = await getClient();
  callCount++;
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  return { isError: Boolean(res.isError), text, size: text.length };
}

export function getCallCount(): number {
  return callCount;
}

export async function close(): Promise<void> {
  if (!clientPromise) return;
  const c = await clientPromise;
  clientPromise = null;
  await c.close();
}
