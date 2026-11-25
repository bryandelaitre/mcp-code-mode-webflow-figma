# Usage réel des MCP Webflow

Analyse de tous les transcripts Claude Code de `~/.claude/projects/` qui appellent un MCP Webflow (10 projets : Client A,
Client B, Client C, Client D, Client E, Client F, site de l'agence, Client G, Client H, Client I).
Script : `npm run usage` (rejouable ; les tableaux entre les marqueurs sont régénérés, le reste est rédigé à la main).

## À lire avant la liste des workflows

1. **Tout l'usage mesuré passe par le MCP hébergé** (`https://mcp.webflow.com/mcp`, OAuth) : outils `data_*`.
   Le serveur npm local demandé par la mission (`webflow-mcp-server` 1.0.0, dernière version publiée, septembre 2025)
   expose **d'autres outils** (`collections_items_list_items`, `pages_list`, `sites_publish`…) et ne fait l'édition des
   éléments, styles, variables, composants et assets **que via des outils Designer** (Designer Webflow ouvert avec
   l'app MCP), exclus de la V1.
2. **Conséquence** : avec le serveur local en V1, la lib couvre CMS, pages / SEO, publication et scripts, soit
   **≈ 1,9 M des 5,5 M tokens** entrés en contexte (34 %). Les éléments, réglages, props, styles et assets
   (≈ 3,5 M, 64 %) ne sont atteignables qu'avec le serveur hébergé ou le Designer ouvert.
3. **« Entré en contexte » ≠ « brut »** : Claude Code sauve sur disque les réponses trop lourdes (« Déportées ») et
   n'injecte qu'un avis de quelques centaines de caractères ; l'agent relit ensuite des morceaux avec jq / python,
   coût non mesuré ici. C'est le cas de `list_collection_items` : 11,7 M tokens bruts pour 131 k en contexte,
   et 68 erreurs sur 116 appels.

## Répartition par famille (tokens ≈ caractères / 4)

| Famille | Appels | Entrés en contexte | Bruts | Serveur local 1.0.0 (Data API) |
|---|---:|---:|---:|---|
| Éléments / réglages | 3 341 | 1 979 126 | 2 647 928 | non (Designer) |
| CMS | 621 | 1 517 236 | 17 544 449 | **oui** |
| Composants / props | 1 250 | 590 672 | 652 805 | non (Designer) ; contenus localisés seulement |
| Styles / variables / polices | 693 | 556 792 | 750 960 | non (Designer) |
| Assets | 149 | 420 039 | 988 825 | non (Designer) |
| Pages / SEO | 171 | 259 697 | 530 820 | **oui** |
| Scripts | 88 | 92 442 | 92 442 | partiel (scripts inline ≤ 2 000 caractères) |
| Sites / publication | 381 | 27 569 | 27 569 | **oui** |
| Guide | 22 | 9 511 | 557 781 | sans objet |

## Workflows candidats pour la couche haute, classés par gain potentiel

Gain potentiel = tokens entrés en contexte observés sur les appels concernés ; une fonction haute qui ne renvoie qu'un
résumé en supprime l'essentiel (hypothèse : 80 à 95 %, à mesurer au benchmark). « V1 » = faisable avec le serveur local.

| # | Fonction proposée | Appels remplacés | Tokens en contexte observés | V1 |
|---:|---|---|---:|:---:|
| 1 | `findElements(page, filtre)` / `tree(page, {depth})` : ids, type, classes, texte, élagués | `query_elements`, `get_all_elements` (1 059 appels) | ≈ 1 388 000 | non |
| 2 | `upsertCmsItems(collectionId, items, {dryRun})` : diff champ par champ, création / mise à jour / publication en lot, résumé des comptes | `create_collection_items`, `update_collection_items`, `publish_collection_items` | ≈ 1 042 000 | **oui** |
| 3 | `uploadAsset(path, alt)` : MD5, création, POST S3, texte alternatif, renvoie id + URL | `create_asset`, `update_asset`, `list_assets` | ≈ 420 000 | non |
| 4 | `getDesignSystem(siteId)` avec cache fichier : variables par nom → id, classes utilitaires, composants | `get_variables`, `query_variables`, `query_styles`, `get_styles`, `get_all_components`, `query_components` | ≈ 359 000 | non |
| 5 | `listCmsItems(collectionId, {fields, where})` + `getCollectionSchema` : pagination interne, seulement les champs demandés | `list_collection_items`, `get_collection_details` | ≈ 309 000 en contexte, 12,6 M bruts, 77 erreurs | **oui** |
| 6 | `setInstanceProps(instance, {NomDeProp: valeur})` : par nom, type déduit | `set_component_instance_prop_values` (souvent après `query_elements`) | ≈ 277 000 | non |
| 7 | `getSettings` / `setSettings` compacts, `appendToEmbed` sûr | `get_settings`, `set_settings` | ≈ 260 000 | non |
| 8 | `listPages(siteId)` compact + `auditPageSeo(pageId)` (seulement les problèmes) + `updatePagesSeo([...], {dryRun})` | `list_pages`, `get_page_metadata`, `update_page_settings` | ≈ 260 000 | **oui** |
| 9 | `ensureStyle(nom, {parent, props, breakpoints, mode})` : variables résolues par nom, renvoie ok + diff | `create_style`, `update_style`, `set_style_variable_mode` | ≈ 239 000 | non |
| 10 | `setSiteScript(siteId, code)` : inline ≤ 2 000 caractères, sinon refus explicite | `data_scripts_tool` | ≈ 92 000 | partiel |
| 11 | `insertSection({html, css, images})` : WHTML, images au format S3, relecture des classes et attributs jetés | `whtml`, `set_image_asset` (+ `query_elements` comptés en 1) | ≈ 57 000 | non |
| 12 | `publish(siteId)` avec file d'attente 1 / min et attente de la préprod | `publish_site` (340 appels, 12 erreurs 429) | ≈ 28 000 + relances | **oui** |

<!-- data:start -->
_Généré par `npm run usage` le 2026-11-24 sur 198 transcripts ; 44 utilisent un MCP Webflow._

**Total** : 6 897 appels. Réponses entrées en contexte : ≈ 5 514 477 tokens ; taille brute des réponses : ≈ 23 854 970 tokens ; arguments écrits par l'agent : ≈ 3 103 504 tokens.
Tokens estimés à caractères / 4. « Déportées » : réponses trop lourdes que Claude Code a sauvées sur disque (taille réelle relevée dans le message).

### Par projet
| Projet | Appels | Tokens entrés en contexte (≈) | Tokens bruts (≈) |
|---|---:|---:|---:|
| client-a | 3381 | 2 883 274 | 12 627 781 |
| client-b | 1427 | 838 850 | 1 115 159 |
| client-c | 601 | 412 531 | 504 842 |
| client-d | 547 | 831 092 | 4 937 135 |
| client-e | 443 | 211 877 | 278 045 |
| client-f | 371 | 183 377 | 317 361 |
| site-agence | 66 | 75 062 | 3 832 354 |
| OpenBot-Agents-agent-a0eed9a7-ea57-4fac-bb1a-2d62eabc7e0b | 51 | 68 672 | 182 056 |
| client-h | 8 | 9 141 | 34 740 |
| client-i | 2 | 601 | 25 499 |

### Par serveur MCP
| Serveur | Appels | Tokens entrés en contexte (≈) |
|---|---:|---:|
| `webflow-client-a` | 3381 | 2 883 274 |
| `webflow-client-b` | 1427 | 838 850 |
| `webflow-client-c` | 601 | 412 531 |
| `webflow-client-d` | 547 | 831 092 |
| `webflow-client-e` | 443 | 211 877 |
| `webflow-client-f` | 371 | 183 377 |
| `webflow-agence` | 65 | 75 036 |
| `webflow-client-g` | 51 | 68 672 |
| `webflow-client-h` | 8 | 9 141 |
| `claude_ai_Webflow` | 3 | 628 |

### Par outil
| Outil | Appels | Réponse moy. (car.) | Réponse max | Tokens entrés en contexte (≈) | Tokens bruts (≈) | Entrée moy. (car.) | Erreurs | Déportées |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `data_element_tool` | 1797 | 5 083 | 207 373 | 1 614 750 | 2 283 552 | 715 | 129 | 22 |
| `data_element_settings_tool` | 876 | 1 189 | 40 236 | 260 374 | 260 374 | 1 736 | 117 | 0 |
| `data_component_props_tool` | 663 | 2 043 | 21 698 | 338 560 | 338 560 | 2 706 | 60 | 0 |
| `data_cms_tool` | 621 | 113 008 | 8 668 670 | 1 517 236 | 17 544 449 | 6 765 | 142 | 104 |
| `data_style_tool` | 565 | 4 320 | 441 753 | 416 043 | 610 211 | 1 565 | 35 | 5 |
| `data_component_tool` | 386 | 2 860 | 117 514 | 213 839 | 275 973 | 759 | 34 | 3 |
| `data_element_builder` | 383 | 532 | 11 295 | 50 910 | 50 910 | 1 280 | 27 | 0 |
| `data_sites_tool` | 381 | 289 | 2 629 | 27 570 | 27 570 | 291 | 15 | 0 |
| `data_whtml_builder` | 285 | 745 | 5 567 | 53 093 | 53 093 | 2 397 | 16 | 0 |
| `data_pages_tool` | 171 | 12 417 | 196 706 | 259 697 | 530 820 | 611 | 21 | 12 |
| `data_assets_tool` | 138 | 28 511 | 697 593 | 414 860 | 983 646 | 1 383 | 16 | 13 |
| `data_component_builder` | 136 | 930 | 16 974 | 31 614 | 31 614 | 1 262 | 9 | 0 |
| `data_variable_tool` | 117 | 4 321 | 28 960 | 126 382 | 126 382 | 1 716 | 5 | 0 |
| `designer_tool` | 117 | 280 | 713 | 8 177 | 8 177 | 347 | 24 | 0 |
| `data_scripts_tool` | 88 | 4 202 | 29 203 | 92 443 | 92 443 | 3 181 | 5 | 0 |
| `data_component_variants_tool` | 65 | 410 | 1 788 | 6 659 | 6 659 | 891 | 5 | 0 |
| `data_localization_tool` | 35 | 3 328 | 21 682 | 29 119 | 29 119 | 1 814 | 2 | 0 |
| `webflow_guide_tool` | 22 | 101 415 | 113 613 | 9 512 | 557 781 | 186 | 22 | 22 |
| `element_snapshot_tool` | 16 | 57 | 112 | 226 | 226 | 321 | 12 | 0 |
| `data_fonts_tool` | 11 | 5 225 | 9 476 | 14 368 | 14 368 | 779 | 0 | 0 |
| `asset_tool` | 11 | 1 883 | 5 615 | 5 180 | 5 180 | 1 750 | 6 | 0 |
| `ask_webflow_ai` | 6 | 13 070 | 31 512 | 19 605 | 19 605 | 618 | 0 | 0 |
| `data_agent_instructions_tool` | 3 | 202 | 202 | 152 | 152 | 290 | 0 | 0 |
| `data_forms_tool` | 2 | 8 020 | 10 429 | 4 010 | 4 010 | 280 | 0 | 0 |
| `data_interactions_tool` | 1 | 296 | 296 | 74 | 74 | 533 | 0 | 0 |
| `authenticate` | 1 | 107 | 107 | 27 | 27 | 2 | 0 | 0 |

### Par outil et action (30 premiers, par nombre d'appels)
| Clé | Appels | Réponse moy. (car.) | Réponse max | Tokens entrés en contexte (≈) | Tokens bruts (≈) | Entrée moy. (car.) | Erreurs | Déportées |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `data_element_tool:query_elements` | 814 | 6 563 | 207 373 | 920 617 | 1 335 630 | 527 | 39 | 14 |
| `data_element_settings_tool:set_settings` | 548 | 254 | 4 170 | 34 802 | 34 802 | 2 357 | 69 | 0 |
| `data_component_props_tool:set_component_instance_prop_values` | 439 | 2 491 | 21 698 | 273 346 | 273 346 | 3 441 | 31 | 0 |
| `data_element_builder:build` | 383 | 532 | 11 295 | 50 910 | 50 910 | 1 280 | 27 | 0 |
| `data_sites_tool:publish_site` | 340 | 181 | 342 | 15 394 | 15 394 | 294 | 12 | 0 |
| `data_whtml_builder:whtml` | 284 | 746 | 5 567 | 52 983 | 52 983 | 2 403 | 15 | 0 |
| `data_element_tool:get_all_elements` | 245 | 11 775 | 201 887 | 467 422 | 721 211 | 367 | 16 | 8 |
| `data_element_settings_tool:get_settings` | 206 | 3 313 | 40 236 | 170 631 | 170 631 | 596 | 13 | 0 |
| `data_element_tool:remove_element` | 177 | 372 | 5 753 | 16 448 | 16 448 | 814 | 5 | 0 |
| `data_style_tool:update_style` | 137 | 1 548 | 11 816 | 53 026 | 53 026 | 1 014 | 4 | 0 |
| `data_style_tool:create_style` | 130 | 1 790 | 16 979 | 58 170 | 58 170 | 1 954 | 4 | 0 |
| `data_style_tool:query_styles` | 129 | 5 295 | 27 054 | 170 777 | 170 777 | 553 | 7 | 0 |
| `data_cms_tool:create_collection_items` | 125 | 18 860 | 49 833 | 589 368 | 589 368 | 17 963 | 4 | 0 |
| `data_component_props_tool:create_prop` | 121 | 1 061 | 5 421 | 32 105 | 32 105 | 1 232 | 4 | 0 |
| `data_cms_tool:list_collection_items` | 116 | 404 765 | 8 668 670 | 130 923 | 11 738 199 | 538 | 68 | 63 |
| `data_component_tool:insert_component_instance` | 111 | 1 762 | 8 420 | 48 886 | 48 886 | 867 | 8 | 0 |
| `data_assets_tool:create_asset` | 106 | 18 140 | 98 872 | 363 964 | 480 703 | 1 623 | 6 | 6 |
| `data_cms_tool:update_collection_items` | 105 | 117 034 | 1 080 532 | 371 933 | 3 072 155 | 13 221 | 20 | 17 |
| `data_element_tool:set_style` | 103 | 360 | 4 218 | 9 275 | 9 275 | 852 | 6 | 0 |
| `data_component_builder:insert_in_element` | 87 | 1 027 | 16 974 | 22 346 | 22 346 | 1 169 | 5 | 0 |
| `data_style_tool:create_style+update_style` | 78 | 4 032 | 14 192 | 78 624 | 78 624 | 3 537 | 2 | 0 |
| `data_component_tool:get_component` | 59 | 2 629 | 29 818 | 38 777 | 38 777 | 712 | 2 | 0 |
| `data_pages_tool:list_pages` | 56 | 34 222 | 196 706 | 207 981 | 479 104 | 307 | 13 | 12 |
| `data_element_settings_tool:get_settings+set_settings` | 52 | 921 | 4 902 | 11 979 | 11 979 | 983 | 23 | 0 |
| `data_component_tool:transform_element_to_component` | 52 | 383 | 1 736 | 4 985 | 4 985 | 707 | 4 | 0 |
| `data_element_tool:set_attributes` | 49 | 419 | 2 053 | 5 128 | 5 128 | 860 | 13 | 0 |
| `data_component_tool:query_components` | 47 | 6 172 | 53 730 | 59 475 | 72 523 | 455 | 5 | 1 |
| `data_element_tool:move_element` | 47 | 688 | 3 104 | 8 089 | 8 089 | 1 637 | 7 | 0 |
| `data_component_builder:insert_in_slot` | 45 | 773 | 4 551 | 8 692 | 8 692 | 1 412 | 1 | 0 |
| `designer_tool:select_element` | 43 | 213 | 704 | 2 289 | 2 289 | 368 | 7 | 0 |

### Par volume entré en contexte (20 premiers)
| Clé | Appels | Réponse moy. (car.) | Réponse max | Tokens entrés en contexte (≈) | Tokens bruts (≈) | Entrée moy. (car.) | Erreurs | Déportées |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `data_element_tool:query_elements` | 814 | 6 563 | 207 373 | 920 617 | 1 335 630 | 527 | 39 | 14 |
| `data_cms_tool:create_collection_items` | 125 | 18 860 | 49 833 | 589 368 | 589 368 | 17 963 | 4 | 0 |
| `data_element_tool:get_all_elements` | 245 | 11 775 | 201 887 | 467 422 | 721 211 | 367 | 16 | 8 |
| `data_cms_tool:update_collection_items` | 105 | 117 034 | 1 080 532 | 371 933 | 3 072 155 | 13 221 | 20 | 17 |
| `data_assets_tool:create_asset` | 106 | 18 140 | 98 872 | 363 964 | 480 703 | 1 623 | 6 | 6 |
| `data_component_props_tool:set_component_instance_prop_values` | 439 | 2 491 | 21 698 | 273 346 | 273 346 | 3 441 | 31 | 0 |
| `data_pages_tool:list_pages` | 56 | 34 222 | 196 706 | 207 981 | 479 104 | 307 | 13 | 12 |
| `data_style_tool:query_styles` | 129 | 5 295 | 27 054 | 170 777 | 170 777 | 553 | 7 | 0 |
| `data_element_settings_tool:get_settings` | 206 | 3 313 | 40 236 | 170 631 | 170 631 | 596 | 13 | 0 |
| `data_cms_tool:list_collection_items` | 116 | 404 765 | 8 668 670 | 130 923 | 11 738 199 | 538 | 68 | 63 |
| `data_style_tool:create_style+update_style` | 78 | 4 032 | 14 192 | 78 624 | 78 624 | 3 537 | 2 | 0 |
| `data_component_tool:query_components` | 47 | 6 172 | 53 730 | 59 475 | 72 523 | 455 | 5 | 1 |
| `data_style_tool:create_style` | 130 | 1 790 | 16 979 | 58 170 | 58 170 | 1 954 | 4 | 0 |
| `data_variable_tool:get_variables` | 16 | 13 655 | 28 960 | 54 620 | 54 620 | 649 | 1 | 0 |
| `data_cms_tool:get_collection_details` | 23 | 12 036 | 60 481 | 54 545 | 69 206 | 545 | 1 | 1 |
| `data_style_tool:update_style` | 137 | 1 548 | 11 816 | 53 026 | 53 026 | 1 014 | 4 | 0 |
| `data_whtml_builder:whtml` | 284 | 746 | 5 567 | 52 983 | 52 983 | 2 403 | 15 | 0 |
| `data_cms_tool:get_collection_details+list_collection_items` | 25 | 134 813 | 913 569 | 51 884 | 842 581 | 564 | 9 | 9 |
| `data_element_builder:build` | 383 | 532 | 11 295 | 50 910 | 50 910 | 1 280 | 27 | 0 |
| `data_component_tool:insert_component_instance` | 111 | 1 762 | 8 420 | 48 886 | 48 886 | 867 | 8 | 0 |

### Enchaînements les plus fréquents
Paires (bigrammes) :

- 100 × data_element_builder:build  →  data_element_settings_tool:set_settings
- 92 × data_element_settings_tool:set_settings  →  data_sites_tool:publish_site
- 86 × data_element_tool:query_elements  →  data_component_props_tool:set_component_instance_prop_values
- 72 × data_whtml_builder:whtml  →  data_element_tool:query_elements
- 68 × data_element_builder:build  →  data_element_tool:query_elements
- 66 × data_element_tool:query_elements  →  data_element_settings_tool:set_settings
- 60 × data_element_settings_tool:get_settings  →  data_element_settings_tool:set_settings
- 58 × data_component_props_tool:set_component_instance_prop_values  →  data_element_tool:query_elements
- 57 × data_element_settings_tool:set_settings  →  data_element_tool:query_elements
- 50 × data_element_tool:query_elements  →  data_element_settings_tool:get_settings
- 44 × data_sites_tool:publish_site  →  data_element_tool:query_elements
- 44 × data_element_tool:query_elements  →  data_element_builder:build
- 44 × data_component_props_tool:set_component_instance_prop_values  →  data_sites_tool:publish_site
- 42 × data_component_tool:insert_component_instance  →  data_component_props_tool:set_component_instance_prop_values
- 39 × data_element_tool:query_elements  →  data_whtml_builder:whtml
- 35 × data_style_tool:create_style  →  data_element_builder:build
- 35 × data_element_settings_tool:set_settings  →  data_component_props_tool:set_component_instance_prop_values
- 32 × data_component_props_tool:create_prop  →  data_element_settings_tool:set_settings
- 32 × data_sites_tool:publish_site  →  data_style_tool:update_style
- 31 × data_element_tool:query_elements  →  data_element_tool:remove_element

Triplets :

- 32 × data_element_builder:build  →  data_element_tool:query_elements  →  data_element_settings_tool:set_settings
- 31 × data_element_tool:query_elements  →  data_component_props_tool:set_component_instance_prop_values  →  data_element_tool:query_elements
- 25 × data_component_props_tool:set_component_instance_prop_values  →  data_element_tool:query_elements  →  data_whtml_builder:whtml
- 24 × data_element_builder:build  →  data_element_settings_tool:set_settings  →  data_element_tool:query_elements
- 20 × data_sites_tool:publish_site  →  data_element_settings_tool:set_settings  →  data_sites_tool:publish_site
- 18 × data_component_builder:insert_in_slot  →  data_element_tool:query_elements  →  data_component_props_tool:set_component_instance_prop_values
- 17 × data_component_builder:insert_in_element  →  data_element_tool:query_elements  →  data_component_props_tool:set_component_instance_prop_values
- 16 × data_element_tool:query_elements  →  data_whtml_builder:whtml  →  data_element_tool:remove_element
- 15 × data_sites_tool:publish_site  →  data_style_tool:update_style  →  data_sites_tool:publish_site
- 15 × data_element_settings_tool:get_settings  →  data_element_settings_tool:set_settings  →  data_sites_tool:publish_site
- 14 × data_element_tool:query_elements  →  data_element_builder:build  →  data_element_settings_tool:set_settings
- 13 × data_element_tool:query_elements  →  data_component_props_tool:set_component_instance_prop_values  →  data_sites_tool:publish_site
- 12 × data_whtml_builder:whtml  →  data_element_tool:query_elements  →  data_element_settings_tool:set_settings
- 11 × data_element_settings_tool:set_settings  →  data_sites_tool:publish_site  →  data_element_settings_tool:set_settings
- 11 × data_component_props_tool:create_prop  →  data_element_tool:get_all_elements  →  data_element_settings_tool:set_settings
<!-- data:end -->
