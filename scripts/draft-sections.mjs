#!/usr/bin/env node
// Draft page sections (sections.json) from a client's migrated content, with Claude.
//
// Run in a client folder (next to content.json):
//   CLAUDE_API_KEY=… node ../../platform/scripts/draft-sections.mjs --pages /,how-to-help
//
// Writes two files for review; nothing goes live:
//   sections.draft.json  the drafted pages, in sections.json's format
//   sections.draft.md    review notes: what Claude wrote itself (vs. quoted), numbers that
//                        disagree between pages, links/images it had to drop, what's missing
// After review, --merge copies the drafted pages into sections.json (other pages and the
// "site" settings are kept); commit and push to publish.
//
// Options:
//   --pages /,about-us     pages to draft: "/" for the homepage, else the page's path
//   --content FILE         default ./content.json
//   --sections FILE        default ./sections.json (existing pages are shown to Claude for a consistent style)
//   --out NAME             default sections.draft (→ NAME.json + NAME.md)
//   --merge                write the last draft (NAME.json) into sections.json instead of drafting
//   --site-name NAME       default: SITE_NAME env, else the site's hostname
// Env: CLAUDE_API_KEY or ANTHROPIC_API_KEY; CLAUDE_MODEL (default claude-opus-5).
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const SECTION_TYPES = ["hero", "stats", "split", "cards", "quote", "stories", "text", "posts"];

function args(argv) {
  const out = { content: "content.json", sections: "sections.json", out: "sections.draft" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--merge") out.merge = true;
    else if (a.startsWith("--")) out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const pageKey = (p) => (p === "/" || p === "" ? "/" : p.replace(/^\/+|\/+$/g, ""));

// ---- Content → plain text Claude can read -----------------------------------

function toText(html) {
  return String(html || "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\bsrc=["']([^"']+)/i)?.[1];
      const alt = tag.match(/\balt=["']([^"']*)/i)?.[1];
      return src ? ` [image: ${src}${alt ? ` | ${alt}` : ""}] ` : "";
    })
    .replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `${text} (${href})`)
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote|figure)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;| /g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8217;|&rsquo;/g, "’").replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function describeSite(content) {
  const collections = Object.entries(content).filter(([k, v]) => Array.isArray(v) && !["media", "menu"].includes(k));
  const paths = new Set(["/"]);
  const images = new Map();
  const blocks = [];
  const front = content.frontPage ? String(content.frontPage) : null;
  for (const [collection, list] of collections) {
    for (const e of list) {
      if (!e?.slug || !e?.title) continue;
      const isFront = collection === "pages" && front && [e.wpId, e.id].some((v) => v != null && String(v) === front);
      const p = isFront ? "/" : `/${e.slug}/`;
      paths.add(p);
      for (const m of String(e.content || "").matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
        const alt = m[0].match(/\balt=["']([^"']*)/i)?.[1] || "";
        if (!images.has(m[1])) images.set(m[1], { alt, page: p });
      }
      if (e.image && !images.has(e.image)) images.set(e.image, { alt: e.imageAlt || "", page: p });
      blocks.push(`### ${e.title}\npath: ${p} · ${collection}${e.date ? ` · ${String(e.date).slice(0, 10)}` : ""}${isFront ? " · HOMEPAGE" : ""}\n\n${toText(e.content || e.description)}`);
    }
  }
  return { paths, images, blocks };
}

// ---- Output schema (structured output) ---------------------------------------
// The API limits optional and union-typed fields per schema, so Claude fills one flat
// section shape where every field is required and "" / [] / 0 / false mean "not used";
// toSection() then keeps only the fields each section type has (site/src/lib/sections.ts).

const str = { type: "string" };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items) => ({ type: "array", items });
const button = obj({ label: str, href: { ...str, description: "A path from the page list, or an https:// / mailto: link" }, style: { enum: ["primary", "secondary"] } });
const valueLabel = obj({ value: { ...str, description: "A figure as the site states it, e.g. 5,500+" }, label: str });
const flatSection = obj({
  type: { enum: SECTION_TYPES },
  tone: { enum: ["light", "alt", "band"], description: "Background: light, alt (tinted) or band (dark, for calls to action)" },
  eyebrow: { ...str, description: "Short label above the heading" },
  title: { ...str, description: "Heading, without the accent phrase" },
  accent: { ...str, description: "Last words of the heading, shown in italics" },
  text: { ...str, description: "hero: intro sentence; quote: the quotation" },
  intro: { ...str, description: "stats/cards: sentence under the heading" },
  paragraphs: { ...arr(str), description: "split/text" },
  list: { ...arr(str), description: "text: bullet list" },
  tags: { ...arr(str), description: "split: short tags" },
  items: {
    ...arr(obj({ title: str, text: str, href: str, linkLabel: str, icon: { ...str, description: "one emoji or empty" }, value: str, label: str, quote: str, by: str, detail: str })),
    description: "cards: title/text/href/linkLabel/icon; stats: value/label; stories: quote/by/detail",
  },
  stats: { ...arr(valueLabel), description: "hero: 2-3 figures" },
  highlight: { ...obj({ value: str, label: str, text: str }), description: "stats: one featured figure (optional)" },
  buttons: { ...arr(button), description: "hero/split/text; posts: first one is the 'all news' link" },
  image: { ...obj({ src: { ...str, description: "Exactly one of the listed image URLs" }, alt: str }), description: "hero/split/quote/text" },
  quote: { ...obj({ text: str, by: str }), description: "split: pull quote" },
  by: { ...str, description: "quote: who said it" },
  reverse: { type: "boolean", description: "split: image on the left" },
  contacts: { ...arr(obj({ label: str, email: str })), description: "cards: email contacts" },
  count: { type: "integer", description: "posts: how many (0 = default 3)" },
});
const outputSchema = obj({
  pages: arr(obj({
    key: { ...str, description: 'The page key as given ("/" or the path without slashes)' },
    content: { enum: ["none", "before", "after"], description: "Also show the page's migrated content before/after the sections, or not at all" },
    sections: arr(flatSection),
  })),
  notes: arr(obj({
    page: str,
    section: { type: "integer", description: "0-based section index, or -1 for the whole page" },
    kind: { enum: ["drafted", "conflict", "needs-input", "source"], description: "drafted: wording you wrote; conflict: pages disagree (e.g. different figures); needs-input: something the client must supply or confirm; source: where quoted text came from" },
    text: str,
  })),
});

const FIELDS = {
  hero: ["text", "buttons", "image", "stats"],
  stats: ["intro", "items", "highlight"],
  split: ["paragraphs", "tags", "image", "quote", "reverse", "buttons"],
  cards: ["intro", "items", "contacts"],
  quote: ["text", "by", "image"],
  stories: ["items"],
  text: ["paragraphs", "list", "buttons", "image"],
  posts: ["count", "buttons"],
};
const ITEM_FIELDS = { stats: ["value", "label"], cards: ["title", "text", "href", "linkLabel", "icon"], stories: ["quote", "by", "detail"] };

// Drop "" / [] / 0 / false and objects whose main field is empty.
function prune(v) {
  if (Array.isArray(v)) {
    const out = v.map(prune).filter((x) => x !== undefined);
    return out.length ? out : undefined;
  }
  if (v && typeof v === "object") {
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x)]).filter(([, x]) => x !== undefined));
    return Object.keys(out).length ? out : undefined;
  }
  return v === "" || v === 0 || v === false ? undefined : v;
}

function toSection(flat) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
  const s = { type: flat.type, ...pick(flat, ["tone", "eyebrow", "title", "accent"]), ...pick(flat, FIELDS[flat.type]) };
  if (s.items) s.items = s.items.map((i) => pick(i, ITEM_FIELDS[flat.type]));
  if (s.type === "posts" && flat.buttons?.[0]) { s.link = { label: flat.buttons[0].label, href: flat.buttons[0].href }; delete s.buttons; }
  if (s.tone === "light") delete s.tone;
  const out = prune(s);
  if (out.image && !out.image.src) delete out.image;
  if (out.quote && typeof out.quote === "object" && !out.quote.text) delete out.quote;
  if (out.highlight && !out.highlight.value) delete out.highlight;
  return out;
}

const SYSTEM = `You design page sections for a nonprofit or small-organization website that has been moved off WordPress. You get the whole site's migrated text and draft a few pages as sections (hero, stats, split, cards, quote, stories, text, posts) that a person will review before anything is published.

Rules:
- Use the organization's own words. Quote or lightly trim text from its pages wherever you can, and add a "source" note naming the page. When you write wording yourself (headings, short intros, button labels), add a "drafted" note saying what you wrote.
- Never invent facts, figures, names, quotes or testimonials. Stats and stories must come from the content. When pages disagree (e.g. "5,000+" on one page and "5,500+" on another), use the most recent and add a "conflict" note listing both with their pages.
- Link buttons and cards only to paths in the page list, or to https:// or mailto: links that appear in the content.
- Use only image URLs from the image list. Prefer photos of events, places or objects; avoid photos where vulnerable people (for example students or clients) could be identified, and say so in a "needs-input" note when a better photo is needed.
- A homepage usually starts with a hero (with 2-3 stats if the content has them), then a mix of split/cards/stats/stories, and ends with a band-toned call to action. Alternate tones so neighbouring sections differ. Keep text short: headings under 8 words, paragraphs under 60 words.
- Headings are split into "title" and an italic "accent" ending, e.g. title "Every graduate deserves to be", accent "celebrated."
- Choose content "none" unless the page's migrated text still needs to appear (e.g. a form or embed); then "after".
- Add a "needs-input" note for anything the client should supply (a logo, a better photo, a current figure).`;

// ---- Checks on what came back ------------------------------------------------

function check(pages, { paths, images }) {
  const notes = [];
  const okHref = (h) => /^(https?:|mailto:|tel:)/i.test(h) || paths.has(h.split(/[?#]/)[0].replace(/\/?$/, "/"));
  for (const page of pages) {
    page.sections.forEach((s, i) => {
      if (!SECTION_TYPES.includes(s.type)) throw new Error(`Unknown section type ${s.type}`);
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        for (const [k, v] of Object.entries(node)) {
          if (k === "href" && typeof v === "string" && !okHref(v)) {
            notes.push({ page: page.key, section: i, kind: "needs-input", text: `Link "${v}" isn't a page on the new site; check it before publishing.` });
          }
          if (v && typeof v === "object" && "src" in v && typeof v.src === "string" && !images.has(v.src)) {
            notes.push({ page: page.key, section: i, kind: "needs-input", text: `Dropped an image that isn't in the site's media (${v.src}).` });
            delete node[k];
            continue;
          }
          walk(v);
        }
      };
      walk(s);
    });
  }
  return notes;
}

function notesMarkdown(siteName, draft, notes, model) {
  const lines = [`# ${siteName}: sections draft`, "", `Drafted ${new Date().toISOString().slice(0, 10)} by ${model} from content.json. Nothing here is live: review \`sections.draft.json\`, then run the script with \`--merge\` (or copy pages into sections.json), commit and push.`, ""];
  for (const [key, page] of Object.entries(draft.pages)) {
    lines.push(`## ${key === "/" ? "Homepage (/)" : `/${key}/`}`, "");
    page.sections.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.type}**${s.title ? `: ${s.title}${s.accent ? ` *${s.accent}*` : ""}` : ""}${s.tone ? ` (${s.tone})` : ""}`);
      for (const n of notes.filter((n) => n.page === key && n.section === i)) lines.push(`   - ${n.kind}: ${n.text}`);
    });
    const pageNotes = notes.filter((n) => n.page === key && n.section == null);
    if (pageNotes.length) lines.push("", ...pageNotes.map((n) => `- ${n.kind}: ${n.text}`));
    if (page.content) lines.push("", `Migrated page text is shown ${page.content} the sections.`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const opts = args(process.argv.slice(2));
  const existing = readJson(opts.sections, {});

  if (opts.merge) {
    const draft = readJson(`${opts.out}.json`, null);
    if (!draft) throw new Error(`${opts.out}.json not found; draft first`);
    const merged = { ...existing, pages: { ...(existing.pages || {}), ...draft.pages } };
    fs.writeFileSync(opts.sections, JSON.stringify(merged, null, 2) + "\n");
    console.log(`Merged ${Object.keys(draft.pages).join(", ")} into ${opts.sections}. Preview with npm run dev, then commit and push.`);
    return;
  }

  if (!opts.pages) throw new Error("Pass --pages, e.g. --pages /,how-to-help");
  const content = readJson(opts.content, null);
  if (!content) throw new Error(`${opts.content} not found (run this in the client folder)`);
  const site = describeSite(content);
  const keys = opts.pages.split(",").map((p) => pageKey(p.trim()));
  for (const k of keys) {
    if (!site.paths.has(k === "/" ? "/" : `/${k}/`)) throw new Error(`No page at ${k === "/" ? "/" : `/${k}/`}`);
  }
  const siteName = opts.siteName || process.env.SITE_NAME || (content.siteUrl ? new URL(content.siteUrl).hostname.replace(/^www\./, "") : "the organization");

  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  const client = new Anthropic(apiKey ? { apiKey } : {});
  const model = process.env.CLAUDE_MODEL || "claude-opus-5";
  const others = Object.fromEntries(Object.entries(existing.pages || {}).filter(([k]) => !keys.includes(k)));
  const input = [
    `Organization: ${siteName}`,
    `Draft sections for these pages: ${keys.map((k) => JSON.stringify(k)).join(", ")}`,
    "",
    "<page_list>", [...site.paths].sort().join("\n"), "</page_list>",
    "",
    "<images>", [...site.images].map(([src, m]) => `${src}${m.alt ? ` | alt: ${m.alt}` : ""} | on ${m.page}`).join("\n"), "</images>",
    "",
    Object.keys(others).length ? `<existing_sections note="already-built pages; match their voice">\n${JSON.stringify(others, null, 1)}\n</existing_sections>\n` : "",
    "<site_content>", site.blocks.join("\n\n---\n\n"), "</site_content>",
  ].join("\n");

  console.log(`Drafting ${keys.join(", ")} for ${siteName} with ${model} (${site.blocks.length} pages/entries, ${site.images.size} images)…`);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    // Re-run on Anthropic's recommended fallback model if the primary declines.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: outputSchema } },
    system: SYSTEM,
    messages: [{ role: "user", content: input }],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === "refusal") throw new Error(`Claude declined (${response.stop_details?.category ?? "unspecified"})`);
  if (response.stop_reason === "max_tokens") throw new Error("The draft was cut off (max_tokens); draft fewer pages at a time");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const result = JSON.parse(text);

  const pages = result.pages.filter((p) => keys.includes(pageKey(p.key)));
  for (const p of pages) {
    p.key = pageKey(p.key);
    p.sections = p.sections.map(toSection);
  }
  const notes = [...(result.notes || []).map((n) => ({ ...n, page: pageKey(n.page), section: n.section >= 0 ? n.section : null })), ...check(pages, site)];
  const draft = { pages: {} };
  for (const p of pages) {
    draft.pages[pageKey(p.key)] = { sections: p.sections, ...(p.content && p.content !== "none" ? { content: p.content } : {}) };
  }
  fs.writeFileSync(`${opts.out}.json`, JSON.stringify(draft, null, 2) + "\n");
  fs.writeFileSync(`${opts.out}.md`, notesMarkdown(siteName, draft, notes, response.model));
  const u = response.usage;
  console.log(`Wrote ${opts.out}.json and ${opts.out}.md (${pages.reduce((n, p) => n + p.sections.length, 0)} sections, ${notes.length} notes; ${u.input_tokens} in / ${u.output_tokens} out tokens).`);
  const missing = keys.filter((k) => !draft.pages[k]);
  if (missing.length) console.warn(`No draft came back for: ${missing.join(", ")}`);
}

main().catch((e) => {
  console.error(`draft-sections: ${e.message}`);
  process.exit(1);
});
