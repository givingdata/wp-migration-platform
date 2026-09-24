import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import fs from "node:fs";
import redirects from "./redirects.mjs";

// Pages marked "hide from search" (seo.noindex) stay out of the sitemap too.
function noindexPaths() {
  const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {});
  const content = read(process.env.CONTENT_PATH || new URL("../content.json", import.meta.url));
  const out = new Set();
  for (const list of Object.values(content)) {
    if (Array.isArray(list)) for (const e of list) if (e?.seo?.noindex && e.slug) out.add(`/${e.slug}/`);
  }
  for (const [key, page] of Object.entries(read(new URL("../sections.json", import.meta.url)).pages || {})) {
    if (page?.seo?.noindex) out.add(key === "/" ? "/" : `/${key.replace(/^\/+|\/+$/g, "")}/`);
  }
  return out;
}
const hidden = noindexPaths();

// SITE_URL is the production origin (used for canonical URLs, sitemap, Open Graph).
const site = process.env.SITE_URL || "https://example.org";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  integrations: [sitemap({ filter: (page) => !hidden.has(new URL(page).pathname) }), redirects()],
  vite: {
    // content.json and config/design-specs.json live one level up.
    server: { fs: { allow: [".."] } },
  },
});
