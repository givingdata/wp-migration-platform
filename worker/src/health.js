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
//   alt        photos without an image description (for screen readers)
//
// Each finding says where (title + address) so staff can ask the bot to fix it.
import { htmlToText } from "./slack-edits.js";

const STALE_NEWS_DAYS = 90;
// Workers on the free plan get 50 outgoing requests per run, shared with Claude, Slack and GitHub,
// and a check can take two (HEAD, then GET): a random sample each time, so repeats cover more.
const MAX_EXTERNAL = 15;
const EXTERNAL_TIMEOUT_MS = 6000;
const MAX_PER_KIND = 8;
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
export async function siteHealth(editor, { today, siteUrl = null, checkExternal = true, fetchImpl = fetch } = {}) {
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
      add("years", `Mentions ${old.join(" and ")}: “…${p.text.slice(Math.max(0, at - 50), at + 50).replace(/\s+/g, " ").trim()}…”`, { title: p.title, path: p.path });
    }
    const ph = p.text.match(PLACEHOLDER);
    if (ph) add("placeholder", `Has placeholder text (“${ph[0]}”)`, { title: p.title, path: p.path });
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

  // Image descriptions.
  for (const e of all.entries) {
    if (e.entry.image && !String(e.entry.imageAlt || "").trim()) add("alt", "Its main photo has no image description", { title: e.title, path: e.path });
  }
  for (const d of all.designed) {
    for (const s of d.sections) {
      for (const x of s.slots.filter((slot) => slot.kind === "image" && slot.value)) {
        const alt = s.slots.find((slot) => slot.slot === x.slot.replace(/\.src$/, ".alt"));
        if (alt && !String(alt.value || "").trim()) add("alt", `A photo in ${s.label} has no image description`, { title: d.title, path: d.path });
      }
    }
  }

  return { findings, checked: { entries: all.entries.length, designed: all.designed.length, external: externalChecked, externalTotal: external.size } };
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

const HEADINGS = {
  news: "News", events: "Events", years: "Old dates (still current?)", placeholder: "Placeholder text", links: "Links", alt: "Image descriptions",
};

/** The Slack reply: grouped findings with where they are, and what to ask for next. */
export function healthReport({ findings, checked }, { siteUrl = null } = {}) {
  const base = siteUrl ? String(siteUrl).replace(/\/+$/, "") : null;
  const where = (f) => (f.path && base ? `<${base}${f.path}|${esc(f.title ?? f.path)}>` : esc(f.title ?? f.path ?? ""));
  const scope = `I checked ${checked.entries + checked.designed} pages and entries${checked.externalTotal ? ` and ${checked.external} outside link${checked.external === 1 ? "" : "s"}${checked.externalTotal > checked.external ? ` (a random ${checked.external} of ${checked.externalTotal}; ask again to check others)` : ""}` : ""}.`;
  if (!findings.length) return `✅ Nothing looks out of date. ${scope}`;
  const lines = [`Here's what could use a look. ${scope}`];
  for (const kind of Object.keys(HEADINGS)) {
    const list = findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    lines.push("", `*${HEADINGS[kind]}*`);
    for (const f of list.slice(0, MAX_PER_KIND)) lines.push(`• ${f.title || f.path ? `${where(f)}: ` : ""}${esc(f.detail)}`);
    if (list.length > MAX_PER_KIND) lines.push(`• …and ${list.length - MAX_PER_KIND} more`);
  }
  lines.push("", "Ask me to fix any of these, e.g. “change 2025 to 2026 on the About page” or “add an image description to the photo on the Contact page”.");
  return lines.join("\n");
}
