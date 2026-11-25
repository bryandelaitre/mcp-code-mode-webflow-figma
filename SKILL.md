---
name: mcp-code-mode-webflow-figma
description: Read a Figma design and read or edit a Webflow site by script, without loading raw MCP responses into the context — compact spec of a Figma section (structure, variables, texts, assets), outline of a Figma page, Figma variables matched to the site's, download of images and SVGs; find elements and their ids, page outline, insert an HTML + CSS section, create or edit classes, upload images, element settings and attributes, embed code, instance props, design system (variables, classes, components), CMS items, title / meta descriptions, webflow.io publishing. Use it for any Webflow work through the MCP — find an element, place a section, adjust a class, upload an asset, set props, import CMS content, audit SEO, publish — instead of calling the Webflow MCP tools one by one.
---

# mcp-code-mode-webflow-figma

Repo: `~/orca/projects/mcp-code-mode-webflow-figma`. A raw Webflow MCP response (page tree, styles, CMS item list)
often runs to tens of thousands of characters and stays in your context until the end. With the lib, you
write a short script; it calls the MCP, filters, and prints only a summary.

## When to use it

| Need | Lib | Direct MCP |
|---|:---:|:---:|
| List, filter, count CMS items | ✓ | |
| Create or update CMS items (import, bulk fix) | ✓ | |
| Collection schema | ✓ | |
| List pages, audit SEO, fix title / description / Open Graph | ✓ | |
| Publish to the webflow.io subdomain | ✓ | |
| Find elements, page outline, ids to pass to the tools | ✓ | |
| Set instance props by name | ✓ | |
| Available variables, classes, components (read) | ✓ | |
| Insert an HTML + CSS section (WHTML), delete elements | ✓ | |
| Create or edit classes (variables, breakpoints, states, modes) | ✓ | |
| Upload images (local file or URL) with alt text | ✓ | |
| Element settings, data-* attributes, append to an embed | ✓ | |
| Build components, variables, interactions, fonts, forms | | ✓ (not in the lib) |

## Writing a script

1. Create a file in `scratch/` (not versioned), e.g. `scratch/import-temoignages.ts`.
2. Import from `../src/kit/index.js` and end with `await run(() => …)`.
3. Run from the repo root: `npx tsx scratch/import-temoignages.ts`.
4. Read the output: one JSON line (capped at 4,000 characters, with the `[tronqué …]` marker if needed) then
   `[mcp] N appel(s)`. On error: `{"error": …, "message": …}` on one line.

The lib goes through the hosted MCP (OAuth). If a script answers "Autorisation Webflow requise", or if the target site
does not show up (`getSite()` without an argument lists the authorized sites), ask the user to run
`npm run hosted-login` in the repo and tick the site. The local server with a token (`WEBFLOW_BACKEND=local`,
`WEBFLOW_TOKEN`) only covers CMS, pages and publishing. Never write a token in a script, a commit or a
message.

Never `console.log` a response from `src/generated/`: that is exactly what the lib avoids. If some data is
missing from a summary, filter in the script and print only the useful field.

## Safety

- **dryRun by default**: every function that writes first returns the diff of what would change. Re-read the diff,
  then run again with `dryRun: false`.
- **Allowlist**: the actual write is refused if the site is not in `WEBFLOW_WRITE_ALLOWED_SITES`
  (`Écriture refusée : …`). Do not edit this variable to get around the refusal: ask.
- **Publishing**: webflow.io subdomain only. A custom domain requires `allowCustomDomains: true`, which
  must only be passed on the client's explicit decision.
- Functions check that the collection or page does belong to the site passed as `siteId` before writing.

## Functions

### `getSite(siteId?)`
Compact site (name, subdomain, domains, last publish). With no argument and no `WEBFLOW_SANDBOX_SITE_ID`:
list of the sites visible with the token.
```ts
await run(() => getSite("6af6…"));
// {"id":"…","name":"Bac à sable","shortName":"bac-a-sable","customDomains":[],"lastPublished":"…"}
```

### `listCollections(siteId)`
```ts
await run(() => listCollections(siteId));   // [{"id":"…","name":"Témoignages","slug":"temoignages"}]
```

### `getCollectionSchema(collectionId)`
Fields with slug, name, type, required. Read it before an import to get the exact slugs.
```ts
await run(() => getCollectionSchema(colId));
// {"id":"…","name":"Témoignages","slug":"temoignages","fields":[{"slug":"name","name":"Name","type":"PlainText","required":true},…]}
```

### `listCmsItems(collectionId, { fields?, where?, max?, maxValueLength? })`
Internal pagination; returns only `id` and the requested fields (default: name, slug), at most 50 items by default,
values cut at 120 characters. `where` filters script-side on the full `fieldData`.
```ts
await run(() => listCmsItems(colId, { fields: ["name", "note"], where: (fd) => !fd.photo, max: 20 }));
// {"total":42,"matched":3,"items":[{"id":"…","name":"Sophie M.","note":5},…]}
```

### `upsertCmsItems({ siteId, collectionId, items, matchBy?, publish?, dryRun?, maxDiff? })`
Creates or updates by `slug` (or `matchBy`). `items` = flat fieldData with the Webflow slugs. Refuses before any
write: unknown field, missing or duplicate key, required field missing on creation. Sends only the fields
that change. `publish: true` publishes the created or updated items.
```ts
const items = [{ name: "Sophie M.", slug: "sophie-m", note: 5 }];
await run(() => upsertCmsItems({ siteId, collectionId: colId, items }));                 // diff only
await run(() => upsertCmsItems({ siteId, collectionId: colId, items, dryRun: false }));  // write
// {"dryRun":false,"collection":"temoignages","create":1,"update":0,"unchanged":0,"diff":[…],"written":1}
```
Image, reference and rich text fields are compared as Webflow returns them (image object, id, HTML):
pass the same shape to avoid needless updates.

### `listPages(siteId, { includeArchived?, max? })`
```ts
await run(() => listPages(siteId));   // {"total":12,"pages":[{"id":"…","path":"/contact","title":"Contact"},…]}
```

### `auditPageSeo({ siteId } | { pageId }, { rules?, max? })`
Returns only the issues: empty, too long or too short title, empty, too long or too short meta description,
Open Graph empty and not copied, duplicate titles (static pages). Thresholds in `SEO_RULES` (60 / 15 / 160 / 50),
overridable with `rules`. Archived and draft pages are skipped.
```ts
await run(() => auditPageSeo({ siteId }));
// {"pagesAudited":12,"issues":2,"list":[{"page":"…","path":"/contact","issue":"meta description vide"},…]}
```

### `updatePagesSeo(siteId, updates, { dryRun?, maxDiff? })`
`updates`: `[{ pageId, title?, description?, ogTitle?, ogDescription?, ogCopy? }]`. Writes only what changes;
`ogCopy: true` ticks "Same as SEO" for Open Graph.
```ts
await run(() => updatePagesSeo(siteId, [{ pageId, description: "…", ogCopy: true }]));
```

### `publish(siteId, { dryRun?, customDomains?, allowCustomDomains? })`
Publishes to `<shortName>.webflow.io`. Waits if the lib published this site less than a minute ago (Webflow limit:
one publish per minute).
```ts
await run(() => publish(siteId, { dryRun: false }));
```

### `findElements({ siteId, pageId }, filter, { max?, maxText?, pathDepth? })`
A single `get_all_elements` per page and per script (cached), filtered in the script. Filter: `type`, `tag` (h1…h6,
section…), `class` (substring) or `classExact`, `text`, `attribute: { name, value? }`, `component` (instance name),
`within` (substring of the path), `where` (function). Strings are excluded unless `type: "String"`.
```ts
await run(() => findElements(page, { tag: "h2", within: "section_hero" }));
// {"page":"…","component":"…","nodes":906,"matched":1,"items":[{"id":"32ea…","el":"h2.heading-style-h2","text":"Titre","children":1,"path":"main.main-wrapper > section.section_hero > div.container"}]}
```
`elementId(result, item)` gives the composite id `{component, element}` expected by the MCP tools.

### `tree({ siteId, pageId }, { depth?, from?, maxLines?, ids? })`
Indented outline of the page (`h2.heading "Titre" #id`, `«Navbar» #id`, `slot:vflex`). `from`: id or exact class.
```ts
await run(() => tree(page, { depth: 3, from: "section_faq" }));
```

### `setInstanceProps({ siteId, pageId }, [{ instance, props: { PropName: value } }], { dryRun? })`
By prop name, type inferred from the definition: text, rich text (string), number, boolean / visibility, link (URL,
`mailto:`, `tel:`; a link to a Webflow page is not possible through the MCP), video, variant (variant id as a string).
Other types: pass the raw object `{type, …}`. Writes only what changes, in batches of 10.
```ts
await run(() => setInstanceProps(page, [{ instance: "8011…", props: { Question: "…", Answer: "…" } }]));  // diff
```

### `getDesignSystem(siteId)`, `findVariables(siteId, q)`, `findClasses(siteId, q)`, `findComponents(siteId, q)`
Single read (5 calls), cached in `.cache/ds-<site>.json` for 30 min (`refresh: true` to re-read). `getDesignSystem`:
collections and variable count, classes by type, components and their props. The `find*` functions search for a
substring (or a regex) in the name.
```ts
await run(() => findVariables(siteId, "padding"));
// {"matched":1,"items":[{"id":"variable-593f…","name":"Spacers - Padding/global","collection":"General","type":"Size","cssName":"--spacers-padding--global","value":"3rem","modes":{"Mobile":"1rem"}}]}
```

### `insertSection({ siteId, pageId }, { target, position?, html, css?, uploadImages?, dryRun? })`
`target`: element id or exact class; `position`: append (default), prepend, before, after. Before the call: rejects
descendant CSS selectors (`.a .b` makes the whole section fail; one class or one combo `.a.is-b` per rule),
rewrites `cdn.prod…` `src` values to the S3 format, uploads the images listed in `uploadImages` (`{ "path/or/url": "alt" }`),
flags non-`data-*` attributes (dropped by Webflow) and adds an empty rule for each new class without CSS
(otherwise Webflow does not create it). After: re-reads the page and lists `lostClasses`, `lostDataAttributes`, `unlinkedImages`.
No insertion next to a component instance (target a sibling or the parent).
```ts
await run(() => insertSection(page, { target: "main-wrapper", html, css }));                 // checks + plan
await run(() => insertSection(page, { target: "main-wrapper", html, css, dryRun: false }));  // {"inserted":[{"id":"…","el":"section.x_section"}],"elements":12}
```
`removeElements(page, [ids], { dryRun })` deletes elements (and their descendants).

### `ensureStyles(siteId, [{ name, parent?, props?, breakpoints?, pseudos?, modes? }], { dryRun? })`
Creates the class if missing, otherwise updates only what differs. Value: `"2rem"`, `{ var: "Variable/name" }` or
`"var(--css-name)"` (resolved by name; unknown variable → error listing close names), `null` to remove.
`parent` for a combo, `breakpoints: { medium, small, tiny }`, `pseudos: { hover }`, `modes: { "Color modes": "Dark" }`.
```ts
await run(() => ensureStyles(siteId, [{ name: "x_section", props: { "padding-top": { var: "Spacers/section-large" } }, breakpoints: { small: { "padding-top": "3rem" } } }]));
```

### `uploadAssets(siteId, [{ file, alt?, name?, folderId? }], { dryRun? })`
`file`: local path or public URL (downloaded by the script). Reuses an asset with the same name. Returns the id and
the S3 URL (the one to put in a WHTML `<img>`). `preexisting: true` = identical file already present under another
name: existing asset, left unchanged — **never delete it**. `listAssets(siteId, { query })` to search.

### `getSettings(page, el, { keys? })`, `setSettings(page, [{ element, settings }], { dryRun? })`, `appendToEmbed(page, el, code, { dryRun? })`
Settings of an element (domId, tag, attributes, visibility, code…). `setSettings`: string, number, boolean,
`{ mode, to }` for a link, `attributes: { "data-x": "1" }` (replaces the whole list; only `data-*` are
reliable), `null` or `""` to clear. Re-reads after writing: `notApplied` lists what Webflow did not take.
`appendToEmbed` appends code to the end of an embed without copying it back, then checks the re-read content byte for byte.

### Building a full site (additions from the Client E test)

| Need | Function |
|---|---|
| Custom fonts | `uploadFonts(siteId, [{ file, family, weight }])` |
| Variables (creation, modes, renaming, alias by name) | `ensureVariables(siteId, [{ collection, name, type, value, modes?, from? }])`, `ensureVariableMode`, `variableUsage`, `deleteVariables` (refuses if in use) |
| Classes: rename, read, delete | `renameStyles` (chains a → b then c → a can be replayed), `readStyles` (variables by name), `removeStyles` |
| Styles of a component variant | `ensureVariantStyles([{ component, variant, style, props, breakpoint?, pseudo? }])` |
| Texts and classes of existing elements | `setTexts`, `setClasses` (creates the base class if missing) |
| Build inside a component definition, embeds, images | `buildElements(page, { parent, schema })` (classes re-applied and created if needed) |
| Place instances, detach | `insertComponents`, `detachInstances` |
| Turn into a component with bound props | `componentize(page, { element, name, group, props: [{ name, type, bind, default }] })`, `createVariants`, `setPropDefaults` |
| Site scripts (libraries, head code) | `ensureSiteScripts(siteId, [{ name, version, location, url | code }])` |
| Embed code | `setEmbed(page, el, code)`: `var(--dt:Variable name)` resolved, exact re-read |
| WHTML links | fixed automatically by `insertSection` (`fixLinkAttributes`) |

Pitfalls seen in real conditions (details in `reports/dogfood.md` and `reports/quirks.md`): a single root per
WHTML insertion (the lib splits), image and link props without a default value (the lib sets them), missing class =
element with no class and no error (the lib creates the class), duplicate `href` (the lib fixes it), errors in `result`.

After a write made outside the lib in the same script, call `invalidateTree(page)` before re-reading.

### Reading a Figma design (`src/figma` module)

The Figma MCP returns huge responses: on Client E, a section with a vector pattern weighs 1.3 M characters,
the whole home page 4.6 M. The module keeps them in the script and in a disk cache (`.cache/figma/<file>/`, 24 h:
re-reading a node costs no call).

Prerequisites: **the Figma app open, the file in the active tab, MCP server enabled** (local server
`127.0.0.1:3845`, no authorization). The remote server refuses the lib's registration (403). Open the file
in the app: `open -a Figma "<figma link>"`.

| Need | Function |
|---|---|
| Link → reference | `figmaRef(url)` → `{ fileKey, nodeId }` |
| Outline of a section (patterns folded into one line) | `figmaOutline(ref, { depth? })` |
| Spec to build from: structure, reduced classes, variables by name, texts, assets | `figmaSpec(ref, { maxLines? })`: automatically splits a node that is too heavy; patterns become "graphics to export" (`graphique (N formes) : à exporter…` in the output) |
| Figma variables ↔ Webflow variables (same value, spacing ≠ font size) | `figmaTokens(ref, { siteId })` → `matched`, `unmatched`, `styles` |
| Images and SVGs ready for Webflow | `figmaAssets(spec.assets, { dir })`: resized to cover the Figma frame size × 3 (× 1.5 if displayed ≥ 1200 px), never upscaled, converted to AVIF (`sips`, alpha kept); SVGs cleaned; integrity checked. Options: `scale`, `fullWidthScale`, `format` (`avif` / `jpeg` / `webp`), `quality`, `optimize: false` for raw files |
| Screenshot | `figmaScreenshot(ref)` → path of the PNG (open with Read only if needed) |
| Sections of a whole page (REST API, `FIGMA_TOKEN`) | `figmaSections(fileKey, pageNodeId)`; `figmaOutline` and `figmaSpec` use it on their own on a page frame |
| Comments on a section (REST API) | `figmaComments(fileKey, sectionId, { includeResolved? })`: threads and replies whose pin falls inside the section's area; `orphans` counts threads pinned to a deleted node, to read with `figmaOrphanComments(fileKey)` (often an old version of the page: check before building) |
| Export a vector pattern or a node (REST API) | `figmaExport(fileKey, ids, { dir, format: "svg" \| "png" \| "jpg", scale? })` |

A whole page (10,000 px frame) comes back **without its children** from the local server: with `FIGMA_TOKEN`
(personal read-only token, in `.env`), the module reads its sections through the REST API; without it, pass the sections
one by one. Open each final image
with Read before `uploadAssets` (first convert to a reduced JPEG: `sips -Z 600 -s format jpeg x.avif --out x.jpg`).
An image displayed with an offset crop in Figma (`top-[-33%]`…) is recropped as a centered `object-fit: cover`:
check the rendering.

### One project = one Webflow authorization

From the project folder (the one that holds `.mcp.json`), go through the launcher:

```bash
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit login          # Webflow screen: choose the workspace and sites
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit sites          # sites authorized for this project
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit scratch/x.ts   # run a script for this project
```

Each project has its own OAuth client, its tokens (in the lib's `.cache/projects/<key>/`, never in the project's
repo) and its sessions. The key is the name of the Webflow server in `.mcp.json` (`webflow-client-e`). Without the launcher
(script run from the lib), it is the lib's "default" authorization, reserved for the sandbox. Writing stays
limited to the sites in `WEBFLOW_WRITE_ALLOWED_SITES` (the lib's `.env`): adding the project's site there is a
human decision.

### Parallel agents

Each script is a process with **its own MCP connection and its own Webflow session** (`session_id`
issued by Webflow, random `agent_id`, or `WEBFLOW_AGENT_ID=agent-hero` to name it). Several agents can
run scripts at the same time on the same repo (verified: 5 simultaneous processes, 5 distinct sessions).

- OAuth tokens: only one process at a time refreshes them (lock in `.cache/locks/`), the others re-read the new token.
- Shared design system cache, written atomically; a write by one agent invalidates the affected part for
  all (an invalidation wins over a concurrent read).
- Page tree: in memory, specific to each script (60 s). **One agent per page** (or per clearly separate section).
- Shared Webflow rate limit: more agents = more 429s (the lib retries for up to 60 s).
- Figma (local server): a single app, a single active tab. Several agents on the **same** file,
  yes; on different files, no. The Figma disk cache is shared: a node read by one agent is free
  for the others.


## On error

- `Autorisation Webflow requise`: the user runs `npm run hosted-login`.
- `404` on a site: the site was not ticked during authorization (run `hosted-login` again).
- `Too Many Requests`: the lib retries on its own for up to 60 s; beyond that, wait a minute.
- Local server: `WEBFLOW_TOKEN manquant` (fill in `.env`), `HTTP 401` / `403` (invalid token or missing scope).
- Behavior that contradicts the schema: log it in `reports/quirks.md` (date, tool, expected, actual, workaround).
