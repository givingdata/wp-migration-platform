// Astro integration: writes Cloudflare Pages' _redirects (301s) after the build, from
//   1. redirects.csv in the client repo (your own rules; they win),
//   2. every migrated page whose old WordPress address differs from its new one,
//   3. standard WordPress addresses: uploads → R2 media, category/tag/author/feed/page
//      archives → the news listing, old sitemap names → the new sitemap.
// Old ?p=123 / ?page_id=45 links can't be matched by _redirects (it ignores query strings),
// so wp-ids.json is written for functions/index.js to redirect those.
import fs from "node:fs";
import path from "node:path";

const LIMIT_STATIC = 2000;
const LIMIT_DYNAMIC = 100;
const STATUSES = new Set(["301", "302", "303", "307", "308"]);

export function parseCsv(text, file = "redirects.csv") {
  const rules = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || /^from\s*,/i.test(line)) return;
    const [from, to, status = "301"] = line.split(",").map((s) => s.trim());
    const at = `${file} line ${i + 1}`;
    if (!from?.startsWith("/") || /\s/.test(from)) throw new Error(`${at}: "from" must be a path starting with / (got ${JSON.stringify(from)})`);
    if (!to || /\s/.test(to) || !(to.startsWith("/") || /^https?:\/\//.test(to))) throw new Error(`${at}: "to" must be a /path or a full URL`);
    if (!STATUSES.has(status)) throw new Error(`${at}: status must be 301, 302, 303, 307 or 308`);
    if (seen.has(from)) throw new Error(`${at}: ${from} is listed twice`);
    seen.add(from);
    rules.push({ from, to, status, source: "redirects.csv" });
  });
  return rules;
}

const pathOf = (link) => {
  try {
    const u = new URL(link);
    return u.search ? null : decodeURI(u.pathname); // ?p= links are handled by the Function
  } catch {
    return null;
  }
};

/** All rules, in the order Cloudflare should apply them (first match wins). */
export function buildRules({ map, csv = [], media = [], skipped = [], builtPaths = new Set() }) {
  const rules = [...csv];
  const taken = new Set(csv.map((r) => r.from));
  const add = (from, to, source) => {
    if (taken.has(from) || from === to) return;
    taken.add(from);
    rules.push({ from, to, status: "301", source });
  };

  for (const e of map.entries) {
    const old = e.link && pathOf(e.link);
    if (!old || old === "/" || old === e.path) continue;
    // Never redirect an address the new site actually serves.
    if (builtPaths.has(old.endsWith("/") ? old : `${old}/`)) continue;
    add(old, e.path, "moved page");
  }

  // WordPress file folders (uploads, NextGEN's gallery…) → the same files in R2: one pattern
  // rule per folder, when the mirror kept the folder layout for most of its files.
  const byDir = {};
  for (const m of media) {
    const match = m.source && m.url && m.source.match(/^https?:\/\/[^/]+\/wp-content\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const [, folder, rest] = match;
    const d = (byDir[folder] ||= { total: 0, prefixes: {} });
    d.total++;
    if (m.url.endsWith(rest)) {
      const prefix = m.url.slice(0, -rest.length);
      d.prefixes[prefix] = (d.prefixes[prefix] || 0) + 1;
    }
  }
  for (const [folder, d] of Object.entries(byDir)) {
    const [prefix, n] = Object.entries(d.prefixes).sort((a, b) => b[1] - a[1])[0] || [];
    if (prefix && n >= d.total * 0.8) add(`/wp-content/${folder}/*`, `${prefix}:splat`, "WordPress files → media");
  }

  const listing = map.hasNews ? map.newsPath ?? "/news/" : "/";
  // Entries the new site leaves out (e.g. untitled posts) go to the listing rather than a 404.
  for (const link of skipped) {
    const old = pathOf(link);
    if (old && old !== "/" && !builtPaths.has(old.endsWith("/") ? old : `${old}/`)) add(old, listing, "left out of the new site");
  }
  for (const from of ["/category/*", "/tag/*", "/author/*", "/page/*", "/feed", "/feed/*", "/comments/feed/*"]) add(from, listing, "WordPress archive");
  for (const from of ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"]) add(from, "/sitemap-index.xml", "old sitemap");
  return rules;
}

export function toRedirectsFile(rules) {
  const dynamic = rules.filter((r) => /[*:]/.test(r.from)).length;
  const fixed = rules.length - dynamic;
  if (fixed > LIMIT_STATIC) throw new Error(`_redirects: ${fixed} fixed rules; Cloudflare Pages allows ${LIMIT_STATIC}`);
  if (dynamic > LIMIT_DYNAMIC) throw new Error(`_redirects: ${dynamic} pattern rules; Cloudflare Pages allows ${LIMIT_DYNAMIC}`);
  const lines = ["# Generated at build time by site/redirects.mjs (edit redirects.csv, not this file)."];
  let last = null;
  for (const r of rules) {
    if (r.source !== last) lines.push(`# ${r.source}`);
    last = r.source;
    lines.push(`${r.from} ${r.to} ${r.status}`);
  }
  return `${lines.join("\n")}\n`;
}

function builtPathsIn(dir) {
  const out = new Set();
  const walk = (d, rel) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name), `${rel}${f.name}/`);
      else if (f.name === "index.html") out.add(rel);
    }
  };
  walk(dir, "/");
  return out;
}

export default function redirects() {
  return {
    name: "wp-redirects",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const out = new URL(dir).pathname;
        const mapFile = path.join(out, "redirects-map.json");
        if (!fs.existsSync(mapFile)) return;
        const map = JSON.parse(fs.readFileSync(mapFile, "utf8"));
        fs.rmSync(mapFile);

        const root = path.resolve(process.cwd(), "..");
        const csvFile = path.join(root, "redirects.csv");
        const csv = fs.existsSync(csvFile) ? parseCsv(fs.readFileSync(csvFile, "utf8")) : [];
        const contentFile = process.env.CONTENT_PATH || path.join(root, "content.json");
        const content = fs.existsSync(contentFile) ? JSON.parse(fs.readFileSync(contentFile, "utf8")) : {};
        const built = new Set(map.entries.map((e) => e.link).filter(Boolean));
        const skipped = (map.collections ?? ["pages", "posts", "events", "exhibitions"]).flatMap((k) => content[k] || []).map((e) => e?.link).filter((l) => l && !built.has(l));

        const rules = buildRules({ map, csv, media: content.media || [], skipped, builtPaths: builtPathsIn(out) });
        fs.writeFileSync(path.join(out, "_redirects"), toRedirectsFile(rules));
        const ids = Object.fromEntries(map.entries.filter((e) => e.wpId).map((e) => [String(e.wpId), e.path]));
        fs.writeFileSync(path.join(out, "wp-ids.json"), JSON.stringify(ids));
        logger.info(`_redirects: ${rules.length} rules (${csv.length} from redirects.csv); wp-ids.json: ${Object.keys(ids).length} WordPress IDs`);
      },
    },
  };
}
