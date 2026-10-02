// Monthly check-up: once a month the bot posts a short summary of the site check (health.js) to
// the site's Slack channel, but only when something could use a look:
//
//   🩺 Monthly website check-up: 9 things could use a look.
//   • Photo descriptions (4): About, Team, Contact and 1 more
//   • Search titles (2): …
//   For the full list with links, post “is anything out of date?” here. Ask me: “describe the photos on About”
//
// When: the first weekday (Mon–Fri) of the month, from 10:00 until 17:00 in the site's TIMEZONE
// (UTC if unset). onTick (the router's cron, every 10 minutes) calls runCheckup; a KV marker per
// month (slack:checkup:<YYYY-MM>) makes it post once. A check that fails (GitHub down) leaves no
// marker, so the next tick that day tries again. Router mode only (direct mode has no tick).
//
// Outside links aren't checked here: they're the slow part and use the run's outgoing-request
// budget. Staff get them by asking the bot.
//
// Settings ([vars] in wrangler.toml, docs/SLACK.md): SLACK_CHECKUP = "off" turns it off.
// It posts in the first channel of SLACK_CHANNEL_IDS.
import { siteHealth, groupFindings, fixHint } from "./health.js";
import { postMessage } from "./slack.js";

const START_HOUR = 10;
const END_HOUR = 17;
const MARKER_TTL = 45 * 86_400;
const TOP = 3;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

export const checkupKey = (month) => `slack:checkup:${month}`;

/** SLACK_CHECKUP = "off" (or false/no/0) turns the monthly post off. On by default. */
export const checkupOff = (env) => /^(off|false|no|0)$/i.test(String(env?.SLACK_CHECKUP ?? "").trim());

function timeZone(env) {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: env.TIMEZONE || "UTC" }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

// Wall-clock parts of an instant in a time zone: { year, month, day, hour (strings), weekday ("Mon") }.
function wallClock(ms, tz) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** Is this local time inside the check-up window: the month's first weekday, 10:00–17:00? */
export function checkupDue(w) {
  const day = Number(w.day);
  const hour = Number(w.hour);
  if (!WEEKDAYS.includes(w.weekday) || hour < START_HOUR || hour >= END_HOUR) return false;
  return day === 1 || (w.weekday === "Mon" && day <= 3); // the 1st was a Saturday or Sunday
}

// Slack mrkdwn needs &, < and > escaped.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Fewer findings than this aren't worth a post of their own; staff see them when they ask.
export const MIN_FINDINGS = 3;

/** The monthly post (Slack mrkdwn), or null when there's not enough to say. */
export function checkupMessage({ findings }, { siteUrl = null } = {}) {
  if (findings.length < MIN_FINDINGS) return null;
  const base = siteUrl ? String(siteUrl).replace(/\/+$/, "") : null;
  const groups = groupFindings(findings);
  const lines = [`🩺 *Monthly website check-up*: ${findings.length === 1 ? "1 thing" : `${findings.length} things`} could use a look.`];
  for (const g of groups) {
    const seen = new Set();
    const names = [];
    for (const f of g.list) {
      const name = f.title ?? f.path;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(f.path && base ? `<${base}${f.path}|${esc(name)}>` : esc(name));
    }
    const shown = names.slice(0, TOP).join(", ");
    const more = names.length > TOP ? ` and ${names.length - TOP} more` : "";
    lines.push(`• *${g.group.heading}* (${g.list.length})${shown ? `: ${shown}${more}` : ""}`);
  }
  lines.push(`For the full list with links, post “is anything out of date?” here. ${fixHint(groups[0])}`);
  return lines.join("\n");
}

/**
 * Post this month's check-up if it's due and not done yet. Returns what happened, for logs and
 * tests: { skipped } or { posted, findings }. `post` is postMessage (tests pass a fake).
 */
export async function runCheckup(env, getEditor, { now = Date.now(), post = postMessage } = {}) {
  if (checkupOff(env)) return { skipped: "off" };
  const channel = String(env.SLACK_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)[0];
  if (!channel || !env.CONTENT) return { skipped: "no channel" };
  const w = wallClock(now, timeZone(env));
  if (!checkupDue(w)) return { skipped: "not due" };
  const key = checkupKey(`${w.year}-${w.month}`);
  if (await env.CONTENT.get(key)) return { skipped: "done" };

  const siteUrl = env.SITE_URL || null;
  const result = await siteHealth(getEditor(), { today: `${w.year}-${w.month}-${w.day}`, siteUrl, siteName: env.SITE_NAME, checkExternal: false });
  const text = checkupMessage(result, { siteUrl });
  if (text) await post(env, { channel, text });
  await env.CONTENT.put(key, text ? "posted" : "nothing to report", { expirationTtl: MARKER_TTL });
  return { posted: !!text, findings: result.findings.length };
}
