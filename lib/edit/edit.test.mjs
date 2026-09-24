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

async function setup(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-"));
  await fs.writeFile(path.join(dir, "content.json"), JSON.stringify(content));
  const editor = createEditor({ store: fileStore(dir), specs });
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

  const opened = await editor.get("pages", "p2");
  assert.equal(opened.inMenu, true);
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
