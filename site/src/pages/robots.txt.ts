import type { APIRoute } from "astro";
import { SITE_CONFIG } from "../lib/siteConfig";

// A site hidden from search (config/site.json "noindex") disallows everything and has no sitemap.
export const GET: APIRoute = ({ site }) =>
  new Response(SITE_CONFIG.noindex ? "User-agent: *\nDisallow: /\n" : `User-agent: *\nAllow: /\n\nSitemap: ${new URL("sitemap-index.xml", site).href}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
