// How a page looks on Google (Slack), and changing its search title, search description and
// share image through the usual proposal → Approve flow. Claude is faked as in slack-edits.test.js.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createEditor, StaleError } from "../../lib/edit/index.js";
import { proposeEdit, applyProposal, proposalBlocks } from "../src/slack-edits.js";
import { breadcrumb, searchWarnings, previewText } from "../src/search-preview.js";

const specs = JSON.parse(await fs.readFile(new URL("../../config/design-specs.json", import.meta.url), "utf8"));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function memoryStore(initial) {
  let files = { "content.json": structuredClone(initial) };
  let head = 0;
  return {
    files: () => files,
    async read(names) {
      return { files: Object.fromEntries(names.map((n) => [n, files[n] === undefined ? null : structuredClone(files[n])])), head: String(head) };
    },
    async write(out, message, h) {
      if (h !== String(head)) throw new StaleError();
      files = { ...files, ...structuredClone(out) };
      head++;
      return { commitSha: `c${head}`, commitUrl: `https://github.test/commit/c${head}`, message };
    },
  };
}

const LONG = "Cinderella Project gives graduating students free prom dresses, suits, shoes and accessories so every grad can celebrate. Book a free fitting today and bring a friend.";

const base = () => ({
  frontPage: "p1",
  menu: [],
  pages: [
    { id: "p1", slug: "home", title: "Home", content: "<p>Hi</p>" },
    { id: "p2", slug: "about", title: "About", description: "Who we are", content: "<p>About us</p>" },
    { id: "p3", slug: "volunteer", title: "Volunteer with the Cinderella Project and help grads celebrate", description: LONG, content: "<p>x</p>" },
    { id: "p4", slug: "donate", title: "Donate", description: "Who we are", content: "<p>Give</p>", seo: { noindex: true } },
  ],
  posts: [],
  events: [{ id: "e1", slug: "boutique-day", title: "Boutique Day", date: "2026-05-01", content: "<p>Come</p>", image: "https://media.example/e1.webp" }],
  media: [],
});

function setup(content = base(), envOver = {}) {
  const store = memoryStore(content);
  const editor = createEditor({ store, specs });
  const kv = new Map();
  const env = {
    CLAUDE_API_KEY: "k", SITE_NAME: "Cinderella Project", SITE_URL: "https://www.cinderella.example", ...envOver,
    CONTENT: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => (k.startsWith("usage:") ? null : kv.set(k, v)) },
  };
  const queue = [];
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch ${url}`);
    requests.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error("no Claude reply queued");
    return new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(next) }], usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { "content-type": "application/json" } });
  };
  const claude = (...bodies) => queue.push(...bodies);
  return { store, editor, env, requests, claude };
}

const pick = (fields) => ({ action: "reply", collection: null, id: null, typeKey: null, trashId: null, changeId: null, terms: [], from: null, to: null, when: null, days: null, reply: null, summary: "x", ...fields });

test("search preview: title and description as rendered, where they come from, and a hint", async () => {
  const ctx = setup();
  ctx.claude(pick({ action: "searchPreview", collection: "pages", id: "p2" }));
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "how does the About page look on Google?" });
  assert.equal(out.kind, "reply");
  assert.match(out.text, /How “About” looks on Google/);
  assert.match(out.text, />\*About \| Cinderella Project\*/, "page title plus the site name");
  assert.match(out.text, />cinderella\.example › about/);
  assert.match(out.text, />Who we are/);
  assert.match(out.text, /the page's summary, because it has no search description/);
  assert.match(out.text, /short \(10 characters\)/);
  assert.match(out.text, /same as on “Donate”/, "Donate has the same summary");
  assert.match(out.text, /Ask me to change the search title or description, e\.g\. “make the search description for About mention …”/);
  assert.doesNotMatch(out.text, /\bSEO\b|\bmeta\b/i, "staff never see SEO or meta");
  // The classify step knows about the new action; nothing is proposed.
  assert.ok(ctx.requests[0].output_config.format.schema.properties.action.enum.includes("searchPreview"));
  assert.equal(ctx.requests.length, 1);
});

test("search preview: long title and description, hidden pages, homepage and its tagline", async () => {
  const ctx = setup(base(), { SITE_TAGLINE: "Every grad deserves a night to remember" });
  ctx.claude(pick({ action: "searchPreview", collection: "pages", id: "p3" }));
  const long = (await proposeEdit(ctx.env, ctx.editor, { text: "search preview for volunteer" })).text;
  assert.match(long, /The title is 83 characters; Google usually shows about 60/);
  assert.match(long, /The description is 158 characters; Google usually shows about 155/);

  ctx.claude(pick({ action: "searchPreview", collection: "pages", id: "p4" }));
  assert.match((await proposeEdit(ctx.env, ctx.editor, { text: "donate page on google?" })).text, /hidden from search engines/);

  ctx.claude(pick({ action: "searchPreview", collection: "pages", id: "nope" }));
  assert.match((await proposeEdit(ctx.env, ctx.editor, { text: "how does nope look on google" })).text, /couldn't find that page/);

  // The homepage: the site name alone; with no summary of its own, the tagline.
  const home = setup({ ...base(), pages: [{ id: "p1", slug: "home", title: "Home", content: "" }] }, { SITE_TAGLINE: "Every grad deserves a night to remember" });
  home.claude(pick({ action: "searchPreview" }));
  const text = (await proposeEdit(home.env, home.editor, { text: "how does our site look on Google" })).text;
  assert.match(text, /How the homepage looks on Google/);
  assert.match(text, />\*Cinderella Project\*\n>cinderella\.example\n>Every grad deserves a night to remember/);
  assert.match(text, /the site's tagline/);

  // Unknown tagline (not given to the Worker): shown as a placeholder, not measured.
  const unknown = setup({ ...base(), pages: [{ id: "p1", slug: "home", title: "Home", content: "" }] });
  unknown.claude(pick({ action: "searchPreview" }));
  assert.match((await proposeEdit(unknown.env, unknown.editor, { text: "google preview" })).text, /your site's tagline/);
});

test("search preview: designed pages use their search values and first text", async () => {
  const ctx = setup();
  ctx.store.files()["sections.json"] = { pages: { about: { seo: { title: "About the Cinderella Project", description: LONG.slice(0, 140) }, sections: [{ type: "split", title: "Mission", paragraphs: ["We help"] }] } } };
  ctx.claude(pick({ action: "searchPreview", collection: "designed", id: "about" }));
  const text = (await proposeEdit(ctx.env, ctx.editor, { text: "how does about look on google" })).text;
  assert.match(text, />\*About the Cinderella Project\*/, "used exactly as written");
  assert.match(text, /Title: its search title\. Description: its search description\./);
  assert.match(text, /✅/);
  // Claude may also pick the entry the designed page replaces.
  assert.equal(searchWarnings({ shownTitle: "A", shownDescription: "" }, []).length, 1);
  assert.equal(breadcrumb(null, "/about/"), "/about/");
});

test("previewText: share image line and duplicate titles", () => {
  const a = { title: "News", path: "/news/x/", shownTitle: "News | Site", titleFrom: "page", shownDescription: "x".repeat(130), descriptionFrom: "summary", shareImage: "https://m.example/a.webp", seo: null };
  const b = { ...a, title: "Other", path: "/other/", shareImage: null };
  const text = previewText(a, [a, b], { siteUrl: "https://site.example" });
  assert.match(text, /<https:\/\/m\.example\/a\.webp\|the page's main photo>/);
  assert.match(text, /title is the same as on “Other”/);
  assert.match(previewText(b, [b]), /none of its own/);
});

test("changing the search description: proposal → Approve, saved in entry.seo, undoable", async () => {
  const ctx = setup();
  ctx.claude(
    pick({ action: "update", collection: "pages", id: "p2", summary: "Search description" }),
    { title: null, description: null, imageAlt: null, searchTitle: null, searchDescription: "Free prom dresses and suits for graduating students in Vancouver. Book a free fitting with the Cinderella Project.", contentEdits: [], summary: "Search description mentions free prom dresses" },
  );
  const { proposal } = await proposeEdit(ctx.env, ctx.editor, { text: "make the search description for About mention free prom dresses", by: "Sam" });
  assert.deepEqual(Object.keys(proposal.changes), ["seo.description"]);
  assert.deepEqual(proposal.before, { "seo.description": null });
  // The drafting prompt explains the search fields.
  assert.match(ctx.requests[1].system, /search title and search description: shown only in Google results/);
  assert.match(ctx.requests[1].messages[0].content, /"searchDescription":null/);
  const blocks = JSON.stringify(proposalBlocks(proposal).blocks);
  assert.match(blocks, /Search description/);
  assert.doesNotMatch(blocks, /\bSEO\b|seo\.description/);

  await applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" });
  const saved = ctx.store.files()["content.json"].pages[1];
  assert.equal(saved.seo.description, proposal.changes["seo.description"]);
  assert.equal(saved.description, "Who we are", "the visible summary is untouched");

  ctx.claude(pick({ action: "undo", changeId: proposal.id }));
  const undo = (await proposeEdit(ctx.env, ctx.editor, { text: "undo that" })).proposal;
  assert.deepEqual(undo.changes, { "seo.description": null });
  await applyProposal(ctx.env, ctx.editor, undo.id, { by: "Sam" });
  assert.ok(!("seo" in ctx.store.files()["content.json"].pages[1]));
});

test("designed page: search title offered as a value next to the sections; too long is refused", async () => {
  const ctx = setup();
  ctx.store.files()["sections.json"] = { pages: { "/": { sections: [{ type: "hero", title: "Welcome", text: "Open 10–4" }] } } };
  ctx.claude(
    pick({ action: "update", collection: "designed", id: "index" }),
    { edits: [{ slot: "seo.title", value: "Free Prom Dresses for Grads | Cinderella Project" }], summary: "Homepage search title" },
  );
  const { proposal } = await proposeEdit(ctx.env, ctx.editor, { text: "change the homepage's search title to Free Prom Dresses for Grads" });
  const slotEnum = ctx.requests[1].output_config.format.schema.properties.edits.items.properties.slot.enum;
  assert.ok(slotEnum.includes("seo.title") && slotEnum.includes("seo.description"));
  assert.match(ctx.requests[1].system, /How it looks on Google/);
  assert.equal(proposal.fieldLabels["seo.title"], "How it looks on Google › Search title");
  await applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" });
  assert.equal(ctx.store.files()["sections.json"].pages["/"].seo.title, "Free Prom Dresses for Grads | Cinderella Project");

  ctx.claude(pick({ action: "update", collection: "designed", id: "index" }), { edits: [{ slot: "seo.title", value: "x".repeat(130) }], summary: "x" });
  assert.match((await proposeEdit(ctx.env, ctx.editor, { text: "longer search title" })).text, /Search title: Max 120 characters/);
});

const PHOTO = { name: "share.jpg", preview: { mediaType: "image/jpeg", data: "AAAA" } };
const photoChoice = (over) => ({ action: "setImage", collection: null, id: null, slot: null, typeKey: null, imageAlt: "Grads in gowns", reply: null, summary: "x", ...over });

function fakeStore() {
  const calls = [];
  const storeImage = async (typeSpec, contentId) => {
    calls.push({ typeSpec, contentId });
    const at = `https://media.example/media/uploads/slack-${contentId}`;
    return { image: `${at}/1200.webp`, images: [`${at}/1200.webp`], variants: { 1200: `${at}/1200.webp` } };
  };
  return { calls, storeImage };
}

test("share image: a posted photo becomes a page's share image, cropped for link previews; undo clears it", async () => {
  const ctx = setup();
  const store = fakeStore();
  ctx.claude(photoChoice({ action: "shareImage", collection: "events", id: "e1", summary: "New share image for Boutique Day" }));
  const { proposal } = await proposeEdit(ctx.env, ctx.editor, { text: "use this as the share image for Boutique Day", by: "Sam", image: PHOTO, storeImage: store.storeImage });
  assert.equal(proposal.op, "update");
  assert.deepEqual(proposal.changes, { "seo.image": proposal.photo.after });
  assert.equal(proposal.photo.before, "https://media.example/e1.webp", "what a shared link shows now: the main photo");
  assert.equal(store.calls[0].typeSpec.aspectRatio, "1.91:1");
  // Every page is offered when the message is about sharing; the card explains it.
  assert.match(ctx.requests[0].messages[0].content[1].text, /Pages that can get a share image.*"id":"p2"/s);
  const blocks = proposalBlocks(proposal).blocks;
  assert.match(JSON.stringify(blocks), /picture shown when someone shares a link/);
  assert.deepEqual(blocks.filter((b) => b.type === "image").map((b) => b.image_url), ["https://media.example/e1.webp", proposal.photo.after]);
  assert.ok(!JSON.stringify(blocks).includes("*Share image*"), "the address isn't listed as a text change");

  await applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" });
  const saved = ctx.store.files()["content.json"].events[0];
  assert.equal(saved.seo.image, proposal.photo.after);
  assert.equal(saved.image, "https://media.example/e1.webp", "the page's own photo is untouched");

  ctx.claude(pick({ action: "undo", changeId: proposal.id }));
  const undo = (await proposeEdit(ctx.env, ctx.editor, { text: "undo that" })).proposal;
  assert.deepEqual(undo.changes, { "seo.image": null });
  await applyProposal(ctx.env, ctx.editor, undo.id, { by: "Sam" });
  assert.ok(!("seo" in ctx.store.files()["content.json"].events[0]));
});

test("share image: designed pages too; other photo messages don't get the page list", async () => {
  const ctx = setup();
  ctx.store.files()["sections.json"] = { pages: { "/": { sections: [{ type: "hero", title: "Welcome", image: { src: "https://media.example/a.jpg", alt: "" } }] } } };
  ctx.claude(photoChoice({ action: "shareImage", collection: "designed", id: "index", summary: "Homepage share image" }));
  const { proposal } = await proposeEdit(ctx.env, ctx.editor, { text: "use this as the share image for the homepage", image: PHOTO, storeImage: fakeStore().storeImage });
  assert.equal(proposal.collection, "designed");
  await applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" });
  assert.equal(ctx.store.files()["sections.json"].pages["/"].seo.image, proposal.photo.after);

  ctx.claude(photoChoice({ action: "setImage", collection: "events", id: "e1" }));
  await proposeEdit(ctx.env, ctx.editor, { text: "new photo for Boutique Day", image: PHOTO, storeImage: fakeStore().storeImage });
  assert.doesNotMatch(ctx.requests[1].messages[0].content[1].text, /share image/);
});
