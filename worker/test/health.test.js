// The "anything out of date?" check over a real editor (in-memory files), with outside links faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createEditor } from "../../lib/edit/index.js";
import { siteHealth, healthReport } from "../src/health.js";

const specs = JSON.parse(await fs.readFile(new URL("../../config/design-specs.json", import.meta.url), "utf8"));

function editorWith(files) {
  const store = {
    async read(names) {
      return { files: Object.fromEntries(names.map((n) => [n, files[n] === undefined ? null : structuredClone(files[n])])), head: "0" };
    },
    async write() {
      throw new Error("read-only");
    },
  };
  return createEditor({ store, specs });
}

const content = () => ({
  siteUrl: "https://old.example",
  frontPage: "p1",
  menu: [{ title: "About", url: null, children: [{ title: "Gone", url: "/gone-page/" }] }],
  pages: [
    { id: "p1", slug: "home", title: "Home", content: "<p>Welcome</p>" },
    {
      id: "p2", slug: "about", title: "About", image: "https://m.example/a.jpg", imageAlt: "",
      content: '<p>Our 2025 schedule is below. Lorem ipsum.</p><p><a href="/contact/">Contact</a> <a href="https://old.example/2019/05/contact/">old link</a> <a href="/missing/">x</a> <a href="/gallery/nggallery/image/1">g1</a> <a href="/gallery/nggallery/image/2">g2</a> <a href="https://dead.example/x">dead</a> <a href="https://fine.example/">fine</a> <a href="mailto:a@b.org">mail</a> <a href="/wp-content/uploads/a.pdf">pdf</a></p>',
    },
    { id: "p3", slug: "contact", title: "Contact", content: "<p>Founded in 1998.</p>" },
  ],
  posts: [{ id: "n1", slug: "old-news", title: "Old news", date: "2026-01-02", content: "<p>2025 was great</p>" }],
  events: [{ id: "e1", slug: "gala", title: "Gala", date: "2026-05-01" }],
  redirects: [],
});

const fetchImpl = async (url, init) => new Response(null, { status: String(url).includes("dead") ? 404 : init.method === "HEAD" && String(url).includes("fine") ? 405 : 200 });

test("finds stale news, no upcoming events, old years, placeholders, broken links and missing descriptions", async () => {
  const editor = editorWith({
    "content.json": content(),
    "sections.json": { pages: { "/": { sections: [{ type: "hero", title: "Hi", text: "Coming soon", image: { src: "https://m.example/h.jpg", alt: "" }, buttons: [{ label: "Go", href: "/nope/" }] }] } } },
  });
  const { findings, checked } = await siteHealth(editor, { today: "2026-09-30", fetchImpl });
  const by = (kind) => findings.filter((f) => f.kind === kind);

  assert.match(by("news")[0].detail, /2026-01-02 \(271 days ago\)/);
  assert.match(by("events")[0].detail, /No upcoming events.*latest was 2026-05-01/);
  assert.deepEqual(by("years").map((f) => f.title), ["About"], "pages only; 1998 and dated news are fine");
  assert.match(by("years")[0].detail, /Mentions 2025: “….*Our 2025 schedule is below/);
  assert.deepEqual(by("placeholder").map((f) => f.title).sort(), ["About", "Home"]);
  const links = by("links").map((f) => `${f.title}: ${f.detail}`);
  assert.deepEqual(links.sort(), [
    "About: Links to 3 addresses that aren't pages on the site, e.g. /missing/, /gallery/nggallery/image/1",
    "About: Outside link https://dead.example/x answers 404 (not found)",
    "Home: Links to /nope/, which isn't a page on the site",
    "Menu: Links to /gone-page/, which isn't a page on the site",
  ], "old WordPress links that match a page by slug, mailto and uploads are fine; 405 on HEAD retries with GET");
  assert.deepEqual(by("alt").map((f) => f.title).sort(), ["About", "Home"]);
  assert.equal(checked.external, 2);

  const text = healthReport({ findings, checked }, { siteUrl: "https://site.example/" });
  assert.match(text, /^Here's what could use a look\. I checked \d+ pages and entries and 2 outside links\./);
  assert.match(text, /\*Links\*\n• <https:\/\/site\.example\/about\/\|About>: Links to 3 addresses/);
  assert.match(text, /Ask me to fix any of these/);
});

test("a tidy site gets a short all-clear; redirected addresses aren't broken links", async () => {
  const c = content();
  c.pages[1] = { id: "p2", slug: "about", title: "About", description: "Who we are.", content: '<p><a href="/summer-camp/">Camp</a></p>' };
  c.pages[0].description = "Welcome.";
  c.pages[2].description = "How to reach us.";
  c.posts[0].date = "2026-09-20";
  c.events[0].date = "2026-12-01";
  c.menu = [];
  c.redirects = [{ from: "/summer-camp", to: "/contact/" }];
  const { findings, checked } = await siteHealth(editorWith({ "content.json": c }), { today: "2026-09-30", siteName: "Acme", fetchImpl });
  assert.deepEqual(findings, []);
  assert.match(healthReport({ findings, checked }), /^✅ Nothing looks out of date\./);
});

test("photo descriptions inside the text, missing summaries, and search titles and descriptions", async () => {
  const long = "We run after-school programs, summer camps and weekend workshops for kids and families across the whole valley, all year.";
  const c = {
    siteUrl: "https://old.example",
    frontPage: "p1",
    menu: [],
    pages: [
      { id: "p1", slug: "home", title: "Home", content: "<p>Welcome</p>" },
      {
        id: "p2", slug: "about", title: "About", image: "https://m.example/a.jpg",
        content: `<p>Hi</p><img src="https://m.example/1.jpg"><img alt="" src="https://m.example/2.jpg"><img src="https://m.example/3.jpg" alt="A dog on the beach"><img alt='  ' src="https://m.example/4.jpg"><IMG SRC="https://m.example/5.jpg" ALT=Kids>`,
      },
      { id: "p3", slug: "contact", title: "Contact", description: "Write to us." },
      { id: "p4", slug: "contact-us", title: "Contact", description: "Or call." },
      { id: "p5", slug: "visit", title: "Visit", description: "Come by.", seo: { title: "Contact | Acme" } },
      { id: "p6", slug: "history", title: "Our long history of community programming and volunteering", description: "Since 1950." },
      { id: "p7", slug: "programs", title: "Programs", description: long + " " + long },
      { id: "p8", slug: "hidden", title: "Hidden", seo: { noindex: true } },
    ],
    posts: [
      { id: "n1", slug: "news-1", title: "A very long news headline about the summer camp season and the new pool", date: "2026-09-20", content: "<p>Camp news.</p>" },
      { id: "n2", slug: "news-2", title: "Pool", date: "2026-09-21", content: "<p>Pool news.</p>", seo: { title: "The new pool is open all week long for families, seniors and swim clubs" } },
    ],
    events: [],
    redirects: [],
  };
  const sections = {
    pages: {
      "/": { seo: { description: "The Acme community centre." }, sections: [{ type: "hero", title: "Hi" }] },
      "/camps": { sections: [{ type: "hero", title: "Camps", text: "Summer fun." }] },
      "/donate": { sections: [{ type: "hero", title: "Donate" }] },
    },
  };
  const { findings, checked } = await siteHealth(editorWith({ "content.json": c, "sections.json": sections }), { today: "2026-09-30", siteName: "Acme", checkExternal: false });
  const by = (kind) => findings.filter((f) => f.kind === kind).map((f) => `${f.title}: ${f.detail}`);

  assert.deepEqual(by("alt"), ["About: The main photo and 3 photos in the text have no description"], "one line per page; quoted, unquoted and capitalised alts count");
  assert.deepEqual(by("title"), [
    "Contact: Has the same search title as Contact (/contact-us/) and Visit: “Contact | Acme”",
    "Our long history of community programming and volunteering: Search title is 65 characters; Google shows about 60: “Our long history of community programming and volunteering | Acme”",
    "Pool: Search title is 71 characters; Google shows about 60: “The new pool is open all week long for families, seniors and swim clubs”",
  ], "a search title counts as written; long news headlines without one are fine; the homepage is the site name");
  assert.deepEqual(by("summary").sort(), [
    "About: No summary, so Google shows the first lines of the page instead",
    "Donate: No summary and no text, so Google gets the site's general description",
    `Programs: Search description is ${2 * long.length + 1} characters; Google shows about 155`,
  ], "designed pages use their first section text; the homepage's own search description wins; noindex pages and news are skipped");
  assert.equal(checked.external, 0);

  const text = healthReport({ findings, checked }, { siteUrl: "https://site.example" });
  assert.match(text, /\*Photo descriptions\*\n• <https:\/\/site\.example\/about\/\|About>: The main photo and 3 photos[^\n]*\n→ Ask me: “describe the photos on About”/);
  assert.match(text, /\*Search titles\*\n(• [^\n]*\n){3}→ Ask me: “how does Contact look on Google\?” \(you can change the search title there\)/);
  assert.match(text, /\*Search descriptions\*\n(• [^\n]*\n){3}→ Ask me: “how does About look on Google\?” \(you can change the search description there\)/);
  assert.doesNotMatch(text, /SEO|\bmeta\b|alt text|image description/i, "staff words only");
});

test("long lists are capped with “…and N more”", async () => {
  const c = { frontPage: "p0", menu: [], posts: [], events: [], redirects: [], pages: [{ id: "p0", slug: "home", title: "Home", description: "Hi." }] };
  for (let i = 1; i <= 20; i++) c.pages.push({ id: `p${i}`, slug: `page-${i}`, title: `Page ${i}`, content: "<p>Text</p>" });
  const result = await siteHealth(editorWith({ "content.json": c }), { today: "2026-09-30", siteName: "Acme" });
  const text = healthReport(result);
  assert.equal((text.match(/No summary/g) || []).length, 8);
  assert.match(text, /• …and 12 more\n→ Ask me: “how does Page 1 look on Google\?”/);
});
