import * as api from "./api.js";
import { KitError, assertWriteAllowed, cap, short } from "./util.js";

export interface FieldInfo {
  slug: string;
  name: string;
  type: string;
  required: boolean;
}
export interface CollectionSchema {
  id: string;
  name: string;
  slug: string;
  fields: FieldInfo[];
}

/** Compact schema of a collection: slug, name, type and required flag of each field. */
export async function getCollectionSchema(collectionId: string): Promise<CollectionSchema> {
  const c = await api.collectionsGet(collectionId);
  return {
    id: c.id,
    name: c.displayName,
    slug: c.slug,
    fields: (c.fields ?? []).map((f: any) => ({
      slug: f.slug, name: f.displayName, type: f.type, required: Boolean(f.isRequired),
    })),
  };
}

/** A site's collections, compact. */
export async function listCollections(siteId: string) {
  const r = await api.collectionsList(siteId);
  return (r.collections ?? []).map((c: any) => ({ id: c.id, name: c.displayName, slug: c.slug }));
}

async function assertCollectionInSite(siteId: string, collectionId: string) {
  const cols = await listCollections(siteId);
  if (!cols.some((c: { id: string }) => c.id === collectionId)) {
    throw new KitError(`La collection ${collectionId} n'appartient pas au site ${siteId}.`);
  }
}

export interface CmsItem {
  id: string;
  draft: boolean;
  archived: boolean;
  fieldData: Record<string, unknown>;
}

/** Reads all items of a collection (internal pagination by 100). Internal use: returns the full data. */
async function fetchAllItems(collectionId: string): Promise<CmsItem[]> {
  const out: CmsItem[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = await api.itemsList(collectionId, 100, offset);
    for (const it of r.items ?? []) {
      out.push({ id: it.id, draft: Boolean(it.isDraft), archived: Boolean(it.isArchived), fieldData: it.fieldData ?? {} });
    }
    const total = r.pagination?.total ?? out.length;
    if (out.length >= total || (r.items ?? []).length === 0) break;
  }
  return out;
}

export interface ListCmsItemsOptions {
  /** Fields (slugs) to return. Default: name and slug. */
  fields?: string[];
  /** Library-side filter, applied to the full fieldData. */
  where?: (fieldData: Record<string, unknown>, item: CmsItem) => boolean;
  /** Maximum number of items returned (default 50). The total is always given. */
  max?: number;
  /** Maximum length of a field value (default 120 characters). */
  maxValueLength?: number;
}

/** Items of a collection with only the requested fields, capped. */
export async function listCmsItems(collectionId: string, opts: ListCmsItemsOptions = {}) {
  const fields = opts.fields ?? ["name", "slug"];
  const all = await fetchAllItems(collectionId);
  const matched = opts.where ? all.filter((it) => opts.where!(it.fieldData, it)) : all;
  const rows = matched.map((it) => {
    const row: Record<string, unknown> = { id: it.id };
    if (it.draft) row.draft = true;
    if (it.archived) row.archived = true;
    for (const f of fields) row[f] = short(it.fieldData[f], opts.maxValueLength ?? 120);
    return row;
  });
  const { items, truncated } = cap(rows, opts.max ?? 50);
  return { total: all.length, matched: matched.length, items, ...(truncated ? { truncated } : {}) };
}

export interface UpsertOptions {
  siteId: string;
  collectionId: string;
  /** Items to write: flat fieldData ({ name, slug, ... }), Webflow field slugs. */
  items: Record<string, unknown>[];
  /** Field that identifies an existing item. Default: slug. */
  matchBy?: string;
  /** Publish the created or updated items. Default: false (drafts). */
  publish?: boolean;
  /** Default: true. Write nothing, return the diff. */
  dryRun?: boolean;
  /** Maximum number of diff lines returned (default 30). */
  maxDiff?: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const chunks = <T>(l: T[], n: number) => Array.from({ length: Math.ceil(l.length / n) }, (_, i) => l.slice(i * n, i * n + n));

/**
 * Creates or updates items by key (slug by default). Validates the fields against the collection schema
 * before any write. dryRun by default: returns the diff without writing anything.
 */
export async function upsertCmsItems(o: UpsertOptions) {
  const dryRun = o.dryRun ?? true;
  const matchBy = o.matchBy ?? "slug";
  const schema = await getCollectionSchema(o.collectionId);
  const known = new Set(schema.fields.map((f) => f.slug));

  // Validation: unknown fields, missing key, duplicates.
  const unknown = [...new Set(o.items.flatMap((it) => Object.keys(it)))].filter((k) => !known.has(k));
  if (unknown.length) throw new KitError(`Champs inconnus dans ${schema.slug} : ${unknown.join(", ")}. Champs : ${[...known].join(", ")}.`);
  const keys = o.items.map((it) => it[matchBy]);
  if (keys.some((k) => k === undefined || k === "")) throw new KitError(`Chaque item doit porter le champ « ${matchBy} ».`);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) throw new KitError(`Valeurs de « ${matchBy} » en double : ${[...new Set(dup)].join(", ")}.`);

  const existing = await fetchAllItems(o.collectionId);
  const byKey = new Map(existing.map((it) => [String(it.fieldData[matchBy]), it]));
  const required = schema.fields.filter((f) => f.required).map((f) => f.slug);

  const toCreate: Record<string, unknown>[] = [];
  const toUpdate: { id: string; fieldData: Record<string, unknown> }[] = [];
  const diff: unknown[] = [];
  let unchanged = 0;
  for (const it of o.items) {
    const key = String(it[matchBy]);
    const cur = byKey.get(key);
    if (!cur) {
      const missing = required.filter((r) => it[r] === undefined || it[r] === "");
      if (missing.length) throw new KitError(`Création de « ${key} » impossible : champs obligatoires manquants (${missing.join(", ")}).`);
      toCreate.push(it);
      diff.push({ [matchBy]: key, action: "create", fields: Object.keys(it) });
      continue;
    }
    const changed: Record<string, unknown> = {};
    const changes: Record<string, [unknown, unknown]> = {};
    for (const [f, v] of Object.entries(it)) {
      if (!same(cur.fieldData[f], v)) {
        changed[f] = v;
        changes[f] = [short(cur.fieldData[f], 60), short(v, 60)];
      }
    }
    if (Object.keys(changed).length === 0) { unchanged++; continue; }
    toUpdate.push({ id: cur.id, fieldData: changed });
    diff.push({ [matchBy]: key, action: "update", id: cur.id, changes });
  }

  const shown = cap(diff, o.maxDiff ?? 30);
  const summary: Record<string, unknown> = {
    dryRun, collection: schema.slug, create: toCreate.length, update: toUpdate.length, unchanged,
    diff: shown.items, ...(shown.truncated ? { diffTruncated: shown.truncated } : {}),
  };
  if (dryRun || (toCreate.length === 0 && toUpdate.length === 0)) return summary;

  assertWriteAllowed(o.siteId);
  await assertCollectionInSite(o.siteId, o.collectionId);
  const touched: string[] = [];
  for (const batch of chunks(toCreate, 100)) touched.push(...(await api.itemsCreate(o.collectionId, batch)));
  for (const batch of chunks(toUpdate, 100)) touched.push(...(await api.itemsUpdate(o.collectionId, batch)));
  summary.written = touched.length;
  if (o.publish && touched.length) {
    // The items are already written: a publish failure must not hide this summary.
    let published = 0;
    try {
      for (const batch of chunks(touched, 100)) {
        published += (await api.itemsPublish(o.collectionId, batch)).length;
      }
    } catch (e) {
      // HTTP 409 "The site is not published": publish the site once (publish()), then retry.
      summary.publishError = (e as Error).message;
    }
    summary.published = published;
  }
  return summary;
}
