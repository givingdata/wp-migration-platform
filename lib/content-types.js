// Content types: the kinds of entry staff can add (News, Event, Announcement, …).
//
// Each client lists its types in config/design-specs.json → contentTypes. The staff form,
// the Worker, the Edit module and the site all read that list through this file, so a
// client can add or hide a type without code changes.
//
// Types that were built in before the list existed (exhibition, event, post) keep working
// for entries already in content.json even when a client's list leaves them out: they
// still render at the same paths, they just can't be added through the form.

/** Defaults for the original built-in types; a client's design-specs entry overrides them. */
export const BUILT_IN = {
  post: {
    label: "News", collection: "posts", layout: "article", aspectRatio: "16:9", dateLabel: "Publish date",
    listing: { path: "news", title: "News", intro: "News and updates." },
    fields: ["title", "description", "date", "author", "image"],
  },
  event: {
    label: "Event", collection: "events", layout: "event", aspectRatio: "1:1", dateLabel: "Event date",
    listing: { path: "events", title: "Events", intro: "Upcoming and past events.", upcoming: true, currentLabel: "Upcoming", pastLabel: "Past events" },
    fields: ["title", "description", "date", "endDate", "time", "location", "image"],
  },
  exhibition: {
    label: "Exhibition", collection: "exhibitions", layout: "exhibition", aspectRatio: "1.5:1", dateLabel: "Opening date",
    listing: { path: "exhibitions", title: "Exhibitions", intro: "Current, upcoming and past exhibitions.", upcoming: true, currentLabel: "Current & upcoming", pastLabel: "Past exhibitions" },
    fields: ["title", "description", "date", "endDate", "location", "image"],
  },
};

/** Pages come from WordPress (or the Edit module), never from the form. */
export const PAGE_TYPE = { key: "page", label: "Page", collection: "pages", layout: "article", aspectRatio: "16:9", fields: [] };

const LAYOUTS = ["article", "event", "exhibition"];

/**
 * All content types for a client: the ones in design-specs (enabled: can be added) plus any
 * built-in type that isn't listed (enabled: false). Returns { key: typeDef } in spec order.
 */
export function contentTypes(specs) {
  const listed = specs?.contentTypes || {};
  const out = {};
  for (const [key, spec] of Object.entries(listed)) {
    const base = BUILT_IN[key] || {};
    const def = { ...base, ...spec, key, enabled: true };
    def.label ||= key.charAt(0).toUpperCase() + key.slice(1);
    def.collection ||= `${key}s`;
    def.layout = LAYOUTS.includes(def.layout) ? def.layout : "article";
    def.fields ||= ["title", "description", "date", "image"];
    if (def.listing !== false && !def.listing) def.listing = { path: def.collection, title: `${def.label}s` };
    out[key] = def;
  }
  for (const [key, base] of Object.entries(BUILT_IN)) if (!out[key]) out[key] = { ...base, key, enabled: false };
  return out;
}

/** The type whose entries live in `collection` (e.g. "events" → event), or null. */
export function typeForCollection(types, collection) {
  if (collection === "pages") return PAGE_TYPE;
  return Object.values(types).find((t) => t.collection === collection) ?? null;
}

/** Collection name for a type key ("page" → "pages"). */
export function collectionFor(types, key) {
  if (key === "page") return "pages";
  return types[key]?.collection ?? `${key}s`;
}

/** Every collection that can hold entries: pages first, then each type's. */
export function allCollections(types) {
  return ["pages", ...new Set(Object.values(types).map((t) => t.collection))];
}
