// Who and where the Slack bot acts: allowed channels, staff emails/domains,
// and a per-user hourly limit on Claude drafts. Settings are [vars] in
// wrangler.toml (see docs/SLACK.md). Empty settings mean nobody, not everybody.

const DEFAULT_HOURLY_LIMIT = 20;

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Channels the bot acts in: env.SLACK_CHANNEL_IDS, comma-separated Slack channel IDs (C…/G…). Empty/missing = none (deny). */
export function channelAllowed(env, channelId) {
  if (!channelId || typeof channelId !== "string") return false;
  return list(env?.SLACK_CHANNEL_IDS).includes(channelId);
}

/** Staff check on the Slack user's email: env.SLACK_STAFF_EMAILS (comma list, case-insensitive exact) and/or env.SLACK_STAFF_DOMAINS (comma list, e.g. "thecinderellaproject.com" matches exactly that domain after @, no subdomain tricks). Empty both = nobody. null email = false. */
export function isStaff(env, email) {
  if (!email || typeof email !== "string") return false;
  const addr = email.trim().toLowerCase();
  // Exactly one @, with something on both sides.
  const parts = addr.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const emails = list(env?.SLACK_STAFF_EMAILS).map((e) => e.toLowerCase());
  if (emails.includes(addr)) return true;

  const domains = list(env?.SLACK_STAFF_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, ""));
  return domains.includes(parts[1]);
}

// UTC hour as YYYYMMDDHH.
function hourKey(now) {
  return now.toISOString().slice(0, 13).replace(/[-T]/g, "");
}

/** Per-user hourly limit on Claude drafts. KV env.CONTENT key `slack:rate:<userId>:<YYYYMMDDHH UTC>`, expirationTtl 7200. Limit env.SLACK_HOURLY_LIMIT (default 20). Returns { ok, remaining, limit }. Increments on each call. If env.CONTENT is missing, allow. now for tests. */
export async function takeRateLimit(env, userId, now = new Date()) {
  const parsed = Number.parseInt(env?.SLACK_HOURLY_LIMIT, 10);
  const limit = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HOURLY_LIMIT;
  if (!env?.CONTENT) return { ok: true, remaining: limit, limit };

  // KV isn't atomic: two messages in the same instant may count once.
  // Fine for a cost guard.
  const key = `slack:rate:${userId}:${hourKey(now)}`;
  const used = Number.parseInt(await env.CONTENT.get(key), 10) || 0;
  if (used >= limit) return { ok: false, remaining: 0, limit };
  await env.CONTENT.put(key, String(used + 1), { expirationTtl: 7200 });
  return { ok: true, remaining: limit - used - 1, limit };
}
