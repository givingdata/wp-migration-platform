// "Is anything out of date on my site?": a read-only check of the content staff can change,
// answered in Slack. Every finding comes from the content itself (no guessing by Claude):
//
//   news       the newest news item is more than STALE_NEWS_DAYS old
//   events     no upcoming events, for a site that lists events
//   years      a page mentions last year or the year before ("2025 schedule")
//   placeholder "lorem ipsum", "coming soon", TBD/TBA left on a page
//   links      links to pages on this site that don't exist (old WordPress addresses that the
//              site redirects, by slug like the menu, don't count), and outside links that
//              answer 404/410 or can't be reached (a random MAX_EXTERNAL each time, in parallel)
//   alt        photos without a description (for screen readers): the main photo, designed
//              sections' photos and photos inside the text, counted per page
//   summary    pages and entries with no summary or search description, so Google picks the
//              text itself; search descriptions Google will cut off (over ~155 characters)
//   title      search titles shared by several pages, or long enough for Google to cut off
//              (over ~60 characters)
//
// Search titles and descriptions are worked out as the site renders them
// (site/src/layouts/BaseLayout.astro): `seo.title || "<title> | <site name>"` (the homepage: the
// site name) and `seo.description || summary`. Pages marked noindex are skipped.
//
// Each finding says where (title + address) so staff can ask the bot to fix it. The report
// (healthReport) and the monthly check-up (checkup.js) group them the same way (GROUPS), each
// group ending with what to ask for. Staff-facing words: "photo descriptions", "search title",
// "search description".
import { htmlToText } from "./slack-edits.js";

const STALE_NEWS_DAYS = 90;
// Workers on the free plan get 50 outgoing requests per run, shared with Claude, Slack and GitHub,
// and a check can take two (HEAD, then GET): a random sample each time, so repeats cover more.
const MAX_EXTERNAL = 15;
const EXTERNAL_TIMEOUT_MS = 6000;
const MAX_PER_KIND = 8;
// Roughly what Google shows before cutting off with "…".
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;
const PLACEHOLDER = /lorem ipsum|coming soon|\bTB[AD]\b|placeholder text|\[insert/i;
// Addresses the build redirects anyway (site/redirects.mjs): WordPress archives, files, feeds.
const HANDLED = /^\/(wp-content|wp-admin|wp-includes|category|tag|author|page|feed|comments|cdn-cgi)(\/|$)|^\/[^/]*\.(xml|txt|pdf|jpe?g|png|gif|webp|svg|docx?|xlsx?|pptx?|zip)$/i;

const host = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);

// Links in HTML (href) and in designed-page link slots.
function linksIn(html) {
  return [...String(html ?? "").matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
}

/** The text and links of every page and entry, with where each lives. */
function places(all) {
  const out = [];
  for (const e of all.entries) {
    const text = [e.entry.title, e.entry.description, htmlToText(e.entry.content)].filter(Boolean).join("\n");
    out.push({ title: e.title, path: e.path, kind: e.type, text, links: [...linksIn(e.entry.content), ...(e.entry.linkUrl ? [e.entry.linkUrl] : [])], entry: e });
  }
  for (const d of all.designed) {
    const slots = d.sections.flatMap((s) => s.slots);
    out.push({
      title: d.title, path: d.path, kind: "designed",
      text: slots.filter((x) => !["image", "url", "email"].includes(x.kind)).map((x) => x.value).join("\n"),
      links: slots.filter((x) => x.kind === "url" && x.value).map((x) => x.value),
      designed: d,
    });
  }
  return out;
}

/**
 * Check the site's content. `today` is the business's own date (YYYY-MM-DD).
 * @returns {Promise<{ findings: Array<{ kind: string, title?: string, path?: string, detail: string }>, checked: object }>}
 */
export async function siteHealth(editor, { today, siteUrl = null, siteName = "", checkExternal = true, fetchImpl = fetch } = {}) {
  const all = await editor.readAll();
  const findings = [];
  const add = (kind, detail, where = {}) => findings.push({ kind, detail, ...where });
  const year = Number(today.slice(0, 4));

  // News and events.
  const news = all.entries.filter((e) => e.type === "post" && e.entry.date).sort((a, b) => String(b.entry.date).localeCompare(String(a.entry.date)));
  if (news.length && daysBetween(news[0].entry.date, today) > STALE_NEWS_DAYS) {
    add("news", `The newest news item is from ${news[0].entry.date} (${daysBetween(news[0].entry.date, today)} days ago)`, { title: news[0].title, path: news[0].path });
  }
  const eventTypes = Object.values(editor.types || {}).filter((t) => t.enabled && t.listing?.upcoming);
  for (const t of eventTypes) {
    const list = all.entries.filter((e) => e.type === t.key);
    if (list.length && !list.some((e) => String(e.entry.endDate || e.entry.date || "") >= today)) {
      add("events", `No upcoming ${String(t.label).toLowerCase()}s are listed; the latest was ${list.map((e) => e.entry.endDate || e.entry.date).sort().at(-1)}`, { path: `/${t.listing.path}/` });
    }
  }

  // Pages: old years and placeholder text (news and events are dated, so years there are normal).
  const spots = places(all);
  for (const p of spots.filter((x) => x.kind === "page" || x.kind === "designed")) {
    const old = [year - 1, year - 2].filter((y) => new RegExp(`\\b${y}\\b`).test(p.text));
    if (old.length) {
      const at = p.text.search(new RegExp(`\\b${old[0]}\\b`));
      add("years", `Mentions ${old.join(" and ")}: “…${p.text.slice(Math.max(0, at - 50), at + 50).replace(/\s+/g, " ").trim()}…”`, { title: p.title, path: p.path, years: old, year });
    }
    const ph = p.text.match(PLACEHOLDER);
    if (ph) add("placeholder", `Has placeholder text (“${ph[0]}”)`, { title: p.title, path: p.path, match: ph[0] });
  }

  // Links.
  const live = new Set(all.live.map((x) => (x.endsWith("/") ? x : `${x}/`)));
  const redirected = new Set(all.redirects.map((x) => (x.endsWith("/") ? x : `${x}/`)));
  const slugs = new Set(all.entries.map((e) => e.entry.slug));
  const ownHosts = new Set([siteUrl, all.siteUrl].filter(Boolean).map((u) => { try { return host(new URL(u).hostname); } catch { return null; } }).filter(Boolean));
  const external = new Map(); // url → first place it appears
  const brokenInternal = [];
  for (const p of [...spots, { title: "Menu", path: null, links: all.menu.map((m) => m.url).filter(Boolean) }]) {
    for (const raw of p.links) {
      if (/^(mailto|tel|#|javascript):/i.test(raw) || raw.startsWith("#")) continue;
      let local = null;
      if (raw.startsWith("/")) local = raw;
      else if (/^https?:\/\//i.test(raw)) {
        let u;
        try { u = new URL(raw); } catch { continue; }
        if (ownHosts.has(host(u.hostname))) local = u.pathname;
        else if (!external.has(u.href)) external.set(u.href, p);
      }
      if (local == null) continue;
      const pathOnly = decodeURI(local.split(/[?#]/)[0] || "/");
      const withSlash = pathOnly.endsWith("/") ? pathOnly : `${pathOnly}/`;
      const last = pathOnly.replace(/\/+$/, "").split("/").pop();
      if (live.has(withSlash) || redirected.has(withSlash) || HANDLED.test(pathOnly) || (last && slugs.has(last))) continue;
      brokenInternal.push({ p, link: pathOnly });
    }
  }
  // One line per page (old WordPress galleries can leave dozens of these on one page).
  const byPage = new Map();
  for (const { p, link } of brokenInternal) {
    const key = `${p.title}\0${p.path}`;
    if (!byPage.has(key)) byPage.set(key, { p, links: [] });
    if (!byPage.get(key).links.includes(link)) byPage.get(key).links.push(link);
  }
  for (const { p, links } of byPage.values()) {
    const detail = links.length === 1
      ? `Links to ${links[0]}, which isn't a page on the site`
      : `Links to ${links.length} addresses that aren't pages on the site, e.g. ${links.slice(0, 2).join(", ")}`;
    add("links", detail, { title: p.title, path: p.path });
  }

  let externalChecked = 0;
  if (checkExternal && external.size) {
    const urls = sample([...external.keys()], MAX_EXTERNAL);
    externalChecked = urls.length;
    const results = await Promise.all(urls.map((url) => checkUrl(url, fetchImpl)));
    urls.forEach((url, i) => {
      const r = results[i];
      if (r.ok) return;
      const p = external.get(url);
      add("links", r.status ? `Outside link ${url} answers ${r.status} (${r.status === 404 ? "not found" : "gone"})` : `Outside link ${url} couldn't be reached`, { title: p.title, path: p.path });
    });
  }

  // Photo descriptions: one line per page, counting every photo without one.
  for (const e of all.entries) {
    const parts = [];
    if (e.entry.image && !String(e.entry.imageAlt || "").trim()) parts.push([1, "the main photo"]);
    const inText = photosWithoutAlt(e.entry.content);
    if (inText) parts.push([inText, "in the text"]);
    if (parts.length) add("alt", missingPhotos(parts), { title: e.title, path: e.path, photos: total(parts) });
  }
  for (const d of all.designed) {
    const parts = [];
    for (const s of d.sections) {
      let n = 0;
      for (const x of s.slots.filter((slot) => slot.kind === "image" && slot.value)) {
        const alt = s.slots.find((slot) => slot.slot === x.slot.replace(/\.src$/, ".alt"));
        if (alt && !String(alt.value || "").trim()) n++;
      }
      if (n) parts.push([n, `in ${s.label}`]);
    }
    if (parts.length) add("alt", missingPhotos(parts), { title: d.title, path: d.path, photos: total(parts) });
  }

  // Search titles and descriptions.
  const listings = searchListings(all, siteName);
  const byTitle = new Map();
  for (const l of listings) {
    const key = l.searchTitle.trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(l);
  }
  for (const same of byTitle.values()) {
    if (same.length < 2) continue;
    const others = same.slice(1).map((l) => l.title);
    const named = others.length > 3 ? `${others.slice(0, 3).join(", ")} and ${others.length - 3} more` : joinAnd(others);
    add("title", `Has the same search title as ${named}: “${same[0].searchTitle}”`, { title: same[0].title, path: same[0].path, pages: same.length });
  }
  // Long titles and missing summaries on news, events and the like are common and mostly fine
  // (Google shows the start of the article), so those count for pages only; titles and
  // descriptions staff wrote count everywhere.
  const pageLike = (l) => l.kind === "page" || l.kind === "designed" || l.path === "/";
  for (const l of listings) {
    if (l.searchTitle.length > TITLE_MAX && (l.ownTitle || pageLike(l))) add("title", `Search title is ${l.searchTitle.length} characters; Google shows about ${TITLE_MAX}: “${l.searchTitle}”`, { title: l.title, path: l.path });
  }
  for (const l of listings) {
    if (l.written.length > DESCRIPTION_MAX) add("summary", `Search description is ${l.written.length} characters; Google shows about ${DESCRIPTION_MAX}`, { title: l.title, path: l.path });
    else if (!l.written && !l.fallback && pageLike(l)) {
      add("summary", l.hasText ? "No summary, so Google shows the first lines of the page instead" : "No summary and no text, so Google gets the site's general description", { title: l.title, path: l.path });
    }
  }

  return { findings, checked: { entries: all.entries.length, designed: all.designed.length, external: externalChecked, externalTotal: external.size } };
}

const total = (parts) => parts.reduce((n, [count]) => n + count, 0);
const joinAnd = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

// "The main photo and 3 photos in the text have no description"
function missingPhotos(parts) {
  const words = parts.map(([n, where]) => (where === "the main photo" ? where : `${n} photo${n === 1 ? "" : "s"} ${where}`));
  const text = joinAnd(words);
  return `${text[0].toUpperCase()}${text.slice(1)} ${total(parts) === 1 ? "has" : "have"} no description`;
}

/** Photos (<img>) in body HTML with no alt, or an empty one. */
export function photosWithoutAlt(html) {
  let n = 0;
  for (const [tag] of String(html ?? "").matchAll(/<img\b[^>]*>/gi)) {
    const alt = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!alt || !String(alt[1] ?? alt[2] ?? alt[3] ?? "").replace(/&nbsp;|&#160;/gi, " ").trim()) n++;
  }
  return n;
}

// The first section text a designed page's description comes from (site/src/lib/sections.ts
// sectionsDescription: a section's text, intro or first paragraph).
function sectionsText(sections) {
  for (const s of sections) {
    const slot = s.slots.find((x) => [`${s.index}.text`, `${s.index}.intro`, `${s.index}.paragraphs.0`].includes(x.slot) && String(x.value || "").trim());
    if (slot) return slot.value.trim();
  }
  return "";
}

/**
 * One search listing per address, as the site renders it: { title, path, searchTitle, written
 * (search description or summary staff wrote), fallback (section text a designed page uses
 * instead), hasText, kind (content type, or "designed"), ownTitle }. A designed page wins over the entry it's built on; noindex pages are left out.
 */
function searchListings(all, siteName) {
  const byPath = new Map();
  for (const e of all.entries) {
    if (!e.path || byPath.has(e.path)) continue;
    byPath.set(e.path, { kind: e.type, title: e.title, path: e.path, seo: e.entry.seo || {}, summary: String(e.entry.description || "").trim(), fallback: "", hasText: !!htmlToText(e.entry.content).trim() });
  }
  for (const d of all.designed) {
    const entry = byPath.get(d.path);
    const fallback = sectionsText(d.sections);
    // Section text comes before the entry's summary here (site/src/layouts/Post.astro).
    byPath.set(d.path, { kind: "designed", title: d.title, path: d.path, seo: d.seo || {}, summary: fallback ? "" : entry?.summary || "", fallback, hasText: !!fallback || !!entry?.hasText });
  }
  const name = String(siteName || "").trim();
  return [...byPath.values()]
    .filter((l) => !l.seo.noindex)
    .map((l) => ({
      kind: l.kind,
      title: l.title,
      ownTitle: !!String(l.seo.title || "").trim(),
      path: l.path,
      searchTitle: String(l.seo.title || "").trim() || (l.path === "/" || !name ? name || l.title : `${l.title} | ${name}`),
      written: String(l.seo.description || "").trim() || l.summary,
      fallback: l.fallback,
      hasText: l.hasText,
    }));
}

function sample(list, n) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// 404/410 and unreachable count as broken; anything else (including 403 from sites that block
// checkers) counts as fine.
async function checkUrl(url, fetchImpl) {
  const attempt = async (method) => {
    const res = await fetchImpl(url, { method, redirect: "follow", signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS), headers: { "user-agent": "SiteFlo link check (+https://www.flomysite.com)" } });
    return res.status;
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 501) status = await attempt("GET");
    return { ok: status !== 404 && status !== 410, status };
  } catch {
    return { ok: false, status: null };
  }
}

// Slack mrkdwn needs &, < and > escaped.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Report groups, in order, each with what to ask the bot for (naming the group's first page).
export const GROUPS = [
  { key: "news", heading: "News", kinds: ["news"], fix: () => "“post this as news: …” with the text or a link" },
  { key: "events", heading: "Events", kinds: ["events"], fix: () => "“add an event: …” with the details or a link" },
  { key: "years", heading: "Old dates (still current?)", kinds: ["years"], fix: (page, f) => `“change ${f.years?.[0] ?? "last year"} to ${f.year ?? "this year"} on ${page ?? "the page"}”` },
  { key: "placeholder", heading: "Placeholder text", kinds: ["placeholder"], fix: (page) => `“remove the placeholder text on ${page ?? "the page"}”` },
  { key: "links", heading: "Links", kinds: ["links"], fix: (page) => (page ? `“remove the broken links on ${page}”, or say where a link should go` : "“remove the broken link from the menu”, or say where it should go") },
  { key: "photos", heading: "Photo descriptions", kinds: ["alt"], fix: (page) => `“describe the photos on ${page ?? "the page"}”` },
  { key: "titles", heading: "Search titles", kinds: ["title"], fix: (page) => `“how does ${page ?? "a page"} look on Google?” (you can change the search title there)` },
  { key: "descriptions", heading: "Search descriptions", kinds: ["summary"], fix: (page) => `“how does ${page ?? "a page"} look on Google?” (you can change the search description there)` },
];

/** Findings by report group, in GROUPS order, without empty groups: [{ group, list }]. */
export function groupFindings(findings) {
  return GROUPS.map((group) => ({ group, list: findings.filter((f) => group.kinds.includes(f.kind)) })).filter((g) => g.list.length);
}

/** What to ask for to fix a group, naming its first page (Slack-escaped). */
export function fixHint({ group, list }) {
  const first = list.find((f) => f.title && f.path);
  return `Ask me: ${esc(group.fix(first?.title ?? null, first ?? list[0]))}`;
}

/** The Slack reply: grouped findings with where they are, and what to ask for next. */
export function healthReport({ findings, checked }, { siteUrl = null } = {}) {
  const base = siteUrl ? String(siteUrl).replace(/\/+$/, "") : null;
  const where = (f) => (f.path && base ? `<${base}${f.path}|${esc(f.title ?? f.path)}>` : esc(f.title ?? f.path ?? ""));
  const scope = `I checked ${checked.entries + checked.designed} pages and entries${checked.externalTotal ? ` and ${checked.external} outside link${checked.external === 1 ? "" : "s"}${checked.externalTotal > checked.external ? ` (a random ${checked.external} of ${checked.externalTotal}; ask again to check others)` : ""}` : ""}.`;
  if (!findings.length) return `✅ Nothing looks out of date. ${scope}`;
  const lines = [`Here's what could use a look. ${scope}`];
  for (const g of groupFindings(findings)) {
    lines.push("", `*${g.group.heading}*`);
    for (const f of g.list.slice(0, MAX_PER_KIND)) lines.push(`• ${f.title || f.path ? `${where(f)}: ` : ""}${esc(f.detail)}`);
    if (g.list.length > MAX_PER_KIND) lines.push(`• …and ${g.list.length - MAX_PER_KIND} more`);
    lines.push(`→ ${fixHint(g)}`);
  }
  lines.push("", "Ask me to fix any of these, or check again once you've made changes.");
  return lines.join("\n");
}
