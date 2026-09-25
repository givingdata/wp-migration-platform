// Slack transport: the HTTP side of the Slack bot (staff ask for a change in a channel,
// the bot replies in a thread with Approve/Cancel buttons).
//
//   POST /slack/events         Events API: url_verification challenge, channel messages → onMessage
//   POST /slack/interactions   button clicks (block_actions) → onAction
//
// Every request must carry Slack's v0 signature (SLACK_SIGNING_SECRET). The routes are off
// (404) when that secret isn't set. Slack wants a 200 within 3 s, so handlers run in
// ctx.waitUntil and the response goes back straight away. Events are deduped on event_id in
// KV because Slack retries anything it thinks was slow.
//
// Also: small Web API helpers (slackApi, postMessage, updateMessage, userEmail).
// No content logic here: drafting, approving and committing changes live in the handlers.
// Never logs message text or tokens.
import { toHex, safeEqual, MAX_SKEW_SECONDS } from "./auth.js";

const MAX_BODY = 256 * 1024;
const EVENT_TTL = 3600;
const USER_TTL = 86400;

const encoder = new TextEncoder();

export class SlackError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Constant-time check of Slack's v0 signature. nowSeconds for tests. */
export async function verifySlackSignature(secret, timestamp, rawBody, signature, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof signature !== "string" || !/^\d{1,12}$/.test(timestamp || "")) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${rawBody}`));
  return safeEqual(`v0=${toHex(mac)}`, signature);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// Run a handler after the response; errors are logged (without message text), never thrown.
function later(ctx, label, fn) {
  ctx.waitUntil(Promise.resolve().then(fn).catch((e) => console.error(`slack ${label} failed:`, e?.message || e)));
}

// A plain top-level human message: not a bot, edit, join, or thread reply.
function isStaffMessage(event) {
  return event?.type === "message" && !event.subtype && !event.bot_id && !!event.user &&
    typeof event.text === "string" && event.text.trim() !== "" &&
    (!event.thread_ts || event.thread_ts === event.ts);
}

// True the first time an event_id is seen (records it). Without KV, always true.
async function firstSighting(env, eventId) {
  if (!env.CONTENT || !eventId) return true;
  const key = `slack:event:${eventId}`;
  if (await env.CONTENT.get(key)) return false;
  await env.CONTENT.put(key, "1", { expirationTtl: EVENT_TTL });
  return true;
}

async function handleEvents(raw, env, ctx, handlers) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }
  if (body?.type === "url_verification") return json({ challenge: body.challenge });
  if (body?.type !== "event_callback") return json({ ok: true });

  // Slack retries (x-slack-retry-num) land here too; a seen event_id is simply acked.
  if (!(await firstSighting(env, body.event_id))) return json({ ok: true });

  const event = body.event;
  if (isStaffMessage(event)) {
    const msg = { eventId: body.event_id, teamId: body.team_id, channel: event.channel, user: event.user, text: event.text, ts: event.ts };
    later(ctx, "onMessage", () => handlers.onMessage(msg));
  }
  return json({ ok: true });
}

function handleInteractions(raw, env, ctx, handlers) {
  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") || "");
  } catch {
    return json({ ok: false, error: "Missing payload" }, 400);
  }
  const action = payload?.type === "block_actions" ? payload.actions?.[0] : null;
  if (action) {
    const act = {
      actionId: action.action_id,
      value: action.value,
      user: payload.user?.id,
      channel: payload.channel?.id ?? payload.container?.channel_id,
      messageTs: payload.container?.message_ts ?? payload.message?.ts,
      threadTs: payload.message?.thread_ts ?? null,
      responseUrl: payload.response_url,
    };
    later(ctx, "onAction", () => handlers.onAction(act));
  }
  return new Response(null, { status: 200 });
}

/**
 * Routes POST /slack/events and POST /slack/interactions. Returns a Response, or null for
 * any other path. 404 for /slack/* when SLACK_SIGNING_SECRET isn't set (feature off).
 * handlers: { onMessage(msg): Promise<void>, onAction(act): Promise<void> }
 */
export async function handleSlackRoute(request, env, ctx, handlers) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/slack" && !pathname.startsWith("/slack/")) return null;
  if (!env.SLACK_SIGNING_SECRET) return json({ ok: false }, 404);
  if (pathname !== "/slack/events" && pathname !== "/slack/interactions") return json({ ok: false }, 404);
  if (request.method !== "POST") return json({ ok: false }, 405);

  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return json({ ok: false }, 413);
  const raw = await request.text();
  if (encoder.encode(raw).length > MAX_BODY) return json({ ok: false }, 413);

  const ok = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    request.headers.get("x-slack-request-timestamp"),
    raw,
    request.headers.get("x-slack-signature"),
  );
  if (!ok) return json({ ok: false }, 401);

  return pathname === "/slack/events"
    ? handleEvents(raw, env, ctx, handlers)
    : handleInteractions(raw, env, ctx, handlers);
}

// One Web API call. Write methods take JSON; read methods like users.info only accept
// form-encoded bodies, hence `form`.
async function call(env, method, body, form) {
  if (!env.SLACK_BOT_TOKEN) throw new SlackError("Server is missing SLACK_BOT_TOKEN", 500);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body ?? {}),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new SlackError(`Slack ${method}: HTTP ${res.status}`);
  }
  if (!data?.ok) throw new SlackError(`Slack ${method}: ${data?.error || `HTTP ${res.status}`}`);
  return data;
}

/** POST https://slack.com/api/<method> (JSON body) as the bot. Throws SlackError when Slack says !ok. */
export async function slackApi(env, method, body) {
  return call(env, method, body, false);
}

/** chat.postMessage (in a thread when threadTs). Returns the new message's ts. */
export async function postMessage(env, { channel, threadTs, text, blocks }) {
  const data = await slackApi(env, "chat.postMessage", {
    channel, text, ...(blocks ? { blocks } : {}), ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false,
  });
  return data.ts;
}

/** chat.update: replace a message's text/blocks (e.g. swap buttons for "Approved by …"). */
export async function updateMessage(env, { channel, ts, text, blocks }) {
  await slackApi(env, "chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
}

/** A Slack user's email (lowercased) via users.info, cached a day in KV. null if hidden/absent. */
export async function userEmail(env, userId) {
  const key = `slack:user:${userId}`;
  if (env.CONTENT) {
    const cached = await env.CONTENT.get(key);
    if (cached) return cached;
  }
  const data = await call(env, "users.info", { user: userId }, true);
  const email = data.user?.profile?.email;
  if (typeof email !== "string" || !email) return null;
  const lower = email.toLowerCase();
  if (env.CONTENT) await env.CONTENT.put(key, lower, { expirationTtl: USER_TTL });
  return lower;
}
