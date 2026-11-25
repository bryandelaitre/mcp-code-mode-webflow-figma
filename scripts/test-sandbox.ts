/**
 * Tests of the high-level layer on the sandbox site, and only on it.
 *
 * Usage: npm test
 * Requires WEBFLOW_SANDBOX_SITE_ID and a token that sees only this site. Writes additionally require the site to be
 * listed in WEBFLOW_WRITE_ALLOWED_SITES; otherwise only the read and dryRun tests run.
 * What the test writes: a "Kit Tests" collection (created if missing) and its items, deleted at the end;
 * a page's meta description and an instance text prop, restored at the end; a publish to the webflow.io
 * subdomain; hosted MCP: an asset, kit-test_* classes and a section inserted into the lightest page,
 * all deleted at the end (no existing element is modified by these tests).
 */
import { randomPng } from "./test-utils.js";
import * as api from "../src/kit/api.js";
import { close, getCallCount } from "../src/lib/client.js";
import { closeHosted, getHostedCallCount } from "../src/lib/hosted.js";
import {
  getSite, listPages, auditPageSeo, updatePagesSeo, listCollections, getCollectionSchema,
  listCmsItems, upsertCmsItems, publish, findElements, tree, loadTree, setInstanceProps, getComponentDefs,
  getDesignSystem, findVariables, findClasses, findComponents, uploadAssets, listAssets, ensureStyles,
  insertSection, removeElements, setSettings, getSettings,
} from "../src/kit/index.js";
import * as h from "../src/generated/hosted/tools.js";
import { hostedResults } from "../src/kit/hosted-util.js";


const SITE = process.env.WEBFLOW_SANDBOX_SITE_ID ?? "";
const results: { test: string; ok: boolean; info?: unknown }[] = [];
async function t(name: string, fn: () => Promise<unknown>) {
  try {
    const info = await fn();
    results.push({ test: name, ok: true, info });
  } catch (e) {
    results.push({ test: name, ok: false, info: (e as Error).message.slice(0, 300) });
  }
}
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const size = (x: unknown) => JSON.stringify(x).length;

try {
  if (!SITE) throw new Error("WEBFLOW_SANDBOX_SITE_ID manquant dans .env");
  const list = (await api.sitesList()).sites ?? [];
  if (list.length !== 1 || list[0].id !== SITE) {
    throw new Error(`Le token voit ${list.length} site(s) (${list.map((s: any) => s.id).join(", ")}) : il doit ne voir que le bac à sable ${SITE}.`);
  }
  const canWrite = (process.env.WEBFLOW_WRITE_ALLOWED_SITES ?? "").split(",").map((s) => s.trim()).includes(SITE);

  await t("getSite", async () => {
    const s: any = await getSite(SITE);
    assert(s.id === SITE, "id différent");
    return { name: s.name, shortName: s.shortName, size: size(s) };
  });

  let pageId = "";
  await t("listPages", async () => {
    const r = await listPages(SITE);
    assert(r.total > 0, "aucune page");
    pageId = (r.pages.find((p: any) => !p.cmsTemplate && !p.draft) ?? r.pages[0]).id;
    return { total: r.total, size: size(r) };
  });

  await t("auditPageSeo (site)", async () => {
    const r = await auditPageSeo({ siteId: SITE });
    return { pages: r.pagesAudited, issues: r.issues, size: size(r) };
  });

  const marker = `Description de test mcp-code-mode-webflow-figma ${new Date().toISOString().slice(0, 16)}, à restaurer.`;
  let original: string | undefined;
  await t("updatePagesSeo dryRun", async () => {
    const meta = await api.pageMetadata(pageId);
    original = meta.seo?.description ?? "";
    const r = await updatePagesSeo(SITE, [{ pageId, description: marker }]);
    assert(r.dryRun === true && r.pages === 1, "le dryRun devrait annoncer 1 page modifiée");
    const after = await api.pageMetadata(pageId);
    assert((after.seo?.description ?? "") === original, "le dryRun a écrit");
    return { diff: r.diff, size: size(r) };
  });

  await t("garde-fou : écriture sur un site hors liste refusée", async () => {
    const saved = process.env.WEBFLOW_WRITE_ALLOWED_SITES;
    process.env.WEBFLOW_WRITE_ALLOWED_SITES = "";
    try {
      await updatePagesSeo(SITE, [{ pageId, description: marker }], { dryRun: false });
      throw new Error("l'écriture aurait dû être refusée");
    } catch (e) {
      assert(/Écriture refusée/.test((e as Error).message), (e as Error).message);
    } finally {
      process.env.WEBFLOW_WRITE_ALLOWED_SITES = saved;
    }
    return "refus OK";
  });

  if (canWrite) {
    await t("updatePagesSeo écriture puis restauration", async () => {
      const w = await updatePagesSeo(SITE, [{ pageId, description: marker }], { dryRun: false });
      assert(w.written === 1, "aucune écriture");
      const again = await updatePagesSeo(SITE, [{ pageId, description: marker }]);
      assert(again.pages === 0 && again.unchanged === 1, "la relecture devrait être inchangée");
      await updatePagesSeo(SITE, [{ pageId, description: original ?? "" }], { dryRun: false });
      return { written: w.written, restored: true };
    });
  }

  // CMS: dedicated test collection.
  let colId = "";
  await t("listCollections", async () => {
    const cols = await listCollections(SITE);
    colId = cols.find((c: any) => c.slug === "kit-tests")?.id ?? "";
    return { count: cols.length, kitTests: Boolean(colId) };
  });
  if (!colId && canWrite) {
    await t("création de la collection Kit Tests", async () => {
      const c = await api.collectionCreate(SITE, { displayName: "Kit Tests", singularName: "Kit Test", slug: "kit-tests" });
      colId = c.id;
      await api.fieldCreateStatic(colId, { type: "PlainText", displayName: "Résumé" });
      return { id: colId };
    });
  }

  if (colId) {
    let summaryField = "";
    await t("getCollectionSchema", async () => {
      const s = await getCollectionSchema(colId);
      summaryField = s.fields.find((f) => f.type === "PlainText" && f.slug !== "name")?.slug ?? "";
      return { fields: s.fields.map((f) => `${f.slug}:${f.type}${f.required ? "*" : ""}`), size: size(s) };
    });
    const stamp = Date.now().toString(36);
    const items = [1, 2, 3].map((i) => ({ name: `Test ${stamp} ${i}`, slug: `test-${stamp}-${i}`, ...(summaryField ? { [summaryField]: `Résumé ${i}` } : {}) }));

    await t("upsertCmsItems : champ inconnu refusé", async () => {
      try {
        await upsertCmsItems({ siteId: SITE, collectionId: colId, items: [{ name: "x", slug: "x", champInexistant: 1 }] });
        throw new Error("aurait dû refuser");
      } catch (e) { assert(/Champs inconnus/.test((e as Error).message), (e as Error).message); }
      return "refus OK";
    });

    await t("upsertCmsItems dryRun (3 créations)", async () => {
      const r = await upsertCmsItems({ siteId: SITE, collectionId: colId, items });
      assert(r.create === 3 && r.update === 0, JSON.stringify(r).slice(0, 200));
      return { create: r.create, size: size(r) };
    });

    if (canWrite) {
      await t("upsertCmsItems écriture (3 créations)", async () => {
        const r = await upsertCmsItems({ siteId: SITE, collectionId: colId, items, dryRun: false });
        assert(r.written === 3, JSON.stringify(r).slice(0, 300));
        return { written: r.written };
      });
      await t("upsertCmsItems rejoué : inchangé", async () => {
        const r = await upsertCmsItems({ siteId: SITE, collectionId: colId, items });
        assert(r.unchanged === 3 && r.create === 0 && r.update === 0, JSON.stringify(r).slice(0, 300));
        return { unchanged: r.unchanged };
      });
      await t("upsertCmsItems mise à jour d'un item + publication", async () => {
        const changed = [{ ...items[0], name: `${items[0].name} modifié` }];
        const dry = await upsertCmsItems({ siteId: SITE, collectionId: colId, items: changed });
        assert(dry.update === 1, JSON.stringify(dry).slice(0, 300));
        const r = await upsertCmsItems({ siteId: SITE, collectionId: colId, items: changed, dryRun: false, publish: true });
        assert(r.written === 1 && r.published === 1, JSON.stringify(r).slice(0, 300));
        return { update: r.update, written: r.written, published: r.published, diff: dry.diff };
      });
      await t("listCmsItems (filtre + champs)", async () => {
        const r = await listCmsItems(colId, { fields: ["name"], where: (fd) => String(fd.slug).startsWith(`test-${stamp}`) });
        assert(r.matched === 3, `matched=${r.matched}`);
        return { total: r.total, matched: r.matched, size: size(r) };
      });
      await t("nettoyage des items de test", async () => {
        const all = await listCmsItems(colId, { fields: ["slug"], max: 1000, where: (fd) => String(fd.slug).startsWith("test-") });
        await api.itemsDelete(colId, all.items.map((it) => String(it.id)));
        return { deleted: all.items.length };
      });
    }
  }

  await t("publish dryRun", async () => {
    const r = await publish(SITE);
    assert(r.dryRun === true, "dryRun attendu");
    return r;
  });
  await t("publish refuse un domaine personnalisé sans autorisation", async () => {
    try { await publish(SITE, { dryRun: false, customDomains: ["example.com"] }); throw new Error("aurait dû refuser"); }
    catch (e) { assert(/domaine personnalisé refusée/.test((e as Error).message), (e as Error).message); }
    return "refus OK";
  });
  if (canWrite) await t("publish webflow.io", async () => publish(SITE, { dryRun: false }));

  // V2: Designer tools, hosted MCP only.
  if (api.backend() === "hosted") {
    const pages = (await listPages(SITE)).pages.filter((p: any) => !p.cmsTemplate && !p.draft);
    let target: { siteId: string; pageId: string } | undefined;
    let inst: { id: string; prop: string; value: string } | undefined;
    await t("findElements / tree", async () => {
      let nodes = 0;
      for (const p of pages) {
        const ref = { siteId: SITE, pageId: p.id };
        const f = await findElements(ref, { type: "ComponentInstance" }, { max: 200 });
        nodes += f.nodes;
        if (!inst) {
          for (const it of f.items) {
            const node = (function find(n: any): any { return n.id.element === it.id ? n : (n.children ?? []).map(find).find(Boolean); })(await loadTree(ref));
            const def = (await getComponentDefs(ref, [node.instanceDetails.id])).get(node.instanceDetails.id)!;
            const pd = def.props.find((x) => x.type === "textContent");
            const cur = node.instanceDetails.props?.find((x: any) => x.propId === pd?.id)?.value;
            if (pd && typeof cur === "string") { target = ref; inst = { id: it.id, prop: pd.name, value: cur }; break; }
          }
        }
        if (inst) break;
      }
      assert(target, "aucune instance avec une prop texte sur les pages statiques");
      const tr = await tree(target!, { depth: 2 });
      assert(tr.lines.length > 0, "plan vide");
      return { nodesScanned: nodes, treeLines: tr.lines.length, size: size(tr) };
    });
    if (target && inst) {
      await t("setInstanceProps dryRun, écriture, restauration", async () => {
        const marker = `Kit test ${Date.now().toString(36)}`;
        const dry = await setInstanceProps(target!, [{ instance: inst!.id, props: { [inst!.prop]: marker } }]);
        assert(dry.dryRun === true && dry.instances === 1, JSON.stringify(dry).slice(0, 200));
        if (!canWrite) return { dryRun: dry.instances };
        const w = await setInstanceProps(target!, [{ instance: inst!.id, props: { [inst!.prop]: marker } }], { dryRun: false });
        assert(w.written === 1, JSON.stringify(w).slice(0, 300));
        const again = await setInstanceProps(target!, [{ instance: inst!.id, props: { [inst!.prop]: marker } }]);
        assert(again.unchanged === 1, "relecture : la valeur devrait être déjà en place");
        await setInstanceProps(target!, [{ instance: inst!.id, props: { [inst!.prop]: inst!.value } }], { dryRun: false });
        const back = await setInstanceProps(target!, [{ instance: inst!.id, props: { [inst!.prop]: inst!.value } }]);
        assert(back.unchanged === 1, "restauration non vérifiée");
        return { written: w.written, restored: true };
      });
      await t("setInstanceProps : prop inconnue refusée", async () => {
        try { await setInstanceProps(target!, [{ instance: inst!.id, props: { PropInexistante: "x" } }]); throw new Error("aurait dû refuser"); }
        catch (e) { assert(/n'a pas de prop/.test((e as Error).message), (e as Error).message); }
        return "refus OK";
      });
    }
    if (canWrite) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(".cache", { recursive: true });
      const png = `.cache/kit-test-${Date.now().toString(36)}.png`;
      writeFileSync(png, randomPng());
      let assetId = "";
      await t("uploadAssets : envoi, réutilisation, suppression", async () => {
        const dry = await uploadAssets(SITE, [{ file: png, alt: "Test kit" }]);
        assert((dry as any).upload === 1, JSON.stringify(dry).slice(0, 200));
        const w = await uploadAssets(SITE, [{ file: png, alt: "Test kit" }], { dryRun: false });
        const it = w.items[0] as any;
        assert(!it.preexisting, "fichier aléatoire vu comme préexistant");
        assetId = it.id;
        const head = await fetch(it.url, { method: "HEAD" });
        const again = await uploadAssets(SITE, [{ file: png, alt: "Test kit" }]);
        assert((again as any).reuse === 1, "le second passage devrait réutiliser l'asset");
        return { s3: head.status, url: it.url.startsWith("https://s3.amazonaws.com/") };
      });
      if (assetId) await h.dataAssetsTool.deleteAsset({ asset_id: assetId } as any);

      const styles = [
        { name: "kit-test_box", props: { "padding-left": { var: "Spacers - Padding/global" }, "border-radius": "8px" }, breakpoints: { small: { display: "block" } }, pseudos: { hover: { opacity: "0.8" } } },
        { name: "is-kit-dark", parent: ["kit-test_box"], props: { "border-radius": "0px" } },
      ];
      await t("ensureStyles : création, rejeu inchangé, mise à jour", async () => {
        const w = await ensureStyles(SITE, styles as any, { dryRun: false });
        assert(!(w as any).errors, JSON.stringify((w as any).errors));
        const again = await ensureStyles(SITE, styles as any);
        assert(again.styles === 0, `rejeu : ${JSON.stringify(again.diff).slice(0, 200)}`);
        const up = await ensureStyles(SITE, [{ name: "kit-test_box", props: { "border-radius": "12px", "padding-left": null } }], { dryRun: false });
        const check = await ensureStyles(SITE, [{ name: "kit-test_box", props: { "border-radius": "12px", "padding-left": null } }]);
        assert(check.styles === 0, "mise à jour non vérifiée");
        return { created: (w as any).actions, updated: (up as any).actions };
      });

      // Section inserted into the lightest static page, settings applied to it, then everything deleted.
      let host = { siteId: SITE, pageId: "", nodes: Infinity };
      for (const p of pages) {
        const f = await findElements({ siteId: SITE, pageId: p.id }, { type: "Body" });
        if (f.nodes < host.nodes) host = { siteId: SITE, pageId: p.id, nodes: f.nodes };
      }
      const ref = { siteId: SITE, pageId: host.pageId };
      const inserted: string[] = [];
      await t("insertSection : contrôles, insertion, relecture", async () => {
        let refused = "";
        try { await insertSection(ref, { target: (await loadTree(ref)).id.element, html: "<div class='x'></div>", css: ".a .b { color: red; }" }); } catch (e) { refused = (e as Error).message; }
        assert(/Sélecteurs refusés/.test(refused), "sélecteur descendant non refusé");
        const html = `<section class="kit-test_section" data-kit="1"><div class="kit-test_inner"><h2 class="kit-test_title">Test</h2></div></section>`;
        const w: any = await insertSection(ref, { target: (await loadTree(ref)).id.element, html, css: ".kit-test_section { padding-top: 2rem; }", dryRun: false });
        inserted.push(...(w.inserted ?? []).map((x: any) => x.id));
        assert(inserted.length === 1 && !(w as any).lostClasses && !(w as any).lostDataAttributes, JSON.stringify(w).slice(0, 300));
        return { elements: (w as any).elements, emptyRulesAdded: (w as any).emptyRulesAdded };
      });
      if (inserted.length) {
        await t("setSettings : attributs data-* écrits et relus", async () => {
          const w = await setSettings(ref, [{ element: inserted[0], settings: { attributes: { "data-kit": "2", "data-kit-extra": "x" } } }], { dryRun: false });
          assert(w.written === 1 && !(w as any).notApplied, JSON.stringify(w).slice(0, 300));
          const g = await getSettings(ref, inserted[0], { keys: ["attributes"] });
          return g.settings;
        });
        await t("removeElements : section de test supprimée", async () => {
          const r: any = await removeElements(ref, inserted, { dryRun: false });
          const left = await findElements(ref, { class: "kit-test_" }, { refresh: true });
          assert(left.matched === 0, "éléments de test restants");
          return { removed: r.removed };
        });
      }
      // Cleanup of the test classes (combos first).
      const cls = (await findClasses(SITE, "kit-test", { refresh: true, max: 50 })).items;
      const isCombo = (c: any) => c.type === "combo";
      const actions = [...cls.filter(isCombo), ...cls.filter((c) => !isCombo(c))].map((c) => ({
        label: c.name,
        remove_style: { style_name: c.name, ...(isCombo(c) ? { parent_style_names: (c.selector ?? "").split(".").filter(Boolean).slice(0, -1) } : {}) },
      }));
      if (actions.length) {
        const r = hostedResults(await h.dataStyleTool.call({ siteId: SITE, pageId: host.pageId, actions } as any));
        await t("nettoyage des classes et assets de test", async () => {
          const bad = r.filter((x) => !x.ok);
          assert(!bad.length, JSON.stringify(bad).slice(0, 200));
          const assetsLeft = (await listAssets(SITE, { query: "kit-test" })).matched;
          return { classesRemoved: r.length, assetsLeft };
        });
      }
    }
    await t("getDesignSystem + recherches", async () => {
      const s = await getDesignSystem(SITE, { refresh: true });
      const v = await findVariables(SITE, "", { max: 1 });
      const c = await findClasses(SITE, "", { max: 1 });
      const k = await findComponents(SITE, "", { max: 1 });
      return { collections: s.collections.length, variables: v.matched, classes: c.matched, components: k.matched, size: size(s) };
    });
  }
} catch (e) {
  results.push({ test: "préalable", ok: false, info: (e as Error).message });
} finally {
  await Promise.all([close(), closeHosted()]);
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.test}  ${r.info === undefined ? "" : JSON.stringify(r.info).slice(0, 220)}`);
console.log(`[${api.backend()}] ${results.filter((r) => r.ok).length}/${results.length} OK, ${getCallCount() + getHostedCallCount()} appels MCP`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
