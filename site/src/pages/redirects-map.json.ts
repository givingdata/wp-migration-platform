// Build-time list of every entry's old WordPress address and its new one. redirects.mjs
// turns it into Cloudflare's _redirects (and removes this file from the output).
import { getContent, getFrontPage, getRoutedEntries, urlFor } from "../lib/content";

export function GET() {
  const content = getContent();
  const front = getFrontPage();
  const entries = [...getRoutedEntries(), ...(front ? [front] : [])].map((e) => ({
    link: e.link ?? null,
    wpId: e.wpId ?? null,
    path: urlFor(e),
  }));
  return new Response(JSON.stringify({ siteUrl: content.siteUrl ?? null, hasNews: content.posts.length > 0, entries }));
}
