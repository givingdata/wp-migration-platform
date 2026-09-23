// Optional page sections from sections.json (next to content.json in a client repo).
// A page listed there is built from sections; every other page renders its migrated content
// as before, so a site can be fully traditional, fully sections-based, or a mix.
//
// {
//   "site":  { "header": { "style": "band", "button": { "label": "Donate", "href": "/donations/" } },
//              "footer": { "about": "…", "address": ["…"], "contacts": [{ "label": "…", "email": "…" }], "note": "…" } },
//   "pages": { "/": { "sections": [ { "type": "hero", … } ] },
//              "how-to-help": { "sections": [ … ], "content": "after" } }
// }
// Page keys are the page's path without slashes ("/" is the homepage). "content" adds the
// page's migrated content "before" or "after" the sections (default: not shown).

import fs from "node:fs";
import path from "node:path";

export interface Button { label: string; href: string; style?: "primary" | "secondary" }
export interface Img { src: string; alt?: string }
interface Base { type: string; id?: string; tone?: "light" | "alt" | "band"; eyebrow?: string; title?: string; accent?: string }

export interface Hero extends Base { type: "hero"; text?: string; buttons?: Button[]; image?: Img; stats?: { value: string; label: string }[] }
export interface Stats extends Base { type: "stats"; intro?: string; items: { value: string; label: string }[]; highlight?: { value: string; label: string; text?: string } }
export interface Split extends Base { type: "split"; paragraphs?: string[]; tags?: string[]; image?: Img; quote?: { text: string; by?: string }; reverse?: boolean; buttons?: Button[] }
export interface Cards extends Base { type: "cards"; intro?: string; items: { title: string; text: string; href?: string; linkLabel?: string; icon?: string }[]; contacts?: { label: string; email: string }[] }
export interface Quote extends Base { type: "quote"; text: string; by?: string; image?: Img }
export interface Stories extends Base { type: "stories"; items: { quote: string; by: string; detail?: string }[] }
export interface Text extends Base { type: "text"; paragraphs?: string[]; list?: string[]; buttons?: Button[]; image?: Img }
export interface Posts extends Base { type: "posts"; count?: number; link?: Button }

export type Section = Hero | Stats | Split | Cards | Quote | Stories | Text | Posts;
export const SECTION_TYPES = ["hero", "stats", "split", "cards", "quote", "stories", "text", "posts"] as const;

export interface SiteSettings {
  header?: { style?: "default" | "band"; button?: Button };
  footer?: { about?: string; address?: string[]; contacts?: { label: string; email: string }[]; note?: string };
}
interface PageSections { sections: Section[]; content?: "before" | "after"; seo?: import("./content").Seo }
interface SectionsFile { site?: SiteSettings; pages?: Record<string, PageSections> }

let cache: SectionsFile | null = null;

function load(): SectionsFile {
  if (cache) return cache;
  const candidates = [process.env.SECTIONS_PATH, path.resolve(process.cwd(), "../sections.json"), path.resolve(process.cwd(), "sections.json")];
  const file = candidates.find((p) => p && fs.existsSync(p));
  const data: SectionsFile = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  // Fail the build on typos rather than silently dropping a section.
  for (const [key, page] of Object.entries(data.pages || {})) {
    if (!Array.isArray(page?.sections)) throw new Error(`sections.json: pages["${key}"].sections must be a list`);
    page.sections.forEach((s, i) => {
      if (!SECTION_TYPES.includes(s?.type as never)) throw new Error(`sections.json: pages["${key}"].sections[${i}] has unknown type "${s?.type}" (use ${SECTION_TYPES.join(", ")})`);
    });
  }
  cache = data;
  return data;
}

/** Sections for a page path ("/" for the homepage, else e.g. "how-to-help"), or null. */
export function pageSections(pagePath: string): PageSections | null {
  const key = pagePath === "/" ? "/" : pagePath.replace(/^\/+|\/+$/g, "");
  return load().pages?.[key] ?? null;
}

export function siteSettings(): SiteSettings {
  return load().site ?? {};
}

/** Meta description for a sections page: the hero's text, else the first section's text. */
export function sectionsDescription(sections: Section[], max = 160): string | null {
  for (const s of sections) {
    const t = (s as { text?: string }).text || (s as { intro?: string }).intro || (s as { paragraphs?: string[] }).paragraphs?.[0];
    if (t) return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : t;
  }
  return null;
}
