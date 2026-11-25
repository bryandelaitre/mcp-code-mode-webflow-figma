/**
 * Benchmark on the sandbox, hosted MCP: the same workflow done (1) like an agent making direct MCP calls, where
 * every raw response enters its context, and (2) with the library, where only the output of report() enters it.
 *
 * Usage: npm run bench   (requires WEBFLOW_SANDBOX_SITE_ID and npm run hosted-login; writes require the site to be
 * in WEBFLOW_WRITE_ALLOWED_SITES). Writes reports/benchmark.md.
 * Measures: actual MCP calls; characters entering the context (responses) and written by the agent (arguments,
 * including the session_id / agent_id / context required on every call, or the script); tokens estimated as
 * characters / 4.
 */
import { writeFileSync } from "node:fs";
import * as h from "../src/generated/hosted/tools.js";
import { closeHosted, getHostedCallCount, getHostedSession, type HostedResponse } from "../src/lib/hosted.js";
import * as api from "../src/kit/api.js";
import {
  auditPageSeo, upsertCmsItems, listCollections, listPages, findElements, setInstanceProps, getDesignSystem,
  findVariables, loadTree, getComponentDefs, uploadAssets, ensureStyles, insertSection, removeElements, findClasses, listAssets,
} from "../src/kit/index.js";
import { hostedResults } from "../src/kit/hosted-util.js";
import { randomPng } from "./test-utils.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

const SITE = process.env.WEBFLOW_SANDBOX_SITE_ID ?? "";
if (!SITE) throw new Error("WEBFLOW_SANDBOX_SITE_ID manquant");
const canWrite = (process.env.WEBFLOW_WRITE_ALLOWED_SITES ?? "").split(",").map((s) => s.trim()).includes(SITE);
const tok = (n: number) => Math.round(n / 4);
// What the agent writes on top of the arguments on every direct call to the hosted MCP.
const COMMON = JSON.stringify({ session_id: "ses_3MYnNZiqxK518hqxAZpzS2TuwZr", agent_id: getHostedSession().agentId, context: "Agent looks up page elements to update the section requested by the user, as part of the Webflow integration task." }).length;

interface Mesure { calls: number; ctxChars: number; agentChars: number }
const rows: { workflow: string; direct: Mesure; kit: Mesure }[] = [];

/** Direct mode: the agent sees every response and writes every set of arguments. */
async function direct(steps: Array<[unknown, () => Promise<HostedResponse>]>): Promise<Mesure> {
  const before = getHostedCallCount();
  let ctx = 0, agent = 0;
  for (const [args, run] of steps) {
    const r = await run();
    ctx += r.text.length;
    agent += JSON.stringify(args).length + COMMON;
  }
  return { calls: getHostedCallCount() - before, ctxChars: ctx, agentChars: agent };
}
/** Library mode: the agent writes a script (size measured) and only sees the output of report(). */
async function viaKit(script: string, fn: () => Promise<unknown>): Promise<Mesure> {
  const before = getHostedCallCount();
  const out = JSON.stringify(await fn());
  return { calls: getHostedCallCount() - before, ctxChars: out.length + 30, agentChars: script.length };
}
const head = `import { run } from "../src/kit/index.js";\n`;

try {
  const pages = (await listPages(SITE)).pages.filter((p: any) => !p.cmsTemplate && !p.draft);

  // 1. SEO audit.
  {
    const a = { site_id: SITE };
    const d = await direct([[a, () => h.dataPagesTool.listPages(a)]]);
    const k = await viaKit(`${head}await run(() => auditPageSeo({ siteId: "${SITE}" }));\n`, () => auditPageSeo({ siteId: SITE }));
    rows.push({ workflow: "Audit SEO de toutes les pages", direct: d, kit: k });
  }

  // 2. CMS import of 10 items.
  const colId = (await listCollections(SITE)).find((c: any) => c.slug === "kit-tests")?.id;
  if (colId && canWrite) {
    const stamp = Date.now().toString(36);
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `Bench ${stamp} ${i + 1}`, slug: `bench-${stamp}-${i + 1}` }));
    const a1 = { collection_id: colId }, a2 = { collection_id: colId, request: { limit: 100 } };
    const a3 = { collection_id: colId, request: { items: items.map((fd) => ({ isDraft: false, fieldData: fd })) } };
    const d = await direct([
      [a1, () => h.dataCmsTool.getCollectionDetails(a1)],
      [a2, () => h.dataCmsTool.listCollectionItems(a2)],
      [a3, () => h.dataCmsTool.createCollectionItems(a3 as any)],
    ]);
    const clean = async () => {
      const all = (await api.itemsList(colId, 100, 0)).items.filter((it) => String(it.fieldData?.slug).startsWith(`bench-${stamp}`));
      if (all.length) await api.itemsDelete(colId, all.map((it) => it.id));
    };
    await clean();
    const script = `${head}const items = ${JSON.stringify(items)};\nawait run(() => upsertCmsItems({ siteId: "${SITE}", collectionId: "${colId}", items, dryRun: false }));\n`;
    const k = await viaKit(script, () => upsertCmsItems({ siteId: SITE, collectionId: colId, items, dryRun: false }));
    await clean();
    rows.push({ workflow: "Import CMS de 10 items", direct: d, kit: k });
  }

  // 3. Find elements: the site's heaviest page (H2 headings), get_all_elements as agents used to do.
  let heaviest = { pageId: "", nodes: 0, slug: "" };
  const allStatic = (await listPages(SITE)).pages.filter((p: any) => !p.cmsTemplate);
  for (const p of allStatic) {
    const f = await findElements({ siteId: SITE, pageId: p.id }, { type: "Body" });
    if (f.nodes > heaviest.nodes) heaviest = { pageId: p.id, nodes: f.nodes, slug: p.path };
  }
  {
    const base = { siteId: SITE, pageId: heaviest.pageId };
    const a1 = { ...base, actions: [{ label: "h2", query_elements: { queries: [{ label: "h2", element_filter: { tag: "h2" }, limit: 50 }] } }] };
    const a2 = { ...base, actions: [{ label: "tree", get_all_elements: { depth: -1 } }] };
    // query_elements first (what an agent tries), then the full tree when it fails or is not enough.
    const d = await direct([
      [a1, () => h.dataElementTool.call(a1 as any)],
      [a2, () => h.dataElementTool.call(a2 as any)],
    ]);
    const k = await viaKit(
      `${head}await run(() => findElements({ siteId: "${SITE}", pageId: "${heaviest.pageId}" }, { tag: "h2" }));\n`,
      async () => { const r = { siteId: SITE, pageId: heaviest.pageId }; await loadTree(r, { refresh: true }); return findElements(r, { tag: "h2" }); },
    );
    rows.push({ workflow: `Trouver les titres H2 d'une page (${heaviest.slug}, ${heaviest.nodes} nœuds)`, direct: d, kit: k });
  }

  // 4. Design system: spacing variables, available classes and components.
  {
    const base = { siteId: SITE, pageId: pages[0].id };
    const vc = await h.dataVariableTool.getVariableCollections(base, { query: "all" });
    const cols: any[] = vc.results[0]?.result ?? [];
    const steps: Array<[unknown, () => Promise<HostedResponse>]> = [
      [{ ...base, query: "all" }, async () => vc],
      ...cols.map((c): [unknown, () => Promise<HostedResponse>] => {
        const a = { variable_collection_id: c.id, include_all_modes: true };
        return [{ ...base, ...a }, () => h.dataVariableTool.getVariables(base, a)];
      }),
      [{ ...base, query: "all" }, () => h.dataStyleTool.getStyles(base, { query: "all" })],
      [{ ...base, options: { includeProps: true } }, () => h.dataComponentTool.getAllComponents(base, { options: { includeProps: true } })],
    ];
    const d = await direct(steps);
    d.calls += 1; // get_variable_collections, called before the measurement
    const k = await viaKit(
      `${head}await run(async () => ({ ds: await getDesignSystem("${SITE}", { refresh: true }), spacing: await findVariables("${SITE}", "padding") }));\n`,
      async () => ({ ds: await getDesignSystem(SITE, { refresh: true }), spacing: await findVariables(SITE, "padding") }),
    );
    rows.push({ workflow: "Design system : variables, classes, composants", direct: d, kit: k });
  }

  // 5. Change a text prop of an instance (find the instance, learn the type, write), then restore.
  if (canWrite) {
    let target: { pageId: string; id: string; comp: string; prop: { id: string; name: string }; value: string; name: string } | undefined;
    for (const p of pages) {
      const ref = { siteId: SITE, pageId: p.id };
      const root = await loadTree(ref);
      const walk = (n: any): any[] => [n, ...(n.children ?? []).flatMap(walk)];
      for (const n of walk(root).filter((x) => x.type === "ComponentInstance")) {
        const def = (await getComponentDefs(ref, [n.instanceDetails.id])).get(n.instanceDetails.id)!;
        const text = new Set(def.props.filter((d) => d.type === "textContent").map((d) => d.id));
        const pr = (n.instanceDetails.props ?? []).find((x: any) => text.has(x.propId) && typeof x.value === "string");
        if (pr) { target = { pageId: p.id, id: n.id.element, comp: n.instanceDetails.id, prop: { id: pr.propId, name: pr.name }, value: pr.value, name: n.instanceDetails.name }; break; }
      }
      if (target) break;
    }
    if (target) {
      const base = { siteId: SITE, pageId: target.pageId };
      const marker = `Bench ${Date.now().toString(36)}`;
      const a1 = { ...base, actions: [{ label: "q", query_elements: { queries: [{ label: "q", component_filter: { component_name: target.name }, limit: 50 }] } }] };
      const a2 = { ...base, actions: [{ label: "c", get_component: { component_id: target.comp, options: { includeProps: true } } }] };
      const a3 = { ...base, actions: [{ label: "s", set_component_instance_prop_values: { element_id: { component: target.pageId, element: target.id }, values: [{ prop_id: target.prop.id, type: "string", string_value: marker }] } }] };
      const d = await direct([
        [a1, () => h.dataElementTool.call(a1 as any)],
        [a2, () => h.dataComponentTool.call(a2 as any)],
        [a3, () => h.dataComponentPropsTool.call(a3 as any)],
      ]);
      const ref = { siteId: SITE, pageId: target.pageId };
      await loadTree(ref, { refresh: true });
      const marker2 = `${marker} b`;
      const k = await viaKit(
        `${head}await run(() => setInstanceProps({ siteId: "${SITE}", pageId: "${target.pageId}" }, [{ instance: "${target.id}", props: { "${target.prop.name}": "${marker2}" } }], { dryRun: false }));\n`,
        async () => { await loadTree(ref, { refresh: true }); return setInstanceProps(ref, [{ instance: target!.id, props: { [target!.prop.name]: marker2 } }], { dryRun: false }); },
      );
      await setInstanceProps(ref, [{ instance: target.id, props: { [target.prop.name]: target.value } }], { dryRun: false });
      rows.push({ workflow: `Modifier une prop texte d'une instance (« ${target.name} »)`, direct: d, kit: k });
    }
  }
  if (canWrite) {
    // 6. Upload an image (local file) with its alt text.
    {
      mkdirSync(".cache", { recursive: true });
      const fa = `.cache/kit-bench-a-${Date.now().toString(36)}.png`, fb = `.cache/kit-bench-b-${Date.now().toString(36)}.png`;
      const pa = randomPng(), pb = randomPng();
      writeFileSync(fa, pa); writeFileSync(fb, pb);
      const a1 = { site_id: SITE, file_name: "kit-bench-a.png", file_hash: createHash("md5").update(pa).digest("hex") };
      let createdId = "";
      const d = await direct([
        [a1, async () => { const r = await h.dataAssetsTool.createAsset(a1); createdId = r.results[0]?.result?.id ?? ""; return r; }],
      ]);
      // The agent then posts to S3 (curl command with a dozen fields, ~900 characters written), then sets the alt.
      d.agentChars += 900;
      const a2 = { asset_id: createdId, alt_text: "Image de test" };
      const d2 = await direct([[a2, () => h.dataAssetsTool.updateAsset(a2)]]);
      const dd = { calls: d.calls + d2.calls, ctxChars: d.ctxChars + d2.ctxChars, agentChars: d.agentChars + d2.agentChars };
      const k = await viaKit(
        `${head}await run(() => uploadAssets("${SITE}", [{ file: "${fb}", name: "kit-bench-b.png", alt: "Image de test" }], { dryRun: false }));\n`,
        () => uploadAssets(SITE, [{ file: fb, name: "kit-bench-b.png", alt: "Image de test" }], { dryRun: false }),
      );
      for (const a of (await listAssets(SITE, { query: "kit-bench" }))._all.filter((x) => x.name.startsWith("kit-bench"))) await h.dataAssetsTool.deleteAsset({ asset_id: a.id } as any);
      if (createdId) await h.dataAssetsTool.deleteAsset({ asset_id: createdId } as any);
      rows.push({ workflow: "Envoyer une image avec son texte alternatif", direct: dd, kit: k });
    }

    // 7. Create a class with a variable, a breakpoint and a state.
    {
      const base = { siteId: SITE, pageId: pages[0].id };
      const general = (await h.dataVariableTool.getVariableCollections(base, { query: "all" })).results[0]?.result?.find((c: any) => c.name === "General");
      const a1 = { ...base, actions: [{ label: "q", query_styles: { queries: [{ label: "q", name_path: ["kit-bench_a"], include_properties: true }] } }] };
      const a2 = { ...base, actions: [{ label: "v", get_variables: { variable_collection_id: general?.id } }] };
      const v = (await findVariables(SITE, "Spacers - Padding/global")).items[0];
      const a3 = { ...base, actions: [
        { label: "c", create_style: { name: "kit-bench_a", properties: [{ property_name: "padding-left", variable_as_value: v.id }, { property_name: "border-radius", property_value: "8px" }] } },
        { label: "s", update_style: { style_name: "kit-bench_a", breakpoint_id: "small", properties: [{ property_name: "display", property_value: "block" }] } },
        { label: "h", update_style: { style_name: "kit-bench_a", pseudo: "hover", properties: [{ property_name: "opacity", property_value: "0.8" }] } },
      ] };
      const d = await direct([
        [a1, () => h.dataStyleTool.call(a1 as any)],
        [a2, () => h.dataVariableTool.call(a2 as any)],
        [a3, () => h.dataStyleTool.call(a3 as any)],
      ]);
      const spec = { name: "kit-bench_b", props: { "padding-left": { var: "Spacers - Padding/global" }, "border-radius": "8px" }, breakpoints: { small: { display: "block" } }, pseudos: { hover: { opacity: "0.8" } } };
      const k = await viaKit(
        `${head}await run(() => ensureStyles("${SITE}", [${JSON.stringify(spec)}], { dryRun: false }));\n`,
        () => ensureStyles(SITE, [spec as any], { dryRun: false }),
      );
      rows.push({ workflow: "Créer une classe (variable, breakpoint, survol)", direct: d, kit: k });
    }

    // 8. Insert an HTML + CSS section, then check what was placed.
    {
      let host = { pageId: "", nodes: Infinity };
      for (const p of pages) { const f = await findElements({ siteId: SITE, pageId: p.id }, { type: "Body" }); if (f.nodes < host.nodes) host = { pageId: p.id, nodes: f.nodes }; }
      const ref = { siteId: SITE, pageId: host.pageId };
      const body = (await loadTree(ref, { refresh: true })).id;
      const html = (x: string) => `<section class="kit-bench_${x}-section" data-kit="1"><div class="kit-bench_${x}-inner"><h2 class="kit-bench_${x}-title">Titre</h2><p class="kit-bench_${x}-text">Texte de la section.</p></div></section>`;
      const css = (x: string) => `.kit-bench_${x}-section { padding-top: 4rem; } .kit-bench_${x}-inner {} .kit-bench_${x}-title { margin-bottom: 1rem; } .kit-bench_${x}-text {}`;
      const a1 = { siteId: SITE, pageId: host.pageId, actions: [{ build_label: "s", parent_element_id: body, creation_position: "append", html: html("a"), css: css("a"), return_element_info: true }] };
      const a2 = { siteId: SITE, pageId: host.pageId, actions: [{ label: "t", get_all_elements: { depth: -1 } }] };
      const d = await direct([
        [a1, () => h.dataWhtmlBuilder(a1 as any)],
        [a2, () => h.dataElementTool.call(a2 as any)],
      ]);
      const k = await viaKit(
        `${head}await run(() => insertSection({ siteId: "${SITE}", pageId: "${host.pageId}" }, { target: "${body.element}", html: ${JSON.stringify(html("b"))}, css: ${JSON.stringify(css("b"))}, dryRun: false }));\n`,
        () => insertSection(ref, { target: body.element, html: html("b"), css: css("b"), dryRun: false }),
      );
      const left = await findElements(ref, { class: "kit-bench_" }, { refresh: true, max: 50 });
      const tops = left.items.filter((i) => i.el.startsWith("section."));
      if (tops.length) await removeElements(ref, tops.map((i) => i.id), { dryRun: false });
      rows.push({ workflow: "Insérer une section HTML + CSS et vérifier", direct: d, kit: k });
    }

    // Cleanup of the kit-bench_* classes.
    const cls = (await findClasses(SITE, "kit-bench", { refresh: true, max: 50 })).items;
    if (cls.length) hostedResults(await h.dataStyleTool.call({ siteId: SITE, pageId: pages[0].id, actions: cls.map((c) => ({ label: c.name, remove_style: { style_name: c.name } })) } as any));
  }
} finally {
  await closeHosted();
}

const line = (r: (typeof rows)[number]) => {
  const dT = tok(r.direct.ctxChars + r.direct.agentChars), kT = tok(r.kit.ctxChars + r.kit.agentChars);
  return `| ${r.workflow} | ${r.direct.calls} | ${r.kit.calls} | ${tok(r.direct.ctxChars)} | ${tok(r.kit.ctxChars)} | ${tok(r.direct.agentChars)} | ${tok(r.kit.agentChars)} | ${dT} | ${kT} | ${dT ? Math.round((1 - kT / dT) * 100) : 0} % |`;
};
const sum = (k: "direct" | "kit") => rows.reduce((a, r) => a + tok(r[k].ctxChars + r[k].agentChars), 0);
const md = `# Benchmark : appels MCP directs contre mcp-code-mode-webflow-figma

_Mesuré le ${new Date().toISOString().slice(0, 16).replace("T", " ")} sur le site bac à sable \`${SITE}\`, MCP hébergé (mcp.webflow.com)._

Méthode : le même workflow est exécuté deux fois. En direct, chaque réponse brute du MCP compte comme entrée dans le
contexte de l'agent, et chaque jeu d'arguments (avec session_id, agent_id et context, exigés à chaque appel) comme écrit
par lui. Avec la lib, l'agent écrit un script (taille réelle) et ne voit que la sortie de \`report()\`. Les appels MCP
sont comptés réellement ; les tokens sont estimés à caractères / 4. Non comptés : le raisonnement de l'agent entre les
appels et la relecture du contexte à chaque tour, qui amplifie l'écart (les réponses brutes restent dans le contexte
jusqu'à la fin de la session).

Le bac à sable est petit (14 pages, collections presque vides) : en direct, le coût croît avec la taille du site ;
avec la lib, la sortie est plafonnée (4 000 caractères par défaut).

| Workflow | Appels directs | Appels lib | Tokens en contexte (direct) | Tokens en contexte (lib) | Tokens écrits (direct) | Tokens écrits (lib) | Total direct | Total lib | Gain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.map(line).join("\n")}
| **Total** | | | | | | | **${sum("direct")}** | **${sum("kit")}** | **${Math.round((1 - sum("kit") / sum("direct")) * 100)} %** |
`;
writeFileSync("reports/benchmark.md", md);
console.log(md);
