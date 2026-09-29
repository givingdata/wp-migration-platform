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
// Days are the business's days: TIMEZONE (an IANA name such as "America/Vancouver"; default UTC).
// visitorStats() returns one shape for both sources, which the bot hands to Claude to answer from.
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

// ---- dates in the business's time zone ----------------------------------------------------------

function timeZone(env) {
  const tz = String(env.TIMEZONE || "UTC");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** YYYY-MM-DD of instant t in tz. */
export function localDate(t, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}

// Milliseconds tz is ahead of UTC at instant t.
function offset(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant a local date starts in tz. */
export function startOfDay(date, tz) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - offset(guess, tz);
  return guess - offset(first, tz); // second pass handles a daylight-saving change that day
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ---- shared -------------------------------------------------------------------------------------

/**
 * Visits, page views, daily visits, top pages, referrers, countries and devices for the last
 * `days` days up to and including today, in the business's time zone.
 * @param {object} env
 * @param {{ days?: number, pages?: { path: string, title?: string }[], now?: number }} options
 *   pages: the site's pages, to name them by title (and, for sample numbers, to pick from)
 */
export async function visitorStats(env, { days = 7, pages = [], now = Date.now() } = {}) {
  const source = analyticsSource(env);
  if (!source) throw new AnalyticsError("Visitor numbers aren't set up for this site yet.", 404);
  const tz = timeZone(env);
  const n = Math.min(Math.max(Math.round(Number(days) || 7), 1), MAX_DAYS);
  const to = localDate(now, tz);
  const from = addDays(to, -(n - 1));
  const range = { from, to, n, tz, now, start: startOfDay(from, tz) };
  const paths = pages.map((p) => p?.path).filter((p) => typeof p === "string");
  const stats = source === "sample" ? sampleStats({ ...range, paths }) : await cloudflareStats(env, range);
  const titles = new Map(pages.filter((p) => p?.path && p.title).map((p) => [slash(p.path), String(p.title).slice(0, 120)]));
  stats.topPages = stats.topPages.map((p) => ({ ...p, ...(titles.has(slash(p.name)) ? { title: titles.get(slash(p.name)) } : {}) }));
  return { source, timeZone: tz, today: to, from, to, days: n, ...stats };
}

const slash = (path) => (String(path).endsWith("/") ? String(path) : `${path}/`);

// ---- Cloudflare ---------------------------------------------------------------------------------

const QUERY = `query VisitorStats($account: string!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!, $hours: uint64!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: $filter) { count sum { visits } }
      hourly: rumPageloadEventsAdaptiveGroups(limit: $hours, filter: $filter, orderBy: [datetimeHour_ASC]) { sum { visits } dimensions { datetimeHour } }
      pages: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: $filter, orderBy: [count_DESC]) { count dimensions { requestPath } }
      referrers: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: $filter, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { refererHost } }
      countries: rumPageloadEventsAdaptiveGroups(limit: ${TOP}, filter: $filter, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { countryName } }
      devices: rumPageloadEventsAdaptiveGroups(limit: 5, filter: $filter, orderBy: [sum_visits_DESC]) { sum { visits } dimensions { deviceType } }
    }
  }
}`;

async function cloudflareStats(env, { from, n, tz, now, start }) {
  const filter = {
    AND: [
      { datetime_geq: new Date(start).toISOString(), datetime_leq: new Date(now).toISOString() },
      { siteTag: env.ANALYTICS_SITE_TAG },
      { bot: 0 },
    ],
  };
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
    body: JSON.stringify({ query: QUERY, variables: { account: env.CF_ACCOUNT_ID, filter, hours: n * 24 + 24 } }),
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

  // Hours (UTC) into the business's days, with empty days kept as 0.
  const byDay = new Map(Array.from({ length: n }, (_, i) => [addDays(from, i), 0]));
  for (const r of a.hourly || []) {
    const day = localDate(Date.parse(r.dimensions?.datetimeHour), tz);
    if (byDay.has(day)) byDay.set(day, byDay.get(day) + (r.sum?.visits ?? 0));
  }
  const list = (rows, key, value) => (rows || []).map((r) => ({ name: r.dimensions?.[key] || "(none)", [value]: value === "views" ? r.count : r.sum?.visits ?? 0 }));
  return {
    visits: a.total?.[0]?.sum?.visits ?? 0,
    pageViews: a.total?.[0]?.count ?? 0,
    daily: [...byDay].map(([date, visits]) => ({ date, visits })),
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

const REFERRERS = [["google.com", 0.44], ["direct (typed or bookmarked)", 0.27], ["instagram.com", 0.12], ["facebook.com", 0.06], ["yelp.com", 0.05], ["tripadvisor.com", 0.03], ["bing.com", 0.02], ["duckduckgo.com", 0.01]];
const COUNTRIES = [["Canada", 0.81], ["United States", 0.12], ["United Kingdom", 0.02], ["Australia", 0.015], ["Germany", 0.012], ["France", 0.01], ["Japan", 0.008], ["Mexico", 0.015]];
const DEVICES = [["mobile", 0.66], ["desktop", 0.29], ["tablet", 0.05]];
// Page weights by path; other pages (news, events) share what's left.
const PAGE_WEIGHTS = { "/": 0.34, "/menu/": 0.21, "/event-space/": 0.09, "/events/": 0.07, "/contact/": 0.07, "/about/": 0.05, "/news/": 0.03 };

// Split total by weights (varied a little), in whole numbers that add up to exactly total.
function split(rows, total, key, r) {
  const varied = rows.map(([name, w]) => [name, w * (0.9 + r() * 0.2)]);
  const sum = varied.reduce((s, [, w]) => s + w, 0) || 1;
  const exact = varied.map(([name, w]) => ({ name, value: (total * w) / sum }));
  const out = exact.map((x) => ({ name: x.name, value: Math.floor(x.value) }));
  let left = total - out.reduce((s, x) => s + x.value, 0);
  for (const i of exact.map((x, i) => [x.value % 1, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left-- <= 0) break;
    out[i].value += 1;
  }
  return out.sort((a, b) => b.value - a.value).map((x) => ({ name: x.name, [key]: x.value }));
}

function sampleStats({ from, n, tz, now, paths }) {
  const today = localDate(now, tz);
  const daily = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(from, i);
    const t = Date.parse(`${date}T12:00:00Z`);
    const r = rng(`visits:${date}`);
    const weekday = new Date(t).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // Slow growth over the year, busier weekends, a Friday bump for live music, some noise.
    const growth = 1 + (((t / DAY) % 365) / 365) * 0.25;
    let visits = (weekend ? 205 : weekday === 5 ? 175 : 138) * growth * (0.82 + r() * 0.36);
    if (date === today) {
      // Today isn't over: most café traffic comes between 7 am and 9 pm.
      const hours = (now - startOfDay(date, tz)) / 3_600_000;
      visits *= Math.min(1, Math.max(0, (hours - 6) / 15));
    }
    daily.push({ date, visits: Math.round(visits) });
  }
  const visits = daily.reduce((s, d) => s + d.visits, 0);
  const r = rng(`mix:${from}:${n}:${visits}`);
  const pageViews = Math.round(visits * (1.8 + r() * 0.25));

  const known = [...new Set(paths.filter((p) => p.startsWith("/")).map(slash))];
  const extra = known.filter((p) => !(p in PAGE_WEIGHTS));
  const left = 1 - Object.values(PAGE_WEIGHTS).reduce((s, w) => s + w, 0);
  const pageRows = [
    ...Object.entries(PAGE_WEIGHTS).filter(([p]) => !known.length || known.includes(p)),
    ...extra.map((p, i) => [p, Math.min(0.035, (left * (extra.length - i)) / ((extra.length * (extra.length + 1)) / 2))]),
  ];
  return {
    visits,
    pageViews,
    daily,
    topPages: split(pageRows, pageViews, "views", r).slice(0, TOP),
    referrers: split(REFERRERS, visits, "visits", r),
    countries: split(COUNTRIES, visits, "visits", r),
    devices: split(DEVICES, visits, "visits", r),
  };
}
