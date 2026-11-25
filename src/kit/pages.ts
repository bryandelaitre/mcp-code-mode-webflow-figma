import * as api from "./api.js";
import { KitError, assertWriteAllowed, cap, short } from "./util.js";

interface Page {
  id: string;
  siteId: string;
  title: string;
  slug: string;
  draft?: boolean;
  archived?: boolean;
  collectionId?: string | null;
  publishedPath?: string;
  seo?: { title?: string; description?: string };
  openGraph?: { title?: string; titleCopied?: boolean; description?: string; descriptionCopied?: boolean };
}

async function fetchAllPages(siteId: string): Promise<Page[]> {
  const out: Page[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = await api.pagesList(siteId, 100, offset);
    out.push(...(r.pages ?? []));
    const total = r.pagination?.total ?? out.length;
    if (out.length >= total || (r.pages ?? []).length === 0) break;
  }
  return out;
}

/** A site's pages, compact: id, path, title, draft, CMS template. */
export async function listPages(siteId: string, opts: { includeArchived?: boolean; max?: number } = {}) {
  const pages = (await fetchAllPages(siteId)).filter((p) => opts.includeArchived || !p.archived);
  const rows = pages.map((p) => ({
    id: p.id,
    path: p.publishedPath ?? `/${p.slug}`,
    title: p.title,
    ...(p.draft ? { draft: true } : {}),
    ...(p.collectionId ? { cmsTemplate: true } : {}),
  }));
  const { items, truncated } = cap(rows, opts.max ?? 100);
  return { total: pages.length, pages: items, ...(truncated ? { truncated } : {}) };
}

/** Audit thresholds, overridable per call. */
export const SEO_RULES = { titleMax: 60, titleMin: 15, descriptionMax: 160, descriptionMin: 50 };

type Issue = { page: string; path: string; issue: string; value?: unknown };

function auditOne(p: Page, rules = SEO_RULES): Issue[] {
  const path = p.publishedPath ?? `/${p.slug}`;
  const out: Issue[] = [];
  const add = (issue: string, value?: unknown) => out.push({ page: p.id, path, issue, ...(value !== undefined ? { value: short(value, 70) } : {}) });
  const t = p.seo?.title?.trim() ?? "";
  const d = p.seo?.description?.trim() ?? "";
  if (!t) add("title SEO vide (Webflow utilisera le nom de la page)");
  else if (t.length > rules.titleMax) add(`title SEO trop long (${t.length} > ${rules.titleMax})`, t);
  else if (t.length < rules.titleMin) add(`title SEO trop court (${t.length} < ${rules.titleMin})`, t);
  if (!d) add("meta description vide");
  else if (d.length > rules.descriptionMax) add(`meta description trop longue (${d.length} > ${rules.descriptionMax})`, d);
  else if (d.length < rules.descriptionMin) add(`meta description trop courte (${d.length} < ${rules.descriptionMin})`, d);
  if (!p.openGraph?.titleCopied && !p.openGraph?.title?.trim()) add("titre Open Graph vide et non copié du title");
  if (!p.openGraph?.descriptionCopied && !p.openGraph?.description?.trim()) add("description Open Graph vide et non copiée");
  return out;
}

/**
 * SEO audit: returns only the issues. With a siteId, audits all pages (excluding archived pages and drafts)
 * and adds duplicate titles; with { pageId }, a single page.
 */
export async function auditPageSeo(target: { siteId: string } | { pageId: string }, opts: { rules?: typeof SEO_RULES; max?: number } = {}) {
  const rules = { ...SEO_RULES, ...opts.rules };
  let pages: Page[];
  if ("pageId" in target) {
    pages = [await api.pageMetadata(target.pageId)];
  } else {
    pages = (await fetchAllPages(target.siteId)).filter((p) => !p.archived && !p.draft);
  }
  const issues = pages.flatMap((p) => auditOne(p, rules));
  if (pages.length > 1) {
    const byTitle = new Map<string, Page[]>();
    for (const p of pages) {
      const t = p.seo?.title?.trim();
      if (t && !p.collectionId) byTitle.set(t, [...(byTitle.get(t) ?? []), p]);
    }
    for (const [t, ps] of byTitle) if (ps.length > 1) for (const p of ps) issues.push({ page: p.id, path: p.publishedPath ?? `/${p.slug}`, issue: `title en double (${ps.length} pages)`, value: short(t, 70) });
  }
  const { items, truncated } = cap(issues, opts.max ?? 40);
  return { pagesAudited: pages.length, issues: issues.length, list: items, ...(truncated ? { truncated } : {}) };
}

export interface SeoUpdate {
  pageId: string;
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  /** Copy title / description into Open Graph (the Designer's "Same as SEO" checkboxes). */
  ogCopy?: boolean;
}

/** Updates title, description and Open Graph of several pages. dryRun by default: returns the diff. */
export async function updatePagesSeo(siteId: string, updates: SeoUpdate[], opts: { dryRun?: boolean; maxDiff?: number } = {}) {
  const dryRun = opts.dryRun ?? true;
  const plan: { page: Page; body: any; changes: Record<string, [unknown, unknown]> }[] = [];
  for (const u of updates) {
    const p: Page = await api.pageMetadata(u.pageId);
    if (p.siteId !== siteId) throw new KitError(`La page ${u.pageId} n'appartient pas au site ${siteId}.`);
    const changes: Record<string, [unknown, unknown]> = {};
    const seo: Record<string, string> = {};
    const og: Record<string, string | boolean> = {};
    const cmp = (label: string, cur: unknown, next: unknown, set: () => void) => {
      if (next !== undefined && cur !== next) { changes[label] = [short(cur ?? "", 60), short(next, 60)]; set(); }
    };
    cmp("seo.title", p.seo?.title, u.title, () => (seo.title = u.title!));
    cmp("seo.description", p.seo?.description, u.description, () => (seo.description = u.description!));
    if (u.ogCopy) {
      cmp("og.titleCopied", p.openGraph?.titleCopied, true, () => (og.titleCopied = true));
      cmp("og.descriptionCopied", p.openGraph?.descriptionCopied, true, () => (og.descriptionCopied = true));
    }
    cmp("og.title", p.openGraph?.title, u.ogTitle, () => { og.title = u.ogTitle!; og.titleCopied = false; });
    cmp("og.description", p.openGraph?.description, u.ogDescription, () => { og.description = u.ogDescription!; og.descriptionCopied = false; });
    if (!Object.keys(changes).length) continue;
    const body: { seo?: object; openGraph?: object } = {};
    if (Object.keys(seo).length) body.seo = { ...p.seo, ...seo };
    if (Object.keys(og).length) body.openGraph = { ...p.openGraph, ...og };
    plan.push({ page: p, body, changes });
  }
  const diff = plan.map((x) => ({ page: x.page.id, path: x.page.publishedPath ?? `/${x.page.slug}`, changes: x.changes }));
  const shown = cap(diff, opts.maxDiff ?? 30);
  const summary: Record<string, unknown> = {
    dryRun, pages: plan.length, unchanged: updates.length - plan.length,
    diff: shown.items, ...(shown.truncated ? { diffTruncated: shown.truncated } : {}),
  };
  if (dryRun || !plan.length) return summary;
  assertWriteAllowed(siteId);
  for (const x of plan) await api.pageUpdateSettings(x.page.id, x.body);
  summary.written = plan.length;
  return summary;
}
