/**
 * Variables (hosted MCP): creation, per-mode update, rename, deletion with usage check, modes.
 * Values by variable name (no more hand-built ids). MCP limits: a mode can be neither renamed nor deleted
 * (quirks.md); `update_*` without mode_id writes the base mode (Webflow MCP lessons file, webflow-mcp.md).
 */
import * as h from "../generated/hosted/tools.js";
import { hostedResult, hostedResults } from "./hosted-util.js";
import { invalidateDesignSystem, loadDesignSystem, type DesignSystem } from "./design-system.js";
import { KitError, assertWriteAllowed, cap } from "./util.js";

const CTX = "Library mcp-code-mode-webflow-figma aligns site variables with the design file and returns only a compact diff.";
export type VarType = "color" | "size" | "number" | "percentage" | "font";
/** "#030e15", "4rem", 1.24, "Feature Display", or { var: "Variable name" } (alias). */
export type VarValue = string | number | { var: string };
export interface VarSpec {
  collection: string;
  name: string;
  type: VarType;
  /** Base mode value. */
  value: VarValue;
  /** Values for the other modes, by mode name. */
  modes?: Record<string, VarValue>;
  /** Current name to rename to `name` (rename, then update). */
  from?: string;
}

const TYPES: Record<string, VarType> = { Color: "color", Size: "size", Number: "number", Percentage: "percentage", FontFamily: "font" };

function findVar(ds: DesignSystem, name: string, collection?: string) {
  const pool = collection ? ds.variables.filter((v) => v.collection === collection) : ds.variables;
  return pool.find((v) => v.name === name) ?? pool.find((v) => v.name.trim() === name.trim());
}

/** Value → form comparable to DesignSystem.variables[].value, plus the API's `value` argument. */
function encode(ds: DesignSystem, type: VarType, v: VarValue): { cmp: string; api: Record<string, unknown> } {
  if (typeof v === "object") {
    const ref = findVar(ds, v.var);
    if (!ref) throw new KitError(`Variable introuvable pour l'alias : ${v.var}`);
    return { cmp: `var(${ref.id})`, api: { existing_variable_id: ref.id } };
  }
  if (type === "size") {
    const m = String(v).match(/^(-?\d*\.?\d+)(px|em|rem|vh|vw|dvh|dvw|lvh|lvw|svh|svw|vmax|vmin|ch)$/);
    if (!m) return { cmp: String(v), api: { custom_value: String(v) } };
    return { cmp: `${Number(m[1])}${m[2]}`, api: { static_value: { value: Number(m[1]), unit: m[2] } } };
  }
  if (type === "number" || type === "percentage") return { cmp: String(Number(v)), api: { static_value: Number(v) } };
  if (type === "color") return { cmp: String(v).toLowerCase(), api: { static_value: String(v).toLowerCase() } };
  return { cmp: String(v), api: { static_value: String(v) } };
}

const ACTION = (verb: "create" | "update", t: VarType) => `${verb}_${t === "font" ? "font_family" : t}_variable`;

/**
 * Aligns variables with the design file. dryRun by default: diff per variable (rename, creation, base, modes).
 * Execution order: renames, creations, then values (base and modes) — an alias can target a variable created
 * in the same call.
 */
export async function ensureVariables(siteId: string, specs: VarSpec[], opts: { dryRun?: boolean; maxDiff?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  let ds = await loadDesignSystem(siteId, { refresh: true, parts: ["variables"] });
  const col = (name: string) => {
    const c = ds.collections.find((x) => x.name === name);
    if (!c) throw new KitError(`Collection introuvable : ${name}. Collections : ${ds.collections.map((x) => x.name).join(", ")}.`);
    return c;
  };
  const renames: any[] = [], creates: any[] = [], diff: unknown[] = [];
  for (const s of specs) {
    const c = col(s.collection);
    for (const m of Object.keys(s.modes ?? {})) if (!c.modes.some((x) => x.name === m)) throw new KitError(`Mode « ${m} » absent de ${c.name} (${c.modes.map((x) => x.name).join(", ")}).`);
    const cur = findVar(ds, s.name, c.name) ?? (s.from ? findVar(ds, s.from, c.name) : undefined);
    const changes: Record<string, [unknown, unknown]> = {};
    if (cur && cur.name !== s.name) {
      renames.push({ label: `rename ${s.name}`, rename_variable: { variable_collection_id: c.id, variable_id: cur.id, new_name: s.name } });
      changes.name = [cur.name, s.name];
    }
    if (!cur) {
      creates.push({ s, c });
      diff.push({ variable: `${c.name}/${s.name}`, action: "create", value: s.value, ...(s.modes ? { modes: s.modes } : {}) });
      continue;
    }
    if (TYPES[cur.type] && TYPES[cur.type] !== s.type) throw new KitError(`${s.name} est de type ${cur.type}, pas ${s.type}.`);
    // Alias comparisons are done on the id; re-read values are "var(id)" when they are aliases.
    const curBase = cur.value;
    const wantBase = s.value === undefined ? undefined : encode(ds, s.type, s.value).cmp;
    if (wantBase !== undefined && curBase.toLowerCase() !== wantBase.toLowerCase()) changes.base = [curBase, wantBase];
    for (const [mode, v] of Object.entries(s.modes ?? {})) {
      const w = encode(ds, s.type, v).cmp;
      const now = cur.modes?.[mode] ?? curBase; // an unset mode follows the base
      if (now.toLowerCase() !== w.toLowerCase()) changes[mode] = [now, w];
    }
    if (Object.keys(changes).length) diff.push({ variable: `${c.name}/${s.name}`, action: "update", changes });
  }
  const d = cap(diff, opts.maxDiff ?? 60);
  const named = (x: unknown) => JSON.stringify(x).replace(/var\((variable-[0-9a-f-]+)\)/g, (_m, id) => `var(${ds.variables.find((v) => v.id === id)?.name ?? id})`);
  const summary: Record<string, unknown> = { dryRun, variables: diff.length, unchanged: specs.length - diff.length, diff: JSON.parse(named(d.items)), ...(d.truncated ? { diffTruncated: d.truncated } : {}) };
  if (dryRun || !diff.length) return summary;
  assertWriteAllowed(siteId);

  const base = { siteId, pageId: ds.pageId };
  const errors: unknown[] = [];
  const runBatch = async (actions: any[]) => {
    for (let i = 0; i < actions.length; i += 10) {
      const r = await h.dataVariableTool.call({ ...base, actions: actions.slice(i, i + 10) } as any, CTX);
      for (const res of hostedResults(r)) if (!res.ok) errors.push({ action: res.label, error: res.error });
    }
  };
  await runBatch(renames);
  // Creations: base value at creation; an alias to a variable not yet created waits for the next pass.
  const deferred: VarSpec[] = [];
  await runBatch(creates.map(({ s, c }) => {
    let value: Record<string, unknown>;
    try { value = encode(ds, s.type, s.value).api; } catch { deferred.push(s); value = encode(ds, s.type, s.type === "color" ? "#000000" : s.type === "size" ? "0rem" : s.type === "font" ? "inherit" : 0).api; }
    return { label: `create ${s.name}`, [ACTION("create", s.type)]: { variable_collection_id: c.id, variable_name: s.name, value } };
  }));
  ds = await loadDesignSystem(siteId, { refresh: true, parts: ["variables"] });
  // Values: base (without mode_id) then modes, for everything that still differs.
  const updates: any[] = [];
  for (const s of specs) {
    const c = col(s.collection);
    const cur = findVar(ds, s.name, c.name);
    if (!cur) { errors.push({ variable: s.name, error: "absente après création" }); continue; }
    const wb = encode(ds, s.type, s.value);
    if (cur.value.toLowerCase() !== wb.cmp.toLowerCase() || deferred.includes(s)) {
      updates.push({ label: `${s.name}:base`, [ACTION("update", s.type)]: { variable_collection_id: c.id, variable_id: cur.id, value: wb.api } });
    }
    for (const [mode, v] of Object.entries(s.modes ?? {})) {
      const w = encode(ds, s.type, v);
      const now = cur.modes?.[mode] ?? cur.value;
      if (now.toLowerCase() === w.cmp.toLowerCase() && !creates.some((x) => x.s === s)) continue;
      updates.push({ label: `${s.name}:${mode}`, [ACTION("update", s.type)]: { variable_collection_id: c.id, variable_id: cur.id, mode_id: c.modes.find((x) => x.name === mode)!.id, value: w.api } });
    }
  }
  await runBatch(updates);
  invalidateDesignSystem(siteId, ["variables"]);
  return { ...summary, written: renames.length + creates.length + updates.length - errors.length, ...(errors.length ? { errors } : {}) };
}

/** Adds a mode to a collection if it does not exist. dryRun by default. */
export async function ensureVariableMode(siteId: string, collection: string, name: string, opts: { dryRun?: boolean } = {}) {
  const ds = await loadDesignSystem(siteId, { refresh: true, parts: ["variables"] });
  const c = ds.collections.find((x) => x.name === collection);
  if (!c) throw new KitError(`Collection introuvable : ${collection}`);
  const exists = c.modes.find((m) => m.name === name);
  if (exists || (opts.dryRun ?? true)) return { dryRun: opts.dryRun ?? true, collection, mode: name, exists: Boolean(exists) };
  assertWriteAllowed(siteId);
  hostedResult(await h.dataVariableTool.createVariableMode({ siteId, pageId: ds.pageId }, { variable_collection_id: c.id, name }, CTX), "create_variable_mode");
  invalidateDesignSystem(siteId, ["variables"]);
  return { dryRun: false, collection, mode: name, created: true };
}

/**
 * Where each variable is used: classes (all breakpoints and states read) and other variables (aliases).
 * The full get_styles response stays inside the process.
 */
export async function variableUsage(siteId: string, names: string[]) {
  const ds = await loadDesignSystem(siteId, { refresh: true, parts: ["variables"] });
  const targets = names.map((n) => {
    const v = findVar(ds, n);
    if (!v) throw new KitError(`Variable introuvable : ${n}`);
    return v;
  });
  const r = await h.dataStyleTool.getStyles(
    { siteId, pageId: ds.pageId },
    { query: "all", include_properties: true, include_breakpoints: ["main", "medium", "small", "tiny", "large", "xl", "xxl"], include_base_pseudos: ["noPseudo", "hover", "focus", "active", "before", "after", "placeholder"] } as any,
    CTX,
  );
  const styles = hostedResult<any[]>(r, "get_styles") ?? [];
  return Object.fromEntries(targets.map((v) => {
    const inStyles = styles.filter((s) => JSON.stringify(s.properties ?? {}).includes(v.id)).map((s) => s.selector ?? s.name);
    const inVars = ds.variables.filter((x) => x.value === `var(${v.id})` || Object.values(x.modes ?? {}).includes(`var(${v.id})`)).map((x) => `${x.collection}/${x.name}`);
    return [v.name, { styles: inStyles, variables: inVars }];
  }));
}

/** Deletes unused variables. Refuses if a class or a variable uses them (unless force). dryRun by default. */
export async function deleteVariables(siteId: string, names: string[], opts: { dryRun?: boolean; force?: boolean } = {}) {
  const dryRun = opts.dryRun ?? true;
  const usage = await variableUsage(siteId, names);
  const used = Object.entries(usage).filter(([, u]) => u.styles.length || u.variables.length);
  if (used.length && !opts.force) {
    return { dryRun, refused: used.map(([n, u]) => ({ variable: n, styles: u.styles.slice(0, 8), variables: u.variables.slice(0, 8) })), deletable: names.filter((n) => !used.some(([u]) => u === n)) };
  }
  if (dryRun) return { dryRun, delete: names };
  assertWriteAllowed(siteId);
  const ds = await loadDesignSystem(siteId, { parts: ["variables"] });
  const actions = names.map((n) => {
    const v = findVar(ds, n)!;
    return { label: n, delete_variable: { variable_collection_id: ds.collections.find((c) => c.name === v.collection)!.id, variable_id: v.id } };
  });
  const errors: unknown[] = [];
  for (let i = 0; i < actions.length; i += 10) {
    const r = await h.dataVariableTool.call({ siteId, pageId: ds.pageId, actions: actions.slice(i, i + 10) } as any, CTX);
    for (const res of hostedResults(r)) if (!res.ok) errors.push({ variable: res.label, error: res.error });
  }
  invalidateDesignSystem(siteId, ["variables"]);
  return { dryRun: false, deleted: names.length - errors.length, ...(errors.length ? { errors } : {}) };
}
