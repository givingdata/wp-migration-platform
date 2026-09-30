// The readable text of a web page linked in a Slack request ("post this article as news:
// https://…"), so Claude can write the entry from it. Only the page's title, description and
// main text are kept, capped; it's treated as data like the Slack message itself. Plain GET,
// no cookies, short timeout, HTML only (Workers can't reach private networks anyway).
import { htmlToText } from "./slack-edits.js";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;
const MAX_TEXT = 6000;

/** The first web address in a Slack message (Slack writes links as <https://…|label>). */
export function firstLink(text) {
  const m = String(text ?? "").match(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)/i);
  const url = m?.[1] ?? m?.[2]?.replace(/[).,;:!?'"]+$/, "");
  if (!url) return null;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

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
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "SiteFlo/1.0 (+https://www.flomysite.com)" },
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
