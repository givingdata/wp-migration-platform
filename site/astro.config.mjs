import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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

// config/site.json "noindex": the whole site stays out of search engines (demos, staging).
const siteHidden = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../config/site.json", import.meta.url), "utf8")).noindex === true;
  } catch {
    return false;
  }
})();

// …including an X-Robots-Tag header on every response, added inside _headers' own "/*" rule
// (a second "/*" rule would stop the security headers applying).
function hideSite() {
  return {
    name: "hide-site",
    hooks: {
      "astro:build:done": ({ dir }) => {
        if (!siteHidden) return;
        const file = new URL("_headers", dir);
        const rules = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        const tag = "  X-Robots-Tag: noindex, nofollow";
        if (rules.includes(tag)) return;
        fs.writeFileSync(file, /^\/\*\s*$/m.test(rules) ? rules.replace(/^\/\*\s*$/m, (line) => `${line}\n${tag}`) : `${rules}\n/*\n${tag}\n`);
      },
    },
  };
}

// public/sample/ holds the pictures for src/data/sample-content.json. A build from a real
// content.json (same lookup as src/lib/content.ts) leaves them out of the published site.
function dropSamples() {
  const real = [process.env.CONTENT_PATH, "../content.json", "content.json"].some((p) => p && fs.existsSync(p));
  return {
    name: "drop-samples",
    hooks: {
      "astro:build:done": ({ dir }) => {
        if (real) fs.rmSync(new URL("sample/", dir), { recursive: true, force: true });
      },
    },
  };
}

// Extra CSS for the site's preset (src/styles/presets/<preset>.css), imported by BaseLayout as
// "virtual:preset.css" right after global.css. Only the chosen preset's file is built, so sites
// don't ship the styles of designs they don't use; presets without a file get an empty one.
function presetCss() {
  let preset = "classic";
  try {
    preset = JSON.parse(fs.readFileSync(new URL("../config/theme.json", import.meta.url), "utf8")).preset || preset;
  } catch {}
  const file = new URL(`./src/styles/presets/${preset}.css`, import.meta.url);
  const id = "virtual:preset.css";
  return {
    name: "preset-css",
    resolveId: (source) => (source === id ? (fs.existsSync(file) ? fileURLToPath(file) : "\0preset.css") : null),
    load: (resolved) => (resolved === "\0preset.css" ? "" : null),
  };
}

// SITE_URL is the production origin (used for canonical URLs, sitemap, Open Graph).
const site = process.env.SITE_URL || "https://example.org";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  integrations: [...(siteHidden ? [] : [sitemap({ filter: (page) => !hidden.has(new URL(page).pathname) })]), redirects(), hideSite(), dropSamples()],
  vite: {
    plugins: [presetCss()],
    // content.json and config/design-specs.json live one level up.
    server: { fs: { allow: [".."] } },
  },
});
