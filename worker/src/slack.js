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
//   POST /slack/inbox          { kind: "message" | "action" | "deleted", data } or { kind: "tick" } (the router's
//                              cron: run scheduled changes), signed with SLACK_ROUTER_KEY
//   Web API calls go to <router>/api/<method>, signed the same way; the router adds the bot token.
//
// The routes are off (404) when neither mode is configured. Slack wants a 200 within 3 s, so
// handlers run in ctx.waitUntil and the response goes back straight away. Messages are deduped on
// event_id in KV because Slack retries anything it thinks was slow.
//
// Photos: a message with files attached (subtype "file_share") passes through with the files'
// id, type and size; downloadFile() fetches one (via the router, which holds the bot token and
// only hands out files posted in the client's own channel). Needs the files:read scope.
//
// Also: small Web API helpers (slackApi, postMessage, updateMessage, userEmail).
// No content logic here: drafting, approving and committing changes live in the handlers.
// Never logs message text or tokens.
import { toHex, safeEqual, sign, verifySignature, MAX_SKEW_SECONDS } from "./auth.js";

const MAX_BODY = 256 * 1024;
const EVENT_TTL = 3600;
const USER_TTL = 86400;

const encoder = new TextEncoder();

// Photos staff can post: the staff form's rules (config/design-specs.json → image).
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_FILE_BYTES = 10 * 1048576;
const MAX_FILES = 5;

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

/**
 * A plain human message: not a bot, edit or join. A message with files (subtype file_share)
 * counts, even without text. Thread replies count; onMessage decides (answers to the bot's questions).
 */
export function isStaffMessage(event) {
  if (event?.type !== "message" || event.bot_id || !event.user) return false;
  if (event.subtype && event.subtype !== "file_share") return false;
  const hasText = typeof event.text === "string" && event.text.trim() !== "";
  return hasText || (Array.isArray(event.files) && event.files.length > 0);
}

/**
 * A person deleted a top-level message: { channel, ts }, else null. Slack sends subtype
 * message_deleted, or (when the message had thread replies) message_changed to a "tombstone".
 * Only people's messages count; thread replies don't (the bot's thread belongs to the top message).
 */
export function deletedFromEvent(event) {
  if (event?.type !== "message") return null;
  const before = event.previous_message;
  let ts = null;
  if (event.subtype === "message_deleted") ts = event.deleted_ts;
  else if (event.subtype === "message_changed" && event.message?.subtype === "tombstone") ts = event.message.ts;
  if (!ts || typeof event.channel !== "string" || !/^\d+\.\d+$/.test(String(ts))) return null;
  if (!before?.user || before.bot_id) return null;
  if (before.thread_ts && before.thread_ts !== ts) return null;
  return { channel: event.channel, ts: String(ts) };
}

/** The files on a message: id, name, type and size only (never Slack's private URLs). */
export function filesOf(event) {
  return (Array.isArray(event?.files) ? event.files : [])
    .filter((f) => f && typeof f.id === "string" && /^F[A-Z0-9]{4,}$/.test(f.id))
    .slice(0, MAX_FILES)
    .map((f) => ({ id: f.id, name: String(f.name || "photo").slice(0, 200), mimetype: String(f.mimetype || ""), size: Number(f.size) || 0 }));
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
  const deleted = deletedFromEvent(body.event);
  if (deleted && handlers.onDeleted) later(ctx, "onDeleted", () => handlers.onDeleted(deleted));
  return json({ ok: true });
}

/** What onMessage gets, from an event_callback body. */
export function messageFromEvent(body) {
  const event = body.event;
  const threadTs = event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : null;
  const files = filesOf(event);
  return {
    eventId: body.event_id, teamId: body.team_id, channel: event.channel, user: event.user,
    text: typeof event.text === "string" ? event.text : "", ts: event.ts, threadTs, ...(files.length ? { files } : {}),
  };
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
  } else if (body?.kind === "tick") {
    if (handlers.onTick) later(ctx, "onTick", () => handlers.onTick());
  } else if (body?.kind === "deleted" && body.data?.channel && body.data?.ts) {
    if (handlers.onDeleted) later(ctx, "onDeleted", () => handlers.onDeleted({ channel: body.data.channel, ts: body.data.ts }));
  } else {
    return json({ ok: false, error: "Unknown kind" }, 400);
  }
  return json({ ok: true });
}

/**
 * Routes POST /slack/events and /slack/interactions (direct mode, SLACK_SIGNING_SECRET) and
 * POST /slack/inbox (router mode, SLACK_ROUTER_KEY). Returns a Response, or null for any other
 * path. 404 for a /slack/* route whose mode isn't configured.
 * handlers: { onMessage(msg), onAction(act), onDeleted?({ channel, ts }), onTick?() }, each returning a Promise
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
const FORM_METHODS = new Set(["users.info", "users.list", "users.lookupByEmail", "conversations.info", "conversations.members", "conversations.replies", "files.info"]);

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
  try {
    await slackApi(env, "chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
  } catch (e) {
    // Slack rejects the whole message when it can't load one image; show those as links instead.
    if (!(e instanceof SlackError) || !/invalid_blocks/.test(e.message) || !blocks?.some((b) => b.type === "image")) throw e;
    await slackApi(env, "chat.update", { channel, ts, text, blocks: blocks.map(imageAsLink) });
  }
}

const imageAsLink = (b) =>
  b.type === "image" ? { type: "section", text: { type: "mrkdwn", text: `🖼 <${b.image_url}|${b.title?.text || "Photo"}>${b.alt_text ? `: ${b.alt_text}` : ""}` } } : b;

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

/**
 * Download a photo posted as `file` ({ id }) with the bot token: files.info, then its private
 * download URL. Only JPEG, PNG or WebP up to MAX_FILE_BYTES. Returns { bytes, type, name }.
 * Used directly in direct mode and by the router; clients in router mode use downloadFile().
 */
export async function fetchSlackFile(env, fileId) {
  const info = await slackDirect(env, "files.info", { file: fileId });
  if (!info?.ok) throw new SlackError(`Slack files.info: ${info?.error || "failed"}`, info?.error === "missing_scope" ? 500 : 404);
  const f = info.file || {};
  if (!IMAGE_TYPES.includes(f.mimetype)) throw new SlackError("unsupported_type", 415);
  if (Number(f.size) > MAX_FILE_BYTES) throw new SlackError("too_large", 413);
  const url = f.url_private_download || f.url_private;
  if (typeof url !== "string" || !/^https:\/\/files\.slack\.com\//.test(url)) throw new SlackError("no_download_url", 502);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  if (!res.ok) throw new SlackError(`Slack file download: HTTP ${res.status}`, 502);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Slack answers a failed download with its sign-in page (HTML), not an error status.
  if (bytes.length > MAX_FILE_BYTES) throw new SlackError("too_large", 413);
  if (!IMAGE_TYPES.includes((res.headers.get("Content-Type") || "").split(";")[0].trim())) throw new SlackError("not_an_image", 502);
  return { bytes, type: f.mimetype, name: String(f.name || "photo") };
}

/** A photo posted in this client's channel: { bytes, type, name }. Router mode asks the router. */
export async function downloadFile(env, file) {
  if (!routed(env)) return fetchSlackFile(env, file.id);
  const bytes = encoder.encode(JSON.stringify({ file: file.id }));
  const res = await fetch(`${env.SLACK_ROUTER_URL.replace(/\/+$/, "")}/files/download`, {
    method: "POST",
    headers: await routerHeaders(env.SLACK_ROUTER_KEY, env.SLACK_CLIENT, bytes),
    body: bytes,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new SlackError(err.error || `router file download: HTTP ${res.status}`, res.status);
  }
  const type = (res.headers.get("Content-Type") || "").split(";")[0].trim();
  const out = new Uint8Array(await res.arrayBuffer());
  if (!IMAGE_TYPES.includes(type) || out.length > MAX_FILE_BYTES) throw new SlackError("not_an_image", 502);
  return { bytes: out, type, name: file.name || "photo" };
}
