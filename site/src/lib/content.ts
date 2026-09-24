// Loads content.json (produced by wordpress_export.py and updated by the Worker)
// and gives every entry a unique URL.
import fs from "node:fs";
import path from "node:path";
import specs from "../../../config/design-specs.json";
import { contentTypes, allCollections, typeForCollection } from "../../../lib/content-types.js";
import { assignPaths, isFrontPage as isFront } from "../../../lib/routes.js";

/** A content type key from config/design-specs.json ("post", "event", "announcement", …) or "page". */
export type ContentType = string;

export interface TypeDef {
  key: string;
  label: string;
  collection: string;
  layout: "article" | "event" | "exhibition";
  enabled: boolean;
  listing?: { path: string; title: string; intro?: string; upcoming?: boolean; currentLabel?: string; pastLabel?: string } | false;
  homepage?: boolean;
  banner?: boolean;
  aspectRatio?: string;
}

/** Every content type, enabled (in design-specs) or kept for older entries. */
export const TYPES = contentTypes(specs) as Record<string, TypeDef>;
export const typeDef = (key: string): TypeDef | null => TYPES[key] ?? null;
/** Types with a listing page (/news/, /events/, …), in design-specs order. */
export const LISTED_TYPES = Object.values(TYPES).filter((t) => t.listing);

export interface Entry {
  id: string;
  /** Original WordPress ID (imported entries only). */
  wpId?: number | string | null;
  slug: string;
  type: ContentType;
  title: string;
  description?: string | null;
  content?: string | null;
  image?: string | null;
  imageAlt?: string | null;
  imageVariants?: Record<string, string>;
  images?: string[];
  date?: string | null;
  dateTime?: string | null;
  endDate?: string | null;
  time?: string | null;
  location?: string | null;
  author?: string | null;
  /** "Learn more" link (announcements). */
  linkUrl?: string | null;
  categories?: string[];
  tags?: string[];
  modified?: string | null;
  parent?: number | string | null;
  menuOrder?: number | null;
  link?: string | null;
  seo?: Seo | null;
}

/** Per-page SEO overrides; anything missing falls back to the page's own title/description/image. */
export interface Seo {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  noindex?: boolean;
  canonical?: string | null;
}

export interface MenuItem {
  title: string;
  url: string | null;
  children: MenuItem[];
}

export interface SiteFooter {
  /** Footer paragraphs from WordPress (plain text), e.g. a land acknowledgement. */
  text: string[];
  /** Footer menu links. */
  menu: MenuItem[];
  social: { network: string; url: string }[];
}

export interface SiteContent {
  pages: Entry[];
  /** Entries by collection ("posts", "events", "announcements", …), pages included. */
  collections: Record<string, Entry[]>;
  /** Main navigation copied from WordPress (wordpress_export.py), if any. */
  menu: MenuItem[];
  /** Footer copied from WordPress (wordpress_export.py), if any. */
  footer: SiteFooter;
  /** WordPress ID of the page used as the homepage, if the site had a static front page. */
  frontPage: string | null;
  siteUrl?: string;
}

/** Entry plus the path it is published at (no leading/trailing slash). */
export type RoutedEntry = Entry & { path: string };

const COLLECTIONS: string[] = allCollections(TYPES);

function resolveContentPath(): string | null {
  const candidates = [process.env.CONTENT_PATH, path.resolve(process.cwd(), "../content.json"), path.resolve(process.cwd(), "content.json")];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

let cache: { content: SiteContent; routed: RoutedEntry[]; source: string } | null = null;

function load() {
  if (cache) return cache;

  let file = resolveContentPath();
  if (!file) {
    // Never ship sample content from CI; locally, fall back so `npm run dev` just works.
    if (process.env.CI || process.env.REQUIRE_CONTENT) {
      throw new Error("content.json not found (looked in CONTENT_PATH, ../content.json, ./content.json)");
    }
    file = path.resolve(process.cwd(), "src/data/sample-content.json");
    console.warn(`[content] content.json not found — using sample data (${file})`);
  }

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const content: SiteContent = {
    pages: [],
    collections: {},
    menu: Array.isArray(raw.menu) ? raw.menu : [],
    footer: {
      text: Array.isArray(raw.footer?.text) ? raw.footer.text.filter((t: unknown) => typeof t === "string" && t.trim()) : [],
      menu: Array.isArray(raw.footer?.menu) ? raw.footer.menu : [],
      social: Array.isArray(raw.footer?.social) ? raw.footer.social.filter((s: any) => s && typeof s.url === "string" && /^https?:/i.test(s.url)) : [],
    },
    frontPage: raw.frontPage ? String(raw.frontPage) : null,
    siteUrl: raw.siteUrl,
  };
  for (const collection of COLLECTIONS) {
    const type = typeForCollection(TYPES, collection)?.key ?? collection;
    const items: Entry[] = Array.isArray(raw[collection]) ? raw[collection] : [];
    content.collections[collection] = items
      .filter((e) => e && e.slug && e.title)
      // An entry's type follows the collection it is in.
      .map((e) => ({ ...e, id: String(e.id ?? e.slug), type }));
  }
  content.pages = content.collections.pages;

  // Unique paths (lib/routes.js, shared with the Edit module); the homepage is built by index.astro.
  const routed: RoutedEntry[] = assignPaths(content.collections, content.frontPage, TYPES)
    .filter((r: { path: string | null }) => r.path !== null)
    .map((r: { entry: Entry; path: string }) => ({ ...r.entry, path: r.path }));

  cache = { content, routed, source: file };
  return cache;
}

function isFrontPage(entry: Entry, content: SiteContent): boolean {
  return entry.type === "page" && isFront(content.frontPage, "pages", entry);
}

/** The page WordPress used as its homepage, if any. */
export function getFrontPage(): Entry | null {
  const content = getContent();
  return content.pages.find((p) => isFrontPage(p, content)) ?? null;
}

export function getContent(): SiteContent {
  return load().content;
}

export function getRoutedEntries(): RoutedEntry[] {
  return load().routed;
}

export function urlFor(entry: Entry): string {
  if (isFrontPage(entry, getContent())) return "/";
  const match = getRoutedEntries().find((e) => e.id === entry.id && e.type === entry.type);
  return `/${match?.path ?? entry.slug}/`;
}

// ---- Dates -----------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

export const byDateDesc = (a: Entry, b: Entry) => (b.date ?? "").localeCompare(a.date ?? "");
export const byDateAsc = (a: Entry, b: Entry) => (a.date ?? "").localeCompare(b.date ?? "");

/** All entries of a type (e.g. "event"). */
export function entriesOf(typeKey: string): Entry[] {
  const t = typeDef(typeKey);
  return t ? getContent().collections[t.collection] ?? [] : [];
}

/** Entries on now or starting later (events, exhibitions), soonest first. */
export function upcoming(typeKey: string): Entry[] {
  const t = today();
  return entriesOf(typeKey).filter((e) => (e.endDate ?? e.date ?? "") >= t).sort(byDateAsc);
}

export function past(typeKey: string): Entry[] {
  const t = today();
  return entriesOf(typeKey).filter((e) => (e.endDate ?? e.date ?? "") < t).sort(byDateDesc);
}

/** Newest first; types with a schedule (events) only list what hasn't ended. */
export function latest(typeKey: string, limit?: number): Entry[] {
  const listing = typeDef(typeKey)?.listing;
  const list = listing && listing.upcoming ? upcoming(typeKey) : [...entriesOf(typeKey)].sort(byDateDesc);
  return limit ? list.slice(0, limit) : list;
}

export const latestPosts = (limit?: number) => latest("post", limit);

/**
 * Announcements to show in the banner: started (date ≤ today) and not ended. Dates are
 * checked when the site is built; rebuild.yml also rebuilds daily so they expire on time.
 */
export function activeAnnouncements(): Entry[] {
  const t = today();
  return Object.values(TYPES)
    .filter((type) => type.banner)
    .flatMap((type) => entriesOf(type.key))
    .filter((e) => (e.date ?? "") <= t && (e.endDate ?? "9999") >= t)
    .sort(byDateDesc);
}

/** Body HTML, or the summary as a paragraph when there is no body. */
export function bodyHtml(entry: Entry): string {
  if (entry.content) return fixContentLinks(entry.content);
  const text = String(entry.description ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return text ? `<p>${text}</p>` : "";
}

/**
 * Resolve a WordPress menu link to this site's URL for the same entry (slugs are kept,
 * but colliding ones may have moved). External and unknown links are returned unchanged.
 */
export function resolveMenuUrl(url: string | null): string | null {
  if (!url || /^[a-z]+:/i.test(url)) return url;
  const slug = url.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  if (!slug) return "/";
  const front = getFrontPage();
  if (front && front.slug === slug) return "/";
  const entry = getRoutedEntries().find((e) => e.slug === slug);
  return entry ? `/${entry.path}/` : url;
}

const EMAIL = /^[^\s:/@]+@[^\s:/@]+\.[a-z]{2,}$/i;
// WordPress system paths stay on the old site (e.g. files that weren't mirrored to R2).
const WP_SYSTEM = /^\/(wp-content|wp-admin|wp-includes|wp-json|feed)(\/|$)/;

/**
 * Tidy links in migrated WordPress HTML: links to the old site's pages become links to
 * the same page here (/donate/ instead of https://old-site/donate/), and bare email
 * addresses used as links get the mailto: they were missing. Other links are unchanged.
 */
export function fixContentLinks(html: string): string {
  if (!html) return html;
  const siteUrl = getContent().siteUrl;
  let host: string | null = null;
  try {
    host = siteUrl ? new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {}

  return html.replace(/(<a\b[^>]*?\bhref=)(["'])(.*?)\2/gi, (whole, start: string, q: string, href: string) => {
    const value = href.trim();
    if (EMAIL.test(value)) return `${start}${q}mailto:${value}${q}`;
    if (!host || !/^https?:\/\//i.test(value)) return whole;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return whole;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== host || WP_SYSTEM.test(url.pathname) || url.search) return whole;
    const local = resolveMenuUrl(url.pathname);
    // Only rewrite links to pages this site actually has; anything else keeps pointing at WordPress.
    const known = local === "/" || getRoutedEntries().some((e) => `/${e.path}/` === local);
    if (!known) return whole;
    return `${start}${q}${local}${url.hash}${q}`;
  });
}

/** Top-level pages for the main navigation (used when no WordPress menu was exported). */
export function navPages(limit = 6): Entry[] {
  return getContent()
    .pages.filter((p) => !p.parent)
    .sort((a, b) => (a.menuOrder ?? 0) - (b.menuOrder ?? 0) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export function formatDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = { dateStyle: "long" }): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "UTC" }).format(d);
}

export function formatRange(start?: string | null, end?: string | null): string {
  if (!start) return "";
  if (!end || end === start) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

/** Plain-text excerpt for meta descriptions. */
export function excerpt(entry: Entry, max = 160): string {
  const text = (entry.description || entry.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text;
}
