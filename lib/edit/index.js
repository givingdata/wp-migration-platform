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
import { contentTypes, typeForCollection, collectionFor, allCollections } from "../content-types.js";
import { cleanHtml, plainText } from "./sanitize.js";

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

  function isFrontPage(content, collection, entry) {
    return collection === "pages" && !!content.frontPage && [entry.wpId, entry.id].some((v) => v != null && String(v) === String(content.frontPage));
  }

  function inMenu(content, entry) {
    const walk = (items) => (items || []).some((i) => (i.url || "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/+|\/+$/g, "").split("/").pop() === entry.slug || walk(i.children));
    return walk(content.menu);
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

  const summary = (collection, e, content) => ({
    collection,
    id: String(e.id ?? e.slug),
    type: e.type || typeForCollection(types, collection)?.key || collection,
    title: e.title,
    slug: e.slug,
    date: e.date ?? null,
    endDate: e.endDate ?? null,
    source: e.source ?? (e.wpId != null ? "wordpress" : null),
    frontPage: isFrontPage(content, collection, e),
  });

  return {
    types,

    /** Every entry, grouped by collection, newest first (pages by title). */
    async list() {
      const { files } = await store.read([CONTENT_FILE, TRASH_FILE]);
      const content = files[CONTENT_FILE] ?? emptyContent();
      const collections = {};
      for (const c of allCollections(types)) {
        const list = (Array.isArray(content[c]) ? content[c] : []).filter((e) => e && e.title && e.slug).map((e) => summary(c, e, content));
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
          const taken = new Set(allCollections(types).flatMap((c) => (content[c] || []).filter((e, i) => !(c === collection && i === existing)).map((e) => e.slug)));
          let slug = slugify(clean.slug || clean.title) || clean.id;
          for (let n = 2; taken.has(slug); n++) slug = `${slugify(clean.slug || clean.title)}-${n}`;
          clean.slug = slug;
          if (existing >= 0) list[existing] = { ...list[existing], ...clean };
          else list.unshift(clean);
          return { collection, entry: clean };
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
    async remove(collection, id, { by, reason, version } = {}) {
      return transaction(
        (r) => `content: delete ${r.label} "${r.entry.title}"${by ? ` (by ${by})` : ""}\n\nMoved to ${TRASH_FILE} as ${r.trashId}; restore it from there.`,
        async (content, trash) => {
          const { list, index, entry } = find(content, collection, id);
          if (isFrontPage(content, collection, entry)) throw new EditError("This page is the homepage, so it can't be deleted.", 409);
          if (version && (await hash(entry)) !== version) {
            throw new EditError("Someone else changed this entry after you opened it. Reload it before deleting.", 409);
          }
          list.splice(index, 1);
          const trashId = crypto.randomUUID();
          (trash.deleted ||= []).unshift({ trashId, collection, deletedAt: now(), deletedBy: by ?? null, reason: reason ? plainText(String(reason)).slice(0, 500) : null, entry });
          const label = (typeForCollection(types, collection)?.label ?? collection).toLowerCase();
          return { trashChanged: true, trashId, collection, entry, label };
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
          const { collection, entry } = trash.deleted[idx];
          const list = (content[collection] ||= []);
          if (list.some((e) => matches(e, entry.id ?? entry.slug))) throw new EditError("An entry with the same id is already on the site", 409);
          const taken = new Set(allCollections(types).flatMap((c) => (content[c] || []).map((e) => e.slug)));
          const restored = { ...entry };
          for (let n = 2; taken.has(restored.slug); n++) restored.slug = `${entry.slug}-${n}`;
          list.unshift(restored);
          trash.deleted.splice(idx, 1);
          return { trashChanged: true, collection, entry: restored, slugChanged: restored.slug !== entry.slug };
        },
      );
    },
  };
}
