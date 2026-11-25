---
name: mcp-code-mode-webflow-figma
description: Lire une maquette Figma et lire ou modifier un site Webflow par script, sans faire entrer les réponses brutes des MCP dans le contexte — fiche compacte d'une section Figma (structure, variables, textes, assets), plan d'une page Figma, variables Figma rapprochées de celles du site, téléchargement des images et SVG ; trouver des éléments et leurs ids, plan d'une page, insérer une section HTML + CSS, créer ou modifier des classes, envoyer des images, réglages et attributs d'éléments, code d'embed, props d'instances, design system (variables, classes, composants), items CMS, title / meta descriptions, publication webflow.io. À utiliser pour tout travail Webflow par le MCP — chercher un élément, poser une section, ajuster une classe, uploader un asset, régler des props, importer du CMS, auditer le SEO, publier — plutôt que d'appeler les outils MCP Webflow un par un.
---

# mcp-code-mode-webflow-figma

Dépôt : `~/orca/projects/mcp-code-mode-webflow-figma`. Une réponse brute du MCP Webflow (arbre d'une page, styles,
liste d'items CMS) fait souvent des dizaines de milliers de caractères et reste dans votre contexte jusqu'à la fin. Avec la lib, vous
écrivez un court script, il appelle le MCP, filtre, et n'affiche qu'un résumé.

## Quand l'utiliser

| Besoin | Lib | MCP direct |
|---|:---:|:---:|
| Lister, filtrer, compter des items CMS | ✓ | |
| Créer ou mettre à jour des items CMS (import, correction en masse) | ✓ | |
| Schéma d'une collection | ✓ | |
| Lister les pages, auditer le SEO, corriger title / description / Open Graph | ✓ | |
| Publier sur le sous-domaine webflow.io | ✓ | |
| Trouver des éléments, plan d'une page, ids à passer aux outils | ✓ | |
| Régler des props d'instances par nom | ✓ | |
| Variables, classes, composants disponibles (lecture) | ✓ | |
| Insérer une section HTML + CSS (WHTML), supprimer des éléments | ✓ | |
| Créer ou modifier des classes (variables, breakpoints, états, modes) | ✓ | |
| Envoyer des images (fichier local ou URL) avec texte alternatif | ✓ | |
| Réglages d'éléments, attributs data-*, ajout dans un embed | ✓ | |
| Construire des composants, variables, interactions, polices, formulaires | | ✓ (pas dans la lib) |

## Écrire un script

1. Créer un fichier dans `scratch/` (non versionné), par ex. `scratch/import-temoignages.ts`.
2. Importer depuis `../src/kit/index.js` et terminer par `await run(() => …)`.
3. Lancer depuis la racine du dépôt : `npx tsx scratch/import-temoignages.ts`.
4. Lire la sortie : une ligne JSON (plafonnée à 4 000 caractères, avec la mention `[tronqué …]` si besoin) puis
   `[mcp] N appel(s)`. En erreur : `{"error": …, "message": …}` sur une ligne.

La lib passe par le MCP hébergé (OAuth). Si un script répond « Autorisation Webflow requise », ou si le site visé
n'apparaît pas (`getSite()` sans argument liste les sites autorisés), demander à l'utilisateur de lancer
`npm run hosted-login` dans le dépôt et de cocher le site. Le serveur local avec token (`WEBFLOW_BACKEND=local`,
`WEBFLOW_TOKEN`) ne couvre que CMS, pages et publication. Ne jamais écrire un token dans un script, un commit ou un
message.

Ne jamais faire `console.log` d'une réponse de `src/generated/` : c'est exactement ce que la lib évite. Si une donnée
manque dans un résumé, filtrer dans le script et n'afficher que le champ utile.

## Sécurité

- **dryRun par défaut** : toute fonction qui écrit renvoie d'abord le diff de ce qui changerait. Relire le diff, puis
  relancer avec `dryRun: false`.
- **Allowlist** : l'écriture réelle est refusée si le site n'est pas dans `WEBFLOW_WRITE_ALLOWED_SITES`
  (`Écriture refusée : …`). Ne pas modifier cette variable pour contourner le refus : demander.
- **Publication** : sous-domaine webflow.io seulement. Un domaine personnalisé exige `allowCustomDomains: true`, qui
  n'est à passer que sur décision explicite du client.
- Les fonctions vérifient que la collection ou la page appartient bien au site passé en `siteId` avant d'écrire.

## Fonctions

### `getSite(siteId?)`
Site en compact (nom, sous-domaine, domaines, dernière publication). Sans argument ni `WEBFLOW_SANDBOX_SITE_ID` :
liste des sites visibles avec le token.
```ts
await run(() => getSite("6af6…"));
// {"id":"6af6…","name":"Bac à sable","shortName":"bac-a-sable","customDomains":[],"lastPublished":"…"}
```

### `listCollections(siteId)`
```ts
await run(() => listCollections(siteId));   // [{"id":"…","name":"Témoignages","slug":"temoignages"}]
```

### `getCollectionSchema(collectionId)`
Champs avec slug, nom, type, obligatoire. À lire avant un import pour connaître les slugs exacts.
```ts
await run(() => getCollectionSchema(colId));
// {"id":"…","name":"Témoignages","slug":"temoignages","fields":[{"slug":"name","name":"Name","type":"PlainText","required":true},…]}
```

### `listCmsItems(collectionId, { fields?, where?, max?, maxValueLength? })`
Pagination interne ; ne renvoie que `id` et les champs demandés (défaut : name, slug), 50 items au plus par défaut,
valeurs coupées à 120 caractères. `where` filtre côté script sur le `fieldData` complet.
```ts
await run(() => listCmsItems(colId, { fields: ["name", "note"], where: (fd) => !fd.photo, max: 20 }));
// {"total":42,"matched":3,"items":[{"id":"…","name":"Sophie M.","note":5},…]}
```

### `upsertCmsItems({ siteId, collectionId, items, matchBy?, publish?, dryRun?, maxDiff? })`
Crée ou met à jour par `slug` (ou `matchBy`). `items` = fieldData à plat avec les slugs Webflow. Refuse avant toute
écriture : champ inconnu, clé manquante ou en double, champ obligatoire absent à la création. N'envoie que les champs
qui changent. `publish: true` publie les items créés ou modifiés.
```ts
const items = [{ name: "Sophie M.", slug: "sophie-m", note: 5 }];
await run(() => upsertCmsItems({ siteId, collectionId: colId, items }));                 // diff seulement
await run(() => upsertCmsItems({ siteId, collectionId: colId, items, dryRun: false }));  // écriture
// {"dryRun":false,"collection":"temoignages","create":1,"update":0,"unchanged":0,"diff":[…],"written":1}
```
Les champs image, référence et texte riche sont comparés tels que Webflow les renvoie (objet image, id, HTML) :
passer la même forme pour éviter des mises à jour inutiles.

### `listPages(siteId, { includeArchived?, max? })`
```ts
await run(() => listPages(siteId));   // {"total":12,"pages":[{"id":"…","path":"/contact","title":"Contact"},…]}
```

### `auditPageSeo({ siteId } | { pageId }, { rules?, max? })`
Ne renvoie que les problèmes : title vide, trop long ou trop court, meta description vide, trop longue ou trop courte,
Open Graph vide et non copié, titles en double (pages statiques). Seuils dans `SEO_RULES` (60 / 15 / 160 / 50),
modifiables par `rules`. Les pages archivées et brouillons sont ignorées.
```ts
await run(() => auditPageSeo({ siteId }));
// {"pagesAudited":12,"issues":2,"list":[{"page":"…","path":"/contact","issue":"meta description vide"},…]}
```

### `updatePagesSeo(siteId, updates, { dryRun?, maxDiff? })`
`updates` : `[{ pageId, title?, description?, ogTitle?, ogDescription?, ogCopy? }]`. N'écrit que ce qui change ;
`ogCopy: true` coche « identique au SEO » pour Open Graph.
```ts
await run(() => updatePagesSeo(siteId, [{ pageId, description: "…", ogCopy: true }]));
```

### `publish(siteId, { dryRun?, customDomains?, allowCustomDomains? })`
Publie sur `<shortName>.webflow.io`. Attend si la lib a publié ce site il y a moins d'une minute (limite Webflow :
une publication par minute).
```ts
await run(() => publish(siteId, { dryRun: false }));
```

### `findElements({ siteId, pageId }, filtre, { max?, maxText?, pathDepth? })`
Un seul `get_all_elements` par page et par script (en cache), filtré dans le script. Filtre : `type`, `tag` (h1…h6,
section…), `class` (sous-chaîne) ou `classExact`, `text`, `attribute: { name, value? }`, `component` (nom d'instance),
`within` (sous-chaîne du chemin), `where` (fonction). Les String sont exclus sauf `type: "String"`.
```ts
await run(() => findElements(page, { tag: "h2", within: "section_hero" }));
// {"page":"…","component":"…","nodes":906,"matched":1,"items":[{"id":"32ea…","el":"h2.heading-style-h2","text":"Titre","children":1,"path":"main.main-wrapper > section.section_hero > div.container"}]}
```
`elementId(résultat, item)` donne l'id composite `{component, element}` attendu par les outils du MCP.

### `tree({ siteId, pageId }, { depth?, from?, maxLines?, ids? })`
Plan indenté de la page (`h2.heading "Titre" #id`, `«Navbar» #id`, `slot:vflex`). `from` : id ou classe exacte.
```ts
await run(() => tree(page, { depth: 3, from: "section_faq" }));
```

### `setInstanceProps({ siteId, pageId }, [{ instance, props: { NomDeProp: valeur } }], { dryRun? })`
Par nom de prop, type déduit de la définition : texte, texte riche (chaîne), nombre, booléen / visibilité, lien (URL,
`mailto:`, `tel:` ; lien vers une page Webflow impossible par le MCP), vidéo, variante (id de variante en chaîne).
Autres types : passer l'objet brut `{type, …}`. N'écrit que ce qui change, lots de 10.
```ts
await run(() => setInstanceProps(page, [{ instance: "8011…", props: { Question: "…", Answer: "…" } }]));  // diff
```

### `getDesignSystem(siteId)`, `findVariables(siteId, q)`, `findClasses(siteId, q)`, `findComponents(siteId, q)`
Lecture unique (5 appels), cache `.cache/ds-<site>.json` 30 min (`refresh: true` pour relire). `getDesignSystem` :
collections et nombre de variables, classes par type, composants et leurs props. Les `find*` cherchent une sous-chaîne
(ou une regex) dans le nom.
```ts
await run(() => findVariables(siteId, "padding"));
// {"matched":1,"items":[{"id":"variable-593f…","name":"Spacers - Padding/global","collection":"General","type":"Size","cssName":"--spacers-padding--global","value":"3rem","modes":{"Mobile":"1rem"}}]}
```

### `insertSection({ siteId, pageId }, { target, position?, html, css?, uploadImages?, dryRun? })`
`target` : id d'élément ou classe exacte ; `position` : append (défaut), prepend, before, after. Avant l'appel : refuse
les sélecteurs CSS descendants (`.a .b` fait échouer toute la section ; une classe ou un combo `.a.is-b` par règle),
réécrit les `src` `cdn.prod…` au format S3, envoie les images listées dans `uploadImages` (`{ "chemin/ou/url": "alt" }`),
signale les attributs non `data-*` (jetés par Webflow) et ajoute une règle vide pour chaque classe nouvelle sans CSS
(sinon Webflow ne la crée pas). Après : relit la page et liste `lostClasses`, `lostDataAttributes`, `unlinkedImages`.
Pas d'insertion à côté d'une instance de composant (viser un voisin ou le parent).
```ts
await run(() => insertSection(page, { target: "main-wrapper", html, css }));                 // contrôles + plan
await run(() => insertSection(page, { target: "main-wrapper", html, css, dryRun: false }));  // {"inserted":[{"id":"…","el":"section.x_section"}],"elements":12}
```
`removeElements(page, [ids], { dryRun })` supprime des éléments (et leurs descendants).

### `ensureStyles(siteId, [{ name, parent?, props?, breakpoints?, pseudos?, modes? }], { dryRun? })`
Crée la classe si absente, sinon ne met à jour que ce qui diffère. Valeur : `"2rem"`, `{ var: "Nom/variable" }` ou
`"var(--nom-css)"` (résolue par nom ; variable inconnue → erreur avec des noms proches), `null` pour retirer.
`parent` pour un combo, `breakpoints: { medium, small, tiny }`, `pseudos: { hover }`, `modes: { "Color modes": "Dark" }`.
```ts
await run(() => ensureStyles(siteId, [{ name: "x_section", props: { "padding-top": { var: "Spacers/section-large" } }, breakpoints: { small: { "padding-top": "3rem" } } }]));
```

### `uploadAssets(siteId, [{ file, alt?, name?, folderId? }], { dryRun? })`
`file` : chemin local ou URL publique (téléchargée par le script). Réutilise un asset de même nom. Renvoie l'id et
l'URL S3 (celle à mettre dans un `<img>` de WHTML). `preexisting: true` = fichier identique déjà présent sous un autre
nom : asset existant, non modifié — **ne jamais le supprimer**. `listAssets(siteId, { query })` pour chercher.

### `getSettings(page, el, { keys? })`, `setSettings(page, [{ element, settings }], { dryRun? })`, `appendToEmbed(page, el, code, { dryRun? })`
Réglages d'un élément (domId, tag, attributes, visibility, code…). `setSettings` : chaîne, nombre, booléen,
`{ mode, to }` pour un lien, `attributes: { "data-x": "1" }` (remplace toute la liste ; seuls les `data-*` sont
fiables), `null` ou `""` pour vider. Relit après écriture : `notApplied` liste ce que Webflow n'a pas pris.
`appendToEmbed` ajoute du code à la fin d'un embed sans le recopier, puis vérifie le contenu relu à l'octet près.

### Construire un site complet (ajouts du test Client E)

| Besoin | Fonction |
|---|---|
| Polices personnalisées | `uploadFonts(siteId, [{ file, family, weight }])` |
| Variables (création, modes, renommage, alias par nom) | `ensureVariables(siteId, [{ collection, name, type, value, modes?, from? }])`, `ensureVariableMode`, `variableUsage`, `deleteVariables` (refuse si utilisée) |
| Classes : renommer, lire, supprimer | `renameStyles` (chaînes a → b puis c → a rejouables), `readStyles` (variables par nom), `removeStyles` |
| Styles d'une variante de composant | `ensureVariantStyles([{ component, variant, style, props, breakpoint?, pseudo? }])` |
| Textes et classes d'éléments existants | `setTexts`, `setClasses` (crée la classe de base si absente) |
| Construire dans une définition de composant, embeds, images | `buildElements(page, { parent, schema })` (classes reposées et créées si besoin) |
| Poser des instances, détacher | `insertComponents`, `detachInstances` |
| Transformer en composant avec props reliées | `componentize(page, { element, name, group, props: [{ name, type, bind, default }] })`, `createVariants`, `setPropDefaults` |
| Scripts du site (librairies, code de tête) | `ensureSiteScripts(siteId, [{ name, version, location, url | code }])` |
| Code d'un embed | `setEmbed(page, el, code)` : `var(--dt:Nom de variable)` résolu, relecture exacte |
| Liens WHTML | corrigés automatiquement par `insertSection` (`fixLinkAttributes`) |

Pièges vus en conditions réelles (détail dans `reports/dogfood.md` et `reports/quirks.md`) : une seule racine par
insertion WHTML (la lib découpe), props image et lien sans valeur par défaut (la lib les pose), classe absente =
élément sans classe sans erreur (la lib crée la classe), `href` en double (la lib corrige), erreurs dans `result`.

Après une écriture faite hors de la lib dans le même script, appeler `invalidateTree(page)` avant de relire.

### Lire une maquette Figma (module `src/figma`)

Le MCP Figma renvoie des réponses énormes : sur Client E, une section avec un motif vectoriel pèse 1,3 M caractères,
la home entière 4,6 M. Le module les garde dans le script et en cache disque (`.cache/figma/<fichier>/`, 24 h :
relire un nœud ne coûte aucun appel).

Prérequis : **l'application Figma ouverte, le fichier en onglet actif, serveur MCP activé** (serveur local
`127.0.0.1:3845`, sans autorisation). Le serveur distant refuse l'enregistrement de la lib (403). Ouvrir le fichier
dans l'application : `open -a Figma "<lien figma>"`.

| Besoin | Fonction |
|---|---|
| Lien → référence | `figmaRef(url)` → `{ fileKey, nodeId }` |
| Plan d'une section (motifs repliés en une ligne) | `figmaOutline(ref, { depth? })` |
| Fiche à intégrer : structure, classes réduites, variables par nom, textes, assets | `figmaSpec(ref, { maxLines? })` : découpe seule un nœud trop lourd ; les motifs deviennent des « graphiques à exporter » |
| Variables Figma ↔ variables Webflow (même valeur, espacement ≠ taille de police) | `figmaTokens(ref, { siteId })` → `matched`, `unmatched`, `styles` |
| Images et SVG prêts pour Webflow | `figmaAssets(spec.assets, { dir })` : redimensionnées pour couvrir la taille du cadre Figma × 3 (× 1,5 si affichage ≥ 1200 px), jamais agrandies, converties en AVIF (`sips`, alpha conservé) ; SVG nettoyés ; intégrité vérifiée. Options : `scale`, `fullWidthScale`, `format` (`avif` / `jpeg` / `webp`), `quality`, `optimize: false` pour les fichiers bruts |
| Capture | `figmaScreenshot(ref)` → chemin du PNG (à ouvrir avec Read seulement si besoin) |
| Sections d'une page entière (API REST, `FIGMA_TOKEN`) | `figmaSections(fileKey, pageNodeId)` ; `figmaOutline` et `figmaSpec` s'en servent seuls sur un cadre de page |
| Commentaires d'une section (API REST) | `figmaComments(fileKey, sectionId, { includeResolved? })` : fils et réponses dont l'épingle tombe dans la zone de la section ; `orphans` compte les fils épinglés sur un nœud supprimé, à lire avec `figmaOrphanComments(fileKey)` (souvent une ancienne version de la page : à vérifier avant d'intégrer) |
| Exporter un motif vectoriel ou un nœud (API REST) | `figmaExport(fileKey, ids, { dir, format: "svg" \| "png" \| "jpg", scale? })` |

Une page entière (cadre de 10 000 px) revient **sans ses enfants** par le serveur local : avec `FIGMA_TOKEN`
(jeton personnel en lecture, dans `.env`), le module lit ses sections par l'API REST ; sans lui, passer les sections
une par une. Ouvrir chaque image finale
avec Read avant `uploadAssets` (convertir d'abord en JPEG réduit : `sips -Z 600 -s format jpeg x.avif --out x.jpg`).
Une image affichée avec un cadrage décalé dans Figma (`top-[-33%]`…) est recadrée en `object-fit: cover` centré :
vérifier le rendu.

### Un projet = une autorisation Webflow

Depuis le dossier du projet (celui qui porte `.mcp.json`), passer par le lanceur :

```bash
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit login          # écran Webflow : choix du workspace et des sites
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit sites          # sites autorisés pour ce projet
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit scratch/x.ts   # exécuter un script pour ce projet
```

Chaque projet a son propre client OAuth, ses jetons (`.cache/projects/<clé>/` de la lib, jamais dans le dépôt du
projet) et ses sessions. La clé est le nom du serveur Webflow de `.mcp.json` (`webflow-client-e`). Sans le lanceur
(script lancé depuis la lib), c'est l'autorisation « default » de la lib, réservée au bac à sable. L'écriture reste
limitée aux sites de `WEBFLOW_WRITE_ALLOWED_SITES` (`.env` de la lib) : y ajouter le site du projet est une
décision humaine.

### Agents en parallèle

Chaque script est un processus avec **sa propre connexion MCP et sa propre session Webflow** (`session_id`
émis par Webflow, `agent_id` aléatoire, ou `WEBFLOW_AGENT_ID=agent-hero` pour le nommer). Plusieurs agents peuvent
lancer des scripts en même temps sur le même dépôt (vérifié : 5 processus simultanés, 5 sessions distinctes).

- Jetons OAuth : un seul processus à la fois les rafraîchit (verrou `.cache/locks/`), les autres relisent le jeton neuf.
- Cache du design system partagé, écrit de façon atomique ; une écriture d'un agent périme la partie concernée pour
  tous (une invalidation l'emporte sur une lecture concurrente).
- Arbre de page : en mémoire, propre à chaque script (60 s). **Un agent par page** (ou par section bien séparée).
- Limite de débit Webflow partagée : plus d'agents = plus de 429 (la lib réessaie jusqu'à 60 s).
- Figma (serveur local) : une seule application, un seul onglet actif. Plusieurs agents sur le **même** fichier,
  oui ; sur des fichiers différents, non. Le cache disque Figma est partagé : un nœud lu par un agent est gratuit
  pour les autres.


## En cas d'erreur

- `Autorisation Webflow requise` : l'utilisateur lance `npm run hosted-login`.
- `404` sur un site : le site n'a pas été coché à l'autorisation (relancer `hosted-login`).
- `Too Many Requests` : la lib réessaie seule jusqu'à 60 s ; au-delà, attendre une minute.
- Serveur local : `WEBFLOW_TOKEN manquant` (remplir `.env`), `HTTP 401` / `403` (token invalide ou sans scope).
- Comportement contraire au schéma : le consigner dans `reports/quirks.md` (date, outil, attendu, réel, contournement).
