// Loads content.json (produced by wordpress_export.py and updated by the Worker)
// and gives every entry a unique URL.
import fs from "node:fs";
import path from "node:path";

export type ContentType = "exhibition" | "event" | "post" | "page";

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
  categories?: string[];
  tags?: string[];
  modified?: string | null;
  parent?: number | string | null;
  menuOrder?: number | null;
  link?: string | null;
}

export interface MenuItem {
  title: string;
  url: string | null;
  children: MenuItem[];
}

export interface SiteContent {
  exhibitions: Entry[];
  events: Entry[];
  posts: Entry[];
  pages: Entry[];
  /** Main navigation copied from WordPress (wordpress_export.py), if any. */
  menu: MenuItem[];
  /** WordPress ID of the page used as the homepage, if the site had a static front page. */
  frontPage: string | null;
  siteUrl?: string;
}

/** Entry plus the path it is published at (no leading/trailing slash). */
export type RoutedEntry = Entry & { path: string };

const COLLECTIONS = { exhibitions: "exhibition", events: "event", posts: "post", pages: "page" } as const;
// Paths the site itself uses; content can't take them.
const RESERVED = new Set(["", "index", "exhibitions", "events", "news", "404", "rss.xml", "sitemap-index.xml", "robots.txt"]);

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
    exhibitions: [],
    events: [],
    posts: [],
    pages: [],
    menu: Array.isArray(raw.menu) ? raw.menu : [],
    frontPage: raw.frontPage ? String(raw.frontPage) : null,
    siteUrl: raw.siteUrl,
  };
  for (const [collection, type] of Object.entries(COLLECTIONS)) {
    const items: Entry[] = Array.isArray(raw[collection]) ? raw[collection] : [];
    (content as any)[collection] = items
      .filter((e) => e && e.slug && e.title)
      .map((e) => ({ ...e, id: String(e.id ?? e.slug), type: (e.type as ContentType) || type }));
  }

  // Assign unique paths. Pages keep their bare slug (/about); everything else too,
  // unless it collides, in which case it is prefixed with its type (/event/about).
  const taken = new Set(RESERVED);
  const routed: RoutedEntry[] = [];
  const order: (keyof typeof COLLECTIONS)[] = ["pages", "exhibitions", "events", "posts"];
  for (const collection of order) {
    for (const entry of (content as any)[collection] as Entry[]) {
      if (isFrontPage(entry, content)) continue; // published at "/" instead
      let p = entry.slug.replace(/^\/+|\/+$/g, "");
      if (taken.has(p)) p = `${entry.type}/${p}`;
      let n = 2;
      while (taken.has(p)) p = `${entry.type}/${entry.slug}-${n++}`;
      taken.add(p);
      routed.push({ ...entry, path: p });
    }
  }

  cache = { content, routed, source: file };
  return cache;
}

function isFrontPage(entry: Entry, content: SiteContent): boolean {
  return !!content.frontPage && entry.type === "page" && (String(entry.wpId ?? "") === content.frontPage || entry.id === content.frontPage);
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

/** Exhibitions on now or opening later, soonest first. */
export function currentExhibitions(): Entry[] {
  const t = today();
  return getContent().exhibitions.filter((e) => (e.endDate ?? e.date ?? "") >= t).sort(byDateAsc);
}

export function pastExhibitions(): Entry[] {
  const t = today();
  return getContent().exhibitions.filter((e) => (e.endDate ?? e.date ?? "") < t).sort(byDateDesc);
}

export function upcomingEvents(): Entry[] {
  const t = today();
  return getContent().events.filter((e) => (e.endDate ?? e.date ?? "") >= t).sort(byDateAsc);
}

export function pastEvents(): Entry[] {
  const t = today();
  return getContent().events.filter((e) => (e.endDate ?? e.date ?? "") < t).sort(byDateDesc);
}

export function latestPosts(limit?: number): Entry[] {
  const posts = [...getContent().posts].sort(byDateDesc);
  return limit ? posts.slice(0, limit) : posts;
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
