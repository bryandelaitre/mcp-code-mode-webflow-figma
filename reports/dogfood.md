# Test grandeur nature : Client E sur le bac à sable

Intégration réelle (UI kit + homepage Client E) sur « bac à sable », uniquement par la lib, pour mesurer ce
qu'elle apporte et trouver ce qui lui manque. Statique seulement : ni animation, ni loader (consigne de Bryan).

## Phase 1 : styleguide (24/11/2026), terminé, en attente de validation

### Ce qui a été posé

- **Polices** : Feature Display 400, Instrument Sans 400 et 500, Chivo Mono 400 (fichiers de l'intégration Client E).
- **Palette** : 8 couleurs de marque (renommage des `Brand/abricot*` et `lilas*`, deux créations), gris alignés sur
  la maquette (0, 300, 400, 600, 700, 950), 5 gris inutilisés supprimés après contrôle d'usage.
- **Modes de couleur** : Base (coton), Dark (bleu-nuit, à renommer « Nuit » dans le Designer), Ciel (nouveau).
  Boutons pilotés par les modes : sur une section Nuit, le Secondary devient la version « inverse » de la maquette.
- **Typographie** : 6 titres (60 / 52 / 40 / 32 / 24 / 20 px, mobiles 40 / 32 / 28 / 24 / 22 / 20), 4 textes
  (18 / 16 / 14 / 12 px), interlettrage -3 % et -2 %, classes renommées d'après leur valeur, `text-size-1x25rem`
  supprimée (absente de la maquette), utilitaire `text-style-mono` pour les petits titres en Chivo Mono.
- **Mise en page** : `padding-global` 64 px desktop, 20 px mobile ; `container-82rem` (1 312 px de contenu).
- **Button** : 44 px, texte 14 px, pastille avec flèche Remix (SVG de la maquette), Primary et Secondary, survol de
  la pastille dans le CSS de Global Styles.
- **Page Style Guide** (`/admin/style-guide`, sortie de brouillon pour être publiée) : titres et textes renommés et
  en français, nuancier, thèmes Base / Nuit / Ciel, boutons sur fond clair et sur fond Nuit.

Vérifié sur la page publiée (Playwright) : polices chargées, tailles et interlettrages mesurés à 1440, 991, 767 et
390 px conformes à la maquette, marges 64 / 20 px, nuancier et thèmes à l'œil.

### Mesures

Scripts de la phase rejoués en essai à blanc (mêmes lectures, aucune écriture) :

| | Appels MCP | Caractères bruts reçus | Caractères affichés à l'agent |
|---|---:|---:|---:|
| 10 scripts du styleguide | 54 | 1 106 452 (≈ 277 000 tokens) | 20 379 (≈ 5 100 tokens) |

Gain : environ 98 %. Réserve : une partie du volume brut vient de la lib elle-même (voir « Inefficacités »), un agent
direct n'aurait pas tout relu. Mesures continues à partir de la home : `.cache/metrics.jsonl` (un objet par script).

### Ce que le test a fait ajouter à la lib

| Manque constaté | Ajout |
|---|---|
| Pas d'envoi de police | `uploadFonts`, `listFonts` (envoi S3 partagé avec les assets : `postToS3`) |
| Pas d'écriture de variable | `ensureVariables` (création, base et modes, renommage, alias par nom), `ensureVariableMode`, `variableUsage`, `deleteVariables` (refus si utilisée) |
| Pas de renommage ni de lecture de classe | `renameStyles` (chaînes a → b puis c → a rejouables), `readStyles` (variables par nom), `removeStyles` |
| Pas de style de variante | `ensureVariantStyles` (diff contre `get_variant_styles`) |
| Pas d'écriture de texte ni de classe sur l'existant | `setTexts` (vise le nœud texte tout seul), `setClasses` |
| Pas de construction dans une définition de composant | `buildElements` (repose les classes ignorées par le builder) |
| Pas de pose d'instance | `insertComponents` (pose puis props par nom) |
| Pas de mesure pendant le dev | `report()` affiche bruts → affichés et journalise dans `.cache/metrics.jsonl` |

### Bugs de la lib trouvés et corrigés en route

- `renameStyles` : le rejeu d'une chaîne de renommages aurait renommé deux fois la même classe → simulation dans
  l'ordre, une cible existante n'est jamais écrasée.
- `findElements` avec filtre texte : les ancêtres (Body, page-wrapper…) passaient avant la vraie cible → seuls les
  éléments les plus profonds sont gardés.
- `ensureVariantStyles` en essai à blanc : échec si la classe n'existait pas encore → traité comme « rien de posé ».
- `hostedResult` perdait les réponses `{status, message, …}` sans `data` (`get_style_variable_modes`).
- `uploadFonts` : `create_font` ne renvoie pas l'id au premier niveau → relecture de la liste.

### Inefficacités à corriger

- `ensureVariables`, `ensureStyles` et `deleteVariables` rechargent tout le design system (styles et composants
  compris, ≈ 100 000 caractères) alors qu'ils n'ont besoin que des variables : prévoir un rechargement partiel.
- `insertComponents` relit l'arbre de la page avant et après chaque instance.

### Liste de fin d'intégration (à faire à la main ou à décider)

1. **Renommer le mode « Dark » en « Nuit »** (collection Color modes) dans le Designer : le MCP ne sait ni renommer
   ni supprimer un mode. La classe `mode-dark` garde son nom tant que le mode garde le sien.
2. **Graisses du texte courant** : l'UI kit nomme ses styles « -500 » et « -600 » mais tous sont en Regular dans la
   maquette ; Instrument Sans 500 est chargée, pas la 600. À confirmer avec le designer.
3. **Variables Figma divergentes** : certaines variables du fichier citent Inter et Hanken Grotesk, alors que l'UI
   kit et les maquettes utilisent Instrument Sans. Suivi : Instrument Sans.
4. **Tailles de bouton** : un seul gabarit posé (44 px). La maquette en a trois (56 / 44 / 36) ; à trancher à la
   home (variantes ou combos).
5. **Largeur du conteneur** : 82rem d'après la grille Figma. La règle Gemeos des grands écrans (laisser grandir,
   ex. 120rem) n'est pas appliquée en attendant votre arbitrage.
6. `padding-global` pointait en mobile vers une variable absente de toutes les collections (16 px) : remplacé par
   `Spacers - Padding/global` (20 px). À vérifier sur le gabarit d'agence.
7. Les sélecteurs de balise (H1 à H6 « tout le site ») gardent le style du gabarit, conformément à la règle.


## Phase 2 : home, section 1 « Hero » (24/11/2026), en attente de validation

### Ce qui a été posé

- `Section • Hero` (groupe Sections), construite depuis `Section [DEV]` détachée : classe `hero_section` + combo
  `mode-dark`, Padding 8rem / 4rem, photo plein écran (`media-full-size is-bottom`) et voile à 40 % dans `layer-4`.
  10 props documentées : petit titre, titre, texte, réassurance, image de fond et son alt, texte et lien des deux
  boutons.
- `Element • Tagline` (groupe Elements) : petit titre réutilisable, prop « Texte ».
- Titre 72 px : `heading-size-4x5rem` (40 px en mobile), ajoutée à l'échelle (absente de l'UI kit).
- Button : variantes « Primary Large » et « Secondary Large » (56 px), prop « ID de suivi » reliée à `data-tui-id`,
  `data-tui="cta"` sur tous les boutons ; `data-tui-section="hero"` sur la section.
- Assets : photo (2 416 px, JPEG ~530 Ko) et groupe d'avatars (PNG x3), textes alternatifs.

Vérifié sur la page publiée à 390, 991, 1440 et 1920 px : titre 72 px sur 932 px (maquette 931), boutons 56 px avec
`data-tui-id` et lien, image chargée, pas de débordement horizontal, pas d'erreur console, mobile conforme (contenu en
bas, boutons pleine largeur).

### Mesures

| | Exécutions | Appels MCP | Caractères bruts reçus | Caractères affichés |
|---|---:|---:|---:|---:|
| Section Hero (essais à blanc, échecs et relances compris) | 15 | 225 | 2 292 843 (≈ 573 000 tokens) | 10 698 (≈ 2 700 tokens) |

Le volume brut inclut les relectures internes de la lib (arbre de page, design system) : il mesure ce que la lib a
consommé, pas ce qu'un agent direct aurait strictement lu. La part qui entre dans le contexte reste sous 0,5 %.

### Ajouté à la lib pendant la section

`detachInstances`, `createVariants`, `componentize` (transformation + props + liaisons, y compris props d'instances
imbriquées), `setPropDefaults` (image, alt, lien), `insertSection` multi-racines.

### Bugs trouvés et corrigés en route

- `insertSection` : le builder WHTML n'accepte qu'**une racine par appel** (« Expected single root element but found
  3 elements ») et l'échec arrivait sans rien insérer ; la lib découpe désormais en racines insérées dans l'ordre et
  lève une erreur explicite si rien n'est inséré. (Première hypothèse, le SVG en ligne, non vérifiée : retirée.)
- `componentize` : la liaison par texte visait le premier élément portant ce texte, donc le **conteneur** — la prop
  « Réassurance » a remplacé l'image des avatars et le paragraphe. Corrigé (élément le plus profond) et réparé dans la
  définition.
- Props image et lien créées sans valeur par défaut : l'image de fond et les liens (« # ») auraient disparu à la
  publication. `componentize` pose maintenant ces défauts (`update_prop` / `default_link`).
- `setInstanceProps` et `removeElements` ne transmettaient pas `scope_component_id` : « Element not found » dans une
  définition. Corrigé.
- `ensureStyles` en essai à blanc bloquait sur une variable créée dans le même script : affichée « à créer ».

### Liste de fin d'intégration (ajouts)

8. **Petit titre mobile** : la maquette mobile raccourcit le texte (« Cabinet francophone ») ; un composant n'a qu'un
   texte. Gardé le texte desktop, à confirmer.
9. **Titre 72 px** hors de l'échelle de l'UI kit : variable ajoutée (`heading-size-4x5rem`), à confirmer avec le
   designer.
10. **Grands écrans** : en 1920 px le contenu commence à 304 px du bord (conteneur 82rem). Décision attendue.
11. **Navbar** : encore celle du gabarit sur la home (prochaine étape : composant partagé).
12. **Lien des boutons** en URL `/contact` : à repasser en lien de page dans le Designer quand la page existera.


## Phase 3 : navbar, footer, « Le constat » et animations du prototype (24/11/2026)

### Ce qui a été posé

- **Socle d'animation** : GSAP 3.13 (ScrollTrigger, SplitText, CustomEase) et Lenis 1.3.4 en scripts du site (pied de
  page, empreinte SRI) ; script de tête (`js`, `js-loader`) ; dans Global Styles, embeds `code-css` / `code-js`
  (courbes, défilement doux, apparitions au défilement, file `DT.add`), `code-icons` (icônes et logo en masques CSS).
- **Bouton** : survol du prototype (le bleu nuit balaie la pastille, double flèche) ; variantes Primary Small et Nav.
- **`Element • Navbar`** : barre flottante, méga-menu Expertises (volet, colonnes en cascade, voile), masquage au
  défilement, menu plein écran mobile avec burger animé. 34 liens.
- **`Element • Loader`** : dalles en canvas au motif du logo, pictogramme tracé, lettres, lumière horizon / terracotta,
  désintégration, puis intro du hero ; une fois par session (onglet).
- **Hero** : intro ligne par ligne (SplitText), textes et boutons en cascade, parallaxe en sortie.
- **`Section • Constat`** : six photos flottantes (parallaxe propre, volet à l'apparition), phrase allumée mot à mot,
  motif en fond ; 11 props. `Element • Tagline` gagne une variante Marine.
- **`Element • Footer`** : carte coton sur photo, plan du site, grand « Client E » en dégradé ; la carte monte au
  défilement, le mot se révèle depuis sa ligne de base.
- Démos du gabarit retirées de la home (Section [DEV], Marquee, FAQ, Navbar, Footer).

Vérifié sur la page publiée : Chromium et WebKit, 1440 et 390 px, sans débordement, sans image cassée, sans erreur
console ; loader capturé à 0,7 / 1,4 / 2,2 / 2,9 / 3,7 s ; survol du bouton (balayage 0 → 1, flèche sortie de 170 %) ;
footer (carte 120 → 0 px au défilement, révélation 283 → 0) ; phrase 22 / 23 mots allumés à mi-scène ; méga-menu au
survol et menu mobile au clic.

### Mesures

| | Exécutions | Appels MCP | Caractères bruts reçus | Caractères affichés |
|---|---:|---:|---:|---:|
| Navbar, loader, animations, constat, footer | 33 | 489 | 5 021 932 (≈ 1 255 000 tokens) | 15 645 (≈ 3 900 tokens) |

### Ajouté à la lib

`ensureSiteScripts` (SRI calculée, application par `set_site_scripts`), `setEmbed` (variables par nom
`var(--dt:Nom)`, relecture exacte), `fixLinkAttributes` (automatique en fin d'`insertSection`), création des classes
manquantes dans `buildElements` et `setClasses`.

### Bugs et pièges rencontrés

- `add_site_script` : 404 « Custom code block not found » **renvoyé dans `result`**, donc pris pour un succès ;
  corrigé dans `hostedResult` (et `set_site_scripts` à la place).
- WHTML : chaque `href` reste aussi en attribut personnalisé (34 liens de la navbar, 25 du footer) ; corrigé
  automatiquement.
- Les classes `code-css` / `code-js` n'existaient pas sur ce site : le builder a créé les embeds **sans classe, sans
  erreur** ; un rejeu les a dupliqués (socle d'animation chargé deux fois) ; doublons supprimés, classes créées,
  lib corrigée. Un embed SVG (le grand « Client E ») a reçu `code-css` par mon script et a été masqué : corrigé et
  vérifié.
- 429 au milieu d'un lot de `remove_attribute` : la lib ne rejoue que les lots refusés en entier ; action sans risque,
  relancée à la main.

### Inefficacité principale

Les fonctions d'écriture relisent l'arbre complet de la page (≈ 60 000 caractères par lecture sur la home) avant et
après chaque insertion : 53-nav a reçu 1,6 M de caractères pour 96 appels. Prochaine amélioration : relire une
sous-arborescence (`scope`), mettre l'arbre en cache entre écritures et ne recharger que la branche touchée.

### Liste de fin d'intégration (ajouts)

13. **Réseaux sociaux** : adresses LinkedIn, Instagram, YouTube manquantes (liens « # », encadrés en rouge par la
    règle DEBUG LINKS du gabarit).
14. **Navbar et footer des autres pages** : encore ceux du gabarit ; remplacer par `Element • Navbar` /
    `Element • Footer`.
15. **Retours à la ligne forcés** du Figma (titre du constat, phrase) non reproduits : retour naturel.
16. **Images** reprises du prototype (WebP exportés du Figma), non recompressées en AVIF.
17. **GSAP / Lenis** chargés depuis jsDelivr : à arbitrer (GSAP natif de Webflow, ou fichiers hébergés).
18. **Licence web Feature Display** à vérifier (point ouvert du prototype).
19. **Tracking** : attributs `data-tui-*` posés ; `tui.js` et le conteneur GTM restent à installer.

## Optimisation des relectures (25/11/2026)

Banc `scratch/opt-bench.ts` (page Contact du bac à sable : section à trois racines, deux Buttons, `setTexts`,
`setClasses`, embed par `buildElements`, suppression).

| | Appels MCP | Caractères bruts |
|---|---:|---:|
| Avant | 45 | 206 766 |
| Après, cache du design system vide | 31 | 72 835 (−65 %) |
| Après, cache du design system à jour | 27 | 20 729 (−90 %) |

- Design system en cache par partie (variables, classes, composants), chacune avec sa date. Chaque fonction ne
  charge que la partie dont elle a besoin. Une écriture ne périme que sa partie. `get_styles` (≈ 80 000 car.)
  n'est plus lu sur ce parcours.
- Arbre de page : cache de 60 s par processus. Après une écriture, `setTexts`, `setClasses` et `removeElements`
  corrigent le cache sur place, sans relecture. Les insertions relisent seulement la branche touchée
  (`refreshBranch`, `query_elements` en profondeur complète), avec un repli sur la relecture complète.
  `get_all_elements` : 22 appels → 1.
- Compteurs par outil dans `.cache/metrics.jsonl` (`byTool`).

## Module Figma (25/11/2026)

Test : les 10 sections de la home desktop Client E (`Home - 1440`), fiche compacte de chacune, variables de « Le
constat » rapprochées du site, assets de « Le constat » téléchargés.

| | Appels Figma | Caractères bruts | Tokens (÷ 4) |
|---|---:|---:|---:|
| Réponses brutes reçues par le script | 26 | 4 616 576 | ≈ 1,15 M |
| dont `get_metadata` (3 sections à motif : 1,3 à 1,8 M chacune) | 10 | 4 402 260 | ≈ 1,1 M |
| dont `get_design_context` (sections et morceaux légers) | 15 | 212 834 | ≈ 53 K |
| Les 10 fiches complètes, si l'agent les lit toutes | — | 97 373 | ≈ 24 K |
| Deuxième lecture des mêmes nœuds | 0 | 0 | 0 |

- En direct, un agent qui demande `get_design_context` sur chaque section reçoit les métadonnées XML pour les trois
  sections à motif (≈ 1,1 M tokens) : impossible à tenir en contexte. Meilleur cas en direct (l'agent sait déjà
  découper) : ≈ 53 K tokens de code, contre ≈ 24 K de fiches (−55 %).
- Variables : 15 rapprochées automatiquement (couleurs, polices, tailles de texte, `espace/64` → `Spacers - Padding/global`),
  11 sans équivalent (espacements fins, rayons : le gabarit n'a pas de variables d'espacement).
- Assets : 7 fichiers, 23 Mo bruts (PNG jusqu'à 8 Mo, 2416×2016) : conversion WebP / AVIF nécessaire avant envoi.

### Images (25/11/2026)

`figmaAssets` sur les 44 assets de la home : 53 Mo bruts → 1,6 Mo (−97 %). Chaque image est redimensionnée pour
couvrir son cadre Figma × 3 (× 1,5 en pleine largeur), puis convertie en AVIF. Exemples : hero 6,5 Mo → 386 Ko
(2160×1802 pour un cadre 1440×900), photo du constat 8,1 Mo → 52 Ko (1014×846 pour 338×223). Taille du cadre lue dans
les métadonnées, ou dans le code pour les nœuds d'instance (42 sur 44 ; 2 sans taille, laissées à leur dimension).

### Agents en parallèle (25/11/2026)

5 scripts simultanés (lectures de pages et du design system) : 5 sessions Webflow distinctes, cache JSON intact,
aucun verrou résiduel. Jetons OAuth rafraîchis sous verrou, caches partagés écrits de façon atomique.

### API REST Figma (25/11/2026, jeton personnel en lecture)

- Page entière : `figmaOutline` / `figmaSpec` sur `Home - 1440` lisent les 10 sections par l'API REST, puis les
  fiches (625 lignes, 186 textes, 45 assets pour toute la page).
- Commentaires : 38 fils dans le fichier, aucun sur la home actuelle ; 15 épinglés sur un cadre supprimé (6 ouverts,
  sur le logo et la copy de la home), remontés par `figmaOrphanComments`. 10 sections : 14 appels, 226 000 car.
  bruts (première version, qui relisait chaque section en profondeur : 39 M).
- Export SVG du motif de « Le constat » (13 428 vecteurs) : un fichier de 1,1 Mo.
