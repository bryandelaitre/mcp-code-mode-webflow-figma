// Example: SEO audit of a site, issues only. Run: npx tsx scratch/example.ts
import { auditPageSeo, run } from "../src/kit/index.js";

const siteId = process.env.WEBFLOW_SANDBOX_SITE_ID!;
await run(() => auditPageSeo({ siteId }));
