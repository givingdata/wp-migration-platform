// Edit module: list, read, add, change, delete and restore site content.
//
// One module for every place that changes content (the Worker behind the staff form, the
// Mac dashboard, later the central admin and a Claude connector), so the rules live once:
//   - every change is one commit (or one write), so any version can be recovered from history;
//   - saving checks the entry hasn't changed since it was opened (no silent overwrites);
//   - deleting moves the entry to trash.json with who/when, and restore() puts it back;
//   - slugs never change here, so published links keep working;
//   - HTML is cleaned of scripts and event handlers before it is stored.
//
// Storage is a "store" (a connector): stores/github.js (content.json in the client repo) and
// stores/file.js (a local folder) today; a future content platform or database only has to
// implement the same two methods. See README.md.
import { contentTypes, typeForCollection, collectionFor, allCollections, PAGE_TYPE as PAGE } from "../content-types.js";
import { cleanHtml, plainText } from "./sanitize.js";
import { assignPaths, isFrontPage as isFront, urlPath, RESERVED_PATHS } from "../routes.js";
import { SECTIONS_FILE, DESIGNED, designedId, designedKey, designedPath, designedTitle, pageSlots, checkSlotChanges, applySlotChanges } from "./sections.js";

export { SECTIONS_FILE, DESIGNED };

export const CONTENT_FILE = "content.json";
export const TRASH_FILE = "trash.json";

export class EditError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** The store's data moved on between read and write; the editor retries on this. */
export class StaleError extends Error {
  constructor(message = "Content changed while saving") {
    super(message);
    this.status = 409;
  }
}

// Fields an editor may change, by kind. Anything else on an entry (id, slug, images, wpId,
// link, menu data…) is kept as it is.
const TEXT_LIMITS = { title: 200, description: 1000, content: 200_000, time: 200, location: 500, author: 200, imageAlt: 300, linkUrl: 2000 };
const DATE_FIELDS = new Set(["date", "endDate"]);
const ALWAYS_EDITABLE = ["title", "description", "content", "imageAlt"];
// The rest only for types whose form has them (config/design-specs.json → fields).
const EDITABLE = ["date", "endDate", "time", "location", "author", "linkUrl"];

/** A redirect's destination: a path on this site or a full https:// address. */
export function redirectTarget(to) {
  const v = String(to ?? "").trim();
  if (/^https?:\/\/\S+$/i.test(v) && v.length <= 2000) return v;
  if (/^\/[^\s?#]*$/.test(v) && v.length <= 300) return v;
  throw new EditError("A redirect must go to a page on this site (/about-us/) or a full https:// address");
}

/** An old address to redirect from: the path only (a full URL on any host is cut to its path). */
export function redirectSource(from) {
  let v = String(from ?? "").trim();
  if (/^https?:\/\//i.test(v)) {
    try { v = decodeURI(new URL(v).pathname); } catch { v = ""; }
  }
  if (!/^\/[^\s?#*:]*$/.test(v) || v === "/" || v.length > 300) throw new EditError("The old address must be a path on this site, like /summer-camp/ (not the homepage)");
  return v;
}

function emptyContent() {
  return { pages: [], posts: [], events: [], media: [] };
}

async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slugify(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const matches = (entry, id) => String(entry.id ?? entry.slug) === String(id);

/**
 * Check an entry's new image fields: https addresses (under `base` when given), variants keyed by
 * width, a plain-text description. Returns { image, images, imageVariants, imageAlt }.
 */
export function cleanMedia(media, base = null) {
  const prefix = base ? `${String(base).replace(/\/+$/, "")}/` : null;
  const ok = (url) => typeof url === "string" && url.length <= 2000 && /^https:\/\/\S+$/i.test(url) && (!prefix || url.startsWith(prefix));
  const images = Array.isArray(media?.images) ? media.images : [];
  const variants = media?.imageVariants && typeof media.imageVariants === "object" ? media.imageVariants : {};
  const bad = !ok(media?.image) || images.length > 20 || !images.every(ok) ||
    Object.keys(variants).length > 20 || !Object.entries(variants).every(([w, url]) => /^\d{1,5}$/.test(w) && ok(url));
  if (bad) throw new EditError(prefix ? "The image must be one uploaded to this site's media storage" : "The image must be an https:// address", 400);
  const alt = plainText(String(media.imageAlt ?? "")).slice(0, TEXT_LIMITS.imageAlt);
  return { image: media.image, images: [...images], imageVariants: { ...variants }, imageAlt: alt || null };
}

/**
 * @param {object} opts
 * @param {{ read(): Promise<{files: Record<string, any>, head: string}>, write(files: Record<string, any>, message: string, head: string): Promise<object> }} opts.store
 * @param {object} opts.specs     config/design-specs.json
 * @param {() => string} [opts.now]  ISO timestamp (tests)
 * @param {string} [opts.mediaBase]  public URL of the site's media bucket (R2_PUBLIC_URL): setImage() only accepts images under it
 */
export function createEditor({ store, specs, now = () => new Date().toISOString(), attempts = 3, mediaBase = null }) {
  const types = contentTypes(specs);
  // The main menu bar (top-level items) carries design decisions, so staff only change the links
  // inside existing dropdowns unless design-specs says { "menu": { "topLevel": "editable" } }.
  const topLevelLocked = specs?.menu?.topLevel !== "editable";

  // Read → change → write, retrying when someone else committed in between.
  async function transaction(message, change) {
    for (let attempt = 1; ; attempt++) {
      const { files, head } = await store.read([CONTENT_FILE, TRASH_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const trash = files[TRASH_FILE] ?? { deleted: [] };
      const result = await change(content, trash);
      const out = { [CONTENT_FILE]: content };
      if (result?.trashChanged) out[TRASH_FILE] = trash;
      content.updatedAt = now();
      try {
        const commit = await store.write(out, typeof message === "function" ? message(result) : message, head);
        return { ...result, commit };
      } catch (e) {
        if (e instanceof StaleError && attempt < attempts) continue;
        throw e;
      }
    }
  }

  // Designed pages (sections.json) are written on their own: read → change → write, retrying
  // when someone else committed in between.
  async function sectionsTransaction(message, change) {
    for (let attempt = 1; ; attempt++) {
      const { files, head } = await store.read([SECTIONS_FILE]);
      const data = files[SECTIONS_FILE];
      if (!data?.pages) throw new EditError("This site has no designed pages", 404);
      const result = await change(data);
      try {
        const commit = await store.write({ [SECTIONS_FILE]: data }, message(result), head);
        return { ...result, commit };
      } catch (e) {
        if (e instanceof StaleError && attempt < attempts) continue;
        throw e;
      }
    }
  }

  // Each designed page, with the entry it replaces on the site (same web address), if any.
  // That entry is hidden from staff unless the page also shows its content ("content":
  // "before"/"after"), so edits go where visitors will see them.
  function designedPages(content, sections, pathOf) {
    const byPath = new Map();
    for (const c of allCollections(types)) for (const e of Array.isArray(content[c]) ? content[c] : []) if (e?.slug && e?.title) byPath.set(pathOf(c, e), { collection: c, entry: e });
    return Object.entries(sections?.pages || {})
      .filter(([, page]) => Array.isArray(page?.sections))
      .map(([key, page]) => {
        const path = designedPath(key);
        const replaces = byPath.get(path) ?? null;
        return { key, id: designedId(key), page, path, replaces, hides: !!replaces && !page.content, title: replaces?.entry.title ?? designedTitle(key, page) };
      });
  }

  function findDesigned(content, sections, id) {
    const d = designedPages(content, sections, paths(content)).find((p) => p.id === String(id) || p.key === designedKey(String(id)));
    if (!d) throw new EditError("That designed page doesn't exist any more", 404);
    return d;
  }

  function find(content, collection, id) {
    if (!allCollections(types).includes(collection)) throw new EditError(`Unknown collection "${collection}"`, 404);
    const list = Array.isArray(content[collection]) ? content[collection] : [];
    const index = list.findIndex((e) => matches(e, id));
    if (index < 0) throw new EditError("That entry doesn't exist any more (it may have been deleted)", 404);
    return { list, index, entry: list[index] };
  }

  const isFrontPage = (content, collection, entry) => isFront(content.frontPage, collection, entry);

  // Web address of each entry, exactly as the site builds it (lib/routes.js).
  function paths(content) {
    const byKey = new Map();
    const collections = Object.fromEntries(allCollections(types).map((c) => [c, Array.isArray(content[c]) ? content[c] : []]));
    for (const r of assignPaths(collections, content.frontPage, types)) byKey.set(`${r.collection}\0${r.id}`, urlPath(r.path));
    return (collection, entry) => byKey.get(`${collection}\0${String(entry.id ?? entry.slug)}`) ?? null;
  }

  // A menu link points at an entry when its last path segment is the entry's slug (the site
  // resolves menu links the same way, so old WordPress URLs count too).
  const linksTo = (item, entry) => {
    const url = String(item.url || "");
    if (/^[a-z]+:/i.test(url) && !url.startsWith("http")) return false;
    return url.split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/, "").replace(/^\/+|\/+$/g, "").split("/").pop() === entry.slug;
  };

  function inMenu(content, entry) {
    const walk = (items) => (items || []).some((i) => linksTo(i, entry) || walk(i.children));
    return walk(content.menu);
  }
  const inTopMenu = (content, entry) => (content.menu || []).some((i) => linksTo(i, entry));

  // Slugs in use, plus paths the site keeps for itself (listing pages like /news/).
  const takenSlugs = (content, except) =>
    new Set([
      ...RESERVED_PATHS,
      ...Object.values(types).filter((t) => t.listing).map((t) => t.listing.path),
      ...allCollections(types).flatMap((c) => (content[c] || []).filter((e) => e !== except).map((e) => e.slug)),
    ]);

  // Where a removed entry's visitors go by default: its type's listing page, else the homepage.
  function listingPath(collection) {
    const type = typeForCollection(types, collection);
    return type?.enabled && type.listing?.path ? `/${type.listing.path}/` : "/";
  }

  // Every address the site serves now: entries, listing pages, designed pages.
  function livePaths(content, sections) {
    const pathOf = paths(content);
    const out = new Set(["/"]);
    for (const c of allCollections(types)) for (const e of Array.isArray(content[c]) ? content[c] : []) if (e?.title && e?.slug) out.add(pathOf(c, e));
    for (const t of Object.values(types)) if (t.enabled && t.listing?.path) out.add(`/${t.listing.path}/`);
    for (const d of designedPages(content, sections, pathOf)) out.add(d.path);
    return out;
  }

  /** Validate and clean `changes` for an entry of `type`. Returns only the allowed fields. */
  function cleanChanges(type, changes, { requireCore = false } = {}) {
    const errors = {};
    const out = {};
    const allowed = new Set(type.key === "page" ? ALWAYS_EDITABLE : [...ALWAYS_EDITABLE, ...EDITABLE.filter((f) => type.fields?.includes(f))]);
    for (const [field, raw] of Object.entries(changes || {})) {
      if (!allowed.has(field)) continue;
      if (raw === null || raw === "") {
        if (field === "title" || (field === "date" && type.key !== "page")) errors[field] = "Required";
        else out[field] = null;
        continue;
      }
      if (typeof raw !== "string") { errors[field] = "Must be text"; continue; }
      const value = raw.trim();
      if (DATE_FIELDS.has(field)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) errors[field] = "Use the format YYYY-MM-DD";
        else out[field] = value;
        continue;
      }
      if (value.length > (TEXT_LIMITS[field] ?? 2000)) { errors[field] = `Max ${TEXT_LIMITS[field] ?? 2000} characters`; continue; }
      if (field === "linkUrl" && !/^https?:\/\/\S+$/i.test(value) && !/^\/\S*$/.test(value)) { errors[field] = "Must start with https:// (or / for a page on this site)"; continue; }
      out[field] = field === "content" ? cleanHtml(value) : plainText(value);
    }
    if (requireCore) {
      if (!out.title) errors.title ||= "Required";
      if (type.key !== "page" && !out.date) errors.date ||= "Required";
    }
    const start = out.date, end = out.endDate;
    if (start && end && end < start) errors.endDate = "Can't be before the start date";
    if (Object.keys(errors).length) throw new EditError("Some fields need fixing", 400, errors);
    return out;
  }

  const summary = (collection, e, content, pathOf) => ({
    collection,
    id: String(e.id ?? e.slug),
    type: e.type || typeForCollection(types, collection)?.key || collection,
    title: e.title,
    slug: e.slug,
    date: e.date ?? null,
    endDate: e.endDate ?? null,
    source: e.source ?? (e.wpId != null ? "wordpress" : null),
    frontPage: isFrontPage(content, collection, e),
    path: pathOf(collection, e),
  });

  /**
   * Change text, links or images inside a designed page's sections. `changes` is { slot: text }
   * (slots from get()); sections can't be added, removed, moved or retyped.
   */
  async function updateDesigned(id, changes, { version, by } = {}) {
    if (!changes || typeof changes !== "object" || !Object.keys(changes).length) throw new EditError("Nothing to save");
    return sectionsTransaction(
      (r) => `content: edit designed page "${r.entry.title}"${by ? ` (by ${by})` : ""}`,
      async (sections) => {
        const { files } = await store.read([CONTENT_FILE]);
        const d = findDesigned(files[CONTENT_FILE] ?? emptyContent(), sections, id);
        if (version && (await hash(d.page)) !== version) {
          throw new EditError("Someone else changed this page after you opened it. Reload it to see their changes, then make yours again.", 409);
        }
        const { clean, errors } = checkSlotChanges(pageSlots(d.page).flatMap((s) => s.slots), changes);
        if (Object.keys(errors).length) throw new EditError("Some fields need fixing", 400, errors);
        if (!Object.keys(clean).length) throw new EditError("Nothing to save");
        const next = applySlotChanges(d.page, clean);
        next.modified = now();
        if (by) next.modifiedBy = by;
        sections.pages[d.key] = next;
        return { collection: DESIGNED, entry: { id: d.id, title: d.title, sections: pageSlots(next) }, version: await hash(next), changed: Object.keys(clean) };
      },
    );
  }

  return {
    types,

    /** Every entry, grouped by collection, newest first (pages by title). */
    async list() {
      const { files } = await store.read([CONTENT_FILE, TRASH_FILE, SECTIONS_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const collections = {};
      const pathOf = paths(content);
      const designed = designedPages(content, files[SECTIONS_FILE], pathOf);
      const hidden = new Set(designed.filter((d) => d.hides).map((d) => d.replaces.entry));
      if (designed.length) {
        collections[DESIGNED] = designed
          .map((d) => ({ collection: DESIGNED, id: d.id, type: DESIGNED, title: d.title, slug: d.key, date: null, endDate: null, source: "sections", frontPage: d.key === "/", path: d.path, designed: true }))
          .sort((a, b) => (b.frontPage - a.frontPage) || a.title.localeCompare(b.title));
      }
      for (const c of allCollections(types)) {
        const list = (Array.isArray(content[c]) ? content[c] : []).filter((e) => e && e.title && e.slug && !hidden.has(e)).map((e) => summary(c, e, content, pathOf));
        if (!list.length && c !== "pages" && !typeForCollection(types, c)?.enabled) continue;
        list.sort(c === "pages" ? (a, b) => a.title.localeCompare(b.title) : (a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
        collections[c] = list;
      }
      return { collections, trashCount: (files[TRASH_FILE]?.deleted || []).length };
    },

    /** One entry with its version (pass the version back to update()). */
    async get(collection, id) {
      const { files } = await store.read([CONTENT_FILE, SECTIONS_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      if (collection === DESIGNED) {
        const d = findDesigned(content, files[SECTIONS_FILE], id);
        return {
          collection: DESIGNED,
          entry: { id: d.id, title: d.title, sections: pageSlots(d.page) },
          version: await hash(d.page),
          type: { key: DESIGNED, label: "Designed page", fields: [], fieldLabels: {}, dateLabel: "Date" },
          designed: true,
          frontPage: d.key === "/",
          inMenu: false,
          inTopMenu: false,
          topLevelLocked,
          path: d.path,
        };
      }
      const { entry } = find(content, collection, id);
      // A page replaced on the site by a designed page: point the editor there instead.
      const shadow = designedPages(content, files[SECTIONS_FILE], paths(content)).find((d) => d.hides && d.replaces.entry === entry);
      const type = typeForCollection(types, collection) ?? { key: collection, fields: [] };
      return {
        collection,
        entry,
        version: await hash(entry),
        type: { key: type.key, label: type.label, fields: type.fields, fieldLabels: type.fieldLabels ?? {}, dateLabel: type.dateLabel ?? "Date" },
        frontPage: isFrontPage(content, collection, entry),
        inMenu: inMenu(content, entry),
        inTopMenu: inTopMenu(content, entry),
        topLevelLocked,
        path: paths(content)(collection, entry),
        ...(shadow ? { designedPage: { collection: DESIGNED, id: shadow.id } } : {}),
      };
    },

    /**
     * Add a new entry of `type` (e.g. from the staff form). `entry` is stored as given apart
     * from HTML cleaning; a new id and a unique slug are assigned when missing.
     */
    async create(typeKey, entry, { message } = {}) {
      const type = types[typeKey];
      if (!type?.enabled) throw new EditError(`Unknown content type "${typeKey}"`);
      const collection = collectionFor(types, typeKey);
      return transaction(
        message ?? ((r) => `content: add ${type.label.toLowerCase()} "${r.entry.title}"`),
        async (content) => {
          const list = (content[collection] ||= []);
          const clean = { ...entry, type: typeKey, id: entry.id ?? crypto.randomUUID(), content: entry.content ? cleanHtml(entry.content) : entry.content ?? null };
          if (clean.description) clean.description = plainText(clean.description);
          // Same id again (a retried submission) replaces the earlier copy.
          const existing = list.findIndex((e) => matches(e, clean.id));
          const taken = takenSlugs(content, list[existing]);
          let slug = slugify(clean.slug || clean.title) || clean.id;
          for (let n = 2; taken.has(slug); n++) slug = `${slugify(clean.slug || clean.title)}-${n}`;
          clean.slug = slug;
          if (existing >= 0) list[existing] = { ...list[existing], ...clean };
          else list.unshift(clean);
          return { collection, entry: clean };
        },
      );
    },

    /**
     * Add a page written by staff. Unlike form submissions it isn't rewritten by Claude: the
     * text is stored as written (cleaned of scripts). Returns the page and its web address.
     */
    async createPage(fields, { by } = {}) {
      const clean = cleanChanges(PAGE, fields, { requireCore: true });
      return transaction(
        (r) => `content: add page "${r.entry.title}"${by ? ` (by ${by})` : ""}`,
        async (content) => {
          const list = (content.pages ||= []);
          const base = slugify(clean.title) || "page";
          const taken = takenSlugs(content);
          let slug = base;
          for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
          const entry = { id: crypto.randomUUID(), slug, type: "page", title: clean.title, description: clean.description ?? null, content: clean.content ?? "", date: now().slice(0, 10), created: now(), source: "editor", ...(by ? { createdBy: by } : {}) };
          list.push(entry);
          return { collection: "pages", entry, path: paths(content)("pages", entry) };
        },
      );
    },

    /** Change fields of an existing entry. Fails with 409 if it changed since `version`. */
    async update(collection, id, changes, { version, by } = {}) {
      if (collection === DESIGNED) return updateDesigned(id, changes, { version, by });
      const type = typeForCollection(types, collection);
      if (!type) throw new EditError(`Unknown collection "${collection}"`, 404);
      const clean = cleanChanges(type, changes);
      if (!Object.keys(clean).length) throw new EditError("Nothing to save");
      return transaction(
        (r) => `content: edit ${type.label.toLowerCase()} "${r.entry.title}"${by ? ` (by ${by})` : ""}`,
        async (content) => {
          const { list, index, entry } = find(content, collection, id);
          if (version && (await hash(entry)) !== version) {
            throw new EditError("Someone else changed this entry after you opened it. Reload it to see their changes, then make yours again.", 409);
          }
          const next = { ...entry, ...clean, modified: now() };
          if (by) next.modifiedBy = by;
          for (const [k, v] of Object.entries(clean)) if (v === null) delete next[k];
          list[index] = next;
          return { collection, entry: next, version: await hash(next) };
        },
      );
    },

    /**
     * Where any of `terms` appears (ignoring case) in the text staff can edit: entries' text
     * fields and designed pages' text and link slots. Returns each matching entry with its
     * version and the full value of each matching field, for updateMany().
     */
    async search(terms, { limit = 60 } = {}) {
      const needles = (terms || []).map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 2);
      if (!needles.length) return [];
      const hit = (v) => typeof v === "string" && needles.some((n) => v.toLowerCase().includes(n));
      const { files } = await store.read([CONTENT_FILE, SECTIONS_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const pathOf = paths(content);
      const designed = designedPages(content, files[SECTIONS_FILE], pathOf);
      const hidden = new Set(designed.filter((d) => d.hides).map((d) => d.replaces.entry));
      const out = [];
      for (const d of designed) {
        const slots = pageSlots(d.page).flatMap((x) => x.slots.filter((slot) => slot.kind !== "image").map((slot) => ({ ...slot, section: x.label })));
        const fields = Object.fromEntries(slots.filter((slot) => hit(slot.value)).map((slot) => [slot.slot, slot.value]));
        const labels = Object.fromEntries(slots.filter((slot) => slot.slot in fields).map((slot) => [slot.slot, `${slot.section} › ${slot.label}`]));
        if (Object.keys(fields).length) out.push({ collection: DESIGNED, id: d.id, title: d.title, path: d.path, version: await hash(d.page), fields, labels });
      }
      for (const c of allCollections(types)) {
        const type = typeForCollection(types, c) ?? { key: c, fields: [] };
        const allowed = (type.key === "page" ? ALWAYS_EDITABLE : [...ALWAYS_EDITABLE, ...EDITABLE.filter((f) => type.fields?.includes(f))]).filter((f) => !DATE_FIELDS.has(f));
        for (const e of Array.isArray(content[c]) ? content[c] : []) {
          if (!e?.title || !e?.slug || hidden.has(e)) continue;
          const fields = Object.fromEntries(allowed.filter((f) => hit(e[f])).map((f) => [f, e[f]]));
          if (Object.keys(fields).length) out.push({ collection: c, id: String(e.id ?? e.slug), title: e.title, path: pathOf(c, e), version: await hash(e), fields });
        }
      }
      return out.slice(0, limit);
    },

    /**
     * Change several entries and designed pages in one commit (e.g. a new phone number
     * everywhere). `edits` = [{ collection, id, changes, version }], checked like update(); if
     * any entry changed since its `version` or any change is invalid, nothing is saved.
     * Returns each entry's new version.
     */
    async updateMany(edits, { by, message } = {}) {
      if (!Array.isArray(edits) || !edits.length) throw new EditError("Nothing to save");
      if (edits.length > 100) throw new EditError("That's too many changes for one go; keep it to 100 or fewer");
      for (let attempt = 1; ; attempt++) {
        const { files, head } = await store.read([CONTENT_FILE, SECTIONS_FILE]);
        const content = files[CONTENT_FILE] ?? emptyContent();
        const sections = files[SECTIONS_FILE];
        const out = {};
        const entries = [];
        for (const { collection, id, changes, version } of edits) {
          if (collection === DESIGNED) {
            const d = findDesigned(content, sections, id);
            if (version && (await hash(d.page)) !== version) throw new EditError(`Someone else changed “${d.title}” after this was drafted. Ask again to see their changes.`, 409);
            const { clean, errors } = checkSlotChanges(pageSlots(d.page).flatMap((x) => x.slots), changes);
            if (Object.keys(errors).length) throw new EditError(`“${d.title}” needs fixing`, 400, errors);
            if (!Object.keys(clean).length) continue;
            const next = applySlotChanges(d.page, clean);
            next.modified = now();
            if (by) next.modifiedBy = by;
            sections.pages[d.key] = next;
            out[SECTIONS_FILE] = sections;
            entries.push({ collection, id: d.id, title: d.title, version: await hash(next) });
            continue;
          }
          const type = typeForCollection(types, collection);
          if (!type) throw new EditError(`Unknown collection "${collection}"`, 404);
          const clean = cleanChanges(type, changes);
          if (!Object.keys(clean).length) continue;
          const { list, index, entry } = find(content, collection, id);
          if (version && (await hash(entry)) !== version) throw new EditError(`Someone else changed “${entry.title}” after this was drafted. Ask again to see their changes.`, 409);
          const next = { ...entry, ...clean, modified: now() };
          if (by) next.modifiedBy = by;
          for (const [k, v] of Object.entries(clean)) if (v === null) delete next[k];
          list[index] = next;
          content.updatedAt = now();
          out[CONTENT_FILE] = content;
          entries.push({ collection, id: String(next.id ?? next.slug), title: next.title, version: await hash(next) });
        }
        if (!entries.length) throw new EditError("Nothing to save");
        try {
          const commit = await store.write(out, message ?? `content: edit ${entries.length} entries${by ? ` (by ${by})` : ""}`, head);
          return { entries, commit };
        } catch (e) {
          if (e instanceof StaleError && attempt < attempts) continue;
          throw e;
        }
      }
    },

    /**
     * Give an entry a new main image (Slack photos; the image is already stored and resized).
     * `media` = { image, images, imageVariants, imageAlt }. Only types whose form has an image
     * field show one on the site, and every address must be https (under `mediaBase` when the
     * editor has one, i.e. the site's own R2 bucket). Fails with 409 if it changed since `version`.
     */
    async setImage(collection, id, media, { version, by } = {}) {
      const type = typeForCollection(types, collection);
      if (!type) throw new EditError(`Unknown collection "${collection}"`, 404);
      if (!type.fields?.includes("image")) throw new EditError(`${type.label ?? collection} entries don't show a main image on this site`, 400);
      const clean = cleanMedia(media, mediaBase);
      return transaction(
        (r) => `content: new image for ${type.label.toLowerCase()} "${r.entry.title}"${by ? ` (by ${by})` : ""}`,
        async (content) => {
          const { list, index, entry } = find(content, collection, id);
          if (version && (await hash(entry)) !== version) {
            throw new EditError("Someone else changed this entry after you opened it. Reload it to see their changes, then make yours again.", 409);
          }
          const next = { ...entry, ...clean, modified: now() };
          if (by) next.modifiedBy = by;
          list[index] = next;
          return { collection, entry: next, version: await hash(next) };
        },
      );
    },

    /**
     * Delete an entry: it leaves the site and goes to trash.json (with who, when and why), so
     * restore() can bring it back. Its images stay in storage. The homepage can't be deleted.
     */
    async remove(collection, id, { by, reason, version, removeFromMenu = false, redirectTo = null } = {}) {
      const target = redirectTo == null || redirectTo === "" ? null : redirectTarget(redirectTo);
      return transaction(
        (r) => `content: delete ${r.label} "${r.entry.title}"${by ? ` (by ${by})` : ""}\n\nMoved to ${TRASH_FILE} as ${r.trashId}; restore it from there.`,
        async (content, trash) => {
          if (collection === DESIGNED) throw new EditError("Designed pages are part of the site's design, so they can't be deleted here. Ask your web team.", 409);
          const { list, index, entry } = find(content, collection, id);
          if (isFrontPage(content, collection, entry)) throw new EditError("This page is the homepage, so it can't be deleted.", 409);
          if (topLevelLocked && inTopMenu(content, entry)) {
            throw new EditError("This page is linked from the main menu bar, so it can't be deleted here. Ask your web team to change the menu bar first.", 409);
          }
          if (version && (await hash(entry)) !== version) {
            throw new EditError("Someone else changed this entry after you opened it. Reload it before deleting.", 409);
          }
          // Its old address sends visitors on (the build writes the redirect while it's in the
          // trash, and never for an address the site serves again, e.g. after a restore).
          const oldPath = paths(content)(collection, entry);
          list.splice(index, 1);
          // Optionally take its menu links out too, remembering where they were for restore().
          const menuLinks = [];
          if (removeFromMenu && Array.isArray(content.menu)) {
            const prune = (items, parent) =>
              items.filter((item, i) => {
                if (linksTo(item, entry)) {
                  // A dropdown heading keeps its items and just stops being a link.
                  if ((item.children || []).length) {
                    menuLinks.push({ heading: item.title, url: item.url });
                    item.url = null;
                  } else {
                    menuLinks.push({ item, parent, index: i });
                    return false;
                  }
                }
                if (item.children) item.children = prune(item.children, item.title);
                return true;
              });
            content.menu = prune(content.menu, null);
            if (menuLinks.length) content.menuEditedAt = now();
          }
          const trashId = crypto.randomUUID();
          const sendTo = target && target !== oldPath ? target : listingPath(collection);
          (trash.deleted ||= []).unshift({
            trashId, collection, deletedAt: now(), deletedBy: by ?? null, reason: reason ? plainText(String(reason)).slice(0, 500) : null, entry,
            ...(menuLinks.length ? { menuLinks } : {}), ...(oldPath && oldPath !== "/" ? { path: oldPath, redirectTo: sendTo } : {}),
          });
          const label = (typeForCollection(types, collection)?.label ?? collection).toLowerCase();
          return { trashChanged: true, trashId, collection, entry, label, removedFromMenu: menuLinks.length, path: oldPath, redirectTo: oldPath && oldPath !== "/" ? sendTo : null };
        },
      );
    },

    /**
     * The main menu, with each link's address on this site and the pages it could link to.
     * Pass `version` back to saveMenu().
     */
    async getMenu() {
      const { files } = await store.read([CONTENT_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const menu = Array.isArray(content.menu) ? content.menu : [];
      const pathOf = paths(content);
      const targets = [];
      for (const c of allCollections(types)) {
        for (const e of Array.isArray(content[c]) ? content[c] : []) {
          if (e?.title && e?.slug) targets.push({ title: e.title, path: pathOf(c, e), collection: c, slug: e.slug });
        }
      }
      for (const t of Object.values(types)) if (t.listing && t.enabled) targets.push({ title: t.listing.title, path: `/${t.listing.path}/`, collection: "listing" });
      // Where each menu link goes on the new site (old WordPress URLs resolve by slug, as on the site).
      const bySlug = new Map(targets.filter((t) => t.slug).map((t) => [t.slug, t.path]));
      const host = (h) => h.toLowerCase().replace(/^www\./, "");
      let siteHost = null;
      try { siteHost = content.siteUrl ? host(new URL(content.siteUrl).hostname) : null; } catch {}
      const resolve = (url) => {
        if (!url) return null;
        if (/^(mailto|tel):/i.test(url)) return url;
        let local = url;
        if (/^https?:/i.test(url)) {
          let u;
          try { u = new URL(url); } catch { return url; }
          if (!siteHost || host(u.hostname) !== siteHost) return url; // another website
          local = u.pathname;
        }
        const slug = local.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "").split("/").pop();
        if (!slug) return "/";
        return bySlug.get(slug) ?? targets.find((t) => t.path === `/${slug}/`)?.path ?? local;
      };
      const shape = (items) => items.map((i) => ({ title: i.title, url: i.url ?? null, path: resolve(i.url), children: shape(i.children || []) }));
      targets.sort((a, b) => a.title.localeCompare(b.title));
      return { menu: shape(menu), version: await hash(menu), targets, editedAt: content.menuEditedAt ?? null, topLevelLocked };
    },

    /**
     * Replace the main menu. Items are { title, url, children } with one level of dropdowns;
     * url is a path on this site ("/about-us/"), an https:// or mailto: link, or empty for a
     * dropdown heading. Fails with 409 if the menu changed since `version`. While the menu bar
     * is locked, the top-level items (names, links, order) must stay as they are, and links can
     * only go into dropdowns that already exist.
     */
    async saveMenu(menu, { version, by } = {}) {
      const errors = {};
      const cleanItem = (item, where, depth) => {
        const title = plainText(item?.title ?? "").slice(0, 100);
        let url = typeof item?.url === "string" ? item.url.trim() : "";
        const children = Array.isArray(item?.children) ? item.children : [];
        if (!title) errors[where] = "Every menu item needs a name";
        if (url && !/^(https?:\/\/\S+|mailto:\S+|tel:\S+|\/\S*)$/i.test(url)) errors[where] = `"${title}": links start with / (a page here), https:// or mailto:`;
        if (depth > 0 && children.length) errors[where] = `"${title}": dropdowns can only be one level deep`;
        if (!url && !children.length) errors[where] = `"${title}" needs a link (or items under it)`;
        return { title, url: url || null, children: depth === 0 ? children.map((c, i) => cleanItem(c, `${where}.${i}`, 1)) : [] };
      };
      if (!Array.isArray(menu)) throw new EditError("The menu must be a list");
      if (menu.length > 40) throw new EditError("That's a lot of menu items; keep it to 40 or fewer");
      const clean = menu.map((item, i) => cleanItem(item, String(i), 0));
      if (Object.keys(errors).length) throw new EditError("The menu needs fixing", 400, errors);
      return transaction(
        `content: edit menu${by ? ` (by ${by})` : ""}`,
        async (content) => {
          if (version && (await hash(Array.isArray(content.menu) ? content.menu : [])) !== version) {
            throw new EditError("Someone else changed the menu after you opened it. Reload it to see their changes, then make yours again.", 409);
          }
          if (topLevelLocked) {
            const current = (Array.isArray(content.menu) ? content.menu : []).map((m) => ({
              title: plainText(m.title ?? "").slice(0, 100),
              url: (typeof m.url === "string" && m.url.trim()) || null,
              had: (m.children || []).length > 0,
            }));
            const same = current.length === clean.length && current.every((m, i) => m.title === clean[i].title && (m.url ?? null) === (clean[i].url ?? null));
            if (!same) throw new EditError("The main menu bar can only be changed by your web team. You can change the links inside each dropdown.", 403);
            const newDropdown = clean.find((m, i) => m.children.length && !current[i].had);
            if (newDropdown) throw new EditError(`“${newDropdown.title}” doesn't have a dropdown, and adding one changes the menu bar. Put the link in an existing dropdown.`, 403);
          }
          content.menu = clean;
          content.menuEditedAt = now();
          if (by) content.menuEditedBy = by;
          return { menu: clean, version: await hash(clean) };
        },
      );
    },

    /**
     * Everything staff can see, in one read (for read-only checks such as the Slack bot's
     * "anything out of date?"): entries with their address, designed pages' slots, the menu's
     * links, every address the site serves, and redirects. Nothing here is for writing back.
     */
    async readAll() {
      const { files } = await store.read([CONTENT_FILE, TRASH_FILE, SECTIONS_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const pathOf = paths(content);
      const designed = designedPages(content, files[SECTIONS_FILE], pathOf);
      const hidden = new Set(designed.filter((d) => d.hides).map((d) => d.replaces.entry));
      const entries = [];
      for (const c of allCollections(types)) {
        const type = typeForCollection(types, c) ?? { key: c };
        for (const e of Array.isArray(content[c]) ? content[c] : []) {
          if (e?.title && e?.slug && !hidden.has(e)) entries.push({ collection: c, type: type.key, typeLabel: type.label ?? c, id: String(e.id ?? e.slug), title: e.title, path: pathOf(c, e), entry: e });
        }
      }
      const flat = (items) => (items || []).flatMap((i) => [{ title: i.title, url: i.url ?? null }, ...flat(i.children)]);
      return {
        entries,
        designed: designed.map((d) => ({ id: d.id, title: d.title, path: d.path, sections: pageSlots(d.page), seo: d.page.seo || d.replaces?.entry.seo || null })),
        menu: flat(content.menu),
        live: [...livePaths(content, files[SECTIONS_FILE])],
        redirects: [
          ...(Array.isArray(content.redirects) ? content.redirects : []).map((r) => r.from),
          ...(files[TRASH_FILE]?.deleted || []).filter((d) => d.path && d.redirectTo).map((d) => d.path),
        ],
        siteUrl: content.siteUrl ?? null,
      };
    },

    /** Staff redirects (content.json → redirects), plus where removed entries' addresses go. */
    async redirects() {
      const { files } = await store.read([CONTENT_FILE, TRASH_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      return {
        redirects: Array.isArray(content.redirects) ? content.redirects : [],
        removed: (files[TRASH_FILE]?.deleted || []).filter((d) => d.path).map((d) => ({ from: d.path, to: d.redirectTo, title: d.entry?.title ?? null, trashId: d.trashId })),
      };
    },

    /**
     * Send an old address somewhere (content.json → redirects; the build writes them to
     * _redirects after redirects.csv). Refused for an address the site serves now. Adding the
     * same `from` again replaces its destination.
     */
    async addRedirect(from, to, { by } = {}) {
      const source = redirectSource(from);
      const target = redirectTarget(to);
      const bare = (p) => p.replace(/\/+$/, "");
      if (bare(source) === bare(target)) throw new EditError("A redirect can't point to itself");
      return transaction(
        `content: redirect ${source} → ${target}${by ? ` (by ${by})` : ""}`,
        async (content) => {
          const { files } = await store.read([SECTIONS_FILE]);
          const live = livePaths(content, files[SECTIONS_FILE]);
          if (live.has(source) || live.has(`${bare(source)}/`)) throw new EditError(`${source} is a page on the site, so it can't be redirected. Remove the page first.`, 409);
          const list = (content.redirects = Array.isArray(content.redirects) ? content.redirects : []);
          const previous = list.find((r) => bare(r.from) === bare(source)) ?? null;
          if (!previous && list.length >= 500) throw new EditError("That's a lot of redirects; ask your web team to tidy them up", 409);
          const redirect = { from: source, to: target, addedAt: now(), ...(by ? { addedBy: by } : {}) };
          content.redirects = [...list.filter((r) => r !== previous), redirect];
          return { redirect, previous };
        },
      );
    },

    /** Stop redirecting an old address (a staff redirect; removed entries' ones go with a restore). */
    async removeRedirect(from, { by } = {}) {
      const source = redirectSource(from);
      const bare = (p) => p.replace(/\/+$/, "");
      return transaction(
        `content: remove redirect ${source}${by ? ` (by ${by})` : ""}`,
        async (content) => {
          const list = Array.isArray(content.redirects) ? content.redirects : [];
          const redirect = list.find((r) => bare(r.from) === bare(source));
          if (!redirect) throw new EditError(`There's no redirect from ${source}`, 404);
          content.redirects = list.filter((r) => r !== redirect);
          return { redirect };
        },
      );
    },

    /** Deleted entries, newest first. */
    async trash() {
      const { files } = await store.read([TRASH_FILE]);
      return (files[TRASH_FILE]?.deleted || []).map((d) => ({
        trashId: d.trashId, collection: d.collection, deletedAt: d.deletedAt, deletedBy: d.deletedBy, reason: d.reason,
        id: String(d.entry?.id ?? d.entry?.slug), title: d.entry?.title, slug: d.entry?.slug, type: d.entry?.type,
      }));
    },

    /** Put a deleted entry back where it was. Its slug is kept unless something else took it. */
    async restore(trashId, { by } = {}) {
      return transaction(
        (r) => `content: restore "${r.entry.title}"${by ? ` (by ${by})` : ""}`,
        async (content, trash) => {
          const idx = (trash.deleted || []).findIndex((d) => d.trashId === trashId);
          if (idx < 0) throw new EditError("That item isn't in the trash any more", 404);
          const { collection, entry, menuLinks = [] } = trash.deleted[idx];
          const list = (content[collection] ||= []);
          if (list.some((e) => matches(e, entry.id ?? entry.slug))) throw new EditError("An entry with the same id is already on the site", 409);
          const taken = new Set(allCollections(types).flatMap((c) => (content[c] || []).map((e) => e.slug)));
          const restored = { ...entry };
          for (let n = 2; taken.has(restored.slug); n++) restored.slug = `${entry.slug}-${n}`;
          list.unshift(restored);
          trash.deleted.splice(idx, 1);
          // Put its menu links back where they were (under the same dropdown if it still exists).
          if (menuLinks.length && restored.slug === entry.slug) {
            content.menu ||= [];
            for (const { item, parent, index, heading, url } of menuLinks) {
              if (heading) {
                const h = content.menu.find((m) => m.title === heading && !m.url);
                if (h) h.url = url;
                continue;
              }
              const home = parent == null ? content.menu : content.menu.find((m) => m.title === parent)?.children ?? content.menu;
              home.splice(Math.min(index, home.length), 0, item);
            }
            content.menuEditedAt = now();
          }
          return { trashChanged: true, collection, entry: restored, slugChanged: restored.slug !== entry.slug, menuRestored: menuLinks.length > 0 && restored.slug === entry.slug };
        },
      );
    },
  };
}
