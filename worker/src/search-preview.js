// "How does the About page look on Google?": a mock search result in Slack, plus the search
// fields Slack can change (search title, search description, share image).
//
// The preview shows the title and description exactly as the site renders them (the Edit
// module's searchPages(), which follows BaseLayout.astro), says where each comes from when
// there's no search title or description of its own, and warns in plain words about what
// Google is likely to cut off or what another page also uses. Read-only: changes go through the
// usual proposal → Approve flow in slack-edits.js (update for the words, the photo flow for the
// share image).
//
// Staff never see "SEO" or "meta": these are the search title, the search description, the
// share image and how a page looks on Google.
import { SEARCH_TITLE_FITS, SEARCH_DESCRIPTION_FITS, searchValues } from "../../lib/edit/search.js";
import { DESIGNED } from "../../lib/edit/index.js";

const SHORT_DESCRIPTION = 70;
const MAX_SAME = 3; // other pages named in a "same as" warning

// Share images are cropped to the shape link previews use (Facebook, LinkedIn, Slack: 1.91:1).
export const SHARE_IMAGE_SPEC = { aspectRatio: "1.91:1", minWidth: 600, maxWidth: 1200 };

// Slack mrkdwn needs &, < and > escaped.
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const quoted = (lines) => lines.map((l) => `>${l}`).join("\n");
const same = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const names = (pages) => pages.slice(0, MAX_SAME).map((p) => `“${esc(p.title)}”`).join(", ") + (pages.length > MAX_SAME ? ` and ${pages.length - MAX_SAME} more` : "");

/** The address as Google shows it: "example.org › about-us". */
export function breadcrumb(siteUrl, path) {
  let host = null;
  try { host = siteUrl ? new URL(siteUrl).host.replace(/^www\./, "") : null; } catch {}
  const parts = String(path || "/").split("/").filter(Boolean);
  return host ? [host, ...parts].join(" › ") : path || "/";
}

const TITLE_FROM = {
  search: "its search title",
  page: "the page title plus the site name, because it has no search title",
  site: "the site name, because it has no search title",
};
const DESCRIPTION_FROM = {
  search: "its search description",
  summary: "the page's summary, because it has no search description",
  text: "the first words of the page's text, because it has no search description or summary",
  sections: "the first text on the page, because it has no search description",
  tagline: "the site's tagline, because it has no search description",
  none: null,
};

/** Plain-language warnings for one page, given every page (for "same as another page"). */
export function searchWarnings(page, pages) {
  const out = [];
  const others = pages.filter((p) => p !== page);
  const title = String(page.shownTitle ?? "");
  if (title.length > SEARCH_TITLE_FITS) out.push(`The title is ${title.length} characters; Google usually shows about ${SEARCH_TITLE_FITS}, so the end will likely be cut off.`);
  const description = page.shownDescription;
  if (description == null) {
    // The tagline isn't known here: nothing to measure.
  } else if (!description.trim()) out.push("There's no description, so Google will pick some text from the page itself (often not the best bit).");
  else if (description.length > SEARCH_DESCRIPTION_FITS) out.push(`The description is ${description.length} characters; Google usually shows about ${SEARCH_DESCRIPTION_FITS}, so the end will likely be cut off.`);
  else if (description.length < SHORT_DESCRIPTION) out.push(`The description is short (${description.length} characters), so Google may show other text from the page instead. Around 120–155 characters works best.`);
  const sameTitle = others.filter((p) => same(p.shownTitle, title));
  if (title && sameTitle.length) out.push(`The title is the same as on ${names(sameTitle)}. Each page should have its own, so people can tell them apart in the results.`);
  const sameDescription = description?.trim() ? others.filter((p) => p.shownDescription && same(p.shownDescription, description)) : [];
  if (sameDescription.length) out.push(`The description is the same as on ${names(sameDescription)}. Each page should have its own.`);
  return out;
}

/** The Slack reply: a mock search result, where it comes from, warnings and a hint. */
export function previewText(page, pages, { siteUrl = null } = {}) {
  const name = page.home ? "the homepage" : `“${page.title}”`;
  const shownDescription = page.shownDescription == null ? "_(your site's tagline)_" : page.shownDescription.trim() ? esc(page.shownDescription) : "_(no description)_";
  const lines = [
    `*How ${esc(name)} looks on Google*`,
    quoted([`*${esc(page.shownTitle)}*`, esc(breadcrumb(siteUrl, page.path)), shownDescription]),
  ];
  const from = [`Title: ${TITLE_FROM[page.titleFrom]}.`];
  if (DESCRIPTION_FROM[page.descriptionFrom]) from.push(`Description: ${DESCRIPTION_FROM[page.descriptionFrom]}.`);
  lines.push(`_${from.join(" ")}_`);
  if (page.noindex) lines.push("⚠️ This page is hidden from search engines, so it won't show up on Google at all. Ask your web team if that's not intended.");

  const share = page.shareImage
    ? `<${esc(page.shareImage)}|${page.seo?.image ? "its share image" : "the page's main photo"}>`
    : "none of its own (the site's default picture, if there is one)";
  lines.push(`*Share image* (shown when someone shares a link to it): ${share}`);

  const warnings = searchWarnings(page, pages);
  lines.push(warnings.length ? `*Worth fixing*\n${warnings.map((w) => `• ${w}`).join("\n")}` : "✅ The title and description are a good length and no other page uses them.");
  const short = page.home ? "the homepage" : page.title.length > 40 ? "this page" : page.title;
  lines.push(`_Ask me to change the search title or description, e.g. “make the search description for ${esc(short)} mention …”, or post a photo and say “use this as the share image for ${esc(short)}”._`);
  return lines.join("\n\n");
}

/**
 * Answer "how does <page> look on Google?" for the page Claude picked from the site index
 * (no page = the homepage). Returns { kind: "reply", text }.
 */
export async function searchPreview(env, editor, { collection, id, progress } = {}) {
  await progress?.("Looking at how it shows up on Google…");
  const pages = await editor.searchPages({ siteName: env.SITE_NAME || "", tagline: env.SITE_TAGLINE || null });
  const wanted = id == null ? null : String(id);
  const page = wanted == null
    ? pages.find((p) => p.home)
    : pages.find((p) => !p.listing && ((p.collection === collection && p.id === wanted) || (p.entryCollection === collection && p.entryId === wanted)));
  if (!page) return { kind: "reply", text: "I couldn't find that page. Which page should I look up?" };
  return { kind: "reply", text: previewText(page, pages, { siteUrl: env.SITE_URL || null }) };
}

// ---------------------------------------------------------------------------------------
// Drafting changes

/** For the update prompts: what the search fields are and when to use them. */
export const SEARCH_FIELDS_HINT =
  "searchTitle and searchDescription are the page's search title and search description: shown only in Google results and when a link to the page is shared, never on the page itself. " +
  "Change them only when the request is about Google, search results, the search title or description, or how the page looks when shared; for anything else change the visible title, summary or text instead, and leave them null. " +
  "A search title is used exactly as written (the site name isn't added), so end it with ' | ' and the organization's name when that fits; keep it under 60 characters. " +
  "A search description is one or two plain sentences of 120–155 characters that make someone want to click. Never invent facts.";

/** Designed pages: the search fields as extra values Claude can change, next to the section slots. */
export function searchSlots(seo) {
  const values = searchValues(seo);
  return [
    { slot: "seo.title", section: "How it looks on Google", label: "Search title", kind: "text", optional: true, value: values["seo.title"] },
    { slot: "seo.description", section: "How it looks on Google", label: "Search description", kind: "textarea", optional: true, value: values["seo.description"] },
  ];
}

export const DESIGNED_SEARCH_HINT =
  "The values in the section \"How it looks on Google\" (seo.title, seo.description) are the page's search title and search description: shown only in Google results and when a link is shared, never on the page. " +
  "Change them only when the request is about Google, search results, the search title or description, or how the page looks when shared; otherwise change the page's own text. " +
  "A search title is used exactly as written, so end it with ' | ' and the organization's name when that fits, under 60 characters; a search description is 120–155 characters of plain text.";

// ---------------------------------------------------------------------------------------
// Share image: a photo posted with "use this as the share image for the Events page"

/** Whether a photo's message could be about the share image (so Claude is offered every page). */
export const mentionsShareImage = (message) => /\bshar(e|ed|ing)\b|link preview|social media|facebook|linkedin|thumbnail/i.test(String(message || ""));

/** Every page that can have a share image: (collection, id, title, path), as in the site index. */
export async function shareImageTargets(editor) {
  const pages = await editor.searchPages();
  return pages.filter((p) => p.collection && !p.listing).map((p) => ({ collection: p.collection, id: p.id, title: String(p.title).slice(0, 120), path: p.path }));
}

/**
 * A proposal (without the request fields) to make the posted photo a page's share image, or a
 * reply. The photo is stored cropped for link previews; nothing changes until Approve.
 */
export async function shareImageProposal(editor, { collection, id, summary, alt, storeImage, progress }) {
  let opened;
  try {
    opened = await editor.get(collection, id);
  } catch (e) {
    if (e?.status === 404) return { kind: "reply", text: "I couldn't find that page. Which page should get this share image?" };
    throw e;
  }
  const { entry, version, path } = opened;
  const seo = entry.seo ?? null;
  await progress?.(`Preparing the share image for “${String(entry.title ?? "").slice(0, 120)}”…`);
  const stored = await storeImage(SHARE_IMAGE_SPEC, crypto.randomUUID());
  // What a shared link shows now: its share image, else the entry's main photo.
  const before = seo?.image || entry.image || null;
  return {
    kind: "draft",
    proposal: {
      id: crypto.randomUUID(), op: "update", collection: opened.designed ? DESIGNED : collection, entryId: String(entry.id ?? entry.slug),
      typeKey: opened.designed ? DESIGNED : opened.type.key, typeLabel: opened.designed ? "Designed page" : opened.type.label ?? opened.type.key,
      fieldLabels: { "seo.image": "Share image" }, version, changes: { "seo.image": stored.image }, before: { "seo.image": seo?.image ?? null },
      photo: { after: stored.image, before, alt, slot: "seo.image", share: true },
      title: entry.title, path, summary: summary || `New share image for “${entry.title}”`,
    },
  };
}
