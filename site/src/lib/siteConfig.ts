// Site-wide settings from config/site.json: analytics, Search Console verification and the
// default share image. Mistakes fail the build (a typo'd ID would otherwise track nothing).
//
// {
//   "analytics": [
//     { "provider": "google", "id": "G-ABC123XYZ", "consentDefault": "denied" },
//     { "provider": "cloudflare", "token": "0123456789abcdef0123456789abcdef" }
//   ],
//   "searchConsole": "verification-code",
//   "shareImage": "https://…/share.jpg"
// }

import config from "../../../config/site.json";

export type Analytics =
  | { provider: "google"; id: string; consentDefault?: "granted" | "denied" }
  | { provider: "gtm"; id: string }
  | { provider: "cloudflare"; token: string }
  | { provider: "plausible"; domain: string; src?: string }
  | { provider: "fathom"; site: string }
  | { provider: "matomo"; url: string; siteId: string | number }
  | { provider: "meta"; id: string }
  | { provider: "custom"; html: string; label?: string };

interface SiteConfig {
  analytics: Analytics[];
  searchConsole: string | null;
  shareImage: string | null;
}

function fail(msg: string): never {
  throw new Error(`config/site.json: ${msg}`);
}

const safe = /^[A-Za-z0-9._:\/-]+$/; // IDs and URLs go into script attributes

function check(a: any, i: number): Analytics {
  const at = `analytics[${i}]`;
  switch (a?.provider) {
    case "google":
      if (/^UA-/i.test(a.id || "")) fail(`${at}: "${a.id}" is a Universal Analytics ID. Google stopped collecting Universal Analytics data in July 2023; use the Google Analytics 4 ID (starts with G-).`);
      if (!/^G-[A-Z0-9]{4,16}$/.test(a.id || "")) fail(`${at}: Google Analytics 4 IDs look like G-ABC123XYZ (got ${JSON.stringify(a.id)})`);
      if (a.consentDefault && !["granted", "denied"].includes(a.consentDefault)) fail(`${at}.consentDefault must be "granted" or "denied"`);
      return a;
    case "gtm":
      if (!/^GTM-[A-Z0-9]{4,10}$/.test(a.id || "")) fail(`${at}: Tag Manager IDs look like GTM-ABC1234`);
      return a;
    case "cloudflare":
      if (!/^[a-f0-9]{32}$/.test(a.token || "")) fail(`${at}: the Cloudflare Web Analytics token is 32 letters and digits (from the snippet's data-cf-beacon)`);
      return a;
    case "plausible":
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(a.domain || "")) fail(`${at}: Plausible needs "domain", e.g. "example.org"`);
      if (a.src && !(/^https:\/\//.test(a.src) && safe.test(a.src))) fail(`${at}.src must be an https URL`);
      return a;
    case "fathom":
      if (!/^[A-Z0-9]{4,12}$/.test(a.site || "")) fail(`${at}: Fathom needs "site", its site ID (e.g. ABCDEFGH)`);
      return a;
    case "matomo":
      if (!(/^https:\/\//.test(a.url || "") && safe.test(a.url))) fail(`${at}: Matomo needs "url", your Matomo address (https://…)`);
      if (!/^\d+$/.test(String(a.siteId ?? ""))) fail(`${at}: Matomo needs a numeric "siteId"`);
      return a;
    case "meta":
      if (!/^\d{10,20}$/.test(a.id || "")) fail(`${at}: Meta Pixel IDs are 10–20 digits`);
      return a;
    case "custom":
      if (typeof a.html !== "string" || !a.html.trim()) fail(`${at}: "custom" needs "html", the snippet to add to every page`);
      return a;
    default:
      fail(`${at}: unknown provider ${JSON.stringify(a?.provider)} (use google, gtm, cloudflare, plausible, fathom, matomo, meta or custom)`);
  }
}

function load(raw: any): SiteConfig {
  const analytics = Array.isArray(raw?.analytics) ? raw.analytics.map(check) : [];
  const searchConsole = raw?.searchConsole ? String(raw.searchConsole).trim() : null;
  if (searchConsole && !/^[A-Za-z0-9_-]{10,80}$/.test(searchConsole)) fail("searchConsole is the content=\"…\" code from Google's HTML-tag verification");
  const shareImage = raw?.shareImage ? String(raw.shareImage) : null;
  if (shareImage && !/^(https:\/\/|\/)/.test(shareImage)) fail("shareImage must be an https URL or a /path");
  return { analytics, searchConsole, shareImage };
}

export const SITE_CONFIG = load(config);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The <head> snippets for every configured provider. */
export function analyticsHead(list = SITE_CONFIG.analytics): string {
  return list.map((a) => {
    switch (a.provider) {
      case "google": {
        const consent = a.consentDefault === "denied"
          ? `gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});`
          : "";
        return `<script async src="https://www.googletagmanager.com/gtag/js?id=${a.id}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}${consent}gtag('js',new Date());gtag('config','${a.id}');</script>`;
      }
      case "gtm":
        return `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${a.id}');</script>`;
      case "cloudflare":
        return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${a.token}"}'></script>`;
      case "plausible":
        return `<script defer data-domain="${esc(a.domain)}" src="${esc(a.src || "https://plausible.io/js/script.js")}"></script>`;
      case "fathom":
        return `<script src="https://cdn.usefathom.com/script.js" data-site="${a.site}" defer></script>`;
      case "matomo": {
        const u = a.url.replace(/\/?$/, "/");
        return `<script>var _paq=window._paq=window._paq||[];_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);(function(){var u="${u}";_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId','${a.siteId}']);var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];g.async=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();</script>`;
      }
      case "meta":
        return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${a.id}');fbq('track','PageView');</script>`;
      case "custom":
        return a.html;
    }
  }).join("\n");
}

/** Tag Manager also wants a <noscript> frame right after <body>. */
export function analyticsBody(list = SITE_CONFIG.analytics): string {
  return list
    .filter((a): a is Extract<Analytics, { provider: "gtm" }> => a.provider === "gtm")
    .map((a) => `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${a.id}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`)
    .join("");
}
