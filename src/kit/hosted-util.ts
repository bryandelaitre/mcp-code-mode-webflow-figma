import type { HostedResponse } from "../lib/hosted.js";
import { KitError } from "./util.js";

const errText = (e: unknown) =>
  typeof e === "string" ? e : (e as any)?.message ? String((e as any).message).replace(/\s+/g, " ") : JSON.stringify(e);

/**
 * Result of action no. i of a hosted MCP response, unwrapped. Throws a one-line KitError if the tool or the
 * action failed. The "element" tools return result = [{status, message, data}]: we return data.
 */
export function hostedResult<T = any>(r: HostedResponse, what: string, i = 0): T {
  if (r.isError) throw new KitError(`${what} : ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
  const a = r.results[i];
  if (!a) throw new KitError(`${what} : réponse sans résultat n° ${i} (${r.text.replace(/\s+/g, " ").slice(0, 200)})`);
  if (a.error) throw new KitError(`${what} : ${errText(a.error).slice(0, 300)}`);
  let res = a.result;
  // Some actions (add_site_script) return the error in `result`: { name: "Error", message, error }.
  if (res && typeof res === "object" && !Array.isArray(res) && res.name === "Error" && ("message" in res || "error" in res)) {
    throw new KitError(`${what} : ${errText(res).slice(0, 300)}`);
  }
  if (Array.isArray(res) && res.length === 1 && res[0] && typeof res[0] === "object" && "status" in res[0]) res = res[0];
  if (res && typeof res === "object" && "status" in res && ("data" in res || "message" in res)) {
    if (res.status === "error") throw new KitError(`${what} : ${String(res.message).slice(0, 300)}`);
    // { status, message, data } → data; { status, message, …fields } (get_style_variable_modes) → the whole object.
    return ("data" in res ? res.data : res) as T;
  }
  return res as T;
}

/** All results of a batch, without throwing: [{label, ok, data | error}]. */
export function hostedResults(r: HostedResponse) {
  return r.results.map((a) => {
    try {
      return { label: a.label ?? a.build_label, ok: true as const, data: hostedResult({ ...r, results: [a] }, String(a.label ?? "")) };
    } catch (e) {
      return { label: a.label ?? a.build_label, ok: false as const, error: (e as Error).message };
    }
  });
}
