// Web addresses for entries: the site builds its pages with these, and the Edit module shows
// them to staff, so both always agree on where an entry lives.
import { allCollections, typeForCollection } from "./content-types.js";

// Paths the site itself uses; content can't take them.
export const RESERVED_PATHS = ["", "index", "404", "rss.xml", "sitemap-index.xml", "robots.txt"];

/** Whether `entry` (from `collection`) is the page WordPress used as its homepage. */
export function isFrontPage(frontPage, collection, entry) {
  return !!frontPage && collection === "pages" && [entry.wpId, entry.id].some((v) => v != null && v !== "" && String(v) === String(frontPage));
}

/**
 * Assign every entry a unique path (no leading/trailing slash; the homepage gets null).
 * Pages keep their bare slug (/about); other entries too unless it collides, in which case
 * they're prefixed with their type (/event/about). Pages go first, then the original types,
 * so adding a type never moves an existing link.
 *
 * @param {Record<string, object[]>} collections  entries by collection (entries need slug and title)
 * @returns {{ collection: string, entry: object, id: string, type: string, path: string | null }[]}
 */
export function assignPaths(collections, frontPage, types) {
  const taken = new Set([...RESERVED_PATHS, ...Object.values(types).filter((t) => t.listing).map((t) => t.listing.path)]);
  const out = [];
  const order = [...new Set(["pages", "exhibitions", "events", "posts", ...allCollections(types)])];
  for (const collection of order) {
    const type = typeForCollection(types, collection)?.key ?? collection;
    for (const entry of collections[collection] ?? []) {
      if (!entry?.slug || !entry?.title) continue;
      const id = String(entry.id ?? entry.slug);
      if (isFrontPage(frontPage, collection, entry)) {
        out.push({ collection, entry, id, type, path: null });
        continue;
      }
      const slug = String(entry.slug).replace(/^\/+|\/+$/g, "");
      let p = slug;
      if (taken.has(p)) p = `${type}/${p}`;
      for (let n = 2; taken.has(p); n++) p = `${type}/${slug}-${n}`;
      taken.add(p);
      out.push({ collection, entry, id, type, path: p });
    }
  }
  return out;
}

/** The public URL path ("/" or "/about/") of a path from assignPaths(). */
export const urlPath = (p) => (p == null ? "/" : `/${p}/`);
