// Photo descriptions from Slack, with Claude, the photos and Slack faked: the bot finds photos
// with no description, Claude describes them, one card proposes them, and only Approve writes
// (through the Edit module, so undo works too). A reply in the card's thread can change one.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createEditor, StaleError } from "../../lib/edit/index.js";
import { proposeEdit, applyProposal, getProposal, proposalBlocks, resultBlocks } from "../src/slack-edits.js";
import {
  imgTags, withAlt, setAlts, photosWithoutDescriptions, tidyDescription, parseRevisions, reviseProposal, rememberCard, reviseFromThread,
} from "../src/photo-descriptions.js";

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

const ABOUT_HTML = [
  "<h2>Our story</h2>",
  '<p>We started in a church basement in 1998.</p><img src="/wp-content/uploads/basement.jpg" class="wp-image-1" width="800">',
  '<p>Today our volunteers run the Saturday market.</p><figure><IMG alt="" src="https://site.test/wp-content/uploads/market.jpg" title="Market day"><figcaption>Market day</figcaption></figure>',
  '<p>Our board.</p><img alt="The board at the 2024 AGM" src="https://site.test/board.jpg">',
].join("\n");

const base = () => ({
  frontPage: "p1",
  menu: [],
  pages: [
    { id: "p1", slug: "home", title: "Home", content: "<p>Hi</p>" },
    { id: "p2", slug: "about", title: "About", content: ABOUT_HTML },
    { id: "p3", slug: "contact", title: "Contact", content: '<p>Find us here.</p><img src="https://site.test/map.png">' },
  ],
  posts: [{ id: "n1", slug: "coat-drive", title: "Coat drive", date: "2026-01-01", content: "<p>Thanks!</p>", image: "https://site.test/coats.jpg" }],
  events: [],
  media: [],
});

// Claude answers queued replies in order; photos under https://site.test/ are tiny JPEGs, except `missing`.
function setup(content = base(), { missing = [] } = {}) {
  const store = memoryStore(content);
  const editor = createEditor({ store, specs });
  const kv = new Map();
  const env = {
    CLAUDE_API_KEY: "k", SITE_NAME: "Test Food Bank", SITE_URL: "https://site.test",
    CONTENT: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void (k.startsWith("usage:") || kv.set(k, v)), delete: async (k) => void kv.delete(k) },
  };
  const queue = [];
  const requests = [];
  const photos = [];
  const slack = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith("https://site.test/")) {
      photos.push(u);
      if (missing.some((m) => u.includes(m))) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }
    if (u.startsWith("https://slack.com/api/")) {
      const method = u.split("/").pop();
      if (method === "users.info") return new Response(JSON.stringify({ ok: true, user: { profile: { email: "staff@example.org" } } }));
      slack.push({ method, ...JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, ts: "t9" }));
    }
    if (!u.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch ${u}`);
    requests.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error("no Claude reply queued");
    return new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(next) }], usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { "content-type": "application/json" } });
  };
  const claude = (...bodies) => queue.push(...bodies);
  return { store, editor, env, kv, requests, photos, slack, claude };
}

const choose = (collection = null, id = null) => ({
  action: "describePhotos", collection, id, typeKey: null, trashId: null, changeId: null, terms: [], from: null, to: null, when: null, days: null, reply: null, summary: "Describe photos",
});
const described = (...texts) => ({ descriptions: texts.map((description, i) => ({ n: i + 1, description })) });

test("img tags: exact matching, other attributes kept, quotes escaped", () => {
  const html = '<p>a > b</p><img src="x.jpg" data-x="1 > 2"><IMG ALT="" src=\'y.jpg\' /><img alt src=z.jpg><img alt="ok" src="w.jpg">';
  const tags = imgTags(html);
  assert.equal(tags.length, 4);
  assert.equal(tags[0].tag, '<img src="x.jpg" data-x="1 > 2">', "a > inside a quoted value doesn't end the tag");
  assert.equal(withAlt(tags[0].tag, 'Say "cheese" & <smile>'), '<img alt="Say &quot;cheese&quot; &amp; &lt;smile&gt;" src="x.jpg" data-x="1 > 2">');
  assert.equal(withAlt(tags[1].tag, "Y"), "<IMG alt=\"Y\" src='y.jpg' />", "an empty alt is replaced where it is");
  assert.equal(withAlt(tags[2].tag, "Z"), '<img alt="Z" src=z.jpg>', "a bare alt gets a value");
  const out = setAlts(html, new Map([[1, "Y"], [2, "Z"]]));
  assert.equal(out, html.replace("ALT=\"\"", 'alt="Y"').replace("<img alt src", '<img alt="Z" src'), "only the chosen tags change");
});

test("finding: body photos without a description, the main photo, srcset and lazy loading", () => {
  const entry = {
    title: "X", image: "https://site.test/main.jpg", imageVariants: { 400: "https://site.test/main-400.webp", 800: "https://site.test/main-800.webp" },
    content: '<p>Before the first photo, some words.</p><img src="data:image/gif;base64,R0" data-src="/lazy.jpg"><img src="big.jpg" srcset="/s-300.jpg 300w, /s-768.jpg 768w, /s-1600.jpg 1600w"><img alt=" Has one " src="/x.jpg">',
  };
  const found = photosWithoutDescriptions({ entry }, "https://site.test");
  assert.deepEqual(found.map((p) => [p.kind, p.index ?? null, p.src]), [
    ["main", null, "https://site.test/main-800.webp"],
    ["content", 0, "https://site.test/lazy.jpg"],
    ["content", 1, "https://site.test/s-768.jpg"],
  ]);
  assert.match(found[1].where, /^In the text, after “Before the first photo, some words\.”$/);
  assert.equal(photosWithoutDescriptions({ entry: { ...entry, imageAlt: "Done" } }, "https://site.test").length, 2);
});

test("descriptions are tidied: no 'photo of', capitalised, cut at a word under 150", () => {
  assert.equal(tidyDescription("A photo of volunteers  sorting\ncans"), "Volunteers sorting cans");
  const long = tidyDescription("word ".repeat(60));
  assert.ok(long.length < 150 && !long.endsWith(" "));
});

test("a named page: Claude sees each photo with its context; one card; Approve sets the alts; undo takes them off", async () => {
  const ctx = setup();
  ctx.claude(choose("pages", "p2"), described("People unpacking boxes in a church basement", "An image of shoppers at an outdoor market stall"));
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Describe the photos on the About page", by: "Sam", requestedBy: "U123ABC" });
  assert.equal(out.kind, "proposal");
  const p = out.proposal;
  assert.equal(p.op, "update");
  assert.equal(p.entryId, "p2");
  assert.deepEqual(p.descriptions.map((d) => [d.n, d.kind, d.index, d.src, d.alt]), [
    [1, "content", 0, "https://site.test/wp-content/uploads/basement.jpg", "People unpacking boxes in a church basement"],
    [2, "content", 1, "https://site.test/wp-content/uploads/market.jpg", "Shoppers at an outdoor market stall"],
  ]);
  assert.equal(p.remaining, 0);
  assert.equal(p.otherPages, 2, "Contact and the coat drive still need theirs");
  assert.deepEqual(Object.keys(p.changes), ["content"]);
  assert.deepEqual(p.before, { content: ABOUT_HTML });
  assert.ok(p.changes.content.includes('<img alt="People unpacking boxes in a church basement" src="/wp-content/uploads/basement.jpg" class="wp-image-1" width="800">'));
  assert.ok(p.changes.content.includes('<IMG alt="Shoppers at an outdoor market stall" src="https://site.test/wp-content/uploads/market.jpg" title="Market day">'));
  assert.ok(p.changes.content.includes('<img alt="The board at the 2024 AGM"'), "photos with a description are left alone");

  // Photos first, each labelled with its number, then the page and the text near each.
  const msg = ctx.requests[1].messages[0].content;
  assert.deepEqual(msg.map((b) => b.type), ["text", "image", "text", "image", "text"]);
  assert.equal(msg[0].text, "Photo 1:");
  assert.match(msg[4].text, /"title":"About"/);
  assert.match(msg[4].text, /Market day/);
  assert.match(ctx.requests[1].system, /Never guess who people are/);

  // The card: each photo as an image, numbered, with its description; Approve / Cancel.
  const card = proposalBlocks(p, { siteUrl: "https://site.test" });
  const text = JSON.stringify(card.blocks);
  assert.deepEqual(card.blocks.filter((b) => b.type === "image").map((b) => b.image_url), [p.descriptions[0].src, p.descriptions[1].src]);
  assert.match(text, /Photo descriptions for page “About”/);
  assert.match(text, /#2: Volunteers sorting food donations/, "says how to change one");
  assert.match(text, /2 other pages also have photos without descriptions/);
  assert.ok(!/alt text|SEO/i.test(text));
  assert.equal(card.blocks.at(-1).elements[0].value, p.id);
  assert.equal(ctx.store.files()["content.json"].pages[1].content, ABOUT_HTML, "nothing written before Approve");

  await applyProposal(ctx.env, ctx.editor, p.id, { by: "sam@example.org" });
  assert.equal(ctx.store.files()["content.json"].pages[1].content, p.changes.content);
  assert.match(resultBlocks(await getProposal(ctx.env, p.id), { status: "applied" }).text, /Photo descriptions for page “About”/);

  // Undo: an ordinary proposal that puts the text back, shown as photos with no description.
  ctx.claude({ ...choose(), action: "undo", changeId: p.id });
  const undo = await proposeEdit(ctx.env, ctx.editor, { text: "undo that", by: "Sam" });
  assert.equal(undo.kind, "proposal");
  assert.equal(undo.proposal.changes.content, ABOUT_HTML);
  assert.deepEqual(undo.proposal.descriptions.map((d) => d.alt), ["", ""]);
  assert.match(JSON.stringify(proposalBlocks(undo.proposal).blocks), /no description/);
  await applyProposal(ctx.env, ctx.editor, undo.proposal.id, { by: "sam@example.org" });
  assert.equal(ctx.store.files()["content.json"].pages[1].content, ABOUT_HTML);
});

test("site-wide: the page with the most goes first; a photo that can't be opened is left out and said so", async () => {
  const ctx = setup(base(), { missing: ["market.jpg"] });
  ctx.claude(choose(), described("People unpacking boxes in a church basement"));
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "fix missing photo descriptions", by: "Sam" });
  const p = out.proposal;
  assert.equal(p.entryId, "p2");
  assert.equal(p.descriptions.length, 1);
  assert.equal(p.remaining, 1);
  assert.equal(p.failed, 1);
  assert.match(JSON.stringify(proposalBlocks(p).blocks), /1 more on this page to go: approve these, then ask again\. \(I couldn't open 1 photo/);
  assert.equal(ctx.requests[1].messages[0].content.filter((b) => b.type === "image").length, 1);
});

test("the main photo and a designed page's images; a page with none gets a reply", async () => {
  const ctx = setup();
  ctx.claude(choose("posts", "n1"), described("Racks of donated winter coats"));
  const news = (await proposeEdit(ctx.env, ctx.editor, { text: "describe the photo on the coat drive news", by: "Sam" })).proposal;
  assert.deepEqual(news.changes, { imageAlt: "Racks of donated winter coats" });
  await applyProposal(ctx.env, ctx.editor, news.id, { by: "s" });
  assert.equal(ctx.store.files()["content.json"].posts[0].imageAlt, "Racks of donated winter coats");

  ctx.store.files()["sections.json"] = { pages: { "/": { sections: [{ type: "hero", title: "Welcome", text: "Food for all", image: { src: "https://site.test/hero.jpg", alt: "" } }] } } };
  ctx.claude(choose("designed", "index"), described("A family choosing fresh vegetables"));
  const home = (await proposeEdit(ctx.env, ctx.editor, { text: "describe the homepage photos", by: "Sam" })).proposal;
  assert.equal(home.collection, "designed");
  assert.deepEqual(home.changes, { "0.image.alt": "A family choosing fresh vegetables" });
  assert.match(ctx.requests.at(-1).messages[0].content.at(-1).text, /Food for all/, "the section's words are context");
  await applyProposal(ctx.env, ctx.editor, home.id, { by: "s" });
  assert.equal(ctx.store.files()["sections.json"].pages["/"].sections[0].image.alt, "A family choosing fresh vegetables");

  ctx.claude(choose("pages", "p1"));
  const none = await proposeEdit(ctx.env, ctx.editor, { text: "describe the photos on the home page", by: "Sam" });
  assert.equal(none.kind, "reply");
  assert.match(none.text, /Every photo on “Home” already has a description/);
});

test("a card holds at most 10 photos and says how many are left", async () => {
  const content = base();
  content.pages[1].content = Array.from({ length: 13 }, (_, i) => `<p>Photo ${i}</p><img src="https://site.test/p${i}.jpg">`).join("");
  const ctx = setup(content);
  ctx.claude(choose("pages", "p2"), described(...Array.from({ length: 10 }, (_, i) => `Scene number ${i + 1}`)));
  const p = (await proposeEdit(ctx.env, ctx.editor, { text: "describe the photos on About", by: "Sam" })).proposal;
  assert.equal(p.descriptions.length, 10);
  assert.equal(p.remaining, 3);
  assert.ok(ctx.photos.length <= 12, "downloads stop once the card is full");
  assert.match(JSON.stringify(proposalBlocks(p).blocks), /3 more on this page to go/);
});

test("thread replies: '#2: …' changes one, 'skip #1' leaves one out", () => {
  const { set, skip } = parseRevisions("change #2 to “Shoppers at the Saturday market”\nskip #1 and 3\n#4 is fine");
  assert.deepEqual([...set], [[2, "Shoppers at the Saturday market"]]);
  assert.deepEqual([...skip], [1, 3]);
  assert.deepEqual([...parseRevisions("3: A red barn").set], [[3, "A red barn"]]);
  assert.equal(parseRevisions("looks good to me!").set.size, 0);
});

test("a reply in the card's thread updates the proposal and the card; unknown numbers are explained", async () => {
  const ctx = setup();
  ctx.env.SLACK_BOT_TOKEN = "xoxb";
  ctx.env.SLACK_STAFF_DOMAINS = "example.org";
  ctx.claude(choose("pages", "p2"), described("People unpacking boxes", "Shoppers at a market"));
  const p = (await proposeEdit(ctx.env, ctx.editor, { text: "Describe the photos on the About page", by: "Sam" })).proposal;
  await rememberCard(ctx.env, { channel: "C1", thread: "100.1", ts: "100.2", proposalId: p.id });

  assert.equal(await reviseFromThread(ctx.env, { channel: "C1", user: "U1", text: "nice!", threadTs: "999.9" }), false, "other threads are left alone");
  assert.equal(await reviseFromThread(ctx.env, { channel: "C1", user: "U1", text: "#7: nope", threadTs: "100.1" }), true);
  assert.match(ctx.slack.at(-1).text, /There's no #7/);

  await reviseFromThread(ctx.env, { channel: "C1", user: "U1", text: "#1: Volunteers unpacking food donations\nskip #2", threadTs: "100.1" });
  const revised = await getProposal(ctx.env, p.id);
  assert.deepEqual(revised.descriptions.map((d) => [d.n, d.alt, !!d.edited]), [[1, "Volunteers unpacking food donations", true]]);
  assert.ok(revised.changes.content.includes('alt="Volunteers unpacking food donations"'));
  assert.ok(!revised.changes.content.includes("Shoppers"), "the skipped photo is left as it was");
  const update = ctx.slack.find((m) => m.method === "chat.update");
  assert.equal(update.ts, "100.2");
  assert.match(JSON.stringify(update.blocks), /changed by you/);
  assert.match(ctx.slack.at(-1).text, /card above is updated/);

  assert.equal(reviseProposal(revised, { set: new Map(), skip: new Set([1]) }).error, "That leaves nothing to approve. Press Cancel instead if none of them should change.");
  await applyProposal(ctx.env, ctx.editor, p.id, { by: "s" });
  await reviseFromThread(ctx.env, { channel: "C1", user: "U1", text: "#1: Too late", threadTs: "100.1" });
  assert.match(ctx.slack.at(-1).text, /already been approved/);
});
