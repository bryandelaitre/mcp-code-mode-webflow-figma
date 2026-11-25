# scratch/

One-off scripts written by agents. They are not versioned (only this README and `example.ts` are).

Rules:
- a script imports the library (`../src/kit/index.js`) and ends with `run(...)`: only the compact output of `report`
  reaches the agent's context;
- never `console.log` a raw MCP response;
- writes stay in `dryRun` until the diff has been reviewed.

Run: `npx tsx scratch/my-script.ts`, or `<repo>/bin/kit <script>` from a project folder to use that project's
Webflow authorization.
