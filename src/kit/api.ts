/**
 * Data operations (sites, CMS, pages, publishing) used by the upper layer, on one of the two servers:
 * - hosted (default): hosted MCP mcp.webflow.com, OAuth (npm run hosted-login), no token;
 * - local: npm server webflow-mcp-server, WEBFLOW_TOKEN (WEBFLOW_BACKEND=local).
 * Both return Webflow API v2 objects (same shapes), already parsed.
 */
import * as data from "../generated/data.js";
import * as h from "../generated/hosted/tools.js";
import { hostedResult } from "./hosted-util.js";
import { parse } from "./util.js";

export const backend = (): "hosted" | "local" => (process.env.WEBFLOW_BACKEND === "local" ? "local" : "hosted");
const isLocal = () => backend() === "local";
const CTX = "Library mcp-code-mode-webflow-figma runs a data operation from a script and returns only a compact summary to the agent.";

export async function sitesList(): Promise<{ sites: any[] }> {
  if (isLocal()) return parse(await data.sitesList({}), "sites_list");
  return hostedResult(await h.dataSitesTool.listSites({}, CTX), "list_sites");
}
export async function sitesGet(site_id: string): Promise<any> {
  if (isLocal()) return parse(await data.sitesGet({ site_id }), "sites_get");
  return hostedResult(await h.dataSitesTool.getSite({ site_id }, CTX), "get_site");
}
export async function sitesPublish(site_id: string, customDomains: string[]): Promise<any> {
  const args = { site_id, publishToWebflowSubdomain: true, customDomains };
  if (isLocal()) return parse(await data.sitesPublish(args), "sites_publish");
  return hostedResult(await h.dataSitesTool.publishSite(args, CTX), "publish_site");
}

export async function collectionsList(site_id: string): Promise<{ collections: any[] }> {
  if (isLocal()) return parse(await data.collectionsList({ site_id }), "collections_list");
  return hostedResult(await h.dataCmsTool.getCollectionList({ siteId: site_id }, CTX), "get_collection_list");
}
export async function collectionsGet(collection_id: string): Promise<any> {
  if (isLocal()) return parse(await data.collectionsGet({ collection_id }), "collections_get");
  return hostedResult(await h.dataCmsTool.getCollectionDetails({ collection_id }, CTX), "get_collection_details");
}
export async function collectionCreate(site_id: string, request: { displayName: string; singularName: string; slug?: string }): Promise<any> {
  if (isLocal()) return parse(await data.collectionsCreate({ site_id, request }), "collections_create");
  return hostedResult(await h.dataCmsTool.createCollection({ siteId: site_id, request }, CTX), "create_collection");
}
export async function fieldCreateStatic(collection_id: string, request: { type: "PlainText"; displayName: string }): Promise<any> {
  if (isLocal()) return parse(await data.collectionFieldsCreateStatic({ collection_id, request }), "collection_fields_create_static");
  return hostedResult(await h.dataCmsTool.createCollectionStaticField({ collection_id, request } as any, CTX), "create_collection_static_field");
}

export async function itemsList(collection_id: string, limit: number, offset: number): Promise<{ items: any[]; pagination?: { total?: number } }> {
  if (isLocal()) return parse(await data.collectionsItemsListItems({ collection_id, limit, offset }), "collections_items_list_items");
  return hostedResult(await h.dataCmsTool.listCollectionItems({ collection_id, request: { limit, offset } }, CTX), "list_collection_items");
}
/** Creates items (published on the next publish: isDraft false, like the v2 API default). Returns their ids. */
export async function itemsCreate(collection_id: string, fieldDatas: Record<string, unknown>[]): Promise<string[]> {
  if (isLocal()) {
    const r = parse<any>(await data.collectionsItemsCreateItem({ collection_id, request: { items: fieldDatas.map((fd) => ({ fieldData: fd as any })) } }), "collections_items_create_item");
    return (r.items ?? (r.id ? [r] : [])).map((it: any) => it.id);
  }
  const r = hostedResult<any>(
    await h.dataCmsTool.createCollectionItems({ collection_id, request: { items: fieldDatas.map((fd) => ({ isDraft: false, fieldData: fd as any })) as any } }, CTX),
    "create_collection_items",
  );
  return (r.items ?? (r.id ? [r] : [])).map((it: any) => it.id);
}
export async function itemsUpdate(collection_id: string, items: { id: string; fieldData: Record<string, unknown> }[]): Promise<string[]> {
  if (isLocal()) {
    const r = parse<any>(await data.collectionsItemsUpdateItems({ collection_id, request: { items: items as any } }), "collections_items_update_items");
    return (r.items ?? []).map((it: any) => it.id);
  }
  const r = hostedResult<any>(await h.dataCmsTool.updateCollectionItems({ collection_id, request: { items: items as any } }, CTX), "update_collection_items");
  return (r.items ?? []).map((it: any) => it.id);
}
export async function itemsPublish(collection_id: string, itemIds: string[]): Promise<string[]> {
  if (isLocal()) return parse<any>(await data.collectionsItemsPublishItems({ collection_id, itemIds }), "collections_items_publish_items").publishedItemIds ?? itemIds;
  const r = hostedResult<any>(await h.dataCmsTool.publishCollectionItems({ collection_id, request: { itemIds: itemIds as [string, ...string[]] } }, CTX), "publish_collection_items");
  return r?.publishedItemIds ?? itemIds;
}
export async function itemsDelete(collection_id: string, itemIds: string[]): Promise<void> {
  if (isLocal()) {
    for (const itemId of itemIds) parse(await data.collectionsItemsDeleteItem({ collection_id, itemId }), "collections_items_delete_item");
    return;
  }
  for (let i = 0; i < itemIds.length; i += 100) {
    hostedResult(await h.dataCmsTool.deleteCollectionItems({ collection_id, request: { items: itemIds.slice(i, i + 100).map((id) => ({ id })) } }, CTX), "delete_collection_items");
  }
}

export async function pagesList(site_id: string, limit: number, offset: number): Promise<{ pages: any[]; pagination?: { total?: number } }> {
  if (isLocal()) return parse(await data.pagesList({ site_id, limit, offset }), "pages_list");
  return hostedResult(await h.dataPagesTool.listPages({ site_id, limit, offset }, CTX), "list_pages");
}
export async function pageMetadata(page_id: string): Promise<any> {
  if (isLocal()) return parse(await data.pagesGetMetadata({ page_id }), "pages_get_metadata");
  return hostedResult(await h.dataPagesTool.getPageMetadata({ page_id }, CTX), "get_page_metadata");
}
/** body: full { seo?, openGraph? } (current values + changes). */
export async function pageUpdateSettings(page_id: string, body: { seo?: object; openGraph?: object }): Promise<void> {
  if (isLocal()) { parse(await data.pagesUpdatePageSettings({ page_id, body: { id: page_id, ...body } as any }), "pages_update_page_settings"); return; }
  hostedResult(await h.dataPagesTool.updatePageSettings({ page_id, ...body } as any, CTX), "update_page_settings");
}
