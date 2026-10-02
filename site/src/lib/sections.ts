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

// Hero layouts: "photo" (default) = full-width photo behind the text; "split" = text beside a framed photo.
// shade (photo layout): "tint" (default) fades the photo into the band colour; "neutral" keeps
// the photo's own colours under a soft dark gradient behind the text.
// parallax (photo layout): the photo scrolls more slowly than the text.
export interface Hero extends Base { type: "hero"; layout?: "photo" | "split"; shade?: "tint" | "neutral"; parallax?: boolean; text?: string; buttons?: Button[]; image?: Img; stats?: { value: string; label: string }[] }
export interface Stats extends Base { type: "stats"; intro?: string; items: { value: string; label: string }[]; highlight?: { value: string; label: string; text?: string } }
export interface Split extends Base { type: "split"; paragraphs?: string[]; tags?: string[]; image?: Img; quote?: { text: string; by?: string }; reverse?: boolean; buttons?: Button[] }
export interface Cards extends Base { type: "cards"; intro?: string; items: { title: string; text: string; href?: string; linkLabel?: string; icon?: string }[]; contacts?: { label: string; email: string }[] }
export interface Quote extends Base { type: "quote"; text: string; by?: string; image?: Img }
export interface Stories extends Base { type: "stories"; items: { quote: string; by: string; detail?: string }[] }
export interface Text extends Base { type: "text"; paragraphs?: string[]; list?: string[]; buttons?: Button[]; image?: Img }
export interface Posts extends Base { type: "posts"; contentType?: string; count?: number; link?: Button }
// A price list (restaurant or café menu, services): two columns of items with a dotted rule.
export interface Menu extends Base { type: "menu"; intro?: string; items: { name: string; price?: string; text?: string }[]; note?: string; buttons?: Button[] }
// A row of short features, each with a line icon (components/sections/Icon.astro names).
export interface Features extends Base { type: "features"; intro?: string; items: { icon?: string; title: string; text?: string }[] }
// Photo tiles with their title on the photo, each optionally a link.
export interface Tiles extends Base { type: "tiles"; intro?: string; items: { title: string; href?: string; image?: Img }[] }
// A centred call to action: heading, a line of text, buttons.
export interface Cta extends Base { type: "cta"; text?: string; buttons?: Button[] }

export type Section = Hero | Stats | Split | Cards | Quote | Stories | Text | Posts | Menu | Features | Tiles | Scenes | Cta;
// Full-width photo panels, each with a text card over it; the photos scroll more slowly than the
// cards (parallax) unless parallax is false.
export interface Scenes extends Base { type: "scenes"; intro?: string; parallax?: boolean; items: { image: Img; eyebrow?: string; title: string; text?: string; href?: string; linkLabel?: string }[] }
export const SECTION_TYPES = ["hero", "stats", "split", "cards", "quote", "stories", "text", "posts", "menu", "features", "tiles", "scenes", "cta"] as const;

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
      const shade = (s as { shade?: string }).shade;
      if (s.type === "hero" && shade !== undefined && !["tint", "neutral"].includes(shade)) throw new Error(`sections.json: pages["${key}"].sections[${i}] has unknown shade "${shade}" (use tint or neutral)`);
      const parallax = (s as { parallax?: unknown }).parallax;
      if ((s.type === "hero" || s.type === "scenes") && parallax !== undefined && typeof parallax !== "boolean") throw new Error(`sections.json: pages["${key}"].sections[${i}] parallax must be true or false`);
      if (s.type === "hero" && parallax === true && (s as { layout?: string }).layout === "split") throw new Error(`sections.json: pages["${key}"].sections[${i}] parallax only works with the photo layout`);
      if (s.type === "scenes" && (!Array.isArray((s as Scenes).items) || (s as Scenes).items.some((it) => !it?.image?.src || !it.title))) throw new Error(`sections.json: pages["${key}"].sections[${i}] scenes need items, each with an image and a title`);
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
