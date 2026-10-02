// How a page shows up in search results and when its link is shared: the entry's (or designed
// page's) optional "seo" object. Staff call these the search title, search description and
// share image; the rest of "seo" (noindex, canonical) stays with the web team.
//
// The site renders them in site/src/layouts/BaseLayout.astro: the search title is used exactly
// as written (no site name added), else "Page title | Site name" (the homepage: just the site
// name); the search description, else the page's own description (excerpt() below), else, on
// the homepage, the site's tagline. searchPreview() works that out the same way, for the Slack
// bot's "how does it look on Google?".
import { plainText } from "./sanitize.js";

/** Editable search fields: change key → { key in "seo", staff label, max length }. */
export const SEARCH_FIELDS = {
  "seo.title": { key: "title", label: "Search title", max: 120 },
  "seo.description": { key: "description", label: "Search description", max: 320 },
  "seo.image": { key: "image", label: "Share image", max: 2000 },
};

// About where Google cuts them off; used for warnings, not limits.
export const SEARCH_TITLE_FITS = 60;
export const SEARCH_DESCRIPTION_FITS = 155;

const IMAGE_OK = /^(https:\/\/\S+|\/\S+)$/i;

export const isSearchField = (field) => Object.hasOwn(SEARCH_FIELDS, field);

/** The current search values of an entry or designed page: { "seo.title": "", … }. */
export function searchValues(seo) {
  return Object.fromEntries(Object.entries(SEARCH_FIELDS).map(([field, def]) => [field, typeof seo?.[def.key] === "string" ? seo[def.key] : ""]));
}

/**
 * Split `changes` into search fields and the rest, and check the search ones: one line of plain
 * text within the limit (the share image an https:// or /path address). Empty or null clears
 * the value, so the page's own title, description or image is used again.
 * Returns { clean: { "seo.title": text | null, … }, errors, rest }.
 */
export function checkSearchChanges(changes) {
  const clean = {}, errors = {}, rest = {};
  for (const [field, raw] of Object.entries(changes && typeof changes === "object" ? changes : {})) {
    const def = SEARCH_FIELDS[field];
    if (!def) { rest[field] = raw; continue; }
    if (raw != null && typeof raw !== "string") { errors[field] = "Must be text"; continue; }
    const value = plainText(raw ?? "").replace(/\s+/g, " ");
    if (!value) { clean[field] = null; continue; }
    if (value.length > def.max) { errors[field] = `Max ${def.max} characters`; continue; }
    if (field === "seo.image" && !IMAGE_OK.test(value)) { errors[field] = "Must be an uploaded image (https://…)"; continue; }
    clean[field] = value;
  }
  return { clean, errors, rest };
}

/** `seo` with checked changes applied (cleared keys removed); undefined when nothing is left. */
export function applySearch(seo, clean) {
  const next = { ...(seo && typeof seo === "object" ? seo : {}) };
  for (const [field, value] of Object.entries(clean)) {
    const { key } = SEARCH_FIELDS[field];
    if (value == null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length ? next : undefined;
}

// ---------------------------------------------------------------------------------------
// What the site renders (mirrors site/src/lib/content.ts excerpt() and sections.ts sectionsDescription())

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") {
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return m; }
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text);

/** An entry's own description: its summary, else the start of its text (160 characters). */
export function excerpt(entry, max = 160) {
  const text = decode(String(entry?.description || entry?.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  return shorten(text, max);
}

/** A designed page's own description: the first text, intro or paragraph in its sections. */
export function sectionsDescription(sections, max = 160) {
  for (const s of Array.isArray(sections) ? sections : []) {
    const t = s?.text || s?.intro || s?.paragraphs?.[0];
    if (t) return shorten(String(t), max);
  }
  return null;
}

/**
 * The title and description a page is shown with in search results, and where each comes from.
 * @param {object} page
 * @param {object|null} page.seo      the seo object the site uses for this page
 * @param {string|null} page.title    the page's title (null on the homepage: the site name alone)
 * @param {object|null} page.entry    the content.json entry it renders, if any
 * @param {Array|null} page.sections  a designed page's raw sections, if it's built from them
 * @param {boolean} page.home         the homepage (falls back to the tagline)
 * @param {{ siteName: string, tagline?: string|null }} site  tagline null = unknown here
 * @returns {{ title, titleFrom: "search"|"page"|"site", description, descriptionFrom: "search"|"sections"|"summary"|"text"|"tagline"|"none" }}
 */
export function renderedSearch({ seo, title, entry = null, sections = null, home = false }, { siteName, tagline = null }) {
  const out = {};
  if (seo?.title) Object.assign(out, { title: seo.title, titleFrom: "search" });
  else if (title && !home) Object.assign(out, { title: `${title} | ${siteName}`, titleFrom: "page" });
  else Object.assign(out, { title: siteName, titleFrom: "site" });

  const fromSections = sections ? sectionsDescription(sections) : null;
  const own = entry ? excerpt(entry) : "";
  if (seo?.description) Object.assign(out, { description: seo.description, descriptionFrom: "search" });
  else if (fromSections) Object.assign(out, { description: fromSections, descriptionFrom: "sections" });
  else if (own) Object.assign(out, { description: own, descriptionFrom: entry.description ? "summary" : "text" });
  else if (home) Object.assign(out, { description: tagline, descriptionFrom: "tagline" });
  else Object.assign(out, { description: "", descriptionFrom: "none" });
  return out;
}
