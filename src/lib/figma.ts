/**
 * Connection to the Figma MCP. By default, the Figma desktop app's local server (Dev Mode, http://127.0.0.1:3845/mcp):
 * no authorization, the app must be open with the MCP server enabled. The remote server (FIGMA_MCP=remote) refuses
 * dynamic registration of an unapproved client (403, quirks.md): kept for the day Figma opens it up. Raw responses
 * stay in the script: only the compact output of the src/figma/* functions is shown to the agent, and each response
 * is cached on disk (.cache/figma/) so nothing is ever read twice.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, waitForCode, type OAuthConfig } from "./oauth.js";
import { withLock } from "./fsutil.js";
import "./client.js"; // loads .env

const REMOTE = process.env.FIGMA_MCP === "remote";
const SERVER = new URL(REMOTE ? "https://mcp.figma.com/mcp" : process.env.FIGMA_MCP_URL || "http://127.0.0.1:3845/mcp");
const PORT = 33419;
const OAUTH: OAuthConfig = {
  file: ".cache/figma-oauth.json", port: PORT, clientName: "mcp-code-mode-webflow-figma",
  label: "Figma", loginCommand: "npm run figma-login", scope: "mcp:connect",
};

let figma: Client | null = null;
let calls = 0, rawChars = 0;
const rawByTool: Record<string, { calls: number; chars: number }> = {};

export async function getFigmaClient(opts: { interactive?: boolean } = {}): Promise<Client> {
  if (figma) return figma;
  if (!REMOTE) {
    const c = new Client({ name: "mcp-code-mode-webflow-figma", version: "0.1.0" });
    try { await c.connect(new StreamableHTTPClientTransport(SERVER)); }
    catch (e) { throw new Error(`MCP Figma local injoignable (${SERVER}) : ouvrir l'application Figma et activer le serveur MCP (Préférences). ${String(e).slice(0, 120)}`); }
    return (figma = c);
  }
  const provider = new FileOAuthProvider(OAUTH, Boolean(opts.interactive));
  let transport = new StreamableHTTPClientTransport(SERVER, { authProvider: provider });
  let c = new Client({ name: "mcp-code-mode-webflow-figma", version: "0.1.0" });
  try {
    // Parallel agents: only one process at a time refreshes the token (a refresh token replayed by a neighbor
    // would be rejected). The others wait, then re-read the fresh token from the file.
    await withLock("oauth-figma", () => c.connect(transport));
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !opts.interactive) throw e;
    const code = await waitForCode(PORT);
    await transport.finishAuth(code);
    transport = new StreamableHTTPClientTransport(SERVER, { authProvider: provider });
    c = new Client({ name: "mcp-code-mode-webflow-figma", version: "0.1.0" });
    await c.connect(transport);
  }
  figma = c;
  return figma;
}

export interface FigmaResponse {
  isError: boolean;
  /** Text blocks of the response, in order. */
  texts: string[];
  /** Returned images (screenshot): base64 + type. */
  images: { data: string; mimeType: string }[];
  size: number;
}

/** Calls a Figma MCP tool. Never print the raw response: pass it to a summarizer from src/figma/. */
export async function callFigma(name: string, args: Record<string, unknown>): Promise<FigmaResponse> {
  const c = await getFigmaClient();
  calls++;
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const texts: string[] = (r.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text);
  const images = (r.content ?? []).filter((p: any) => p.type === "image").map((p: any) => ({ data: p.data, mimeType: p.mimeType }));
  const size = texts.reduce((n, t) => n + t.length, 0) + images.reduce((n: number, i: any) => n + i.data.length, 0);
  rawChars += size;
  (rawByTool[name] ??= { calls: 0, chars: 0 }).calls++; rawByTool[name].chars += size;
  return { isError: Boolean(r.isError), texts, images, size };
}

export const getFigmaCallCount = () => calls;
export const getFigmaRawChars = () => rawChars;
export const getFigmaRawByTool = () => rawByTool;
export async function closeFigma() { await figma?.close(); figma = null; }
