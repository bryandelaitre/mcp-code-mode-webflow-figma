import type { RawResult } from "../lib/client.js";

/** Compact error: a one-line message, never the whole raw response. */
export class KitError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "KitError";
  }
}

/**
 * The server returns JSON.stringify(Webflow SDK response); on error, isError + {name, message, error}.
 * Returns the parsed object or throws a one-line KitError.
 */
export function parse<T = any>(raw: RawResult, what: string): T {
  let body: any;
  try {
    body = JSON.parse(raw.text);
  } catch {
    throw new KitError(`${what} : réponse non JSON (${raw.text.slice(0, 160)})`);
  }
  if (raw.isError) {
    const status = body?.error?.statusCode ?? body?.error?.status;
    const msg = body?.error?.body?.message ?? body?.message ?? "erreur inconnue";
    throw new KitError(`${what} : ${status ? `HTTP ${status} ` : ""}${String(msg).slice(0, 300)}`, body?.error?.body);
  }
  return body as T;
}

/** Write guard: the site must be listed in WEBFLOW_WRITE_ALLOWED_SITES. */
export function assertWriteAllowed(siteId: string): void {
  const allowed = (process.env.WEBFLOW_WRITE_ALLOWED_SITES ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(siteId)) {
    throw new KitError(
      `Écriture refusée : le site ${siteId} n'est pas dans WEBFLOW_WRITE_ALLOWED_SITES. ` +
        `Relancez en dryRun, ou ajoutez le site à la variable si l'écriture est voulue.`,
    );
  }
}

/** Output cap for lists: keeps the first `max` items and reports the rest. */
export function cap<T>(list: T[], max: number): { items: T[]; truncated?: string } {
  if (list.length <= max) return { items: list };
  return { items: list.slice(0, max), truncated: `${list.length - max} élément(s) non affiché(s) sur ${list.length}` };
}

/** Shortens a value for a readable diff. */
export function short(v: unknown, n = 80): unknown {
  if (typeof v === "string") return v.length > n ? v.slice(0, n) + `… (${v.length} car.)` : v;
  if (v && typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + `… (${s.length} car.)` : v;
  }
  return v;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
