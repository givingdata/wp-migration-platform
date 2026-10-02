// Photo descriptions from Slack: "describe the photos on the About page", "fix missing photo
// descriptions". Many migrated WordPress pages have photos in their body text with no
// description, so people using screen readers miss them; this lets staff fix a page at a time.
//
// Finding: a page's photos without a description are <img> tags in its body text with no alt
// (or an empty one), its main photo (image without imageAlt), and a designed page's images whose
// description slot is empty. Without a page named, the page with the most goes first, and the
// card says how many other pages still need them.
//
// Describing: each photo is downloaded and shrunk (previewForClaude), and Claude sees up to
// MAX_PER_CARD of them at once, with the page title and the text around each. Photos that can't
// be downloaded are left as they are, and the card says so.
//
// Approving: one card per page. It is an ordinary "update" proposal (body text, imageAlt or
// designed-page slots), so Approve, the version check, the commit and undo work as for any other
// change. Before approving, a reply in the card's thread changes one ("#3: Volunteers sorting
// donations") or leaves it out ("skip #3"); the card is updated in place.
//
// Staff never see "alt text": the words are "photo descriptions" / "image descriptions".
import { EditError, DESIGNED } from "../../lib/edit/index.js";
import { ask, saveProposal, getProposal, proposalBlocks, htmlToText } from "./slack-edits.js";
import { fetchImageLink } from "./linked-page.js";
import { previewForClaude } from "./cloudflare.js";
import { postMessage, updateMessage, userEmail } from "./slack.js";
import { isStaff } from "./slack-access.js";

const MAX_PER_CARD = 10;
const MAX_TRIES = 16; // photos downloaded for one card, at most (some may fail)
const FETCH_AT_ONCE = 4; // downloads in flight together (full-size photos are big)
const MAX_BATCH_DATA = 12_000_000; // base64 characters sent to Claude in one go
const MAX_DESCRIPTION = 150; // Claude's
const MAX_STAFF_DESCRIPTION = 300; // staff's own (the Edit module's limit)
const NEARBY = 300; // characters of text either side of a photo, for context
const MAX_PAGES_TRIED = 3; // site-wide: pages tried when a page's photos can't be downloaded
const CARD_PREFIX = "slack:describe:";
const CARD_TTL = 172_800; // as long as a proposal waits

// ---------------------------------------------------------------------------------------
// <img> tags in body text

// A whole tag, with quoted values that may contain ">".
const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const decode = (s) =>
  String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|#39);/gi, (m, e) => {
    const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[e.toLowerCase()];
    if (named) return named;
    try {
      return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    } catch {
      return m;
    }
  });
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An <img> tag's attributes: name (lowercase) → { value (as written), start, end } within the tag. The first of a repeated name wins, as in browsers. */
export function imgAttrs(tag) {
  const out = new Map();
  const inner = tag.slice(4); // after "<img"
  for (const m of inner.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, { value: m[2] ?? m[3] ?? m[4] ?? "", start: 4 + m.index, end: 4 + m.index + m[0].length });
  }
  return out;
}

/** Every <img> tag in some HTML, in order: { index, start, end, tag, attrs }. */
export function imgTags(html) {
  return [...String(html ?? "").matchAll(IMG_TAG)].map((m, index) => ({ index, start: m.index, end: m.index + m[0].length, tag: m[0], attrs: imgAttrs(m[0]) }));
}

/** The tag with its alt set to `alt` (escaped); every other attribute stays exactly as written. */
export function withAlt(tag, alt) {
  const value = `alt="${escAttr(alt)}"`;
  const at = imgAttrs(tag).get("alt");
  return at ? tag.slice(0, at.start) + value + tag.slice(at.end) : `${tag.slice(0, 4)} ${value}${tag.slice(4)}`;
}

/** HTML with the descriptions in `alts` (Map: tag index → text) set on those <img> tags only. */
export function setAlts(html, alts) {
  let i = -1;
  return String(html ?? "").replace(IMG_TAG, (tag) => {
    i++;
    return alts.has(i) ? withAlt(tag, alts.get(i)) : tag;
  });
}

const hasAlt = (attrs) => !!decode(attrs.get("alt")?.value).trim();

// The candidates in a srcset, as { url, w }.
const srcset = (value) =>
  String(value ?? "").split(/,\s+/).map((c) => c.trim().split(/\s+/)).filter(([url]) => url).map(([url, d]) => ({ url, w: parseInt(d, 10) || 0 }));

// A copy around 600–1200 px is plenty for Claude and quicker for Slack; WordPress lists them in srcset.
function pickSize(candidates) {
  const sized = candidates.filter((c) => c.w).sort((a, b) => a.w - b.w);
  return (sized.find((c) => c.w >= 600) ?? sized[sized.length - 1])?.url ?? null;
}

function tagSource(attrs) {
  const real = (name) => {
    const v = decode(attrs.get(name)?.value).trim();
    return v && !/^data:/i.test(v) ? v : null; // lazy-loading placeholders
  };
  return pickSize(srcset(decode(attrs.get("srcset")?.value ?? attrs.get("data-srcset")?.value))) ?? real("data-src") ?? real("data-lazy-src") ?? real("src");
}

// A full http(s) address for a photo, or null.
function absolute(src, siteUrl) {
  if (!src) return null;
  try {
    const url = new URL(String(src).startsWith("//") ? `https:${src}` : src, siteUrl || undefined);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// The text just before and after a tag (a cut-off tag at either end is dropped).
function nearby(html, t) {
  const before = oneLine(htmlToText(html.slice(Math.max(0, t.start - NEARBY * 5), t.start).replace(/^[^<]*>/, "")));
  const after = oneLine(htmlToText(html.slice(t.end, t.end + NEARBY * 5).replace(/<[^>]*$/, "")));
  return { before: before.slice(-NEARBY), after: after.slice(0, NEARBY) };
}

// "after “…the last few words”", so staff can find it on the page.
function whereInText(before) {
  if (!before) return "At the start of the text";
  const tail = before.length > 50 ? `…${before.slice(-50).replace(/^\S*\s/, "")}` : before;
  return `In the text, after “${tail}”`;
}

// ---------------------------------------------------------------------------------------
// Finding

/**
 * The photos on one page with no description. `page` is { entry } for an entry (from get() or
 * readAll()) or { sections } for a designed page (pageSlots). Each photo: { kind: "main" |
 * "content" | "slot", src (full address or null), where, context, index (content), slot (the
 * description slot, designed) }.
 */
export function photosWithoutDescriptions(page, siteUrl = null) {
  const out = [];
  if (page.sections) {
    for (const s of page.sections) {
      for (const x of s.slots.filter((y) => y.kind === "image" && y.value)) {
        const alt = s.slots.find((y) => y.slot === x.slot.replace(/\.src$/, ".alt"));
        if (!alt || alt.value.trim()) continue;
        const words = s.slots.filter((y) => y.kind === "text" || y.kind === "textarea").map((y) => y.value).filter(Boolean).join(" · ");
        out.push({ kind: "slot", slot: alt.slot, src: absolute(x.value, siteUrl), where: `${s.label} › ${x.label}`, context: { section: oneLine(words).slice(0, NEARBY * 2) } });
      }
    }
    return out;
  }
  const entry = page.entry ?? {};
  if (typeof entry.image === "string" && entry.image && !String(entry.imageAlt ?? "").trim()) {
    const variants = Object.entries(entry.imageVariants ?? {}).map(([w, url]) => ({ url, w: Number(w) }));
    out.push({ kind: "main", src: absolute(pickSize(variants) ?? entry.image, siteUrl), where: "Main photo", context: { summary: oneLine(entry.description).slice(0, NEARBY) } });
  }
  const html = String(entry.content ?? "");
  for (const t of imgTags(html)) {
    if (hasAlt(t.attrs)) continue;
    const context = nearby(html, t);
    const title = oneLine(decode(t.attrs.get("title")?.value));
    out.push({ kind: "content", index: t.index, src: absolute(tagSource(t.attrs), siteUrl), where: whereInText(context.before), context: { ...context, ...(title ? { title } : {}) } });
  }
  return out;
}

// Every page and entry with photos that need a description, most first.
async function pagesNeedingDescriptions(editor, siteUrl) {
  const all = await editor.readAll();
  const site = siteUrl || all.siteUrl || null;
  const pages = [
    ...all.designed.map((d) => ({ collection: DESIGNED, id: d.id, title: d.title, count: photosWithoutDescriptions({ sections: d.sections }, site).length })),
    ...all.entries.map((e) => ({ collection: e.collection, id: e.id, title: e.title, count: photosWithoutDescriptions({ entry: e.entry }, site).length })),
  ];
  return { site, pages: pages.filter((p) => p.count).sort((a, b) => b.count - a.count) };
}

// Download photos (a few at a time) until there are enough for a card. Each one Claude can see
// gets `preview`; the rest are counted as not downloadable.
async function downloadBatch(env, photos) {
  const ready = [];
  let failed = 0, data = 0, tried = 0;
  const queue = photos.slice(0, MAX_TRIES);
  while (queue.length && ready.length < MAX_PER_CARD) {
    const group = queue.splice(0, FETCH_AT_ONCE);
    tried += group.length;
    const previews = await Promise.all(group.map(async (p) => {
      if (!p.src) return null;
      try {
        const file = await fetchImageLink(p.src);
        return file ? await previewForClaude(env, file.bytes, file.type) : null;
      } catch {
        return null; // not a photo Claude can see (wrong type, too big)
      }
    }));
    group.forEach((p, i) => {
      const preview = previews[i];
      if (!preview || ready.length >= MAX_PER_CARD || data + preview.data.length > MAX_BATCH_DATA) {
        if (!preview) failed++;
        return;
      }
      data += preview.data.length;
      ready.push({ ...p, preview });
    });
  }
  return { ready, failed, tried };
}

// ---------------------------------------------------------------------------------------
// Describing

/** A description as stored: one line, no "photo of", capitalised, cut at a word under `max`. */
export function tidyDescription(text, max = MAX_DESCRIPTION) {
  let s = oneLine(String(text ?? "").replace(/<[^>]*>/g, ""));
  s = s.replace(/^(?:(?:an?|the)\s+)?(?:image|photo|photograph|picture|pic)\s+(?:of|showing|shows)\s+/i, "");
  if (s.length >= max) {
    const cut = s.slice(0, max - 1);
    s = (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:–—-]+$/, "");
  }
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

const fileName = (src) => {
  try {
    return decodeURIComponent(new URL(src).pathname.split("/").pop()).slice(0, 120);
  } catch {
    return null;
  }
};

function describeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["descriptions"],
    properties: {
      descriptions: {
        type: "array",
        description: "One item per photo, by its number",
        items: { type: "object", additionalProperties: false, required: ["n", "description"], properties: { n: { type: "integer" }, description: { type: "string" } } },
      },
    },
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "Describe the photos on …": a proposal with a description for each photo on that page that has
 * none (up to MAX_PER_CARD), or a reply. Without `collection`/`id`, the page that needs it most.
 * `base` = the proposal's common fields (requestedBy, text, status, createdAt) from proposeEdit.
 */
export async function proposeDescriptions(env, editor, { collection, id, base, progress }) {
  const reply = (text) => ({ kind: "reply", text });
  await progress?.("Looking for photos without descriptions…");
  const { site, pages } = await pagesNeedingDescriptions(editor, env.SITE_URL || null);
  const named = !!(collection && id);
  if (!named && !pages.length) return reply("Every photo I can find on the site already has a description.");
  const targets = named ? [{ collection, id }] : pages.slice(0, MAX_PAGES_TRIED);
  const others = (t) => pages.filter((p) => !(p.collection === t.collection && String(p.id) === String(t.id)));
  const othersNote = (t) => {
    const rest = others(t);
    return rest.length ? `${plural(rest.length, "other page")} still ${rest.length === 1 ? "has" : "have"} photos without descriptions; say “fix missing photo descriptions” and I'll start with the one that needs it most.` : "";
  };

  let lastProblem = null;
  for (const target of targets) {
    let opened;
    try {
      opened = await editor.get(target.collection, target.id);
    } catch (e) {
      if (e instanceof EditError) return reply("I couldn't find the page you mean. Which page's photos should I describe?");
      throw e;
    }
    const { entry, type, version, path } = opened;
    const title = String(entry.title ?? "").slice(0, 120);
    const photos = photosWithoutDescriptions(opened.designed ? { sections: entry.sections } : { entry }, site);
    if (!photos.length) return reply(`Every photo on “${title}” already has a description. ${othersNote(target)}`.trim());

    await progress?.(`Found ${plural(photos.length, "photo")} without a description on “${title}”. Looking at them… (this can take a minute)`);
    const { ready, failed, tried } = await downloadBatch(env, photos);
    if (!ready.length) {
      lastProblem = `I couldn't open the photos on “${title}” that need a description (they may be missing from the site). Ask your web team to check them.`;
      if (named) return reply(lastProblem);
      continue;
    }

    const answer = await ask(env, {
      task:
        "Describe each numbered photo for people using screen readers, who can't see it. " +
        `For each: one plain sentence under ${MAX_DESCRIPTION} characters saying what the photo shows that matters on this page. ` +
        "Don't start with 'image of', 'photo of' or 'picture of', and don't mention that it's a photo. " +
        "Use the page title and the text near each photo for context (what event or place it is), but describe only what you can see. " +
        "Never guess who people are or give their names; describe them instead (e.g. 'A volunteer handing out winter coats'). " +
        "For a logo, poster or sign, give its main words. Every photo gets a description.",
      user:
        `Page: ${JSON.stringify({ title, type: type?.label ?? null, path })}\n\n` +
        `Photos (n, where on the page, file name, nearby text):\n${JSON.stringify(ready.map((p, i) => ({ n: i + 1, where: p.where, file: fileName(p.src), nearby: p.context })))}`,
      schema: describeSchema(),
      maxTokens: 3000,
      images: ready.map((p, i) => ({ label: `Photo ${i + 1}:`, mediaType: p.preview.mediaType, data: p.preview.data })),
    });
    const said = new Map((answer.descriptions || []).map((d) => [d.n, tidyDescription(d.description)]));
    const items = [];
    ready.forEach((p, i) => {
      const alt = said.get(i + 1);
      if (alt) items.push({ n: items.length + 1, kind: p.kind, ...(p.kind === "content" ? { index: p.index } : {}), ...(p.kind === "slot" ? { slot: p.slot } : {}), src: p.src, where: p.where, alt, before: "" });
    });
    if (!items.length) return reply(`I couldn't describe the photos on “${title}”. Try again in a minute.`);

    const before = {};
    if (items.some((d) => d.kind === "content")) before.content = entry.content;
    if (items.some((d) => d.kind === "main")) before.imageAlt = entry.imageAlt ?? null;
    for (const d of items.filter((x) => x.kind === "slot")) before[d.slot] = "";
    const proposal = {
      id: crypto.randomUUID(), op: "update", collection: opened.designed ? DESIGNED : target.collection, entryId: String(entry.id ?? entry.slug),
      typeKey: type.key, typeLabel: type.label ?? type.key, fieldLabels: {}, version, before, title: entry.title, path,
      summary: `Describe ${plural(items.length, "photo")} on “${title}”`, descriptions: items,
      // For the card: what's left after this one.
      remaining: photos.length - items.length, failed, untried: photos.length - tried, otherPages: others(target).length, ...base,
    };
    proposal.changes = describedChanges(proposal);
    await saveProposal(env, proposal);
    return { kind: "proposal", proposal };
  }
  return reply(lastProblem);
}

/** The proposal's changes from its descriptions: alts set in the original body text, imageAlt, designed slots. */
export function describedChanges(proposal) {
  const changes = {};
  const inText = new Map(proposal.descriptions.filter((d) => d.kind === "content").map((d) => [d.index, d.alt]));
  if (inText.size) changes.content = setAlts(proposal.before.content, inText);
  for (const d of proposal.descriptions) {
    if (d.kind === "main") changes.imageAlt = d.alt;
    if (d.kind === "slot") changes[d.slot] = d.alt;
  }
  return changes;
}

/** For undo: each photo goes back to the description it had (none). */
export const undoDescriptions = (list) => list.map((d) => ({ ...d, alt: d.before ?? "", before: d.alt }));

// ---------------------------------------------------------------------------------------
// The card

const SECTION_LIMIT = 3000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const section = (text) => ({ type: "section", text: { type: "mrkdwn", text: cut(text, SECTION_LIMIT) } });
const context = (text) => ({ type: "context", elements: [{ type: "mrkdwn", text: cut(text, SECTION_LIMIT) }] });
const who = (by) => (by && /^[UW][A-Z0-9]{2,}$/.test(by) ? `<@${by}>` : esc(by || "someone"));

const HOW_TO_CHANGE = "To change one, reply in this thread, e.g. “#2: Volunteers sorting food donations”, or “skip #2” to leave it out.";

/** Slack blocks for a descriptions card: each photo, numbered, with its suggested description. `heading` and `buttons` come from slack-edits.js. */
export function descriptionBlocks(proposal, { siteUrl, heading, buttons }) {
  const blocks = [section(`*${esc(heading)}*\n${esc(proposal.summary || "")}`)];
  const top = [];
  if (proposal.requestedBy) top.push(`Requested by ${who(proposal.requestedBy)}`);
  if (siteUrl && proposal.path) top.push(`<${String(siteUrl).replace(/\/+$/, "")}${proposal.path}|View page>`);
  if (top.length) blocks.push(context(top.join(" · ")));
  blocks.push({ type: "divider" });

  for (const d of proposal.descriptions) {
    // Slack loads the photo from its address, as for a posted photo's before/after.
    if (d.src) blocks.push({ type: "image", image_url: d.src, alt_text: cut(d.alt || "Photo", 1900), title: { type: "plain_text", text: cut(`#${d.n} · ${d.where}`, 1900) } });
    const text = d.alt ? `>${esc(d.alt)}` : ">_(no description)_";
    blocks.push(section(`*#${d.n}*${d.edited ? " _(changed by you)_" : ""}\n${text}`));
  }

  const notes = [];
  if (!proposal.undoOf) {
    notes.push(HOW_TO_CHANGE);
    const left = proposal.remaining ?? 0;
    if (left) {
      const unopened = proposal.failed ?? 0;
      notes.push(`${left} more on this page to go: approve these, then ask again.${unopened ? ` (I couldn't open ${plural(unopened, "photo")}, so I left ${unopened === 1 ? "it" : "them"} out.)` : ""}`);
    }
    if (proposal.otherPages) notes.push(`${plural(proposal.otherPages, "other page")} also ${proposal.otherPages === 1 ? "has" : "have"} photos without descriptions.`);
  }
  if (notes.length) blocks.push(context(notes.join("\n")));
  blocks.push(buttons);
  return { text: cut(`Proposed: ${heading}. ${proposal.summary || ""}`.trim(), SECTION_LIMIT), blocks };
}

// ---------------------------------------------------------------------------------------
// Changing a suggestion before Approve: a reply in the card's thread

const cardKey = (channel, thread) => `${CARD_PREFIX}${channel}:${thread}`;

/** Remember which card a thread holds, so a reply there can change it (slack-flow.js calls this after posting it). */
export async function rememberCard(env, { channel, thread, ts, proposalId }) {
  if (!env.CONTENT) return;
  await env.CONTENT.put(cardKey(channel, thread), JSON.stringify({ ts, proposalId }), { expirationTtl: CARD_TTL });
}

const NUMBER = String.raw`(?:#\s*|no\.?\s*|number\s+|photo\s+)?(\d{1,2})`;
const SKIP = new RegExp(String.raw`\b(?:skip|drop|leave out|remove|take out)\s+((?:${NUMBER}(?:\s*(?:,|and|&|\+)\s*)?)+)`, "i");
const SET = new RegExp(String.raw`^\s*(?:(?:please\s+)?(?:change|make|set|update|use)\s+)?(#\s*|no\.?\s*|number\s+|photo\s+)?(\d{1,2})\s*(?:[:=)–—-]|\.\s|\s+(?:to|should be|should say|as|is)\b)\s*:?\s*(.+?)\s*$`, "i");
const FINE = /^(fine|ok|okay|good|great|perfect|right|correct|spot on)\b/i;

/** What a thread reply asks for: { set: Map n → text, skip: Set n }. Slack's quotes and formatting are taken off the text. */
export function parseRevisions(text) {
  const set = new Map(), skip = new Set();
  for (const line of String(text ?? "").split(/\n+/)) {
    const skipped = line.match(SKIP);
    if (skipped) {
      for (const n of skipped[1].match(/\d{1,2}/g)) skip.add(Number(n));
      continue;
    }
    const m = line.match(SET);
    if (!m) continue;
    const value = m[3].replace(/^[*_~"“”'‘’]+|[*_~"“”'‘’]+$/g, "").trim();
    if (value && !FINE.test(value)) set.set(Number(m[2]), value);
  }
  return { set, skip };
}

/** The proposal with staff's changes applied, or { error } to tell them. Numbers stay as on the card. */
export function reviseProposal(proposal, { set, skip }) {
  const numbers = new Set(proposal.descriptions.map((d) => d.n));
  const unknown = [...set.keys(), ...skip].filter((n) => !numbers.has(n));
  if (unknown.length) return { error: `There's no #${unknown[0]} on this card. ${HOW_TO_CHANGE}` };
  const descriptions = [];
  for (const d of proposal.descriptions) {
    if (skip.has(d.n)) continue;
    if (!set.has(d.n)) {
      descriptions.push(d);
      continue;
    }
    const alt = tidyDescription(set.get(d.n), MAX_STAFF_DESCRIPTION);
    if (!alt) return { error: `What should #${d.n} say? ${HOW_TO_CHANGE}` };
    descriptions.push({ ...d, alt, edited: true });
  }
  if (!descriptions.length) return { error: "That leaves nothing to approve. Press Cancel instead if none of them should change." };
  const next = { ...proposal, descriptions, summary: `Describe ${plural(descriptions.length, "photo")} on “${String(proposal.title ?? "").slice(0, 120)}”` };
  next.changes = describedChanges(next);
  return { proposal: next };
}

/**
 * A reply in a thread (not an answer to a question): if the thread holds a descriptions card
 * still waiting for Approve, change it as asked. Returns true when the reply was about the card.
 */
export async function reviseFromThread(env, { channel, user, text, threadTs }) {
  const raw = await env.CONTENT?.get(cardKey(channel, threadTs));
  if (!raw) return false;
  let card;
  try {
    card = JSON.parse(raw);
  } catch {
    return false;
  }
  const say = (message) => postMessage(env, { channel, threadTs, text: message });
  const asked = parseRevisions(text);
  if (!asked.set.size && !asked.skip.size) {
    // Ordinary talk in the thread stays ignored; only something that looks like "#3 …" gets help.
    if (/#\s?\d/.test(String(text))) await say(HOW_TO_CHANGE.replace("reply in this thread", "reply here"));
    return true;
  }
  if (!isStaff(env, await userEmail(env, user))) {
    await say("Only staff can change this card.");
    return true;
  }
  const proposal = await getProposal(env, card.proposalId);
  if (!proposal) {
    await say("That card has expired. Ask again and I'll describe the photos afresh.");
    return true;
  }
  if (proposal.status !== "pending" || proposal.undoOf) {
    await say(proposal.undoOf ? "This card puts back what was there before, so its descriptions can't be changed." : "That card has already been approved or cancelled. Ask again to describe more photos.");
    return true;
  }
  const revised = reviseProposal(proposal, asked);
  if (revised.error) {
    await say(revised.error);
    return true;
  }
  await saveProposal(env, revised.proposal);
  await updateMessage(env, { channel, ts: card.ts, ...proposalBlocks(revised.proposal, { siteUrl: env.SITE_URL || null }) });
  const changed = [...[...asked.set.keys()].map((n) => `#${n}`), ...[...asked.skip].map((n) => `left out #${n}`)].join(", ");
  await say(`Done (${changed}): the card above is updated. Approve it when it looks right.`);
  return true;
}
