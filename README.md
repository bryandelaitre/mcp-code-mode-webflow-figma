# mcp-code-mode-webflow-figma

A TypeScript library on top of the Webflow and Figma MCP servers, built for "code mode": agents call it from a short
script instead of calling MCP tools one by one. Raw MCP responses stay inside the script process and only a compact
summary reaches the model context (−96 % tokens on 8 Webflow workflows, `reports/benchmark.md`; on a real client
mockup, 4.6 M characters of raw Figma output became 97,000 characters of section specs, `reports/dogfood.md`).

Two Webflow MCP servers are supported:

| | Hosted MCP (default) | Local server (optional) |
|---|---|---|
| Address | `https://mcp.webflow.com/mcp` | `npx webflow-mcp-server` (stdio) |
| Access | OAuth: one browser authorization per project (`bin/kit login`) | `WEBFLOW_TOKEN` (one token per site) |
| Scope | Data API **and** elements, props, classes, variables, components | Data API only (CMS, pages, SEO, publishing) |
| Selection | default | `WEBFLOW_BACKEND=local` |

Figma is read through the Figma desktop app's local MCP server (no authorization needed) plus the Figma REST API
(personal token) for what the local server does not return.

- **Low layer** (`src/generated/`): types and wrappers for every tool, generated from the schemas.
  `hosted/` for the hosted MCP (38 tools, 311 actions), `data.ts` / `designer.ts` for the local server.
- **High layer** (`src/kit/`, `src/figma/`): one function per workflow, compact summaries, writes default to
  `dryRun` and are guarded by a site allowlist. `src/kit/api.ts` routes CMS, pages and publishing through either server.

The workflows were chosen from real usage measured in Claude Code transcripts (`reports/usage.md`).

Agent-facing documentation (`SKILL.md`) and the measurement reports (`reports/`) are written in French.

## Install on a machine

Requirements: Node 22.3+, Claude Code, the Figma desktop app (Preferences → enable the MCP server), macOS (`sips` is
used to convert images).

```bash
gh repo clone bryandelaitre/mcp-code-mode-webflow-figma ~/orca/projects/mcp-code-mode-webflow-figma
cd ~/orca/projects/mcp-code-mode-webflow-figma
npm install
cp .env.example .env     # then fill in: FIGMA_TOKEN, WEBFLOW_WRITE_ALLOWED_SITES, WEBFLOW_SANDBOX_SITE_ID
mkdir -p ~/.claude/skills/mcp-code-mode-webflow-figma
ln -s "$PWD/SKILL.md" ~/.claude/skills/mcp-code-mode-webflow-figma/SKILL.md   # the skill, visible in every session
npm run typecheck
```

`SKILL.md` gives agents the path `~/orca/projects/mcp-code-mode-webflow-figma`: if you clone elsewhere, update that
path in the file.

`FIGMA_TOKEN` is a personal token (Figma → Settings → Security → Personal access tokens) with read scopes only:
`file_content:read`, `file_metadata:read`, `file_comments:read`, `library_*:read`. Never commit it.

## Start a project

From the project folder (the one holding a `.mcp.json` with the `https://mcp.webflow.com/mcp` server):

```bash
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit login         # Webflow screen: pick the workspace and the site
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit sites         # check which sites are authorized
~/orca/projects/mcp-code-mode-webflow-figma/bin/kit path/to/x.ts  # run a script with this project's authorization
```

Each project gets its own authorization (OAuth client, tokens in `.cache/projects/<key>/`, sessions): several agents
working on several projects never share a connection. To allow writes, add the site id to
`WEBFLOW_WRITE_ALLOWED_SITES` (a human decision). Open the project's Figma file in the desktop app before reading
the mockup.

## Developing the library (sandbox)

```bash
npm run hosted-login     # the library's own "default" authorization: tick the sandbox site, then Authorize
```

The OAuth authorization is stored in `.cache/hosted-<profile>.json` (mode 600, not versioned) and renews itself
(one-hour access token, refresh token). It covers the sites ticked at authorization time: run `hosted-login` again to
add some, or use one profile per scope (`WEBFLOW_HOSTED_PROFILE`).

## Environment variables (`.env`, never versioned)

| Variable | Purpose |
|---|---|
| `WEBFLOW_WRITE_ALLOWED_SITES` | Comma-separated ids of the sites where real writes (`dryRun: false`) are allowed. Empty = read and dry-run only. |
| `WEBFLOW_SANDBOX_SITE_ID` | Sandbox site used by the tests and the benchmark. Never a client site. |
| `WEBFLOW_HOSTED_PROFILE` | Authorization profile for the hosted MCP (default `default`). |
| `WEBFLOW_BACKEND` | `local` to use the npm server with a token; empty = hosted MCP. |
| `WEBFLOW_TOKEN` | Local server only: the site's API token (Site settings → Apps & integrations → API access). |
| `WEBFLOW_MCP_VERSION` | Local server only: npm version of the server (default `latest`). |
| `FIGMA_TOKEN` | Personal Figma read token: sections of a full page, comments, SVG export (REST API). |
| `FIGMA_MCP` / `FIGMA_MCP_URL` | Figma MCP: the desktop app's local server by default (`http://127.0.0.1:3845/mcp`); `remote` is refused by Figma (403). |
| `WEBFLOW_PROJECT_DIR` | Set by `bin/kit`: the project folder whose authorization is used. |

Variables already set in the environment take precedence over `.env`.

## Commands

| Command | Effect |
|---|---|
| `npm run hosted-login` | Authorizes the library with the hosted MCP and writes `schemas/hosted-tools.json`. |
| `npm run figma-login` | Connects to the Figma MCP and writes `schemas/figma-tools.json`. |
| `npm run codegen-hosted` | Regenerates `src/generated/hosted/` from `schemas/hosted-tools.json`. Repeatable, deterministic. |
| `npm run regen-hosted` | `hosted-login` (re-reads the schemas) then `codegen-hosted`. |
| `npm run regen` | Same for the local server (`dump-schemas` then `codegen`). |
| `npm run typecheck` | Type-checks the code (run it after a regen). |
| `npm test` | Tests on the sandbox (hosted MCP; `WEBFLOW_BACKEND=local npm test` for the local server). |
| `npm run bench` | Direct-calls vs. library benchmark on the sandbox, writes `reports/benchmark.md`. |
| `npm run usage` | Analyzes Claude Code transcripts and updates the tables in `reports/usage.md` (project names anonymized unless `USAGE_REAL_NAMES=1`). |

After a regen, review the schema diff: a renamed tool or a changed parameter breaks the high layer at type-check
time, on purpose.

## Usage

```ts
// scratch/h2.ts — run from the repo root: npx tsx scratch/h2.ts
import { findElements, run } from "../src/kit/index.js";
await run(() => findElements({ siteId: "…", pageId: "…" }, { tag: "h2" }));
```

```ts
// Figma: compact spec of a section, then its images resized to the Figma frame and converted to AVIF.
import { figmaRef, figmaSpec, figmaAssets, run } from "../src/kit/index.js";
await run(async () => {
  const spec = await figmaSpec(figmaRef("https://www.figma.com/design/<fileKey>/<name>?node-id=12-345"));
  return { spec, assets: await figmaAssets(spec.assets, { dir: "scratch/assets" }) };
});
```

Functions, options and usage rules for agents are in `SKILL.md` (installed as a Claude Code skill:
`~/.claude/skills/mcp-code-mode-webflow-figma/SKILL.md` links to that file). Differences found between the schemas
and the servers' real behavior are logged in `reports/quirks.md`.

## Layout

```
schemas/hosted-tools.json  hosted Webflow MCP contract (generated)
schemas/tools.json         local Webflow server contract (generated)
schemas/figma-tools.json   Figma MCP contract (generated)
bin/kit                    per-project launcher: login, sites, run a script
scripts/                   hosted-login, figma-login, project-sites, codegen(-hosted), dump-schemas, analyze-usage,
                           test-sandbox, benchmark
src/lib/oauth.ts           shared OAuth (dynamic client registration, PKCE, refresh under a lock)
src/lib/project.ts         current project (.mcp.json) and authorization key
src/lib/hosted.ts          OAuth, session, calls and response parsing for the hosted Webflow MCP
src/lib/figma.ts           connection to the Figma MCP (desktop app's local server)
src/lib/client.ts          local Webflow server (stdio), .env loading
src/generated/             generated low layer (do not edit)
src/kit/                   Webflow high layer (api, cms, pages, publish, site, elements, components, design-system,
                           assets, settings, styles, sections, edit, variables, fonts, site-scripts)
src/figma/                 Figma module: outline, compact spec, variables, assets (AVIF), REST (sections, comments,
                           SVG export)
scratch/                   agents' one-off scripts (not versioned)
reports/                   usage.md, quirks.md, benchmark.md, dogfood.md
```

## License

No license yet: all rights reserved by the author until one is added.
