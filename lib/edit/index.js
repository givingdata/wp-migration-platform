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
 * @param {object} opts
 * @param {{ read(): Promise<{files: Record<string, any>, head: string}>, write(files: Record<string, any>, message: string, head: string): Promise<object> }} opts.store
 * @param {object} opts.specs     config/design-specs.json
 * @param {() => string} [opts.now]  ISO timestamp (tests)
 */
export function createEditor({ store, specs, now = () => new Date().toISOString(), attempts = 3 }) {
  const types = contentTypes(specs);

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

  // Slugs in use, plus paths the site keeps for itself (listing pages like /news/).
  const takenSlugs = (content, except) =>
    new Set([
      ...RESERVED_PATHS,
      ...Object.values(types).filter((t) => t.listing).map((t) => t.listing.path),
      ...allCollections(types).flatMap((c) => (content[c] || []).filter((e) => e !== except).map((e) => e.slug)),
    ]);

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

  return {
    types,

    /** Every entry, grouped by collection, newest first (pages by title). */
    async list() {
      const { files } = await store.read([CONTENT_FILE, TRASH_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const collections = {};
      const pathOf = paths(content);
      for (const c of allCollections(types)) {
        const list = (Array.isArray(content[c]) ? content[c] : []).filter((e) => e && e.title && e.slug).map((e) => summary(c, e, content, pathOf));
        if (!list.length && c !== "pages" && !typeForCollection(types, c)?.enabled) continue;
        list.sort(c === "pages" ? (a, b) => a.title.localeCompare(b.title) : (a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
        collections[c] = list;
      }
      return { collections, trashCount: (files[TRASH_FILE]?.deleted || []).length };
    },

    /** One entry with its version (pass the version back to update()). */
    async get(collection, id) {
      const { files } = await store.read([CONTENT_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const { entry } = find(content, collection, id);
      const type = typeForCollection(types, collection) ?? { key: collection, fields: [] };
      return {
        collection,
        entry,
        version: await hash(entry),
        type: { key: type.key, label: type.label, fields: type.fields, fieldLabels: type.fieldLabels ?? {}, dateLabel: type.dateLabel ?? "Date" },
        frontPage: isFrontPage(content, collection, entry),
        inMenu: inMenu(content, entry),
        path: paths(content)(collection, entry),
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
     * Delete an entry: it leaves the site and goes to trash.json (with who, when and why), so
     * restore() can bring it back. Its images stay in storage. The homepage can't be deleted.
     */
    async remove(collection, id, { by, reason, version, removeFromMenu = false } = {}) {
      return transaction(
        (r) => `content: delete ${r.label} "${r.entry.title}"${by ? ` (by ${by})` : ""}\n\nMoved to ${TRASH_FILE} as ${r.trashId}; restore it from there.`,
        async (content, trash) => {
          const { list, index, entry } = find(content, collection, id);
          if (isFrontPage(content, collection, entry)) throw new EditError("This page is the homepage, so it can't be deleted.", 409);
          if (version && (await hash(entry)) !== version) {
            throw new EditError("Someone else changed this entry after you opened it. Reload it before deleting.", 409);
          }
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
          (trash.deleted ||= []).unshift({ trashId, collection, deletedAt: now(), deletedBy: by ?? null, reason: reason ? plainText(String(reason)).slice(0, 500) : null, entry, ...(menuLinks.length ? { menuLinks } : {}) });
          const label = (typeForCollection(types, collection)?.label ?? collection).toLowerCase();
          return { trashChanged: true, trashId, collection, entry, label, removedFromMenu: menuLinks.length };
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
      return { menu: shape(menu), version: await hash(menu), targets, editedAt: content.menuEditedAt ?? null };
    },

    /**
     * Replace the main menu. Items are { title, url, children } with one level of dropdowns;
     * url is a path on this site ("/about-us/"), an https:// or mailto: link, or empty for a
     * dropdown heading. Fails with 409 if the menu changed since `version`.
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
          content.menu = clean;
          content.menuEditedAt = now();
          if (by) content.menuEditedBy = by;
          return { menu: clean, version: await hash(clean) };
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
