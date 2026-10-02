// The readable text of a web page linked in a Slack request ("post this article as news:
// https://…"), so Claude can write the entry from it. Only the page's title, description and
// main text are kept, capped; it's treated as data like the Slack message itself. Plain GET,
// no cookies, short timeout, HTML only (Workers can't reach private networks anyway).
import { htmlToText } from "./slack-edits.js";
import { IMAGE_TYPES, MAX_FILE_BYTES } from "./slack.js";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;
const MAX_TEXT = 6000;
const IMAGE_TIMEOUT_MS = 15000;
const MAX_LINKS = 3;
const USER_AGENT = "SiteFlo/1.0 (+https://www.flomysite.com)";

/** The web addresses in a Slack message, in order, without repeats (Slack writes links as <https://…|label>). */
export function allLinks(text, max = MAX_LINKS) {
  const found = [];
  for (const m of String(text ?? "").matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)/gi)) {
    const url = m[1] ?? m[2].replace(/[).,;:!?'"]+$/, "");
    try {
      const u = new URL(url);
      if (/^https?:$/.test(u.protocol) && !found.includes(u.href)) found.push(u.href);
    } catch {
      // not a usable address
    }
    if (found.length >= max) break;
  }
  return found;
}

/** The first web address in a Slack message, or null. */
export const firstLink = (text) => allLinks(text, 1)[0] ?? null;

const meta = (html, name) => {
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"))?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null;
};

/** Title, description and main text of an HTML page, or null if it can't be read. */
export function readablePage(html) {
  const title = htmlToText(meta(html, "og:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 300);
  const description = htmlToText(meta(html, "og:description") ?? meta(html, "description") ?? "").slice(0, 600);
  // Prefer the article or main element; drop the page's own navigation and boilerplate.
  const body = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html;
  const text = htmlToText(body.replace(/<(nav|header|footer|aside|form|noscript|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")).slice(0, MAX_TEXT);
  if (!title && !text) return null;
  return { title, description, text };
}

/** Fetch and read a linked page; null (never throws) when it can't be read. */
export async function fetchLinkedPage(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": USER_AGENT },
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return null;
    const length = Number(res.headers.get("content-length") || 0);
    if (length > MAX_BYTES) return null;
    const html = (await res.text()).slice(0, MAX_BYTES);
    const page = readablePage(html);
    return page ? { url: res.url || url, ...page } : null;
  } catch {
    return null;
  }
}

// The body, or null once it passes `max` bytes (a missing or wrong content-length can't get past this).
async function readCapped(body, max) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) bytes.set(c, (at += c.length) - c.length);
  return bytes;
}

/**
 * A photo at a direct image link (one found on the web, or already on the site), used like a
 * photo posted in Slack: { bytes, type, name, url }. null when the address isn't an image (a web
 * page) or can't be reached. Throws (message unsupported_type or too_large, like a Slack file)
 * for an image it can't use.
 */
export async function fetchImageLink(url) {
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { accept: `${IMAGE_TYPES.join(",")};q=1, */*;q=0.1`, "user-agent": USER_AGENT },
    });
  } catch {
    return null;
  }
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!res.ok || !type.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!IMAGE_TYPES.includes(type)) {
    await res.body?.cancel().catch(() => {});
    throw new Error("unsupported_type");
  }
  if (Number(res.headers.get("content-length") || 0) > MAX_FILE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error("too_large");
  }
  const bytes = res.body ? await readCapped(res.body, MAX_FILE_BYTES) : new Uint8Array(await res.arrayBuffer());
  if (!bytes || bytes.length > MAX_FILE_BYTES) throw new Error("too_large");
  let name = "photo";
  try {
    name = decodeURIComponent(new URL(res.url || url).pathname.split("/").pop()) || name;
  } catch {
    // keep "photo"
  }
  return { bytes, type, name: name.slice(0, 200), url: res.url || url };
}

/** The first link in a message that is a photo, as fetchImageLink returns it; null when none is. */
export async function findLinkedImage(text) {
  for (const url of allLinks(text)) {
    const image = await fetchImageLink(url);
    if (image) return image;
  }
  return null;
}
