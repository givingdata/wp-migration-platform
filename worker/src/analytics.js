// Visitor numbers for the Slack bot ("how many visits did we have last week?").
//
// Two sources, chosen by ANALYTICS_SOURCE:
//
//   cloudflare  Cloudflare Web Analytics (cookieless, no consent banner) through the GraphQL
//               Analytics API. Needs CF_ACCOUNT_ID, ANALYTICS_SITE_TAG (the site in Web Analytics)
//               and the secret CF_ANALYTICS_TOKEN (Account Analytics: Read, nothing else).
//               Numbers start the day Web Analytics was turned on; there's no backfill.
//   sample      Made-up but realistic numbers for demo sites, the same every time for the same
//               dates. Always labelled as sample data, so nobody mistakes them for real visits.
//
// visitorStats() returns one shape for both, which the bot hands to Claude to answer from.
// Bots are left out of the Cloudflare numbers. Never logs tokens.

export class AnalyticsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const DAY = 86_400_000;
const MAX_DAYS = 90; // Cloudflare keeps Web Analytics data for a limited time; 90 days is safe
const TOP = 8;

/** Which source is configured: "cloudflare", "sample" or null (not set up). */
export function analyticsSource(env) {
  const source = String(env.ANALYTICS_SOURCE || "").toLowerCase();
  if (source === "sample") return "sample";
  if (source === "cloudflare" && env.CF_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID && env.ANALYTICS_SITE_TAG) return "cloudflare";
  return null;
}

const isoDate = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Visits, page views, daily visits, top pages, referrers, countries and devices for the last
 * `days` full days up to and including today (UTC).
 * @param {object} env
 * @param {{ days?: number, paths?: string[], now?: number }} options paths: the site's pages (sample only)
 */
export async function visitorStats(env, { days = 7, paths = [], now = Date.now() } = {}) {
  const source = analyticsSource(env);
  if (!source) throw new AnalyticsError("Visitor numbers aren't set up for this site yet.", 404);
  const n = Math.min(Math.max(Math.round(Number(days) || 7), 1), MAX_DAYS);
  const to = isoDate(now);
  const from = isoDate(now - (n - 1) * DAY);
  const stats = source === "sample" ? sampleStats({ from, n, paths, now }) : await cloudflareStats(env, { from, to, now });
  return { source, from, to, days: n, ...stats };
}

// ---- Cloudflare ---------------------------------------------------------------------------------

const QUERY = `query VisitorStats($account: string!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: $filter) { count sum { visits } }
      daily: rumPageloadEventsAdaptiveGroups(limit: 100, filter: $filter, orderBy: [date_ASC]) { sum { visits } dimensions { date } }
      pages: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: $filter, orderBy: [count_DESC]) { count dimensions { requestPath } }
      referrers: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: $filter, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
      countries: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: $filter, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { countryName } }
      devices: rumPageloadEventsAdaptiveGroups(limit: 5, filter: $filter, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { deviceType } }
    }
  }
}`;

async function cloudflareStats(env, { from, to, now }) {
  const filter = {
    AND: [
      { datetime_geq: `${from}T00:00:00Z`, datetime_leq: new Date(Math.min(now, Date.parse(`${to}T23:59:59Z`))).toISOString() },
      { siteTag: env.ANALYTICS_SITE_TAG },
      { bot: 0 },
    ],
  };
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: JSON.stringify({ query: QUERY, variables: { account: env.CF_ACCOUNT_ID, filter } }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new AnalyticsError(`Cloudflare analytics: HTTP ${res.status}`);
  }
  if (!res.ok || data?.errors?.length) {
    console.error("Cloudflare analytics failed:", res.status, (data?.errors || []).map((e) => e.message).join("; ").slice(0, 300));
    throw new AnalyticsError("Couldn't read the visitor numbers from Cloudflare just now.");
  }
  const a = data?.data?.viewer?.accounts?.[0];
  if (!a) throw new AnalyticsError("Couldn't read the visitor numbers from Cloudflare just now.");
  const list = (rows, key, value) => (rows || []).map((r) => ({ name: r.dimensions?.[key] || "(none)", [value]: value === "views" ? r.count : r.sum?.visits ?? 0 }));
  return {
    visits: a.total?.[0]?.sum?.visits ?? 0,
    pageViews: a.total?.[0]?.count ?? 0,
    daily: (a.daily || []).map((r) => ({ date: r.dimensions.date, visits: r.sum?.visits ?? 0 })),
    topPages: list(a.pages, "requestPath", "views"),
    referrers: list(a.referrers, "refererHost", "visits").map((r) => (r.name === "(none)" || r.name === "" ? { ...r, name: "direct (typed or bookmarked)" } : r)),
    countries: list(a.countries, "countryName", "visits"),
    devices: list(a.devices, "deviceType", "visits"),
  };
}

// ---- sample (demo sites) ------------------------------------------------------------------------

// Small seeded random numbers, so a date always gets the same traffic.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// Shares that add up to about 1, shuffled slightly per day.
const REFERRERS = [["google.com", 0.44], ["direct (typed or bookmarked)", 0.27], ["instagram.com", 0.12], ["facebook.com", 0.06], ["yelp.com", 0.05], ["tripadvisor.com", 0.03], ["bing.com", 0.02], ["duckduckgo.com", 0.01]];
const COUNTRIES = [["Canada", 0.81], ["United States", 0.12], ["United Kingdom", 0.02], ["Australia", 0.015], ["Germany", 0.012], ["France", 0.01], ["Japan", 0.008], ["Mexico", 0.006]];
const DEVICES = [["mobile", 0.66], ["desktop", 0.29], ["tablet", 0.05]];
// Page weights by path; other pages (news, events) share what's left.
const PAGE_WEIGHTS = { "/": 0.34, "/menu/": 0.21, "/event-space/": 0.09, "/events/": 0.07, "/contact/": 0.07, "/about/": 0.05, "/news/": 0.03 };

function sampleStats({ from, n, paths, now }) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const daily = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY;
    const date = isoDate(t);
    const r = rng(`visits:${date}`);
    const weekday = new Date(t).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // Slow growth over the year, busier weekends, a Friday bump for live music, some noise.
    const growth = 1 + ((t / DAY) % 365) / 365 * 0.25;
    let visits = (weekend ? 205 : weekday === 5 ? 175 : 138) * growth * (0.82 + r() * 0.36);
    if (date === isoDate(now)) visits *= Math.min(1, ((now - t) / DAY) * 1.15); // today isn't over
    daily.push({ date, visits: Math.round(visits) });
  }
  const visits = daily.reduce((s, d) => s + d.visits, 0);
  const r = rng(`mix:${from}:${n}`);
  const pageViews = Math.round(visits * (1.8 + r() * 0.25));

  const known = [...new Set(paths.filter((p) => typeof p === "string" && p.startsWith("/")))];
  const extra = known.filter((p) => !(p in PAGE_WEIGHTS));
  // Other pages share what the usual ones leave, earlier ones more; then scale to add up to 1.
  const left = 1 - Object.values(PAGE_WEIGHTS).reduce((s, w) => s + w, 0);
  const raw = [
    ...Object.entries(PAGE_WEIGHTS).filter(([p]) => !known.length || known.includes(p)),
    ...extra.map((p, i) => [p, (left * (extra.length - i)) / ((extra.length * (extra.length + 1)) / 2)]),
  ];
  const sum = raw.reduce((s, [, w]) => s + w, 0) || 1;
  const weights = raw.map(([p, w]) => [p, w / sum]);
  const split = (rows, total, key) =>
    rows
      .map(([name, w]) => ({ name, [key]: Math.round(total * w * (0.9 + r() * 0.2)) }))
      .sort((a, b) => b[key] - a[key])
      .slice(0, TOP);
  return {
    visits,
    pageViews,
    daily,
    topPages: split(weights, pageViews, "views"),
    referrers: split(REFERRERS, visits, "visits"),
    countries: split(COUNTRIES, visits, "visits"),
    devices: split(DEVICES, visits, "visits"),
  };
}
