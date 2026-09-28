// Slack edits with Claude faked: a message becomes a proposal in KV, and only Approve writes
// it through the Edit module (a real editor over an in-memory store).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createEditor, EditError, StaleError } from "../../lib/edit/index.js";
import {
  APPROVE_ACTION, CANCEL_ACTION, proposeEdit, applyProposal, cancelProposal, getProposal, proposalBlocks, resultBlocks,
} from "../src/slack-edits.js";

const specs = JSON.parse(await fs.readFile(new URL("../../config/design-specs.json", import.meta.url), "utf8"));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// content.json in memory; write() refuses a stale head like the real stores.
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

const CONTACT_HTML =
  '<h2>Visit us</h2>\n<p class="intro">We are at 12 Main St.</p>\n<p>Opening hours: 10–4, Tuesday to Saturday.</p>\n<p>Parking is free.</p>';

const base = () => ({
  frontPage: "p1",
  menu: [],
  pages: [
    { id: "p1", slug: "home", title: "Home", content: "<p>Hi</p>" },
    { id: "p2", slug: "contact", title: "Contact", description: "How to reach us", content: CONTACT_HTML },
  ],
  posts: [{ id: "n1", slug: "old-news", title: "Old news", date: "2026-01-01", content: "<p>x</p>" }],
  events: [],
  media: [],
});

// Fake Claude: answers the queued replies in order and records each request body.
function setup(content = base()) {
  const store = memoryStore(content);
  const editor = createEditor({ store, specs });
  const kv = new Map();
  const env = {
    CLAUDE_API_KEY: "k", SITE_NAME: "Test Museum",
    CONTENT: { get: async (k) => kv.get(k) ?? null, put: async (k, v, opts) => kv.set(k, v) && (kv.opts = opts) },
  };
  const queue = [];
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch ${u}`);
    requests.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error("no Claude reply queued");
    return new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "x", stop_reason: next.stop_reason ?? "end_turn",
      content: [{ type: "text", text: typeof next.body === "string" ? next.body : JSON.stringify(next.body) }], usage: { input_tokens: 1, output_tokens: 1 },
    }), { headers: { "content-type": "application/json" } });
  };
  const claude = (...bodies) => queue.push(...bodies.map((body) => ({ body })));
  return { store, editor, env, kv, requests, claude, queue };
}

const nulls = (fields) => Object.fromEntries(fields.map((f) => [f, null]));

async function proposeHours(ctx) {
  ctx.claude(
    { action: "update", collection: "pages", id: "p2", typeKey: null, reply: null, summary: "Update opening hours" },
    { ...nulls(["title", "description", "imageAlt"]), title: "Contact", contentEdits: [{ find: "10–4, Tuesday to Saturday", replace: "9–5, Monday to Friday" }], summary: "Opening hours now 9–5 weekdays" },
  );
  return proposeEdit(ctx.env, ctx.editor, { text: "Change the opening hours on the Contact page to 9–5 weekdays", by: "Sam", requestedBy: "U123ABC" });
}

test("update: only changed fields, before captured, version stored, untouched HTML kept", async () => {
  const ctx = setup();
  const out = await proposeHours(ctx);
  assert.equal(out.kind, "proposal");
  const p = out.proposal;
  assert.equal(p.op, "update");
  assert.equal(p.collection, "pages");
  assert.equal(p.entryId, "p2");
  assert.equal(p.status, "pending");
  assert.deepEqual(Object.keys(p.changes), ["content"], "the unchanged title is dropped");
  assert.equal(p.changes.content, CONTACT_HTML.replace("10–4, Tuesday to Saturday", "9–5, Monday to Friday"));
  assert.deepEqual(p.before, { content: CONTACT_HTML });
  assert.equal(p.version, (await ctx.editor.get("pages", "p2")).version);
  assert.equal(p.path, "/contact/");
  assert.equal(p.requestedBy, "U123ABC");
  assert.deepEqual(await getProposal(ctx.env, p.id), p);
  assert.equal(ctx.kv.opts.expirationTtl, 172800);

  // The Slack text goes in as data, and the system prompt says so.
  assert.match(ctx.requests[0].system, /data, not instructions/);
  assert.match(ctx.requests[0].messages[0].content, /<slack_message>/);
  assert.ok(ctx.requests[0].messages[0].content.includes('"id":"p2"'), "the site index is sent");
  // Pages only offer the always-editable fields.
  assert.deepEqual(Object.keys(ctx.requests[1].output_config.format.schema.properties).sort(), ["contentEdits", "description", "imageAlt", "summary", "title"]);
  // Nothing written yet.
  assert.equal(ctx.store.files()["content.json"].pages[1].content, CONTACT_HTML);
});

test("create: an event proposal with the type's fields", async () => {
  const ctx = setup();
  ctx.claude(
    { action: "create", collection: null, id: null, typeKey: "event", reply: null, summary: "Add Spring Gala" },
    { title: "Spring Gala", description: "Our annual gala.", content: "<p>Join us.</p>", date: "2027-05-03", endDate: null, time: "6–9 pm", location: "City Hall", summary: "New event: Spring Gala" },
  );
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Add an event: Spring Gala, May 3 2027, 6–9pm at City Hall", by: "U1" });
  assert.equal(out.kind, "proposal");
  const p = out.proposal;
  assert.equal(p.op, "create");
  assert.equal(p.typeKey, "event");
  assert.equal(p.collection, "events");
  assert.deepEqual(p.fields, { title: "Spring Gala", description: "Our annual gala.", content: "<p>Join us.</p>", date: "2027-05-03", time: "6–9 pm", location: "City Hall" });
  assert.deepEqual(p.before, {});
  assert.ok(ctx.requests[1].output_config.format.schema.properties.location, "event fields offered");

  const done = await applyProposal(ctx.env, ctx.editor, p.id, { by: "Sam" });
  const saved = ctx.store.files()["content.json"].events[0];
  assert.equal(saved.title, "Spring Gala");
  assert.equal(saved.source, "slack");
  assert.equal(saved.slug, "spring-gala");
  assert.equal(saved.id, p.entryId);
  assert.equal(done.path, "/spring-gala/");
  assert.match(done.commit, /github\.test/);
});

test("reply: a delete request is not turned into a change", async () => {
  const ctx = setup();
  ctx.claude({ action: "reply", collection: null, id: null, typeKey: null, reply: "I can't delete pages; ask your web team.", summary: "Delete request" });
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Delete the Contact page", by: "U1" });
  assert.deepEqual(out, { kind: "reply", text: "I can't delete pages; ask your web team." });
  assert.equal(ctx.kv.size, 0);
  assert.equal(ctx.requests.length, 1, "no second call");
});

test("reply when Claude's draft changes nothing, or picks an entry that doesn't exist", async () => {
  const ctx = setup();
  ctx.claude(
    { action: "update", collection: "pages", id: "p2", typeKey: null, reply: null, summary: "x" },
    { ...nulls(["title", "description", "imageAlt"]), contentEdits: [], summary: "x" },
  );
  assert.equal((await proposeEdit(ctx.env, ctx.editor, { text: "hmm" })).kind, "reply");
  ctx.claude({ action: "update", collection: "pages", id: "nope", typeKey: null, reply: null, summary: "x" });
  assert.match((await proposeEdit(ctx.env, ctx.editor, { text: "change it" })).text, /couldn't find/);
  ctx.claude({ action: "create", collection: null, id: null, typeKey: "exhibition", reply: null, summary: "x" });
  assert.equal((await proposeEdit(ctx.env, ctx.editor, { text: "add a show" })).kind, "reply", "types that aren't enabled are refused");
});

test("apply: the entry changes and the proposal is applied; a second approve is refused", async () => {
  const ctx = setup();
  const { proposal } = await proposeHours(ctx);
  const done = await applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" });
  assert.equal(done.proposal.status, "applied");
  assert.equal(done.proposal.decidedBy, "Sam");
  assert.equal(done.path, "/contact/");
  assert.equal(done.commit, "https://github.test/commit/c1");
  const page = ctx.store.files()["content.json"].pages[1];
  assert.match(page.content, /9–5, Monday to Friday/);
  assert.equal(page.modifiedBy, "Sam");
  assert.equal((await getProposal(ctx.env, proposal.id)).status, "applied");

  await assert.rejects(applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Alex" }), (e) => e instanceof EditError && e.status === 409 && /already approved by Sam/.test(e.message));
  await assert.rejects(cancelProposal(ctx.env, proposal.id, { by: "Alex" }), (e) => e.status === 409);
  await assert.rejects(applyProposal(ctx.env, ctx.editor, "00000000-0000-0000-0000-000000000000", {}), (e) => e.status === 404);
});

test("apply after someone else edited the entry: 409 and the proposal is failed", async () => {
  const ctx = setup();
  const { proposal } = await proposeHours(ctx);
  const opened = await ctx.editor.get("pages", "p2");
  await ctx.editor.update("pages", "p2", { title: "Contact us" }, { version: opened.version, by: "other" });
  await assert.rejects(applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" }), (e) => e instanceof EditError && e.status === 409);
  const after = await getProposal(ctx.env, proposal.id);
  assert.equal(after.status, "failed");
  assert.match(after.error, /Someone else changed/);
  assert.equal(ctx.store.files()["content.json"].pages[1].content, CONTACT_HTML, "nothing overwritten");
});

test("cancel: only while pending", async () => {
  const ctx = setup();
  const { proposal } = await proposeHours(ctx);
  const { proposal: cancelled } = await cancelProposal(ctx.env, proposal.id, { by: "U999" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.decidedBy, "U999");
  await assert.rejects(applyProposal(ctx.env, ctx.editor, proposal.id, { by: "Sam" }), (e) => e.status === 409 && /cancelled/.test(e.message));
  assert.equal(ctx.store.files()["content.json"].pages[1].content, CONTACT_HTML);
  const { blocks } = resultBlocks(cancelled, { status: "cancelled", by: "U999" });
  assert.ok(JSON.stringify(blocks).includes("✖️ Cancelled by <@U999>"));
  assert.ok(!JSON.stringify(blocks).includes('"actions"'));
});

test("proposalBlocks: before → after and two buttons carrying the proposal id", async () => {
  const ctx = setup();
  const { proposal } = await proposeHours(ctx);
  const { text, blocks } = proposalBlocks(proposal, { siteUrl: "https://museum.example/" });
  assert.match(text, /Contact/);
  const actions = blocks.find((b) => b.type === "actions");
  assert.deepEqual(actions.elements.map((e) => [e.action_id, e.value, e.style]), [[APPROVE_ACTION, proposal.id, "primary"], [CANCEL_ACTION, proposal.id, undefined]]);
  const all = JSON.stringify(blocks);
  assert.ok(all.includes("Requested by <@U123ABC>"));
  assert.ok(all.includes("<https://museum.example/contact/|View page>"));
  const field = blocks.find((b) => b.type === "section" && b.text.text.startsWith("*Text*")).text.text;
  assert.match(field, /Before:_\n>…\n>\n>Opening hours: 10–4, Tuesday to Saturday\.\n>\n>…/, "only the changed paragraph, as plain text");
  assert.match(field, /After:_\n>…\n>\n>Opening hours: 9–5, Monday to Friday\./);
  assert.ok(!field.includes("<p"), "HTML is shown as text");

  const applied = resultBlocks(proposal, { status: "applied", by: "U123ABC", siteUrl: "https://museum.example", path: "/contact/" });
  assert.ok(JSON.stringify(applied.blocks).includes("✅ Approved by <@U123ABC>. Going live in a few minutes…"));
  const live = resultBlocks(proposal, { status: "live", by: "U123ABC", siteUrl: "https://museum.example", path: "/contact/" });
  assert.ok(JSON.stringify(live.blocks).includes("🟢 Live on the site. Approved by <@U123ABC> — <https://museum.example/contact/|View page>"));
  assert.match(resultBlocks(proposal, { status: "deployFailed", by: "U123ABC" }).text, /^Saved, site not updated/);
  const failed = resultBlocks(proposal, { status: "failed", error: "Someone else changed <this>" });
  assert.ok(JSON.stringify(failed.blocks).includes("⚠️ Someone else changed &lt;this&gt;"));
});

test("long HTML is truncated to fit Slack", () => {
  const long = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} ${"words ".repeat(20)}</p>`).join("");
  const proposal = {
    id: "0f6b0a52-6a2c-4a3e-9c55-2f3f4d0b1d11", op: "update", collection: "pages", entryId: "p2", typeKey: "page", typeLabel: "Page",
    changes: { content: `<p>New start</p>${long}`, title: "T".repeat(5000) }, before: { content: long, title: "Old" },
    title: "Contact", path: "/contact/", summary: "Rewrite", requestedBy: "Sam", status: "pending",
  };
  const { blocks } = proposalBlocks(proposal);
  for (const b of blocks) if (b.text) assert.ok(b.text.text.length <= 3000, `section ${b.text.text.length} chars`);
  const content = blocks.find((b) => b.text?.text.startsWith("*Text*")).text.text;
  assert.ok(content.includes("…"));
  assert.ok(JSON.stringify(blocks).includes("Requested by Sam"));
});

test("an inserted paragraph shows its neighbours on both sides, not an empty before", () => {
  const paras = ["Address", "General inquiries", "Referrals", "Volunteers"].map((t) => `<p>${t}</p>`);
  const proposal = {
    id: "0f6b0a52-6a2c-4a3e-9c55-2f3f4d0b1d12", op: "update", collection: "pages", entryId: "p3", typeKey: "page", typeLabel: "Page",
    changes: { content: [paras[0], "<p>Phone: 604 555 5505</p>", ...paras.slice(1)].join("") }, before: { content: paras.join("") },
    title: "Contact Us", path: "/contact/", summary: "Add phone", status: "pending",
  };
  const text = proposalBlocks(proposal).blocks.find((b) => b.text?.text.startsWith("*Text*")).text.text;
  const [before, after] = text.split("_After:_");
  assert.match(before, /Address[\s\S]*General inquiries/);
  assert.doesNotMatch(before, /Referrals|Phone/);
  assert.match(after, /Address[\s\S]*Phone: 604 555 5505[\s\S]*General inquiries/);
});

test("Claude errors: malformed JSON and max_tokens", async () => {
  const ctx = setup();
  ctx.claude("not json");
  await assert.rejects(proposeEdit(ctx.env, ctx.editor, { text: "x" }), (e) => e.status === 502);
  ctx.queue.push({ body: "{}", stop_reason: "max_tokens" });
  await assert.rejects(proposeEdit(ctx.env, ctx.editor, { text: "x" }), (e) => e.status === 413);
});

test("designed page: Claude changes text slots; approve writes sections.json through the Edit module", async () => {
  const ctx = setup();
  ctx.store.files()["sections.json"] = {
    pages: { "/": { sections: [{ type: "hero", title: "Welcome", text: "Open 10–4", buttons: [{ label: "Visit", href: "/contact/" }], image: { src: "https://media.example/a.jpg", alt: "" } }] } },
  };
  const { collections } = await ctx.editor.list();
  assert.deepEqual(collections.designed.map((d) => d.id), ["index"]);
  assert.ok(!collections.pages.some((p) => p.id === "p1"), "the migrated homepage is hidden behind the designed one");

  ctx.claude(
    { action: "update", collection: "designed", id: "index", typeKey: null, reply: null, summary: "Update hours" },
    { edits: [{ slot: "0.text", value: "Open 9–5" }, { slot: "0.title", value: "Welcome" }], summary: "Hours on the homepage now 9–5" },
  );
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Homepage hours are now 9–5", by: "Sam" });
  assert.equal(out.kind, "proposal");
  const p = out.proposal;
  assert.equal(p.collection, "designed");
  assert.deepEqual(p.changes, { "0.text": "Open 9–5" }, "unchanged slots dropped");
  assert.deepEqual(p.before, { "0.text": "Open 10–4" });
  assert.equal(p.path, "/");
  assert.match(p.fieldLabels["0.text"], /Section 1 · Hero.*Intro text/);
  // Images aren't offered to Claude; the index marks designed pages.
  const slotEnum = ctx.requests[1].output_config.format.schema.properties.edits.items.properties.slot.enum;
  assert.ok(!slotEnum.includes("0.image.src"));
  assert.ok(slotEnum.includes("0.buttons.0.href"));
  assert.ok(ctx.requests[0].messages[0].content.includes('"designed":true'));

  const { blocks } = proposalBlocks(p);
  assert.ok(JSON.stringify(blocks).includes("Open 10–4") && JSON.stringify(blocks).includes("Open 9–5"));

  await applyProposal(ctx.env, ctx.editor, p.id, { by: "Sam" });
  const saved = ctx.store.files()["sections.json"].pages["/"];
  assert.equal(saved.sections[0].text, "Open 9–5");
  assert.equal(saved.modifiedBy, "Sam");
  assert.equal(ctx.store.files()["content.json"].pages[0].content, "<p>Hi</p>", "content.json untouched");
});

test("designed page: a request that needs a new section gets a reply, not a change", async () => {
  const ctx = setup();
  ctx.store.files()["sections.json"] = { pages: { "/": { sections: [{ type: "text", title: "Hi", paragraphs: ["One"] }] } } };
  ctx.claude(
    { action: "update", collection: "designed", id: "index", typeKey: null, reply: null, summary: "Add a section" },
    { edits: [], summary: "No change" },
  );
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Add a new testimonials section to the homepage" });
  assert.equal(out.kind, "reply");
  assert.match(out.text, /not the layout or images/);
});

// ---- photos ------------------------------------------------------------------------------------

const PHOTO = { name: "grad.jpg", preview: { mediaType: "image/jpeg", data: "AAAA" } };
const photoChoice = (over) => ({ action: "setImage", collection: null, id: null, slot: null, typeKey: null, imageAlt: "Graduates throwing their caps", reply: null, summary: "New photo", ...over });

// storeImage fake: records what it was asked for and returns https variants like cloudflare.js.
function fakeStore() {
  const calls = [];
  const storeImage = async (typeSpec, contentId) => {
    calls.push({ typeSpec, contentId });
    const at = `https://media.example/media/uploads/slack-${contentId}`;
    return { image: `${at}/1200.webp`, images: [`${at}/600.webp`, `${at}/1200.webp`], variants: { 600: `${at}/600.webp`, 1200: `${at}/1200.webp` } };
  };
  return { calls, storeImage };
}

function withEvent() {
  const content = base();
  content.events = [{ id: "e1", slug: "grad-night", title: "Grad Night", date: "2026-06-05", content: "<p>x</p>", image: "https://media.example/old.webp", imageAlt: "Old" }];
  return setup(content);
}

test("photo: Claude sees it, picks an event, describes it; approve sets the event's image", async () => {
  const ctx = withEvent();
  const store = fakeStore();
  ctx.claude(photoChoice({ collection: "events", id: "e1", summary: "New photo for Grad Night" }));
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Use this for Grad Night", by: "Sam", requestedBy: "U123ABC", image: PHOTO, storeImage: store.storeImage });
  assert.equal(out.kind, "proposal");
  const p = out.proposal;
  assert.equal(p.op, "setImage");
  assert.equal(p.entryId, "e1");
  assert.equal(p.media.imageAlt, "Graduates throwing their caps");
  assert.deepEqual(p.photo, { after: p.media.image, before: "https://media.example/old.webp", alt: "Graduates throwing their caps" });

  // The photo goes to Claude before the text; only places that show a photo are offered.
  const msg = ctx.requests[0].messages[0].content;
  assert.equal(msg[0].type, "image");
  assert.equal(msg[0].source.data, "AAAA");
  assert.ok(msg[1].text.includes('"id":"e1"'));
  assert.ok(!msg[1].text.includes('"id":"p2"'), "pages have no main photo, so they aren't offered");
  // Stored with the event type's shape (square), once.
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].typeSpec.aspectRatio, "1:1");

  // The Approve card shows before and after as images, not addresses.
  const { blocks } = proposalBlocks(p);
  const images = blocks.filter((b) => b.type === "image");
  assert.deepEqual(images.map((b) => b.image_url), ["https://media.example/old.webp", p.media.image]);
  assert.match(JSON.stringify(blocks), /New photo for event “Grad Night”/);

  await applyProposal(ctx.env, ctx.editor, p.id, { by: "Sam" });
  const saved = ctx.store.files()["content.json"].events[0];
  assert.equal(saved.image, p.media.image);
  assert.deepEqual(saved.imageVariants, p.media.imageVariants);
  assert.equal(saved.imageAlt, "Graduates throwing their caps");
  assert.equal(saved.title, "Grad Night");
  await assert.rejects(applyProposal(ctx.env, ctx.editor, p.id, { by: "Sam" }), (e) => e.status === 409);
});

test("photo: a designed page's image slot gets the photo and its description", async () => {
  const ctx = setup();
  ctx.store.files()["sections.json"] = { pages: { "/": { sections: [{ type: "hero", title: "Welcome", image: { src: "https://media.example/a.jpg", alt: "" } }] } } };
  const store = fakeStore();
  ctx.claude(photoChoice({ collection: "designed", id: "index", slot: "0.image.src", summary: "New homepage banner" }));
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "Put this in the homepage banner", by: "Sam", image: PHOTO, storeImage: store.storeImage });
  const p = out.proposal;
  assert.equal(p.collection, "designed");
  assert.deepEqual(Object.keys(p.changes).sort(), ["0.image.alt", "0.image.src"]);
  assert.equal(p.changes["0.image.alt"], "Graduates throwing their caps");
  assert.equal(store.calls[0].typeSpec.aspectRatio, null, "designed images are resized, not cropped");
  assert.ok(ctx.requests[0].messages[0].content[1].text.includes('"slot":"0.image.src"'), "image slots are offered");

  const text = JSON.stringify(proposalBlocks(p).blocks);
  assert.ok(!text.includes("› Image*"), "the image address isn't listed as a text change");
  assert.ok(text.includes("Image description"), "its description is");
  assert.equal(proposalBlocks(p).blocks.filter((b) => b.type === "image").length, 2);

  await applyProposal(ctx.env, ctx.editor, p.id, { by: "Sam" });
  const hero = ctx.store.files()["sections.json"].pages["/"].sections[0];
  assert.equal(hero.image.src, p.photo.after);
  assert.equal(hero.image.alt, "Graduates throwing their caps");
});

test("photo: a new news item with the photo; stored under the entry's own id", async () => {
  const ctx = setup();
  const store = fakeStore();
  ctx.claude(
    photoChoice({ action: "create", typeKey: "post", summary: "Add news" }),
    { title: "Class of 2026", description: "We celebrated.", content: "<p>We celebrated.</p>", date: "2026-06-06", author: null, summary: "News: Class of 2026" },
  );
  const out = await proposeEdit(ctx.env, ctx.editor, { text: "News: we celebrated the class of 2026 on June 6", by: "Sam", image: PHOTO, storeImage: store.storeImage });
  const p = out.proposal;
  assert.equal(p.op, "create");
  assert.equal(store.calls[0].contentId, p.entryId);
  assert.equal(store.calls[0].typeSpec.aspectRatio, "16:9");
  assert.equal(typeof ctx.requests[1].messages[0].content, "string", "the second step is text only");
  assert.match(ctx.requests[1].system, /photo comes with it/);

  await applyProposal(ctx.env, ctx.editor, p.id, { by: "Sam" });
  const post = ctx.store.files()["content.json"].posts.find((x) => x.id === p.entryId);
  assert.equal(post.title, "Class of 2026");
  assert.equal(post.image, p.media.image);
  assert.equal(post.imageAlt, "Graduates throwing their caps");
});

test("photo: unclear, or a page without a main photo → a reply, and nothing is stored", async () => {
  const ctx = setup();
  const store = fakeStore();
  ctx.claude(photoChoice({ action: "reply", reply: "Which page should this photo go on?" }));
  const unclear = await proposeEdit(ctx.env, ctx.editor, { text: "", by: "Sam", image: PHOTO, storeImage: store.storeImage });
  assert.deepEqual(unclear, { kind: "reply", text: "Which page should this photo go on?" });
  assert.match(ctx.requests[0].messages[0].content[1].text, /\(no message\)/);

  ctx.claude(photoChoice({ collection: "pages", id: "p2" }));
  const page = await proposeEdit(ctx.env, ctx.editor, { text: "Photo for the contact page", by: "Sam", image: PHOTO, storeImage: store.storeImage });
  assert.equal(page.kind, "reply");
  assert.match(page.text, /doesn't show a main photo/);
  assert.equal(store.calls.length, 0);
});
