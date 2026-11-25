# Benchmark : appels MCP directs contre mcp-code-mode-webflow-figma

_Mesuré le 2026-11-24 16:55 sur le site bac à sable `<id du bac à sable>`, MCP hébergé (mcp.webflow.com)._

Méthode : le même workflow est exécuté deux fois. En direct, chaque réponse brute du MCP compte comme entrée dans le
contexte de l'agent, et chaque jeu d'arguments (avec session_id, agent_id et context, exigés à chaque appel) comme écrit
par lui. Avec la lib, l'agent écrit un script (taille réelle) et ne voit que la sortie de `report()`. Les appels MCP
sont comptés réellement ; les tokens sont estimés à caractères / 4. Non comptés : le raisonnement de l'agent entre les
appels et la relecture du contexte à chaque tour, qui amplifie l'écart (les réponses brutes restent dans le contexte
jusqu'à la fin de la session).

Le bac à sable est petit (14 pages, collections presque vides) : en direct, le coût croît avec la taille du site ;
avec la lib, la sortie est plafonnée (4 000 caractères par défaut).

| Workflow | Appels directs | Appels lib | Tokens en contexte (direct) | Tokens en contexte (lib) | Tokens écrits (direct) | Tokens écrits (lib) | Total direct | Total lib | Gain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Audit SEO de toutes les pages | 1 | 1 | 1775 | 895 | 65 | 29 | 1840 | 924 | 50 % |
| Import CMS de 10 items | 3 | 4 | 1013 | 210 | 422 | 185 | 1434 | 395 | 72 % |
| Trouver les titres H2 d'une page (/admin/style-guide, 906 nœuds) | 2 | 1 | 47299 | 1054 | 191 | 41 | 47491 | 1095 | 98 % |
| Design system : variables, classes, composants | 8 | 5 | 22255 | 394 | 730 | 54 | 22985 | 448 | 98 % |
| Modifier une prop texte d'une instance (« Element • Breadcrumbs ») | 3 | 3 | 786 | 61 | 359 | 68 | 1145 | 129 | 89 % |
| Envoyer une image avec son texte alternatif | 2 | 3 | 668 | 70 | 381 | 54 | 1049 | 124 | 88 % |
| Créer une classe (variable, breakpoint, survol) | 3 | 2 | 445 | 77 | 414 | 78 | 859 | 155 | 82 % |
| Insérer une section HTML + CSS et vérifier | 2 | 3 | 609 | 65 | 296 | 139 | 905 | 204 | 77 % |
| **Total** | | | | | | | **77708** | **3474** | **96 %** |
