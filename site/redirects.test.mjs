import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRules, parseCsv, toRedirectsFile } from "./redirects.mjs";

const map = {
  siteUrl: "https://old.org",
  hasNews: true,
  entries: [
    { link: "https://old.org/about/", wpId: 2, path: "/about/" }, // unchanged
    { link: "https://old.org/about/team/", wpId: 3, path: "/team/" }, // was nested
    { link: "https://old.org/2019/03/boutique-day/", wpId: 9, path: "/boutique-day/" }, // dated permalink
    { link: "https://old.org/?p=12", wpId: 12, path: "/hello/" }, // plain permalinks: Function's job
    { link: "https://old.org/", wpId: 1, path: "/" },
  ],
};
const media = [
  { source: "https://old.org/wp-content/uploads/2020/11/a.jpg", url: "https://r2.dev/media/2020/11/a.jpg" },
  { source: "https://old.org/wp-content/uploads/2021/01/b.png", url: "https://r2.dev/media/2021/01/b.png" },
  { source: "https://old.org/wp-content/gallery/08/c.jpg", url: "https://r2.dev/media/gallery/08/c.jpg" },
  { source: "https://i0.wp.com/old.org/wp-content/uploads/x.jpg", url: "https://r2.dev/media/ext/x.jpg" },
];

test("moved pages, uploads, archives and sitemaps", () => {
  const rules = buildRules({ map, media, builtPaths: new Set(["/about/", "/team/", "/boutique-day/", "/hello/"]) });
  const byFrom = Object.fromEntries(rules.map((r) => [r.from, r.to]));
  assert.equal(byFrom["/about/team/"], "/team/");
  assert.equal(byFrom["/2019/03/boutique-day/"], "/boutique-day/");
  assert.equal(byFrom["/about/"], undefined);
  assert.equal(byFrom["/wp-content/uploads/*"], "https://r2.dev/media/:splat");
  assert.equal(byFrom["/wp-content/gallery/*"], "https://r2.dev/media/gallery/:splat");
  assert.equal(byFrom["/category/*"], "/news/");
  assert.equal(byFrom["/sitemap_index.xml"], "/sitemap-index.xml");
});

test("never redirects an address the new site serves", () => {
  const rules = buildRules({ map: { ...map, entries: [{ link: "https://old.org/team/", path: "/about-us/team/" }] }, builtPaths: new Set(["/team/"]) });
  assert.ok(!rules.some((r) => r.from === "/team/"));
});

test("redirects.csv rules come first and win", () => {
  const csv = parseCsv("from,to,status\n# comment\n/about/team/,/our-team/\n/old-donate,https://www.canadahelps.org/x,302\n");
  const rules = buildRules({ map, csv });
  assert.deepEqual(rules.slice(0, 2).map((r) => [r.from, r.to, r.status]), [["/about/team/", "/our-team/", "301"], ["/old-donate", "https://www.canadahelps.org/x", "302"]]);
  assert.equal(rules.filter((r) => r.from === "/about/team/").length, 1);
  assert.match(toRedirectsFile(rules), /^\/about\/team\/ \/our-team\/ 301$/m);
});

test("redirects.csv mistakes fail with the line number", () => {
  assert.throws(() => parseCsv("about,/x\n"), /line 1: "from" must be a path/);
  assert.throws(() => parseCsv("/a,/b\n/a,/c\n"), /line 2: \/a is listed twice/);
  assert.throws(() => parseCsv("/a,/b,404\n"), /status must be/);
});

test("Cloudflare's limits are enforced", () => {
  const many = Array.from({ length: 2001 }, (_, i) => ({ from: `/p${i}`, to: "/", status: "301", source: "x" }));
  assert.throws(() => toRedirectsFile(many), /allows 2000/);
});

test("entries the new site leaves out redirect to the listing", () => {
  const rules = buildRules({ map, skipped: ["https://old.org/4064-2/"] });
  assert.equal(rules.find((r) => r.from === "/4064-2/")?.to, "/news/");
});
