/**
 * OAuth shared by the remote MCPs (Webflow, Figma): dynamic client registration, PKCE, refresh token. Tokens live
 * in .cache/<file>.json (not versioned, mode 600) and refresh themselves. The first connection opens the browser:
 * authorization is always given by a human.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "./fsutil.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export interface OAuthConfig {
  /** Storage file, e.g. ".cache/hosted-default.json". */
  file: string;
  port: number;
  clientName: string;
  /** Label used in messages ("Webflow", "Figma"). */
  label: string;
  /** Command to run to authorize, quoted in the non-interactive error. */
  loginCommand: string;
  scope?: string;
  /** "none" for a public client; omitted if the server requires a secret (Figma). */
  tokenEndpointAuthMethod?: string;
}

type Store = Record<string, unknown>;

export class FileOAuthProvider implements OAuthClientProvider {
  constructor(private cfg: OAuthConfig, private interactive: boolean) {}
  private load = (): Store => (existsSync(this.cfg.file) ? JSON.parse(readFileSync(this.cfg.file, "utf8")) : {});
  private write(s: Store) { writeAtomic(this.cfg.file, JSON.stringify(s), 0o600); }
  private save(patch: Store) { this.write({ ...this.load(), ...patch }); }
  get redirectUrl() { return `http://127.0.0.1:${this.cfg.port}/callback`; }
  get clientMetadata() {
    return {
      client_name: this.cfg.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(this.cfg.tokenEndpointAuthMethod ? { token_endpoint_auth_method: this.cfg.tokenEndpointAuthMethod } : {}),
      ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
    };
  }
  clientInformation() { return this.load().client as any; }
  saveClientInformation(info: any) { this.save({ client: info }); }
  tokens() { return this.load().tokens as any; }
  saveTokens(tokens: any) { this.save({ tokens }); }
  saveCodeVerifier(v: string) { this.save({ verifier: v }); }
  codeVerifier() { return String(this.load().verifier ?? ""); }
  state() { const s = Math.random().toString(36).slice(2) + Date.now().toString(36); this.save({ state: s }); return s; }
  invalidateCredentials(scope: string) {
    const s = this.load();
    if (scope === "all" || scope === "client") delete s.client;
    if (scope === "all" || scope === "tokens") delete s.tokens;
    if (scope === "all" || scope === "verifier") delete s.verifier;
    this.write(s);
  }
  redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new Error(`Autorisation ${this.cfg.label} requise : lancer ${this.cfg.loginCommand}.`);
    console.error(`Ouverture du navigateur pour autoriser l'accès ${this.cfg.label}…`);
    execFile("open", [url.toString()]);
  }
}

/** Waits for the browser to come back on the callback URL and returns the authorization code. */
export function waitForCode(port: number, timeoutMs = 300_000): Promise<string> {
  const base = `http://127.0.0.1:${port}/callback`;
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", base);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(code ? "<p>Autorisation reçue. Vous pouvez fermer cet onglet.</p>" : `<p>Échec : ${err ?? "pas de code"}</p>`);
      clearTimeout(timer);
      srv.close();
      code ? resolve(code) : reject(new Error(`Autorisation refusée : ${err ?? "pas de code"}`));
    });
    const timer = setTimeout(() => { srv.close(); reject(new Error("Pas d'autorisation reçue en 5 minutes.")); }, timeoutMs);
    srv.listen(port, "127.0.0.1");
  });
}
