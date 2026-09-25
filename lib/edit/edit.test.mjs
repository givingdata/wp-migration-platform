// node --test lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditor, EditError, StaleError } from "./index.js";
import { fileStore } from "./stores/file.js";
import { cleanHtml, plainText } from "./sanitize.js";
import { contentTypes } from "../content-types.js";
import { handleEditRoute } from "../../worker/src/edit-routes.js";
import { sign } from "../../worker/src/auth.js";

const specs = JSON.parse(await fs.readFile(new URL("../../config/design-specs.json", import.meta.url), "utf8"));

async function setup(content, specOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-"));
  await fs.writeFile(path.join(dir, "content.json"), JSON.stringify(content));
  const editor = createEditor({ store: fileStore(dir), specs: { ...specs, ...specOverrides } });
  const read = async (f) => JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
  return { dir, editor, read };
}

const base = () => ({
  frontPage: "10",
  menu: [{ title: "About", url: "https://old.example/about-us/", children: [] }],
  pages: [
    { id: "p1", wpId: 10, slug: "home", title: "Home", content: "<p>Hi</p>" },
    { id: "p2", wpId: 11, slug: "about-us", title: "About us", content: "<p>About</p>" },
  ],
  posts: [{ id: "a", slug: "old-news", title: "Old news", date: "2026-01-01", content: "<p>x</p>" }],
  exhibitions: [{ id: "x", slug: "show", title: "A show", date: "2025-05-01" }],
  media: [],
});

test("content types: defaults are News, Event, Announcement; exhibition stays readable", () => {
  const types = contentTypes(specs);
  assert.deepEqual(Object.keys(types).filter((k) => types[k].enabled), ["post", "event", "announcement"]);
  assert.equal(types.post.label, "News");
  assert.equal(types.exhibition.enabled, false);
  assert.equal(types.exhibition.collection, "exhibitions");
});

test("list, get and update with a version check", async () => {
  const { editor, read } = await setup(base());
  const { collections } = await editor.list();
  assert.deepEqual(Object.keys(collections), ["pages", "posts", "events", "announcements", "exhibitions"]);
  assert.equal(collections.pages.find((p) => p.id === "p1").frontPage, true);

  assert.equal(collections.pages.find((p) => p.id === "p1").path, "/");
  assert.equal(collections.pages.find((p) => p.id === "p2").path, "/about-us/");
  const opened = await editor.get("pages", "p2");
  assert.equal(opened.inMenu, true);
  assert.equal(opened.path, "/about-us/");
  const saved = await editor.update("pages", "p2", { title: "About the project", content: '<p onclick="x()">New</p><script>bad()</script>' }, { version: opened.version, by: "staff@example.org" });
  assert.equal(saved.entry.content, "<p>New</p>");
  assert.equal(saved.entry.slug, "about-us", "slug never changes");
  const file = await read("content.json");
  assert.equal(file.pages[1].title, "About the project");
  assert.equal(file.pages[1].modifiedBy, "staff@example.org");

  // A second save with the old version is refused.
  await assert.rejects(editor.update("pages", "p2", { title: "Other" }, { version: opened.version }), (e) => e instanceof EditError && e.status === 409);
});

test("update validates fields for the entry's type", async () => {
  const { editor } = await setup(base());
  await assert.rejects(editor.update("posts", "a", { date: "yesterday" }), (e) => e.status === 400 && !!e.details.date);
  await assert.rejects(editor.update("posts", "a", { title: "" }), (e) => e.details.title === "Required");
  // Fields the type doesn't have (posts have no location) are ignored.
  await assert.rejects(editor.update("posts", "a", { location: "Hall" }), /Nothing to save/);
});

test("delete moves the entry to trash, restore brings it back", async () => {
  const { editor, read } = await setup(base());
  const del = await editor.remove("posts", "a", { by: "staff@example.org", reason: "duplicate" });
  let content = await read("content.json");
  assert.equal(content.posts.length, 0);
  const trash = await read("trash.json");
  assert.equal(trash.deleted[0].entry.title, "Old news");
  assert.equal(trash.deleted[0].deletedBy, "staff@example.org");
  assert.equal((await editor.list()).trashCount, 1);

  const back = await editor.restore(del.trashId, { by: "staff@example.org" });
  assert.equal(back.slugChanged, false);
  content = await read("content.json");
  assert.equal(content.posts[0].slug, "old-news");
  assert.equal((await read("trash.json")).deleted.length, 0);
});

test("restoring keeps links unique if the slug was reused meanwhile", async () => {
  const { editor } = await setup(base());
  const del = await editor.remove("posts", "a");
  await editor.create("post", { title: "Old news", date: "2026-02-02", content: "<p>again</p>" });
  const back = await editor.restore(del.trashId);
  assert.equal(back.entry.slug, "old-news-2");
});

test("the homepage can't be deleted", async () => {
  const { editor } = await setup(base());
  await assert.rejects(editor.remove("pages", "p1"), /homepage/);
});

test("paths match the site: a post sharing a page's slug is prefixed with its type", async () => {
  const content = base();
  content.posts.push({ id: "b", slug: "about-us", title: "About us (news)", date: "2026-01-02" });
  const { editor } = await setup(content);
  assert.equal((await editor.get("posts", "b")).path, "/post/about-us/");
  assert.equal((await editor.get("pages", "p2")).path, "/about-us/");
});

test("create assigns unique slugs and refuses types that aren't enabled", async () => {
  const { editor, read } = await setup(base());
  const r = await editor.create("announcement", { title: "Office closed", date: "2026-10-01", linkUrl: "https://example.org" });
  assert.equal(r.collection, "announcements");
  assert.equal((await read("content.json")).announcements[0].slug, "office-closed");
  const again = await editor.create("post", { title: "Office closed", date: "2026-10-01" });
  assert.equal(again.entry.slug, "office-closed-2");
  await assert.rejects(editor.create("exhibition", { title: "New show" }), /Unknown content type/);
});

test("a write that loses a race is retried on the new data", async () => {
  const { dir, editor, read } = await setup(base());
  const store = fileStore(dir);
  let raced = false;
  const racing = createEditor({
    specs,
    store: {
      read: (f) => store.read(f),
      async write(files, msg, head) {
        if (!raced) {
          raced = true;
          await editor.create("post", { title: "Sneaky", date: "2026-03-03" });
        }
        return store.write(files, msg, head);
      },
    },
  });
  await racing.update("posts", "a", { title: "Renamed" });
  const content = await read("content.json");
  assert.deepEqual(content.posts.map((p) => p.title).sort(), ["Renamed", "Sneaky"]);
});

test("cleanHtml keeps WordPress markup but drops script", () => {
  assert.equal(cleanHtml('<div class="ngg-gallery" style="x"><img src="a.jpg" onerror="x"></div>'), '<div class="ngg-gallery" style="x"><img src="a.jpg"></div>');
  assert.equal(cleanHtml('<a href="javascript:alert(1)">x</a>'), '<a href="#">x</a>');
  assert.equal(cleanHtml('<a href=" jav&#x09;ascript:alert(1)">x</a>'), '<a href="#">x</a>');
  assert.equal(cleanHtml("<scr<script>x</script>ipt>alert(1)</script>"), "alert(1)");
  assert.equal(cleanHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>'), '<iframe src="https://www.youtube.com/embed/x"></iframe>');
  assert.equal(plainText("5 < 6 and <b>bold</b>"), "5 < 6 and bold");
});

test("worker routes: signed changes, key-only reads", async () => {
  const { editor } = await setup(base());
  const env = { API_KEY: "k" };
  const call = async (method, url, body) => {
    const raw = body ? new TextEncoder().encode(JSON.stringify(body)) : new Uint8Array();
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { Authorization: "Bearer k", "X-Timestamp": ts, "X-Signature": await sign("k", ts, raw), "Content-Type": "application/json" };
    return handleEditRoute(new Request(`https://w.example${url}`, { method, headers, body: method === "GET" ? undefined : raw }), env, () => editor);
  };
  const list = await call("GET", "/entries");
  assert.equal(list.body.collections.posts.length, 1);
  const got = await call("GET", "/entries/pages/p2");
  const put = await call("PUT", "/entries/pages/p2", { changes: { title: "Changed" }, version: got.body.version, by: "me" });
  assert.equal(put.body.entry.title, "Changed");
  const del = await call("DELETE", "/entries/posts/a", { reason: "old" });
  const trash = await call("GET", "/trash");
  assert.equal(trash.body.items[0].trashId, del.body.trashId);
  const restored = await call("POST", `/trash/${del.body.trashId}/restore`, {});
  assert.equal(restored.body.entry.id, "a");
  assert.equal(await call("GET", "/nope"), null);

  // Changes without a valid signature are refused.
  const forged = new Request("https://w.example/entries/posts/a", { method: "DELETE", headers: { Authorization: "Bearer k" }, body: "{}" });
  await assert.rejects(handleEditRoute(forged, env, () => editor), /timestamp/i);
});

test("createPage stores the text as written, with a free address", async () => {
  const { editor, read } = await setup(base());
  const r = await editor.createPage({ title: "News", content: "<p>Hello <script>x()</script></p>" }, { by: "me" });
  assert.equal(r.entry.slug, "news-2", "/news/ is the news listing, so the page gets another address");
  assert.equal(r.path, "/news-2/");
  assert.equal(r.entry.content, "<p>Hello </p>");
  assert.equal((await read("content.json")).pages.at(-1).createdBy, "me");
  await assert.rejects(editor.createPage({ content: "<p>x</p>" }), (e) => e.details?.title === "Required");
});

test("menu: read with local addresses, save with checks and a version", async () => {
  const content = base();
  content.siteUrl = "https://old.example";
  content.menu = [
    { title: "About", url: "https://old.example/about-us/", children: [{ title: "Old news", url: "/old-news/", children: [] }] },
    { title: "Elsewhere", url: "https://other.org/x", children: [] },
  ];
  const { editor, read } = await setup(content, { menu: { topLevel: "editable" } });
  const got = await editor.getMenu();
  assert.equal(got.menu[0].path, "/about-us/");
  assert.equal(got.menu[0].children[0].path, "/old-news/");
  assert.equal(got.menu[1].path, "https://other.org/x");
  assert.ok(got.targets.some((t) => t.path === "/news/"), "listing pages can be linked");

  const next = [{ title: "Home", url: "/", children: [] }, ...got.menu.map(({ title, url, children }) => ({ title, url, children }))];
  await editor.saveMenu(next, { version: got.version, by: "me" });
  const file = await read("content.json");
  assert.equal(file.menu[0].title, "Home");
  assert.ok(file.menuEditedAt);
  await assert.rejects(editor.saveMenu(next, { version: got.version }), (e) => e.status === 409);

  await assert.rejects(editor.saveMenu([{ title: "Bad", url: "javascript:alert(1)", children: [] }]), (e) => e.status === 400);
  await assert.rejects(editor.saveMenu([{ title: "A", url: null, children: [{ title: "B", url: "/b/", children: [{ title: "C", url: "/c/" }] }] }]), /needs fixing/);
  await assert.rejects(editor.saveMenu([{ title: "", url: "/x/", children: [] }]), /needs fixing/);
});

test("deleting a page can take its menu link out; restoring puts it back", async () => {
  const content = base();
  content.menu = [
    { title: "About", url: "/about-us/", children: [{ title: "Team", url: "/team/", children: [] }, { title: "About again", url: "https://old.example/about-us/", children: [] }] },
    { title: "Contact", url: "/contact/", children: [] },
  ];
  const { editor, read } = await setup(content, { menu: { topLevel: "editable" } });
  const del = await editor.remove("pages", "p2", { removeFromMenu: true });
  assert.equal(del.removedFromMenu, 2);
  let menu = (await read("content.json")).menu;
  assert.deepEqual(menu.map((m) => m.title), ["About", "Contact"]);
  assert.deepEqual(menu[0].children.map((m) => m.title), ["Team"]);
  assert.equal(menu[0].url, null, "the dropdown heading stays, without its link");

  const back = await editor.restore(del.trashId);
  assert.equal(back.menuRestored, true);
  menu = (await read("content.json")).menu;
  assert.deepEqual(menu[0].children.map((m) => m.title), ["Team", "About again"]);
  assert.equal(menu[0].url, "/about-us/");
});

test("locked menu bar: dropdown links can change, the top level can't", async () => {
  const content = base();
  content.pages.push({ id: "p3", slug: "team", title: "Team", content: "<p>t</p>" });
  content.menu = [
    { title: "About", url: "/about-us/", children: [{ title: "Team", url: "/team/", children: [] }] },
    { title: "Contact", url: "/contact/", children: [] },
  ];
  const { editor, read } = await setup(content);
  const got = await editor.getMenu();
  assert.equal(got.topLevelLocked, true);
  const plain = (m) => m.map(({ title, url, children }) => ({ title, url, children: children.map(({ title, url }) => ({ title, url, children: [] })) }));

  // Inside a dropdown: add, rename, reorder: fine.
  const ok = plain(got.menu);
  ok[0].children.unshift({ title: "Old news", url: "/old-news/", children: [] });
  ok[0].children[1].title = "Our team";
  const saved = await editor.saveMenu(ok, { version: got.version });
  assert.deepEqual((await read("content.json")).menu[0].children.map((c) => c.title), ["Old news", "Our team"]);

  const tries = {
    add: (m) => m.push({ title: "New", url: "/x/", children: [] }),
    rename: (m) => { m[1].title = "Contact us"; },
    reorder: (m) => m.reverse(),
    remove: (m) => m.pop(),
    newDropdown: (m) => m[1].children.push({ title: "Map", url: "/map/", children: [] }),
  };
  for (const [name, change] of Object.entries(tries)) {
    const m = plain(ok);
    change(m);
    await assert.rejects(editor.saveMenu(m, { version: saved.version }), (e) => e.status === 403, name);
  }

  // Pages linked from the menu bar can't be deleted; pages in a dropdown can.
  assert.equal((await editor.get("pages", "p2")).inTopMenu, true);
  await assert.rejects(editor.remove("pages", "p2", { removeFromMenu: true }), /main menu bar/);
  const del = await editor.remove("pages", "p3", { removeFromMenu: true });
  assert.equal(del.removedFromMenu, 1);
});

// ---- Designed pages (sections.json) -------------------------------------------------------

const sectionsFile = () => ({
  site: { header: { style: "band" } },
  pages: {
    "/": {
      sections: [
        { type: "hero", title: "Every graduate", accent: "celebrated.", text: "Intro", buttons: [{ label: "Donate", href: "/donations/" }], image: { src: "https://media.example/a.jpg", alt: "" }, stats: [{ value: "5,500+", label: "youth" }] },
        { type: "cards", eyebrow: "What we do", title: "Support", items: [{ title: "Boxes", text: "Care packages", href: "/boxes/", linkLabel: "See" }] },
        { type: "text", title: "Where", paragraphs: ["One", "Two"], list: ["Vancouver"] },
      ],
    },
    "about-us": { sections: [{ type: "split", title: "Mission", paragraphs: ["We help"], quote: { text: "Me?", by: "A student" } }] },
    "how-to-help": { content: "after", sections: [{ type: "quote", text: "Thanks" }] },
  },
});

async function setupDesigned() {
  const t = await setup({ ...base(), pages: [...base().pages, { id: "p3", slug: "how-to-help", title: "How To Help", content: "<p>Old</p>" }] });
  await fs.writeFile(path.join(t.dir, "sections.json"), JSON.stringify(sectionsFile()));
  return t;
}

test("designed pages: listed first, and the pages they replace are hidden", async () => {
  const { editor } = await setupDesigned();
  const { collections } = await editor.list();
  assert.equal(Object.keys(collections)[0], "designed");
  assert.deepEqual(collections.designed.map((d) => [d.id, d.title, d.path, d.frontPage]), [
    ["index", "Home", "/", true],
    ["about-us", "About us", "/about-us/", false],
    ["how-to-help", "How To Help", "/how-to-help/", false],
  ]);
  // Home and About us are only shown through their sections; How To Help also shows its own text ("content": "after").
  assert.deepEqual(collections.pages.map((p) => p.id), ["p3"]);
  // Opening a hidden page points to its designed version.
  assert.deepEqual((await editor.get("pages", "p2")).designedPage, { collection: "designed", id: "about-us" });
  assert.equal((await editor.get("pages", "p3")).designedPage, undefined);
});

test("designed pages: get returns slots; update changes text, links and images only", async () => {
  const { editor, read } = await setupDesigned();
  const opened = await editor.get("designed", "index");
  assert.equal(opened.designed, true);
  assert.equal(opened.path, "/");
  const slots = Object.fromEntries(opened.entry.sections.flatMap((s) => s.slots).map((s) => [s.slot, s]));
  assert.equal(opened.entry.sections[1].label, "Section 2 · Cards: What we do");
  assert.equal(slots["0.title"].value, "Every graduate");
  assert.equal(slots["0.buttons.0.href"].kind, "url");
  assert.equal(slots["0.image.src"].kind, "image");
  assert.equal(slots["1.items.0.text"].label, "Card 1 text");
  assert.equal(slots["2.paragraphs.1"].label, "Paragraph 2");
  assert.equal(slots["2.eyebrow"].value, "", "optional small heading can be filled in");

  const saved = await editor.update("designed", "index", {
    "0.title": "Every <b>student</b>", "1.items.0.href": "https://example.org/", "0.image.src": "https://media.example/new.webp", "2.eyebrow": "Area",
  }, { version: opened.version, by: "staff@example.org" });
  assert.deepEqual(saved.changed.sort(), ["0.image.src", "0.title", "1.items.0.href", "2.eyebrow"]);
  const file = await read("sections.json");
  const home = file.pages["/"];
  assert.equal(home.sections[0].title, "Every student", "tags removed");
  assert.equal(home.sections[0].image.src, "https://media.example/new.webp");
  assert.equal(home.sections[1].items[0].href, "https://example.org/");
  assert.equal(home.sections[2].eyebrow, "Area");
  assert.equal(home.modifiedBy, "staff@example.org");
  assert.deepEqual(file.site, sectionsFile().site, "site settings untouched");
  assert.equal(home.sections.length, 3);

  // The old version is refused.
  await assert.rejects(editor.update("designed", "index", { "0.text": "x" }, { version: opened.version }), (e) => e.status === 409);
});

test("designed pages: structure can't change and values are checked", async () => {
  const { editor, read } = await setupDesigned();
  const before = await read("sections.json");
  const bad = async (changes) => assert.rejects(editor.update("designed", "about-us", changes), (e) => e instanceof EditError && e.status === 400 && !!e.details);
  await bad({ "0.type": "hero" });                  // retype
  await bad({ "1.title": "New section" });          // add a section
  await bad({ "0.paragraphs.1": "Extra paragraph" }); // add a list item
  await bad({ "0.reverse": "true" });               // a design switch
  await bad({ "0.title": "" });                     // required
  await bad({ "0.paragraphs.0": ["x"] });           // not text
  await bad({ "0.title": "x".repeat(301) });
  const home = async (changes) => assert.rejects(editor.update("designed", "index", changes), (e) => e.status === 400);
  await home({ "0.buttons.0.href": "javascript:alert(1)" });
  await home({ "0.image.src": "data:image/png;base64,xx" });
  await assert.rejects(editor.update("designed", "nope", { "0.title": "x" }), (e) => e.status === 404);
  await assert.rejects(editor.remove("designed", "index"), (e) => e.status === 409);
  assert.deepEqual(await read("sections.json"), before, "nothing written");

  // Optional values can be emptied.
  await editor.update("designed", "about-us", { "0.quote.by": "" });
  assert.equal((await read("sections.json")).pages["about-us"].sections[0].quote.by, "");
});

test("worker routes: designed pages use /entries/designed", async () => {
  const { editor } = await setupDesigned();
  const env = { API_KEY: "k" };
  const call = async (method, url, body) => {
    const raw = body ? new TextEncoder().encode(JSON.stringify(body)) : new Uint8Array();
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { Authorization: "Bearer k", "X-Timestamp": ts, "X-Signature": await sign("k", ts, raw), "Content-Type": "application/json" };
    return handleEditRoute(new Request(`https://w.example${url}`, { method, headers, body: method === "GET" ? undefined : raw }), env, () => editor);
  };
  const got = await call("GET", "/entries/designed/index");
  assert.equal(got.body.entry.sections.length, 3);
  const put = await call("PUT", "/entries/designed/index", { changes: { "0.text": "New intro" }, version: got.body.version, by: "me" });
  assert.equal(put.body.success, true);
  assert.equal(put.body.entry.sections[0].slots.find((s) => s.slot === "0.text").value, "New intro");
});
