import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { visitorStats, analyticsSource } from "../src/analytics.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const NOW = Date.parse("2026-09-29T18:00:00Z");

test("source: sample, cloudflare only with its settings, else not set up", () => {
  assert.equal(analyticsSource({ ANALYTICS_SOURCE: "sample" }), "sample");
  assert.equal(analyticsSource({ ANALYTICS_SOURCE: "cloudflare" }), null);
  assert.equal(analyticsSource({ ANALYTICS_SOURCE: "cloudflare", CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "a", ANALYTICS_SITE_TAG: "s" }), "cloudflare");
  assert.equal(analyticsSource({}), null);
});

test("not set up → a friendly error", async () => {
  await assert.rejects(visitorStats({}, { now: NOW }), /aren't set up/);
});

test("sample: realistic, uses the site's pages, and the same every time", async () => {
  const env = { ANALYTICS_SOURCE: "sample" };
  const paths = ["/", "/menu/", "/about/", "/harvest-supper-club/"];
  const pages = paths.map((path) => ({ path, title: path === "/" ? "Home" : path.slice(1, -1) }));
  const a = await visitorStats(env, { days: 30, pages, now: NOW });
  const b = await visitorStats(env, { days: 30, pages, now: NOW });
  assert.deepEqual(a, b);
  assert.equal(a.source, "sample");
  assert.equal(a.from, "2026-08-31");
  assert.equal(a.to, "2026-09-29");
  assert.equal(a.daily.length, 30);
  assert.equal(a.visits, a.daily.reduce((s, d) => s + d.visits, 0));
  assert.ok(a.visits > 30 * 80 && a.visits < 30 * 400, `plausible visits: ${a.visits}`);
  assert.ok(a.pageViews > a.visits);
  assert.equal(a.topPages[0].name, "/");
  assert.ok(a.topPages.every((p) => paths.includes(p.name)), "only the site's own pages");
  assert.equal(a.countries[0].name, "Canada");
  assert.equal(a.topPages[0].title, "Home", "pages carry their titles");
  for (const key of ["referrers", "countries", "devices"]) {
    assert.equal(a[key].reduce((s, x) => s + x.visits, 0), a.visits, `${key} add up to the visits`);
  }
  assert.equal((await visitorStats(env, { days: 500, now: NOW })).days, 90, "capped at 90 days");
});

test("cloudflare: one GraphQL call with the site and dates, bots excluded, mapped to the same shape", async () => {
  const env = { ANALYTICS_SOURCE: "cloudflare", CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc", ANALYTICS_SITE_TAG: "site1" };
  let sent;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(init.headers.Authorization, "Bearer tok");
    sent = JSON.parse(init.body);
    return Response.json({ data: { viewer: { accounts: [{
      total: [{ count: 50, sum: { visits: 20 } }],
      hourly: [{ sum: { visits: 8 }, dimensions: { datetimeHour: "2026-09-28T10:00:00Z" } }, { sum: { visits: 12 }, dimensions: { datetimeHour: "2026-09-29T10:00:00Z" } }],
      pages: [{ count: 30, dimensions: { requestPath: "/" } }],
      referrers: [{ sum: { visits: 11 }, dimensions: { refererHost: "" } }, { sum: { visits: 9 }, dimensions: { refererHost: "google.com" } }],
      countries: [{ sum: { visits: 20 }, dimensions: { countryName: "Canada" } }],
      devices: [{ sum: { visits: 20 }, dimensions: { deviceType: "mobile" } }],
    }] } } });
  };
  const s = await visitorStats(env, { days: 2, now: NOW });
  assert.equal(sent.variables.account, "acc");
  assert.deepEqual(sent.variables.filter.AND.slice(1), [{ siteTag: "site1" }, { bot: 0 }]);
  assert.equal(sent.variables.filter.AND[0].datetime_geq, "2026-09-28T00:00:00.000Z");
  assert.deepEqual(s.daily, [{ date: "2026-09-28", visits: 8 }, { date: "2026-09-29", visits: 12 }]);
  assert.equal(s.visits, 20);
  assert.equal(s.pageViews, 50);
  assert.deepEqual(s.topPages, [{ name: "/", views: 30 }]);
  assert.equal(s.referrers[0].name, "direct (typed or bookmarked)");
});

test("cloudflare: API errors become a friendly message", async () => {
  const env = { ANALYTICS_SOURCE: "cloudflare", CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc", ANALYTICS_SITE_TAG: "site1" };
  globalThis.fetch = async () => Response.json({ errors: [{ message: "not authorized" }] });
  await assert.rejects(visitorStats(env, { now: NOW }), /Couldn't read the visitor numbers/);
});

test("days are the business's days (TIMEZONE), not UTC's", async () => {
  // 03:30 UTC on 29 Sep is 20:30 on 28 Sep in Victoria.
  const now = Date.parse("2026-09-29T03:30:00Z");
  const utc = await visitorStats({ ANALYTICS_SOURCE: "sample" }, { days: 7, now });
  const bc = await visitorStats({ ANALYTICS_SOURCE: "sample", TIMEZONE: "America/Vancouver" }, { days: 7, now });
  assert.equal(utc.today, "2026-09-29");
  assert.equal(bc.today, "2026-09-28");
  assert.equal(bc.from, "2026-09-22");
  assert.equal(bc.timeZone, "America/Vancouver");
  const evening = bc.daily.at(-1).visits;
  const full = (await visitorStats({ ANALYTICS_SOURCE: "sample", TIMEZONE: "America/Vancouver" }, { days: 7, now: Date.parse("2026-09-29T12:00:00Z") })).daily.find((d) => d.date === "2026-09-28").visits;
  assert.ok(evening > full * 0.8 && evening <= full, "by 8:30 pm most of the day's visits are in");
  assert.equal((await visitorStats({ ANALYTICS_SOURCE: "sample", TIMEZONE: "Not/AZone" }, { now })).timeZone, "UTC");
});

test("cloudflare: hours are grouped into the business's days", async () => {
  const env = { ANALYTICS_SOURCE: "cloudflare", CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acc", ANALYTICS_SITE_TAG: "site1", TIMEZONE: "America/Vancouver" };
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ data: { viewer: { accounts: [{
      total: [{ count: 9, sum: { visits: 5 } }],
      // 02:00 UTC on the 29th is still the 28th in Vancouver.
      hourly: [{ sum: { visits: 2 }, dimensions: { datetimeHour: "2026-09-28T20:00:00Z" } }, { sum: { visits: 3 }, dimensions: { datetimeHour: "2026-09-29T02:00:00Z" } }],
      pages: [], referrers: [], countries: [], devices: [],
    }] } } });
  };
  const s = await visitorStats(env, { days: 2, now: Date.parse("2026-09-29T03:30:00Z") });
  assert.equal(sent.variables.filter.AND[0].datetime_geq, "2026-09-27T07:00:00.000Z", "midnight in Vancouver (PDT)");
  assert.deepEqual(s.daily, [{ date: "2026-09-27", visits: 0 }, { date: "2026-09-28", visits: 5 }]);
});
