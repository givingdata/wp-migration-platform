#!/usr/bin/env node
// Pre-launch check: every address the old WordPress site had should work on the new site,
// either directly or through a redirect. Run it against the preview or the new domain:
//
//   node scripts/check-redirects.mjs --new https://preview.example.pages.dev [--old https://example.org]
//        [--content content.json] [--media 25] [--out redirect-check.csv]
//
// Old addresses come from the old site's sitemap (with --old), content.json, redirects.csv,
// a sample of media files and the standard WordPress addresses. Exits 1 if anything's broken.

import fs from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : acc), []),
);
if (!args.new || args.new === true) {
  console.log("Usage: node scripts/check-redirects.mjs --new <new site URL> [--old <WordPress URL>] [--content content.json] [--media 25] [--out report.csv]");
  process.exit(2);
}
const NEW = new URL(args.new).origin;
const contentFile = args.content || "content.json";
const mediaSample = Number(args.media ?? 25);
const UA = "Mozilla/5.0 (compatible; WP-Redirect-Check/1.0)";

const paths = new Map(); // path → where it came from
const add = (p, from) => {
  if (!p || !p.startsWith("/")) return;
  if (!paths.has(p)) paths.set(p, from);
};
const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return null;
  }
};

// 1. content.json: every page/post's old address, plus a few ?p= links
if (fs.existsSync(contentFile)) {
  const c = JSON.parse(fs.readFileSync(contentFile, "utf8"));
  const entries = ["pages", "posts", "events", "exhibitions"].flatMap((k) => c[k] || []);
  for (const e of entries) add(pathOf(e.link), "export");
  for (const e of entries.filter((e) => e.wpId).slice(0, 5)) add(`/?p=${e.wpId}`, "WordPress ID link");
  // Only files that were on the old site itself (not on image CDNs like i0.wp.com).
  const oldHost = c.siteUrl ? new URL(c.siteUrl).host : null;
  const media = (c.media || []).filter((m) => m.source && (!oldHost || new URL(m.source).host === oldHost));
  const step = Math.max(1, Math.floor(media.length / Math.max(1, mediaSample)));
  for (let i = 0; i < media.length && i / step < mediaSample; i += step) add(pathOf(media[i].source), "media file");
}

// 2. redirects.csv sources (fixed paths only)
if (fs.existsSync("redirects.csv")) {
  for (const line of fs.readFileSync("redirects.csv", "utf8").split(/\r?\n/)) {
    const from = line.replace(/#.*$/, "").split(",")[0]?.trim();
    if (from?.startsWith("/") && !/[*:]/.test(from)) add(from, "redirects.csv");
  }
}

// 3. Standard WordPress addresses
for (const p of ["/feed/", "/category/uncategorized/", "/sitemap_index.xml", "/wp-sitemap.xml"]) add(p, "standard WordPress");

// 4. The old site's sitemap (pages that may not be in the export, e.g. archives)
async function sitemapUrls(origin) {
  const found = [];
  const seen = new Set();
  const queue = ["/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap.xml"].map((p) => origin + p);
  while (queue.length && seen.size < 60 && found.length < 5000) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!res?.ok) continue;
    const xml = await res.text();
    for (const [, loc] of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
      if (/\.xml(\?|$)/.test(loc)) queue.push(loc.replace(/&amp;/g, "&"));
      else found.push(loc.replace(/&amp;/g, "&"));
    }
    if (found.length) break; // the first sitemap that works is enough
  }
  return found;
}
if (args.old && args.old !== true) {
  const urls = await sitemapUrls(new URL(args.old).origin);
  for (const u of urls) add(pathOf(u), "old sitemap");
  console.log(`Old sitemap: ${urls.length} addresses`);
}

// Check each path on the new site, following up to 5 redirects by hand.
async function check(p) {
  let url = NEW + p;
  const hops = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: 0, error: e.message }));
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      hops.push(res.status);
      url = new URL(res.headers.get("location"), url).href;
      continue;
    }
    return { status: res.status, final: url, hops };
  }
  return { status: "loop", final: url, hops };
}

const list = [...paths.entries()];
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < list.length) {
    const [p, from] = list[next++];
    results.push({ path: p, from, ...(await check(p)) });
  }
}));
results.sort((a, b) => a.path.localeCompare(b.path));

// An old ?p=123 link "works" by showing the homepage unless it's actually redirected.
for (const r of results) if (r.from === "WordPress ID link" && !r.hops.length) r.status = "not redirected";
const ok = results.filter((r) => r.status === 200);
const broken = results.filter((r) => r.status !== 200);
const long = ok.filter((r) => r.hops.length > 1);
const temporary = ok.filter((r) => r.hops.some((h) => h !== 301 && h !== 308));

console.log(`\nChecked ${results.length} old addresses on ${NEW}`);
console.log(`  ✓ ${ok.filter((r) => !r.hops.length).length} work as they are`);
console.log(`  ✓ ${ok.filter((r) => r.hops.length).length} redirect to a working page`);
if (long.length) console.log(`  ! ${long.length} take more than one redirect (fine, but slower): ${long.slice(0, 5).map((r) => r.path).join(", ")}`);
if (temporary.length) console.log(`  ! ${temporary.length} use a temporary redirect (302/307); search engines prefer 301`);
if (broken.length) {
  console.log(`  ✗ ${broken.length} are broken:`);
  for (const r of broken.slice(0, 40)) console.log(`      ${r.status}  ${r.path}  (from ${r.from})${r.hops.length ? ` → ${r.final}` : ""}`);
  if (broken.length > 40) console.log(`      …and ${broken.length - 40} more (see the report)`);
  console.log("\n  Fix them with a line in redirects.csv (from,to), then rebuild.");
}

const out = args.out && args.out !== true ? args.out : "redirect-check.csv";
const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
fs.writeFileSync(out, ["path,source,status,redirects,final", ...results.map((r) => [r.path, r.from, r.status, r.hops.join(" "), r.final].map(cell).join(","))].join("\n") + "\n");
console.log(`\nFull report: ${out}`);
process.exit(broken.length ? 1 : 0);
