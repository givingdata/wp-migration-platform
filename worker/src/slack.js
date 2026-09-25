// Slack transport: the HTTP side of the Slack bot (staff ask for a change in a channel,
// the bot replies in a thread with Approve/Cancel buttons).
//
// Two modes (docs/SLACK.md):
//
//  Direct: this Worker is the Slack app's Request URL (SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN).
//   POST /slack/events         Events API: url_verification challenge, channel messages → onMessage
//   POST /slack/interactions   button clicks (block_actions) → onAction
//   Every request must carry Slack's v0 signature.
//
//  Router: the shared 1wp-slack Worker (slack-router/) receives Slack's requests and forwards this
//  client's ones (SLACK_CLIENT, SLACK_ROUTER_URL, SLACK_ROUTER_KEY).
//   POST /slack/inbox          { kind: "message" | "action", data } signed with SLACK_ROUTER_KEY
//   Web API calls go to <router>/api/<method>, signed the same way; the router adds the bot token.
//
// The routes are off (404) when neither mode is configured. Slack wants a 200 within 3 s, so
// handlers run in ctx.waitUntil and the response goes back straight away. Messages are deduped on
// event_id in KV because Slack retries anything it thinks was slow.
//
// Also: small Web API helpers (slackApi, postMessage, updateMessage, userEmail).
// No content logic here: drafting, approving and committing changes live in the handlers.
// Never logs message text or tokens.
import { toHex, safeEqual, sign, verifySignature, MAX_SKEW_SECONDS } from "./auth.js";

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

/** A plain human message: not a bot, edit or join. Thread replies count; onMessage decides (answers to the bot's questions). */
export function isStaffMessage(event) {
  return event?.type === "message" && !event.subtype && !event.bot_id && !!event.user &&
    typeof event.text === "string" && event.text.trim() !== "";
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

  if (isStaffMessage(body.event)) later(ctx, "onMessage", () => handlers.onMessage(messageFromEvent(body)));
  return json({ ok: true });
}

/** What onMessage gets, from an event_callback body. */
export function messageFromEvent(body) {
  const event = body.event;
  const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : null;
  return { eventId: body.event_id, teamId: body.team_id, channel: event.channel, user: event.user, text: event.text, ts: event.ts, threadTs };
}

/** What onAction gets, from an interaction payload; null unless it's a button click. */
export function actionFromPayload(payload) {
  const action = payload?.type === "block_actions" ? payload.actions?.[0] : null;
  if (!action) return null;
  return {
    actionId: action.action_id,
    value: action.value,
    user: payload.user?.id,
    channel: payload.channel?.id ?? payload.container?.channel_id,
    messageTs: payload.container?.message_ts ?? payload.message?.ts,
    threadTs: payload.message?.thread_ts ?? null,
    responseUrl: payload.response_url,
  };
}

function handleInteractions(raw, env, ctx, handlers) {
  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") || "");
  } catch {
    return json({ ok: false, error: "Missing payload" }, 400);
  }
  const act = actionFromPayload(payload);
  if (act) later(ctx, "onAction", () => handlers.onAction(act));
  return new Response(null, { status: 200 });
}

// ---- router mode --------------------------------------------------------------------------------

/** Headers for a router ↔ client request: timestamp + HMAC of `${ts}.${body}` (auth.js sign). */
export async function routerHeaders(key, client, bytes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ts = String(nowSeconds);
  return { "Content-Type": "application/json", "x-1wp-client": client, "x-1wp-timestamp": ts, "x-1wp-signature": await sign(key, ts, bytes) };
}

/** Checks a router ↔ client request's timestamp and signature. bytes = the exact body received. */
export async function verifyRouterRequest(key, request, bytes, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ts = request.headers.get("x-1wp-timestamp") || "";
  if (!key || !/^\d{1,12}$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > MAX_SKEW_SECONDS) return false;
  return verifySignature(key, ts, bytes, request.headers.get("x-1wp-signature"));
}

const routed = (env) => !!(env?.SLACK_ROUTER_URL && env.SLACK_ROUTER_KEY && env.SLACK_CLIENT);

// POST /slack/inbox from the router. Same handlers as direct mode.
async function handleInbox(bytes, env, ctx, handlers) {
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }
  if (body?.kind === "message" && body.data?.channel) {
    if (await firstSighting(env, body.data.eventId)) later(ctx, "onMessage", () => handlers.onMessage(body.data));
  } else if (body?.kind === "action" && body.data?.channel) {
    later(ctx, "onAction", () => handlers.onAction(body.data));
  } else {
    return json({ ok: false, error: "Unknown kind" }, 400);
  }
  return json({ ok: true });
}

/**
 * Routes POST /slack/events and /slack/interactions (direct mode, SLACK_SIGNING_SECRET) and
 * POST /slack/inbox (router mode, SLACK_ROUTER_KEY). Returns a Response, or null for any other
 * path. 404 for a /slack/* route whose mode isn't configured.
 * handlers: { onMessage(msg): Promise<void>, onAction(act): Promise<void> }
 */
export async function handleSlackRoute(request, env, ctx, handlers) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/slack" && !pathname.startsWith("/slack/")) return null;
  const direct = !!env.SLACK_SIGNING_SECRET && (pathname === "/slack/events" || pathname === "/slack/interactions");
  const inbox = !!env.SLACK_ROUTER_KEY && pathname === "/slack/inbox";
  if (!direct && !inbox) return json({ ok: false }, 404);
  if (request.method !== "POST") return json({ ok: false }, 405);

  if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return json({ ok: false }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY) return json({ ok: false }, 413);

  if (inbox) {
    if (!(await verifyRouterRequest(env.SLACK_ROUTER_KEY, request, bytes))) return json({ ok: false }, 401);
    return handleInbox(bytes, env, ctx, handlers);
  }

  const raw = new TextDecoder().decode(bytes);

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

// Read methods only accept form-encoded bodies; write methods take JSON.
const FORM_METHODS = new Set(["users.info", "users.list", "users.lookupByEmail", "conversations.info", "conversations.members"]);

async function parse(res, method) {
  try {
    return await res.json();
  } catch {
    throw new SlackError(`Slack ${method}: HTTP ${res.status}`);
  }
}

/** One Web API call straight to Slack with SLACK_BOT_TOKEN. Returns Slack's JSON, ok or not. */
export async function slackDirect(env, method, body = {}) {
  if (!env.SLACK_BOT_TOKEN) throw new SlackError("Server is missing SLACK_BOT_TOKEN", 500);
  const form = FORM_METHODS.has(method);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body ?? {}),
  });
  return parse(res, method);
}

// Router mode: the same call through <router>/api/<method>; the router adds the token.
async function viaRouter(env, method, body = {}) {
  const bytes = encoder.encode(JSON.stringify(body ?? {}));
  const res = await fetch(`${env.SLACK_ROUTER_URL.replace(/\/+$/, "")}/api/${method}`, {
    method: "POST",
    headers: await routerHeaders(env.SLACK_ROUTER_KEY, env.SLACK_CLIENT, bytes),
    body: bytes,
  });
  return parse(res, method);
}

/** POST https://slack.com/api/<method> as the bot (via the router in router mode). Throws SlackError when Slack says !ok. */
export async function slackApi(env, method, body) {
  const data = routed(env) ? await viaRouter(env, method, body) : await slackDirect(env, method, body);
  if (!data?.ok) throw new SlackError(`Slack ${method}: ${data?.error || "failed"}`);
  return data;
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
  const data = await slackApi(env, "users.info", { user: userId });
  const email = data.user?.profile?.email;
  if (typeof email !== "string" || !email) return null;
  const lower = email.toLowerCase();
  if (env.CONTENT) await env.CONTENT.put(key, lower, { expirationTtl: USER_TTL });
  return lower;
}
