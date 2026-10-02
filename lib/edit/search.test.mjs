// node --test lib/edit/: search title, search description and share image (entry.seo).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditor, EditError } from "./index.js";
import { fileStore } from "./stores/file.js";
import { checkSearchChanges, applySearch, renderedSearch, excerpt, sectionsDescription } from "./search.js";

const specs = JSON.parse(await fs.readFile(new URL("../../config/design-specs.json", import.meta.url), "utf8"));

async function setup(content, sections) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-test-"));
  await fs.writeFile(path.join(dir, "content.json"), JSON.stringify(content));
  if (sections) await fs.writeFile(path.join(dir, "sections.json"), JSON.stringify(sections));
  const editor = createEditor({ store: fileStore(dir), specs });
  const read = async (f) => JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
  return { editor, read };
}

const base = () => ({
  frontPage: "p1",
  menu: [],
  pages: [
    { id: "p1", slug: "home", title: "Home", content: "<p>Hi</p>" },
    { id: "p2", slug: "about-us", title: "About us", description: "Who we are", content: "<p>About</p>", seo: { noindex: false, canonical: "https://x.example/about/" } },
    { id: "p3", slug: "contact", title: "Contact", content: "<p>We&#8217;re at <b>12 Main St</b>.</p>" },
  ],
  posts: [{ id: "a", slug: "news-1", title: "News one", date: "2026-01-01", content: "<p>x</p>", image: "https://media.example/a.webp" }],
  media: [],
});

test("checkSearchChanges: only the three fields, plain one-line text, limits, empty clears", () => {
  const { clean, errors, rest } = checkSearchChanges({
    "seo.title": " <b>About</b>\n us ", "seo.description": "", "seo.image": "javascript:alert(1)", "seo.noindex": true, title: "x",
  });
  assert.deepEqual(clean, { "seo.title": "About us", "seo.description": null });
  assert.ok(errors["seo.image"]);
  assert.deepEqual(rest, { "seo.noindex": true, title: "x" }, "anything else is left for the caller");
  assert.ok(checkSearchChanges({ "seo.title": "x".repeat(121) }).errors["seo.title"]);
  assert.ok(checkSearchChanges({ "seo.description": "x".repeat(321) }).errors["seo.description"]);
  assert.ok(checkSearchChanges({ "seo.title": 5 }).errors["seo.title"]);
  assert.deepEqual(checkSearchChanges({ "seo.image": "https://media.example/s.webp" }).clean, { "seo.image": "https://media.example/s.webp" });
  assert.deepEqual(applySearch({ title: "Old", noindex: true }, { "seo.title": null, "seo.description": "D" }), { noindex: true, description: "D" });
  assert.equal(applySearch({ title: "Old" }, { "seo.title": null }), undefined);
});

test("entries: search fields saved in entry.seo, other seo keys kept, empty clears", async () => {
  const { editor, read } = await setup(base());
  const opened = await editor.get("pages", "p2");
  const saved = await editor.update("pages", "p2", { "seo.title": "About the Cinderella Project", "seo.description": "Free prom dresses for grads." }, { version: opened.version, by: "me" });
  assert.deepEqual(saved.entry.seo, { noindex: false, canonical: "https://x.example/about/", title: "About the Cinderella Project", description: "Free prom dresses for grads." });
  assert.equal(saved.entry.title, "About us", "the visible title is untouched");
  assert.equal((await read("content.json")).pages[1].seo.title, "About the Cinderella Project");
  assert.ok(!("seo.title" in (await read("content.json")).pages[1]));

  await editor.update("pages", "p2", { "seo.title": "", "seo.description": null });
  assert.deepEqual((await read("content.json")).pages[1].seo, { noindex: false, canonical: "https://x.example/about/" });
  // An entry whose seo only had search fields loses the seo object when they're cleared.
  await editor.update("posts", "a", { "seo.image": "https://media.example/share.webp" });
  assert.deepEqual((await read("content.json")).posts[0].seo, { image: "https://media.example/share.webp" });
  await editor.update("posts", "a", { "seo.image": null });
  assert.ok(!("seo" in (await read("content.json")).posts[0]));

  await assert.rejects(editor.update("pages", "p2", { "seo.title": "x".repeat(200) }), (e) => e instanceof EditError && e.status === 400 && !!e.details["seo.title"]);
  // Only the three search fields; noindex/canonical stay with the web team.
  await assert.rejects(editor.update("pages", "p2", { "seo.noindex": true, seo: { noindex: true } }), /Nothing to save/);
});

const sectionsFile = () => ({
  pages: {
    "/": { sections: [{ type: "hero", title: "Welcome", text: "We help grads shine." }] },
    "about-us": { seo: undefined, sections: [{ type: "split", title: "Mission", paragraphs: ["We help"] }] },
  },
});

test("designed pages: search fields saved on the page; a replaced entry's seo is the starting point", async () => {
  const { editor, read } = await setup(base(), sectionsFile());
  const opened = await editor.get("designed", "about-us");
  assert.deepEqual(opened.entry.seo, { noindex: false, canonical: "https://x.example/about/" }, "what the site shows now: the replaced entry's seo");
  const saved = await editor.update("designed", "about-us", { "seo.description": "Free dresses", "0.title": "Our mission" }, { version: opened.version, by: "me" });
  assert.equal(saved.entry.seo.description, "Free dresses");
  const page = (await read("sections.json")).pages["about-us"];
  assert.deepEqual(page.seo, { noindex: false, canonical: "https://x.example/about/", description: "Free dresses" });
  assert.equal(page.sections[0].title, "Our mission");

  // Clearing the only search value on the homepage removes its seo.
  await editor.update("designed", "index", { "seo.title": "Cinderella Project | Prom dresses" });
  assert.equal((await read("sections.json")).pages["/"].seo.title, "Cinderella Project | Prom dresses");
  await editor.update("designed", "index", { "seo.title": "" });
  assert.ok(!("seo" in (await read("sections.json")).pages["/"]));
  await assert.rejects(editor.update("designed", "index", { "seo.image": "ftp://x" }), (e) => e.status === 400 && !!e.details["seo.image"]);

  // updateMany (undo of a change everywhere) handles them too.
  const d = await editor.get("designed", "about-us");
  await editor.updateMany([{ collection: "designed", id: "about-us", changes: { "seo.description": null }, version: d.version }]);
  assert.deepEqual((await read("sections.json")).pages["about-us"].seo, { noindex: false, canonical: "https://x.example/about/" });
});

test("designed page replacing an entry with search values: clearing keeps them from coming back", async () => {
  const content = base();
  content.pages[1].seo = { title: "Imported title" };
  const { editor, read } = await setup(content, sectionsFile());
  await editor.update("designed", "about-us", { "seo.title": "" });
  assert.deepEqual((await read("sections.json")).pages["about-us"].seo, {}, "an empty object, so the site doesn't fall back to the imported title");
});

test("excerpt and sectionsDescription mirror the site", () => {
  assert.equal(excerpt({ content: "<p>We&#8217;re at <b>12 Main St</b>.</p>" }), "We’re at 12 Main St .");
  assert.equal(excerpt({ description: "Short", content: "<p>Long</p>" }), "Short");
  const long = excerpt({ description: "word ".repeat(60) });
  assert.ok(long.length <= 160 && long.endsWith("…"));
  assert.equal(sectionsDescription([{ type: "hero", title: "x" }, { type: "cards", intro: "Intro" }]), "Intro");
  assert.equal(sectionsDescription([{ type: "hero" }]), null);
  const site = { siteName: "Site", tagline: "Tag" };
  assert.deepEqual(renderedSearch({ seo: null, title: "About", entry: { description: "" } }, site), { title: "About | Site", titleFrom: "page", description: "", descriptionFrom: "none" });
  assert.deepEqual(renderedSearch({ seo: { title: "Exact" }, title: "Home", entry: {}, home: true }, site), { title: "Exact", titleFrom: "search", description: "Tag", descriptionFrom: "tagline" });
});

test("searchPages: every page as the site shows it", async () => {
  const { editor } = await setup(base(), sectionsFile());
  const pages = await editor.searchPages({ siteName: "Cinderella", tagline: "Dresses for grads" });
  const at = (p) => pages.find((x) => x.path === p);
  // Homepage: built from sections, the site name alone, the hero's text.
  assert.deepEqual([at("/").collection, at("/").id, at("/").entryId, at("/").shownTitle, at("/").shownDescription, at("/").descriptionFrom], ["designed", "index", "p1", "Cinderella", "We help grads shine.", "sections"]);
  // About: a designed page over an entry; the entry's seo applies.
  assert.equal(at("/about-us/").collection, "designed");
  assert.equal(at("/about-us/").shownTitle, "About us | Cinderella");
  assert.equal(at("/about-us/").shownDescription, "We help");
  // Contact: from its text; News: from its own image for sharing.
  assert.equal(at("/contact/").descriptionFrom, "text");
  assert.equal(pages.find((x) => x.id === "a").shareImage, "https://media.example/a.webp");
  // Listing pages are there for duplicate checks.
  assert.ok(pages.some((x) => x.listing && x.path === "/news/"));
});
