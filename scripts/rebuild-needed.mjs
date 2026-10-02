#!/usr/bin/env node
// Does tonight's scheduled rebuild need to run? The site only changes by date when an event
// moves to "past", an announcement starts or ends, or the footer's year rolls over; on other
// nights rebuild.yml skips the build (saving GitHub Actions minutes).
//
// The site compares dates with today in UTC (site/src/lib/content.ts), so this does too. It
// builds when any dated entry starts or ends within the last LOOKBACK_DAYS (so one missed or
// failed run is caught up), in the first days of January, and every Monday as a safety net.
// Content pushes and manual runs always build; any error here also means "build".
//
// Usage (rebuild.yml): node scripts/rebuild-needed.mjs  → prints build=true|false and reason=…,
// appended to $GITHUB_OUTPUT when set. Run in the repo root (reads content.json and
// config/design-specs.json).
import fs from "node:fs";

const LOOKBACK_DAYS = 2;
const SAFETY_WEEKDAY = 1; // Monday

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000));

/** Collections whose entries show or hide by date: types with an end date, a banner or an upcoming-only listing. */
export function datedCollections(specs) {
  return Object.entries(specs?.contentTypes ?? {})
    .filter(([, t]) => t?.enabled !== false && (t?.fields?.includes("endDate") || t?.banner || t?.listing?.upcoming))
    .map(([key, t]) => t.collection ?? `${key}s`);
}

/**
 * { build, reason } for a scheduled run on `now`. An entry changes the site on the day it starts
 * (date) and the day after it ends (endDate, or date when it has none).
 */
export function rebuildNeeded(content, specs, now = new Date()) {
  const today = day(now);
  if (now.getUTCDay() === SAFETY_WEEKDAY) return { build: true, reason: "weekly rebuild" };
  if (today.slice(5) <= `01-0${LOOKBACK_DAYS}`) return { build: true, reason: "new year (footer)" };
  const since = addDays(today, -LOOKBACK_DAYS);
  const inWindow = (iso) => typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) && iso.slice(0, 10) > since && iso.slice(0, 10) <= today;
  for (const collection of datedCollections(specs)) {
    for (const e of Array.isArray(content?.[collection]) ? content[collection] : []) {
      const end = e?.endDate ?? e?.date;
      if (inWindow(e?.date) || (typeof end === "string" && inWindow(addDays(end.slice(0, 10), 1)))) {
        return { build: true, reason: `“${String(e.title ?? e.id ?? "an entry").slice(0, 80)}” (${collection}) starts or ends` };
      }
    }
  }
  return { build: false, reason: "nothing changes by date" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let result;
  try {
    if (process.env.GITHUB_EVENT_NAME && process.env.GITHUB_EVENT_NAME !== "schedule") result = { build: true, reason: process.env.GITHUB_EVENT_NAME };
    else result = rebuildNeeded(JSON.parse(fs.readFileSync("content.json", "utf8")), JSON.parse(fs.readFileSync("config/design-specs.json", "utf8")));
  } catch (e) {
    result = { build: true, reason: `check failed (${e.message})` };
  }
  const out = `build=${result.build}\nreason=${result.reason.replace(/\n/g, " ")}\n`;
  process.stdout.write(out);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
}
