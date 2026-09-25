// Designed pages: pages built from sections.json (site/src/lib/sections.ts) instead of their
// migrated content. Staff can change the words, links and images inside the sections, but not
// add, remove, reorder or retype sections: those carry design decisions, like the menu bar.
//
// Every editable value is a "slot" with a path into the page ("2.items.1.text" = the third
// section's second card's text). The Edit module only accepts changes to slots that exist,
// so a change can never alter the page's structure.
import { plainText } from "./sanitize.js";

export const SECTIONS_FILE = "sections.json";
export const DESIGNED = "designed";

// The homepage's key is "/"; "index" is reserved on the site, so no other page can use it.
export const designedId = (key) => (key === "/" ? "index" : key);
export const designedKey = (id) => (id === "index" ? "/" : id);
export const designedPath = (key) => (key === "/" ? "/" : `/${String(key).replace(/^\/+|\/+$/g, "")}/`);

const TYPE_LABELS = { hero: "Hero", stats: "Figures", split: "Text and image", cards: "Cards", quote: "Quote", stories: "Stories", text: "Text", posts: "Latest entries" };
const LIMITS = { text: 300, textarea: 3000, url: 2000, email: 200, image: 2000 };

// [key, label, kind, optional]; `n` in a label becomes the item's number.
const BASE = [["eyebrow", "Small heading above", "text", true], ["title", "Heading", "text"], ["accent", "Heading, highlighted words", "text", true]];
const IMAGE = [["image.src", "Image", "image"], ["image.alt", "Image description (for screen readers)", "text", true]];
const LISTS = {
  buttons: [["label", "Button n text", "text"], ["href", "Button n link", "url"]],
  stats: [["value", "Figure n", "text"], ["label", "Figure n label", "text"]],
  items: {
    stats: [["value", "Figure n", "text"], ["label", "Figure n label", "text"]],
    cards: [["title", "Card n heading", "text"], ["text", "Card n text", "textarea"], ["href", "Card n link", "url", true], ["linkLabel", "Card n link text", "text", true]],
    stories: [["quote", "Story n", "textarea"], ["by", "Story n by", "text"], ["detail", "Story n detail", "text", true]],
  },
  contacts: [["label", "Contact n label", "text"], ["email", "Contact n email", "email"]],
};
const FIELDS = {
  hero: [...BASE, ["text", "Intro text", "textarea", true], ...IMAGE],
  stats: [...BASE, ["intro", "Intro text", "textarea", true], ["highlight.value", "Highlighted figure", "text"], ["highlight.label", "Highlighted figure label", "text"], ["highlight.text", "Highlighted figure note", "text", true]],
  split: [...BASE, ...IMAGE, ["quote.text", "Quote", "textarea"], ["quote.by", "Quote by", "text", true]],
  cards: [...BASE, ["intro", "Intro text", "textarea", true]],
  quote: [...BASE, ["text", "Quote", "textarea"], ["by", "Quote by", "text", true], ...IMAGE],
  stories: [...BASE],
  text: [...BASE, ...IMAGE],
  posts: [...BASE, ["link.label", "Link text", "text"], ["link.href", "Link", "url"]],
};
// Lists of plain strings: [key, label, kind]
const STRING_LISTS = { split: [["paragraphs", "Paragraph n", "textarea"], ["tags", "Tag n", "text"]], text: [["paragraphs", "Paragraph n", "textarea"], ["list", "List item n", "text"]] };
const LIST_KEYS = { hero: ["buttons", "stats"], stats: ["items"], split: ["buttons"], cards: ["items", "contacts"], stories: ["items"], text: ["buttons"] };

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

function set(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

/** A readable name for a section: "Section 2 · Cards: What we do". */
export function sectionLabel(section, index) {
  const name = TYPE_LABELS[section?.type] ?? "Section";
  const title = [section?.eyebrow, section?.title].find((t) => typeof t === "string" && t.trim());
  return `Section ${index + 1} · ${name}${title ? `: ${String(title).slice(0, 60)}` : ""}`;
}

/**
 * The editable values of one section. A slot exists when its value is already text, or when
 * it's optional and its parent is there (so staff can fill in an empty small heading).
 */
export function sectionSlots(section, index) {
  const out = [];
  if (!section || typeof section !== "object") return out;
  const add = (path, label, kind, optional = false) => {
    const value = get(section, path);
    const parent = path.includes(".") ? get(section, path.slice(0, path.lastIndexOf("."))) : section;
    if (typeof value === "string" || (optional && value == null && parent && typeof parent === "object")) {
      out.push({ slot: `${index}.${path}`, label, kind, optional, value: value ?? "" });
    }
  };
  for (const [key, label, kind, optional] of FIELDS[section.type] ?? BASE) add(key, label, kind, optional);
  for (const [key, label, kind] of STRING_LISTS[section.type] ?? []) {
    (Array.isArray(section[key]) ? section[key] : []).forEach((_, i) => add(`${key}.${i}`, label.replace(/\bn\b/, i + 1), kind));
  }
  for (const key of LIST_KEYS[section.type] ?? []) {
    const fields = key === "items" ? LISTS.items[section.type] : LISTS[key];
    (Array.isArray(section[key]) ? section[key] : []).forEach((item, i) => {
      if (item && typeof item === "object") for (const [f, label, kind, optional] of fields) add(`${key}.${i}.${f}`, label.replace(/\bn\b/, i + 1), kind, optional);
    });
  }
  return out;
}

/** Every section of a designed page with its label and slots. */
export function pageSlots(page) {
  return (Array.isArray(page?.sections) ? page.sections : []).map((s, i) => ({ index: i, type: s?.type ?? null, label: sectionLabel(s, i), slots: sectionSlots(s, i) }));
}

const URL_OK = /^(https?:\/\/\S+|mailto:\S+|tel:\S+|\/\S*|#\S*)$/i;
const IMAGE_OK = /^(https:\/\/\S+|\/\S+)$/i;
const EMAIL_OK = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Check `changes` ({ slot: text }) against a page's slots. Returns { clean, errors }: only
 * existing slots, trimmed plain text, links and emails in a valid form.
 */
export function checkSlotChanges(slots, changes) {
  const bySlot = new Map(slots.map((s) => [s.slot, s]));
  const clean = {};
  const errors = {};
  const entries = Object.entries(changes && typeof changes === "object" ? changes : {});
  if (entries.length > 500) return { clean, errors: { _: "Too many changes at once" } };
  for (const [slot, raw] of entries) {
    const def = bySlot.get(slot);
    if (!def) { errors[slot] = "That part of the page can't be changed here (sections can't be added, removed or moved)"; continue; }
    if (typeof raw !== "string") { errors[slot] = "Must be text"; continue; }
    const value = plainText(raw);
    if (!value) {
      if (def.optional) clean[slot] = "";
      else errors[slot] = "Required";
      continue;
    }
    if (value.length > LIMITS[def.kind]) { errors[slot] = `Max ${LIMITS[def.kind]} characters`; continue; }
    if (def.kind === "url" && !URL_OK.test(value)) { errors[slot] = "Links start with / (a page here), https:// or mailto:"; continue; }
    if (def.kind === "image" && !IMAGE_OK.test(value)) { errors[slot] = "Must be an uploaded image (https://…)"; continue; }
    if (def.kind === "email" && !EMAIL_OK.test(value)) { errors[slot] = "Must be an email address"; continue; }
    clean[slot] = value;
  }
  return { clean, errors };
}

/** Apply checked changes to a copy of the page; slot paths start with the section index. */
export function applySlotChanges(page, clean) {
  const next = structuredClone(page);
  for (const [slot, value] of Object.entries(clean)) {
    const dot = slot.indexOf(".");
    set(next.sections[Number(slot.slice(0, dot))], slot.slice(dot + 1), value);
  }
  return next;
}

/** A name for the page: its hero/first heading, else its address. */
export function designedTitle(key, page) {
  const first = (page?.sections || []).find((s) => typeof s?.title === "string" && s.title.trim());
  return first ? [first.title, first.accent].filter(Boolean).join(" ").trim() : designedPath(key);
}
