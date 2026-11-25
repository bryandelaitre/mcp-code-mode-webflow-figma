/**
 * Connection to the hosted Webflow MCP (https://mcp.webflow.com/mcp), over OAuth: dynamic client registration,
 * PKCE, refresh token. No API token: the first connection opens the browser to authorize, then the tokens are kept
 * in .cache/hosted-<profile>.json (not versioned, mode 600) and refreshed automatically.
 *
 * A Webflow authorization covers the sites checked at that moment: one profile per scope
 * (WEBFLOW_HOSTED_PROFILE, default "default").
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider, waitForCode, type OAuthConfig } from "./oauth.js";
import { withLock } from "./fsutil.js";
import { currentProject } from "./project.js";
import "./client.js"; // loads .env

const SERVER = new URL("https://mcp.webflow.com/mcp");
const PORT = 33418;
// Authorization: per project (bin/kit, folder holding .mcp.json), else per profile (WEBFLOW_HOSTED_PROFILE),
// else "default" (library development, sandbox).
const profile = () => {
  if (process.env.WEBFLOW_HOSTED_PROFILE) return process.env.WEBFLOW_HOSTED_PROFILE.replace(/[^\w-]/g, "");
  const p = currentProject();
  return p ? `project-${p.key}` : "default";
};
const oauth = (): OAuthConfig => {
  const p = process.env.WEBFLOW_HOSTED_PROFILE ? null : currentProject();
  return {
    file: p ? `.cache/projects/${p.key}/webflow-oauth.json` : `.cache/hosted-${profile()}.json`,
    port: PORT, clientName: p ? `mcp-code-mode-webflow-figma · ${p.key}` : "mcp-code-mode-webflow-figma",
    label: p ? `Webflow pour le projet « ${p.key} »` : `Webflow (profil « ${profile()} »)`,
    loginCommand: p ? `${process.env.KIT_BIN ?? "<kit>/bin/kit"} login depuis ${p.dir}` : "npm run hosted-login",
    tokenEndpointAuthMethod: "none",
  };
};
export const getHostedProfile = () => ({ profile: profile(), project: currentProject() });

let hosted: Client | null = null;
let calls = 0;
let rawChars = 0;
const rawByTool: Record<string, { calls: number; chars: number }> = {};

/**
 * Client connected to the hosted MCP. interactive=true (hosted-login) opens the browser if no valid authorization
 * is cached; otherwise an explicit error is thrown.
 */
export async function getHostedClient(opts: { interactive?: boolean } = {}): Promise<Client> {
  if (hosted) return hosted;
  const provider = new FileOAuthProvider(oauth(), Boolean(opts.interactive));
  let transport = new StreamableHTTPClientTransport(SERVER, { authProvider: provider });
  let c = new Client({ name: "mcp-code-mode-webflow-figma", version: "0.1.0" });
  try {
    // Parallel agents: only one process at a time refreshes the token (a refresh token replayed by a neighbor
    // would be rejected). The others wait, then re-read the fresh token from the file.
    await withLock(`oauth-hosted-${profile()}`, () => c.connect(transport));
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !opts.interactive) throw e;
    const code = await waitForCode(PORT);
    await transport.finishAuth(code);
    transport = new StreamableHTTPClientTransport(SERVER, { authProvider: provider });
    c = new Client({ name: "mcp-code-mode-webflow-figma", version: "0.1.0" });
    await c.connect(transport);
  }
  hosted = c;
  return hosted;
}

/** Result of one action, as returned by the server (one entry per item of `actions`, in order). */
export interface HostedActionResult {
  label?: string;
  build_label?: string;
  action?: string;
  result?: any;
  error?: { name?: string; message?: string; status?: number; code?: string } | string;
  [k: string]: unknown;
}
export interface HostedResponse {
  /** true if the whole tool failed (MCP isError). A failed action does NOT set it to true: see results[i].error. */
  isError: boolean;
  /** JSON objects found in the response, in order. */
  results: HostedActionResult[];
  /** Raw text (without the session preamble), never to be printed as-is. */
  text: string;
  size: number;
}

// Session and identity: one per process (= one task). See the session_id and agent_id descriptions.
let sessionId = process.env.WEBFLOW_SESSION_ID || "start";
const agentId = process.env.WEBFLOW_AGENT_ID || `opus-5.5|mcp-code-mode-webflow-figma${currentProject() ? ":" + currentProject()!.key : ""}|${Math.random().toString(36).slice(2, 7)}`;

/** Extracts the top-level JSON objects from a text (concatenated responses, text preamble). */
export function extractJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    // At depth 0, only "{" opens an object: a "[" in prose ("[note"…) must not swallow anything.
    else if (ch === "{" || (ch === "[" && depth > 0)) { if (depth++ === 0) start = i; }
    else if ((ch === "}" || ch === "]") && depth > 0) {
      if (--depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* non-JSON fragment: ignored */ }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Calls a hosted MCP tool. session_id, agent_id and context are injected; `context` describes the call
 * (15 to 25 words, third person, no personal data) and feeds Webflow's statistics.
 */
export async function callHosted(name: string, input: Record<string, unknown>, context?: string): Promise<HostedResponse> {
  // 429: retry only if NO action went through (all 429), so a successful write is never replayed.
  for (let attempt = 0; ; attempt++) {
    const r = await callHostedOnce(name, input, context);
    const is429 = (x: unknown) => /Too Many Requests|\b429\b/i.test(typeof x === "string" ? x : JSON.stringify(x ?? ""));
    const all429 = r.isError ? is429(r.text) : r.results.length > 0 && r.results.every((a) => a.error && is429(a.error));
    if (!all429 || attempt >= 4) return r;
    await new Promise((res) => setTimeout(res, Math.min(60_000, 5_000 * 2 ** attempt)));
  }
}

async function callHostedOnce(name: string, input: Record<string, unknown>, context?: string): Promise<HostedResponse> {
  const c = await getHostedClient();
  calls++;
  const args = {
    ...input,
    session_id: sessionId,
    agent_id: agentId,
    context: context ?? `Library mcp-code-mode-webflow-figma runs ${name} from a script and returns only a compact summary to the calling agent.`,
  };
  const r: any = await c.callTool({ name, arguments: args });
  const parts: string[] = (r.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text);
  let text = parts.join("\n");
  const issued = text.match(/\[session_id issued[\s\S]*?session_id:\s*(ses_[\w-]+)[\s\S]*?(?=\{|$)/);
  if (issued) { sessionId = issued[1]; text = text.replace(issued[0], ""); }
  if (/\[session_id unrecognized/.test(text)) {
    sessionId = "start";
    throw new Error("Session MCP hébergé non reconnue : relancer le script (une nouvelle session sera ouverte).");
  }
  const sc = r.structuredContent?.mcp_session?.session_id;
  if (typeof sc === "string" && sc.startsWith("ses_")) sessionId = sc;
  const results = extractJsonObjects(text) as HostedActionResult[];
  rawChars += text.length;
  const k = name + (Array.isArray((input as any).actions) ? ":" + Object.keys((input as any).actions[0] ?? {}).filter((x) => x !== "label" && x !== "build_label").join("+") : "");
  (rawByTool[k] ??= { calls: 0, chars: 0 }).calls++; rawByTool[k].chars += text.length;
  return { isError: Boolean(r.isError), results, text, size: text.length };
}

/** Compat: raw (text) call, used by the probes. */
export async function callHostedTool(name: string, args: Record<string, unknown>) {
  const { session_id: _s, agent_id: _a, context, ...rest } = args;
  const r = await callHosted(name, rest, typeof context === "string" ? context : undefined);
  return { isError: r.isError, text: r.text, size: r.size };
}

export const getHostedSession = () => ({ sessionId, agentId });

export const getHostedCallCount = () => calls;
/** Raw characters received from the hosted MCP since process start (what a direct call would have put in context). */
export const getHostedRawChars = () => rawChars;
/** Raw volume per tool and action, to find what is costly. */
export const getHostedRawByTool = () => rawByTool;
export async function closeHosted() { await hosted?.close(); hosted = null; }
